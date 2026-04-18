import { invoke } from '@tauri-apps/api/core'
import { listen, UnlistenFn } from '@tauri-apps/api/event'
import { useLayoutStore } from '../stores/layoutStore'
import { useChatStore } from '../stores/chatStore'
import { logger } from '../utils/logger'

type ServerStatus = 'starting' | 'running' | 'stopped' | 'error'
type ServerType = 'frontend' | 'backend'

interface DevServerSlot {
  pid: number
  url: string | null
  status: ServerStatus
  projectPath: string
  command: string
  serverType: ServerType
  port: number
  /** Bumped on every start/stop for this slot; guards stale invoke/poll returns. */
  generation: number
  /** Separate poll gen so URL changes cancel prior polls without disturbing lifecycle gen. */
  pollGeneration: number
  eaddrinuseRetried: boolean
}

interface DevServerOutputPayload {
  pid: number
  stream: string
  data: string
}

// URL patterns emitted by common dev servers (including IPv6 variants)
const URL_REGEX = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[0:0:0:0:0:0:0:1\]):\d+\/?/
const PORT_REGEX = /(?:listening on|running (?:on|at)|started on|port|server at)\s+(\d{4,5})/i

const DEV_SERVER_PORT = 7773
const BACKEND_SERVER_PORT = 7777

const READY_TIMEOUT = 12_000
const READY_POLL_INTERVAL = 500

class DevServerManager {
  private static instance: DevServerManager
  private frontendServer: DevServerSlot | null = null
  private backendServer: DevServerSlot | null = null
  private unlistenOutput: UnlistenFn | null = null
  private unlistenExit: UnlistenFn | null = null
  private unsubPreviewDefer: (() => void) | null = null

  static getInstance(): DevServerManager {
    if (!DevServerManager.instance) {
      DevServerManager.instance = new DevServerManager()
    }
    return DevServerManager.instance
  }

  private slotFor(type: ServerType): DevServerSlot | null {
    return type === 'frontend' ? this.frontendServer : this.backendServer
  }

  private setSlot(type: ServerType, slot: DevServerSlot | null): void {
    if (type === 'frontend') this.frontendServer = slot
    else this.backendServer = slot
  }

  /** Find the slot matching this PID (at most one matches since PIDs are unique). */
  private slotByPid(pid: number): DevServerSlot | null {
    if (this.frontendServer?.pid === pid) return this.frontendServer
    if (this.backendServer?.pid === pid) return this.backendServer
    return null
  }

  /**
   * Inject --port CLI flag for frontend dev servers.
   * Host binding (0.0.0.0 for Docker) is handled via HOST/HOSTNAME env vars on the Rust side.
   */
  private injectPort(command: string, port: number, isBackend: boolean): string {
    if (isBackend) return command

    if (/^(npm|yarn|pnpm|bun)\s+(run\s+\w+|start|dev)\b/.test(command)) {
      return `${command} -- --port ${port}`
    }

    if (/^(npx\s+)?(ng\s+serve|next\s+dev|vite|nuxt\s+dev|astro\s+dev|svelte-kit\s+dev)\b/.test(command)) {
      return `${command} --port ${port}`
    }

    return command
  }

  private normalizeUrl(url: string): string {
    // Keep "localhost" — WKWebView on macOS only grants ATS exemption for
    // that hostname in iframes (raw IPs treated as untrusted).
    let normalized = url
      .replace('127.0.0.1', 'localhost')
      .replace('0.0.0.0', 'localhost')
      .replace('[::1]', 'localhost')
      .replace('[::1:]', 'localhost')
      .replace('[0:0:0:0:0:0:0:1]', 'localhost')
    if (!normalized.endsWith('/')) normalized += '/'
    return normalized
  }

  async start(projectPath: string, devCommand: string, serverTypeHint?: ServerType): Promise<void> {
    const serverType: ServerType = serverTypeHint || 'frontend'
    const port = serverType === 'backend' ? BACKEND_SERVER_PORT : DEV_SERVER_PORT

    // Only stop the same-type slot. The other slot (e.g. backend when starting frontend)
    // must stay running — this is the core of dual-server fullstack support.
    await this.stop(serverType)

    try {
      await invoke('kill_port', { port })
      logger.info('devServer', `Port ${port} cleared for ${serverType}`)
    } catch {
      // Port already free — continue
    }

    const resolvedCommand = this.injectPort(devCommand, port, serverType === 'backend')

    useLayoutStore.getState().setPreviewServerLoading(true)

    const slot: DevServerSlot = {
      pid: 0,
      url: null,
      status: 'starting',
      projectPath,
      command: devCommand,
      serverType,
      port,
      generation: Date.now() + Math.random(),
      pollGeneration: 0,
      eaddrinuseRetried: false,
    }
    this.setSlot(serverType, slot)

    // Attach listeners once; both slots share them and demux by PID.
    await this.ensureListeners()

    try {
      const pid = await invoke<number>('start_dev_server', {
        command: resolvedCommand,
        cwd: projectPath,
        port,
      })

      // Slot may have been replaced or cleared while invoke was pending.
      const live = this.slotFor(serverType)
      if (!live || live.generation !== slot.generation) {
        try { await invoke('kill_process', { pid }) } catch {}
        return
      }

      live.pid = pid
      console.warn(`[dev-server] STARTED: type=${serverType}, PID=${pid}, command="${resolvedCommand}", port=${port}`)
      logger.info('devServer', `Started ${serverType} server (PID ${pid}): ${devCommand}`)
    } catch (error) {
      const live = this.slotFor(serverType)
      if (live && live.generation === slot.generation) {
        this.setSlot(serverType, null)
        if (!this.frontendServer && !this.backendServer) {
          this.cleanup()
          useLayoutStore.getState().setPreviewServerLoading(false)
        }
      }
      throw error
    }
  }

