import { invoke } from '@tauri-apps/api/core'
import { listen, UnlistenFn } from '@tauri-apps/api/event'
import { useChatStore } from '../stores/chatStore'
import { useLayoutStore } from '../stores/layoutStore'
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
const URL_REGEX = /https?:\/\/localhost:\d+\/?/
const PORT_REGEX = /(?:listening on|running at|port)\s+(\d{4,5})/i

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

  async start(projectPath: string, devCommand: string): Promise<void> {
    // Stop any existing server first
    await this.stop()

    const gen = ++this.generation

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
        command: devCommand,
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

    // Detect URL in output
    let detectedUrl: string | null = null

    const urlMatch = payload.data.match(URL_REGEX)
    const portMatch = payload.data.match(PORT_REGEX)

    if (urlMatch) {
      detectedUrl = urlMatch[0]
    } else if (portMatch) {
      detectedUrl = `http://localhost:${portMatch[1]}`
    }

    if (detectedUrl && !this.currentServer.url) {
      // First URL detection — server is ready
      this.currentServer.url = detectedUrl
      this.currentServer.status = 'running'

      const chatStore = useChatStore.getState()
      const layoutStore = useLayoutStore.getState()

      chatStore.addSystemMessage(`Dev server running at ${detectedUrl}`)

      // Transition to preview
      layoutStore.setPreviewServer(detectedUrl, this.currentServer.pid)
      layoutStore.setViewMode('preview')
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
      const chatStore = useChatStore.getState()
      chatStore.addSystemMessage('Dev server stopped')
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

  isRunning(): boolean {
    return this.currentServer?.status === 'running'
  }
}

export const devServerManager = DevServerManager.getInstance()
