import { invoke } from '@tauri-apps/api/core'
import { listen, UnlistenFn } from '@tauri-apps/api/event'
import { useLayoutStore } from '../stores/layoutStore'
import { useChatStore } from '../stores/chatStore'
import { isContainerActive } from '../stores/containerStore'
import { logger } from '../utils/logger'

type ServerStatus = 'starting' | 'running' | 'stopped' | 'error'

interface DevServerState {
  pid: number
  url: string | null
  status: ServerStatus
  projectPath: string
  command: string
}

interface DevServerOutputPayload {
  pid: number
  stream: string
  data: string
}

// URL patterns emitted by common dev servers (including IPv6 variants)
const URL_REGEX = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[0:0:0:0:0:0:0:1\]):\d+\/?/
const PORT_REGEX = /(?:listening on|running (?:on|at)|started on|port|server at)\s+(\d{4,5})/i

/** Port used for frontend dev servers — avoids conflict with the IDE's own Vite (5173). */
const DEV_SERVER_PORT = 7773
/** Port used for backend/API dev servers. */
const BACKEND_SERVER_PORT = 7777

/** Max time (ms) to wait for the server to accept connections. */
const READY_TIMEOUT = 12_000
/** Interval (ms) between readiness pings. */
const READY_POLL_INTERVAL = 500

class DevServerManager {
  private static instance: DevServerManager
  private currentServer: DevServerState | null = null
  private unlistenOutput: UnlistenFn | null = null
  private unlistenExit: UnlistenFn | null = null
  /** Incremented on each start() — lets us detect stale invoke returns. */
  private generation = 0
  /** Incremented on each waitForServerReady call — cancels previous polling if URL changes. */
  private pollGeneration = 0
  /** Optional hint from the agent about the server type — skips auto-detection. */
  private serverTypeHint: 'frontend' | 'backend' | null = null
  /** Resolved port for the current server (7773 for frontend, 7777 for backend). */
  private serverPort: number = DEV_SERVER_PORT
  /** Guards against infinite EADDRINUSE retry loops — at most one auto-recovery per start(). */
  private eaddrinuseRetried = false
  /** Pending preview-switch subscription — cleaned up on stop(). */
  private unsubPreviewDefer: (() => void) | null = null

  static getInstance(): DevServerManager {
    if (!DevServerManager.instance) {
      DevServerManager.instance = new DevServerManager()
    }
    return DevServerManager.instance
  }

  /**
   * Inject --port CLI flag for frontend dev servers.
   * Host binding (0.0.0.0 for Docker) is handled via HOST/HOSTNAME env vars
   * on the Rust side — NOT via CLI flags, since each framework uses different
   * flags (Vite: --host, Next: --hostname, Nuxt: --host without value).
   */
  private injectPort(command: string, port: number, isBackend: boolean): string {
    if (isBackend) return command

    if (/^(npm|yarn|pnpm)\s+run\s+/.test(command)) {
      return `${command} -- --port ${port}`
    }
    return command
  }

  /** Normalize dev server URL for iframe compatibility. */
  private normalizeUrl(url: string): string {
    // Use "localhost" instead of "127.0.0.1" — WKWebView on macOS grants
    // localhost ATS (App Transport Security) exemption for iframes, but
    // treats raw IP addresses as untrusted origins.
    // Docker/Colima port-forwarding also binds to localhost on the host.
    let normalized = url
      .replace('127.0.0.1', 'localhost')
      .replace('0.0.0.0', 'localhost')
      .replace('[::1]', 'localhost')
      .replace('[::1:]', 'localhost')
      .replace('[0:0:0:0:0:0:0:1]', 'localhost')
    // Ensure trailing slash
    if (!normalized.endsWith('/')) normalized += '/'
    return normalized
  }

