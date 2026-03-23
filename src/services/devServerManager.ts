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

// URL patterns emitted by common dev servers
const URL_REGEX = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?/
const PORT_REGEX = /(?:listening on|running at|port)\s+(\d{4,5})/i

/** Port used for project dev servers — avoids conflict with the IDE's own Vite (5173). */
const DEV_SERVER_PORT = 7773

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

  static getInstance(): DevServerManager {
    if (!DevServerManager.instance) {
      DevServerManager.instance = new DevServerManager()
    }
    return DevServerManager.instance
  }

  /**
   * Inject --port into the command so the dev server binds to our chosen port.
   * Works with npm/yarn/pnpm run (via -- separator) and direct CLI invocations.
   */
  private injectPort(command: string): string {
    const port = DEV_SERVER_PORT
    // In Docker mode, dev servers must bind to 0.0.0.0 (not localhost)
    // for the port mapping to work from the host.
    const hostFlag = isContainerActive() ? ' --host 0.0.0.0' : ''
    // npm run dev / yarn run dev / pnpm run dev → append "-- --port PORT [--host]"
    if (/^(npm|yarn|pnpm)\s+run\s+/.test(command)) {
      return `${command} -- --port ${port}${hostFlag}`
    }
    // npm start / yarn start → PORT env var is set on the Rust side
    return command
  }

  /** Ensure URL uses 127.0.0.1 (not localhost) and ends with trailing slash. */
  private normalizeUrl(url: string): string {
    // Force IPv4 — Colima only binds forwarded ports to 127.0.0.1, not ::1.
    // WKWebView resolves "localhost" to ::1 first and doesn't fall back to IPv4.
    let normalized = url.replace('localhost', '127.0.0.1')
    // Ensure trailing slash
    if (!normalized.endsWith('/')) normalized += '/'
    return normalized
  }

  async start(projectPath: string, devCommand: string): Promise<void> {
    // Stop any existing server first
    await this.stop()

    // Kill any process occupying our port before starting.
    // Skip in Docker mode — the port is owned by Colima's SSH forwarding.
    // Orphaned dev servers inside the container are cleaned by fuser in start_dev_server.
    if (!isContainerActive()) {
      try {
        await invoke('kill_port', { port: DEV_SERVER_PORT })
      } catch {
        // Ignore — port may already be free
      }
    }

    const gen = ++this.generation

    const resolvedCommand = this.injectPort(devCommand)

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
      })

      // If stop() or another start() was called while we awaited invoke,
      // the generation has changed — kill the orphaned process.
      if (gen !== this.generation || !this.currentServer) {
        try { await invoke('kill_process', { pid }) } catch {}
        return
      }

      this.currentServer.pid = pid
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

    // Classify line level for the console panel
    const isError = payload.stream === 'stderr'
      || /\berror\b/i.test(line)
      || /\bERR[!_]/i.test(line)
    const isWarn = !isError && /\bwarn(ing)?\b/i.test(line)
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

    // Register the preview server URL so it's available
    if (gen === this.generation && this.currentServer) {
      layoutStore.setPreviewServer(url, this.currentServer.pid)
      logger.info('devServer', `Preview server registered: ${url}`)

      // Only auto-switch to preview if the agent isn't actively streaming.
      if (!useChatStore.getState().isStreaming) {
        layoutStore.setViewMode('preview')
      }
    } else {
      logger.warn('devServer', `Polling finished but server no longer active (${attempts} attempts, ${Date.now() - start}ms)`)
    }
  }

  private handleExit(pid: number): void {
    if (!this.currentServer) return
    // Same PID-0 tolerance as handleOutput
    if (this.currentServer.pid !== 0 && this.currentServer.pid !== pid) return

    const wasRunning = this.currentServer.status === 'running'
    const wasStarting = this.currentServer.status === 'starting'
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
  }

  async restart(): Promise<void> {
    if (!this.currentServer) return
    const { projectPath, command } = this.currentServer
    await this.stop()
    await this.start(projectPath, command)
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