  private async ensureListeners(): Promise<void> {
    if (this.unlistenOutput) return
    this.unlistenOutput = await listen<DevServerOutputPayload>(
      'dev-server-output',
      (event) => this.handleOutput(event.payload),
    )
    this.unlistenExit = await listen<number>(
      'dev-server-exit',
      (event) => this.handleExit(event.payload),
    )
  }

  private handleOutput(payload: DevServerOutputPayload): void {
    // Demux by PID. For still-starting slots (pid=0) we fall back to the one
    // that hasn't received a PID yet — safe because only one slot can be in
    // the pid=0 state at any time (start() awaits before another call can
    // enter the same path).
    let slot = this.slotByPid(payload.pid)
    if (!slot) {
      if (this.frontendServer?.pid === 0) slot = this.frontendServer
      else if (this.backendServer?.pid === 0) slot = this.backendServer
    }
    if (!slot) return

    const line = payload.data
    const layoutStore = useLayoutStore.getState()

    // Many tools (npm, next, tsc) send warnings/info to stderr — classify by content.
    const isWarn = /\bwarn(ing)?\b/i.test(line) || /\bnpm warn\b/i.test(line)
    const isError = !isWarn && (
      /\berror\b/i.test(line)
      || /\bERR[!_]/i.test(line)
      || /\bfailed\b/i.test(line)
      || /\bEADDRINUSE\b/.test(line)
    )
    const level = isError ? 'error' : isWarn ? 'warn' : 'info'

    if (line.trim()) {
      layoutStore.addDevServerLog(line, level)
    }

    if (/Cannot find module.*rollup|Error:.*optional dependencies/i.test(line)) {
      layoutStore.addDevServerLog(
        'Fix: Run "rm -rf node_modules package-lock.json && npm install" in the terminal to reinstall dependencies for this platform.',
        'error',
      )
    }

    // Auto-recovery: one retry per slot on EADDRINUSE
    const eaddrinuse = line.match(/EADDRINUSE.*(?:port|address)[:\s]*(\d+)/i)
      || line.match(/EADDRINUSE.*:::(\d+)/i)
      || line.match(/address already in use\s+(?:::)?(\d+)/i)
    if (eaddrinuse && !slot.eaddrinuseRetried) {
      const blockedPort = parseInt(eaddrinuse[1], 10)
      if (blockedPort > 0) {
        slot.eaddrinuseRetried = true
        const { projectPath, command, serverType } = slot
        layoutStore.addDevServerLog(
          `Port ${blockedPort} in use — killing and restarting...`,
          'warn',
        )
        this.stop(serverType).then(async () => {
          try { await invoke('kill_port', { port: blockedPort }) } catch {}
          await new Promise(r => setTimeout(r, 500))
          await this.start(projectPath, command, serverType).catch(() => {})
          const s = this.slotFor(serverType)
          if (s) s.eaddrinuseRetried = true
        })
        return
      }
    }

    // Detect URL in output
    let detectedUrl: string | null = null
    const urlMatch = line.match(URL_REGEX)
    const portMatch = line.match(PORT_REGEX)

    if (urlMatch) {
      detectedUrl = urlMatch[0]
    } else if (portMatch) {
      detectedUrl = `http://localhost:${portMatch[1]}`
    }

    if (detectedUrl) {
      const url = this.normalizeUrl(detectedUrl)

      // Always track the latest URL — Vite/Next may report initial then switch ports.
      if (slot.url !== url) {
        const prevUrl = slot.url
        slot.url = url
        slot.status = 'running'

        if (prevUrl) {
          layoutStore.addDevServerLog(`[debug] URL changed: ${prevUrl} → ${url}`, 'info')
        }
        layoutStore.addDevServerLog(`Server ready at ${url}`, 'info')

        this.waitForServerReady(url, slot)
      }
    }
  }