  async start(projectPath: string, devCommand: string, serverTypeHint?: 'frontend' | 'backend'): Promise<void> {
    // Stop any existing server first
    await this.stop()

    this.serverTypeHint = serverTypeHint || null
    this.serverPort = serverTypeHint === 'backend' ? BACKEND_SERVER_PORT : DEV_SERVER_PORT
    this.eaddrinuseRetried = false

    // Kill any process occupying our port before starting.
    // Skip in Docker mode — the port is owned by Colima's SSH forwarding.
    // Orphaned dev servers inside the container are cleaned by fuser in start_dev_server.
    // The Rust kill_port command polls until the port is actually free (up to 3s).
    if (!isContainerActive()) {
      try {
        await invoke('kill_port', { port: this.serverPort })
        logger.info('devServer', `Port ${this.serverPort} cleared`)
      } catch {
        // Ignore — port may already be free
      }
    }

    const gen = ++this.generation

    const resolvedCommand = this.injectPort(devCommand, this.serverPort, this.serverTypeHint === 'backend')

    // Signal loading state to the UI
    useLayoutStore.getState().setPreviewServerLoading(true)

    this.currentServer = {
      pid: 0,
      url: null,
      status: 'starting',
      projectPath,
      command: devCommand,
    }

    // Listen for output events before spawning
    this.unlistenOutput = await listen<DevServerOutputPayload>(
      'dev-server-output',
      (event) => this.handleOutput(event.payload),
    )

    this.unlistenExit = await listen<number>(
      'dev-server-exit',
      (event) => this.handleExit(event.payload),
    )

    try {
      const pid = await invoke<number>('start_dev_server', {
        command: resolvedCommand,
        cwd: projectPath,
        port: this.serverPort,
      })

      // If stop() or another start() was called while we awaited invoke,
      // the generation has changed — kill the orphaned process.
      if (gen !== this.generation || !this.currentServer) {
        try { await invoke('kill_process', { pid }) } catch {}
        return
      }

      this.currentServer.pid = pid
      console.warn(`[dev-server] STARTED: PID=${pid}, command="${resolvedCommand}", port=${this.serverPort}`)
      logger.info('devServer', `Started dev server (PID ${pid}): ${devCommand}`)
    } catch (error) {
      // Only clean up if we're still the active generation
      if (gen === this.generation) {
        this.currentServer = null
        this.cleanup()
        useLayoutStore.getState().setPreviewServerLoading(false)
      }
      throw error
    }
  }

