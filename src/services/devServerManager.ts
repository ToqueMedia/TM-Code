import { invoke } from '@tauri-apps/api/core'
import { listen, UnlistenFn } from '@tauri-apps/api/event'
import { useLayoutStore } from '../stores/layoutStore'
import { useChatStore } from '../stores/chatStore'
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
const DEV_SERVER_PORT = 5174

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
    // npm run dev / yarn run dev / pnpm run dev → append "-- --port PORT"
    if (/^(npm|yarn|pnpm)\s+run\s+/.test(command)) {
      return `${command} -- --port ${port}`
    }
    // npm start / yarn start → PORT env var is set on the Rust side
    return command
  }

  /** Ensure URL ends with trailing slash (required by some servers). */
  private normalizeUrl(url: string): string {
    // Normalise host to localhost
    let normalized = url.replace('127.0.0.1', 'localhost')
    // Ensure trailing slash
    if (!normalized.endsWith('/')) normalized += '/'
    return normalized
  }

  async start(projectPath: string, devCommand: string): Promise<void> {
    // Stop any existing server first
    await this.stop()

    const gen = ++this.generation

    const resolvedCommand = this.injectPort(devCommand)

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

    // Detect URL in output
    let detectedUrl: string | null = null

    const urlMatch = line.match(URL_REGEX)
    const portMatch = line.match(PORT_REGEX)

    if (urlMatch) {
      detectedUrl = urlMatch[0]
    } else if (portMatch) {
      detectedUrl = `http://localhost:${portMatch[1]}`
    }

    if (detectedUrl && !this.currentServer.url) {
      const url = this.normalizeUrl(detectedUrl)
      this.currentServer.url = url
      this.currentServer.status = 'running'

      layoutStore.addDevServerLog(`Server ready at ${url}`, 'info')

      // Poll until the server actually accepts connections, then show preview
      this.waitForServerReady(url)
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
    const start = Date.now()

    while (Date.now() - start < READY_TIMEOUT) {
      // If server was stopped/restarted while polling, bail out
      if (gen !== this.generation || !this.currentServer) return

      try {
        // no-cors: succeeds if TCP connection accepted, throws if refused
        await fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' })
        // If we reach here, the server is accepting connections
        break
      } catch {
        // Connection refused — server not ready yet, keep polling
      }

      await new Promise(r => setTimeout(r, READY_POLL_INTERVAL))
    }

    // Register the preview server URL so it's available
    if (gen === this.generation && this.currentServer) {
      const layoutStore = useLayoutStore.getState()
      layoutStore.setPreviewServer(url, this.currentServer.pid)

      // Only auto-switch to preview if the agent isn't actively streaming.
      // When the agent finishes (onDone), usePromptBar already handles the
      // transition to preview mode, so we don't lose the user's context.
      if (!useChatStore.getState().isStreaming) {
        layoutStore.setViewMode('preview')
      }
    }
  }

  private handleExit(pid: number): void {
    if (!this.currentServer) return
    // Same PID-0 tolerance as handleOutput
    if (this.currentServer.pid !== 0 && this.currentServer.pid !== pid) return

    const wasRunning = this.currentServer.status === 'running'
    this.currentServer.status = 'stopped'
    this.currentServer = null
    this.cleanup()

    if (wasRunning) {
      useLayoutStore.getState().addDevServerLog('Dev server stopped', 'warn')
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