  /**
   * Poll the detected URL until the server accepts connections, then register
   * it in layoutStore. `no-cors` opaque responses are enough — we only care
   * that the server is reachable, not its body.
   */
  private async waitForServerReady(url: string, slot: DevServerSlot): Promise<void> {
    const gen = slot.generation
    const pollGen = ++slot.pollGeneration
    const start = Date.now()
    const layoutStore = useLayoutStore.getState()
    let attempts = 0

    while (Date.now() - start < READY_TIMEOUT) {
      const live = this.slotFor(slot.serverType)
      if (!live || live !== slot || live.generation !== gen || live.pollGeneration !== pollGen) {
        logger.info('devServer', `Polling cancelled for ${url}`)
        return
      }

      attempts++
      try {
        const reachable = await invoke<boolean>('check_server_health', { url })
        if (reachable) {
          logger.info('devServer', `Server reachable after ${attempts} attempts (${Date.now() - start}ms)`)
          break
        }
      } catch (err) {
        logger.warn('devServer', `Health check error (attempt ${attempts}):`, err)
      }

      await new Promise(r => setTimeout(r, READY_POLL_INTERVAL))
    }

    const timedOut = Date.now() - start >= READY_TIMEOUT
    const live = this.slotFor(slot.serverType)

    if (timedOut && live === slot) {
      layoutStore.addDevServerLog(
        `Server did not respond within ${READY_TIMEOUT / 1000}s. The server may still be starting — click Reload in the preview to retry.`,
        'error',
      )
      layoutStore.setPreviewServerTimedOut(true)
    }

    if (!timedOut && live === slot) {
      // serverType is authoritative — it was set at start() and never changes.
      const uiMode = slot.serverType === 'backend' ? 'api' : 'server'
      layoutStore.setPreviewServer(url, slot.pid, uiMode)
      logger.info('devServer', `Preview server registered: ${url} (mode: ${uiMode})`)

      // Auto-switch to preview. Defer if agent is streaming so we don't yank
      // the user out of chat mid-response.
      if (!useChatStore.getState().isStreaming) {
        layoutStore.setViewMode('preview')
      } else {
        this.unsubPreviewDefer?.()
        const unsub = useChatStore.subscribe((state, prev) => {
          if (prev.isStreaming && !state.isStreaming) {
            unsub()
            this.unsubPreviewDefer = null
            useLayoutStore.getState().setViewMode('preview')
          }
        })
        this.unsubPreviewDefer = unsub
      }
    } else if (!timedOut) {
      logger.warn('devServer', `Polling finished but server no longer active (${attempts} attempts, ${Date.now() - start}ms)`)
    }
  }

  private handleExit(pid: number): void {
    const slot = this.slotByPid(pid)
    if (!slot) return

    const wasRunning = slot.status === 'running'
    const wasStarting = slot.status === 'starting'
    const type = slot.serverType
    console.warn(`[dev-server] EXIT: type=${type}, pid=${pid}, wasRunning=${wasRunning}, wasStarting=${wasStarting}`)
    slot.status = 'stopped'
    this.setSlot(type, null)

    const layoutStore = useLayoutStore.getState()
    if (wasStarting) {
      layoutStore.addDevServerLog(`${type === 'backend' ? 'Backend' : 'Frontend'} server exited before becoming ready. Check your dev command and dependencies.`, 'error')
    } else if (wasRunning) {
      layoutStore.addDevServerLog(`${type === 'backend' ? 'Backend' : 'Frontend'} server stopped`, 'warn')
    }

    // Only clear the dying slot — the other keeps running.
    layoutStore.clearPreviewServer(type)

    if (!this.frontendServer && !this.backendServer) {
      this.cleanup()
    }
  }

  async stop(which: ServerType | 'all' = 'all'): Promise<void> {
    const targets: ServerType[] = which === 'all' ? ['frontend', 'backend'] : [which]

    for (const type of targets) {
      const slot = this.slotFor(type)
      if (!slot) continue

      // Bump generation — any in-flight invoke return will kill its orphaned PID.
      slot.generation = Date.now() + Math.random()
      const pid = slot.pid
      this.setSlot(type, null)

      if (pid) {
        try { await invoke('kill_process', { pid }) } catch {
          // Process may have already exited
        }
      }
    }

    if (!this.frontendServer && !this.backendServer) {
      this.cleanup()
    }
  }

  private cleanup(): void {
    this.unlistenOutput?.()
    this.unlistenOutput = null
    this.unlistenExit?.()
    this.unlistenExit = null
    this.unsubPreviewDefer?.()
    this.unsubPreviewDefer = null
  }

  async restart(which?: ServerType): Promise<void> {
    const type: ServerType = which || 'frontend'
    const slot = this.slotFor(type)
    if (!slot) return
    const { projectPath, command } = slot
    await this.stop(type)
    await this.start(projectPath, command, type)
  }

  /** Returns URL of a specific slot, or the frontend URL by default. */
  getUrl(which?: ServerType): string | null {
    if (which) return this.slotFor(which)?.url || null
    return this.frontendServer?.url || this.backendServer?.url || null
  }

  getProjectPath(): string | null {
    return this.frontendServer?.projectPath || this.backendServer?.projectPath || null
  }

  /** True when at least one slot is accepting connections. */
  isRunning(): boolean {
    return this.frontendServer?.status === 'running'
      || this.backendServer?.status === 'running'
  }

  /** True when at least one slot exists (starting or running). */
  isActive(): boolean {
    return !!(this.frontendServer || this.backendServer)
  }
}

export const devServerManager = DevServerManager.getInstance()