  private handleOutput(payload: DevServerOutputPayload): void {
    if (!this.currentServer) return
    // When pid is 0 we're still waiting for invoke to return — accept all
    // events (safe because stop() unlistens before start() re-listens).
    // Once pid is set, filter to avoid stale events.
    if (this.currentServer.pid !== 0 && payload.pid !== this.currentServer.pid) return

    const line = payload.data
    const layoutStore = useLayoutStore.getState()

    // Classify line level for the console panel.
    // Many tools (npm, next, tsc) send warnings and info to stderr,
    // so we classify by content, not by stream.
    const isWarn = /\bwarn(ing)?\b/i.test(line) || /\bnpm warn\b/i.test(line)
    const isError = !isWarn && (
      /\berror\b/i.test(line)
      || /\bERR[!_]/i.test(line)
      || /\bfailed\b/i.test(line)
      || /\bEADDRINUSE\b/.test(line)
    )
    const level = isError ? 'error' : isWarn ? 'warn' : 'info'

    // Push to dev console log store
    if (line.trim()) {
      layoutStore.addDevServerLog(line, level)
    }

    // Detect common fatal errors and provide actionable feedback
    if (/Cannot find module.*rollup|Error:.*optional dependencies/i.test(line)) {
      layoutStore.addDevServerLog(
        'Fix: Run "rm -rf node_modules package-lock.json && npm install" in the terminal to reinstall dependencies for this platform.',
        'error'
      )
    }

    // Auto-recovery: detect EADDRINUSE, kill the port, and restart (once)
    const eaddrinuse = line.match(/EADDRINUSE.*(?:port|address)[:\s]*(\d+)/i)
      || line.match(/EADDRINUSE.*:::(\d+)/i)
      || line.match(/address already in use\s+(?:::)?(\d+)/i)
    if (eaddrinuse && !this.eaddrinuseRetried && this.currentServer) {
      const blockedPort = parseInt(eaddrinuse[1], 10)
      if (blockedPort > 0) {
        this.eaddrinuseRetried = true
        const { projectPath, command } = this.currentServer
        const hint = this.serverPort === BACKEND_SERVER_PORT ? 'backend' as const : undefined
        layoutStore.addDevServerLog(
          `Port ${blockedPort} in use — killing and restarting...`,
          'warn'
        )
        // Fire-and-forget: stop current, kill port, restart
        this.stop().then(async () => {
          try {
            await invoke('kill_port', { port: blockedPort })
          } catch { /* port may already be free */ }
          await new Promise(r => setTimeout(r, 500))
          // Re-set the flag AFTER start() resets it, to prevent infinite loops
          await this.start(projectPath, command, hint).catch(() => {})
          this.eaddrinuseRetried = true
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

    if (detectedUrl && this.currentServer) {
      const url = this.normalizeUrl(detectedUrl)

      // Always update to the LATEST detected URL.
      // Vite/Next.js may report an initial URL then switch ports if occupied.
      if (this.currentServer.url !== url) {
        const prevUrl = this.currentServer.url
        this.currentServer.url = url
        this.currentServer.status = 'running'

        if (prevUrl) {
          layoutStore.addDevServerLog(`[debug] URL changed: ${prevUrl} → ${url}`, 'info')
        }
        layoutStore.addDevServerLog(`Server ready at ${url}`, 'info')

        // Poll until the server actually accepts connections, then show preview
        this.waitForServerReady(url)
      }
    }
  }

  /**
   * Poll the detected URL until the server accepts connections,
   * then transition to preview mode.
   *
   * Uses `mode: 'no-cors'` because the IDE WebView origin differs from
   * the dev server origin (different port). In no-cors mode the fetch
   * succeeds (opaque response) as long as the server is reachable —
   * we don't need to read the body, just confirm it's accepting
   * connections.
   */
  private async waitForServerReady(url: string): Promise<void> {
    const gen = this.generation
    const pollGen = ++this.pollGeneration
    const start = Date.now()
    const layoutStore = useLayoutStore.getState()
    let attempts = 0

    while (Date.now() - start < READY_TIMEOUT) {
      // If server was stopped/restarted, or URL changed (new poll started), bail out
      if (gen !== this.generation || !this.currentServer || pollGen !== this.pollGeneration) {
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

    // Detect whether this is a frontend SPA or backend API server
    if (gen === this.generation && this.currentServer) {
      const serverType = this.serverTypeHint === 'frontend' ? 'server'
        : this.serverTypeHint === 'backend' ? 'api'
        : await this.detectServerType(url)
      this.serverTypeHint = null
      layoutStore.setPreviewServer(url, this.currentServer.pid, serverType)
      logger.info('devServer', `Preview server registered: ${url} (type: ${serverType})`)

      // Auto-switch to preview. If the agent is streaming, defer until
      // streaming ends so we don't yank the user out of the chat mid-response.
      if (!useChatStore.getState().isStreaming) {
        layoutStore.setViewMode('preview')
      } else {
        // Clean up any previous deferred subscription
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
    } else {
      logger.warn('devServer', `Polling finished but server no longer active (${attempts} attempts, ${Date.now() - start}ms)`)
    }
  }

  /**
   * Detect whether the running server is a backend API via HTTP probe.
   * Only called when no serverTypeHint was provided (callers should use
   * detectProjectCategory before start() to set the hint when possible).
   * The user can always toggle manually via the toolbar button.
   */
  private async detectServerType(url: string): Promise<'server' | 'api'> {
    try {
      const result = await invoke<{
        status: number
        headers: [string, string][]
        body: string
      }>('http_client_request', {
        input: {
          method: 'GET',
          url,
          headers: {},
          body: null,
          timeoutSecs: 5,
        },
      })

      const contentType = (
        result.headers?.find(([k]) => k.toLowerCase() === 'content-type')?.[1] || ''
      ).toLowerCase()

      if (contentType.includes('json')) {
        return 'api'
      }

      return 'server'
    } catch {
      return 'server'
    }
  }

  private handleExit(pid: number): void {
    console.warn(`[dev-server] EXIT event received: pid=${pid}, currentPid=${this.currentServer?.pid}, status=${this.currentServer?.status}`)
    if (!this.currentServer) return
    if (this.currentServer.pid !== 0 && this.currentServer.pid !== pid) return

    const wasRunning = this.currentServer.status === 'running'
    const wasStarting = this.currentServer.status === 'starting'
    console.warn(`[dev-server] Server exited: wasRunning=${wasRunning}, wasStarting=${wasStarting}`)
    this.currentServer.status = 'stopped'
    this.currentServer = null
    this.cleanup()

    const layoutStore = useLayoutStore.getState()
    if (wasStarting) {
      layoutStore.addDevServerLog('Dev server exited before becoming ready. Check your dev command and dependencies.', 'error')
      layoutStore.clearPreviewServer()
    } else if (wasRunning) {
      layoutStore.addDevServerLog('Dev server stopped', 'warn')
      layoutStore.clearPreviewServer()
    }
  }

  async stop(): Promise<void> {
    const server = this.currentServer
    // Bump generation so any in-flight invoke return kills its process
    this.generation++
    this.currentServer = null
    this.cleanup()

    if (server?.pid) {
      try {
        await invoke('kill_process', { pid: server.pid })
      } catch {
        // Process may have already exited
      }
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

  async restart(): Promise<void> {
    if (!this.currentServer) return
    const { projectPath, command } = this.currentServer
    // Preserve server type across restart by deriving from current port
    const hint = this.serverPort === BACKEND_SERVER_PORT ? 'backend' as const : undefined
    await this.stop()
    await this.start(projectPath, command, hint)
  }

  getUrl(): string | null {
    return this.currentServer?.url || null
  }

  getProjectPath(): string | null {
    return this.currentServer?.projectPath || null
  }

  /** Server is accepting connections. */
  isRunning(): boolean {
    return this.currentServer?.status === 'running'
  }

  /** Server exists (starting or running) — guards against double-start. */
  isActive(): boolean {
    return this.currentServer !== null
  }
}

export const devServerManager = DevServerManager.getInstance()
