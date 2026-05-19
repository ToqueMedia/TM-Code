import { invoke } from '@/utils/invokeMetrics'
import MCPService, { type MCPServerConfig } from './mcp/mcpService'
import { useMcpStore } from '../stores/mcpStore'
import { useLayoutStore, type ViewMode } from '../stores/layoutStore'
import { ensureTestBrowser } from './e2eService'
import { logger } from '../utils/logger'

/**
 * On-demand lifecycle for the agent's headless browser session.
 *
 * Start strategy: lazy. The slash command `/te2e` (or any other entry that
 * needs browser tools) calls `start()`. If already running, we just reset
 * the idle timer.
 *
 * Stop strategy: idle timeout. Every `touch()` (called from the agent's MCP
 * tool dispatch wrapper) resets a 5-minute timer. When the timer fires, we
 * stop the underlying server. This bounds the always-on cost without
 * forcing a cold start between consecutive agent turns in the same session.
 *
 * Why not always-on: the underlying engine spawns Chrome (~300MB RAM).
 * Always-on is hostile to laptops on battery and to fresh app launches.
 *
 * Why not stop-after-each-call: agents tend to do `navigate → snapshot →
 * click → snapshot → …`, and each turn flushes back to the model. Cold
 * starting between every two seconds of activity would dominate latency.
 */

export const BROWSER_SERVER_NAME = 'browser'
const IDLE_TIMEOUT_MS = 5 * 60 * 1000
// Pin the upstream package — using `latest` would let a breaking change
// upstream silently break the feature for every TM Code user at once.
// Bump intentionally when the upstream stabilises new tools we rely on.
const MCP_PACKAGE_SPEC = '@playwright/mcp@0.0.41'

/**
 * Browser session config:
 *   - `userDataDir` makes the Chrome profile persistent across runs so the
 *     user only has to sign into the app once. The first `/te2e` opens
 *     Chrome at the login screen; once they sign in there, the session is
 *     remembered for every subsequent run. Lives in the IDE's data dir,
 *     not the user's real Chrome profile, so testing never disturbs their
 *     personal browsing state.
 *   - `headless: false` makes the agent's Chrome visible — exploratory
 *     validation is a UX where the user wants to see what's happening,
 *     and the user needs a visible window to perform that one-time login.
 *   - `chromiumSandbox: true` overrides the upstream default that triggers
 *     the "--no-sandbox unsupported flag" yellow bar on desktop.
 *
 * Config path is filled in at boot since we need the home dir at runtime.
 */
function buildConfigJson(userDataDir: string): string {
  return JSON.stringify({
    browser: {
      type: 'chromium',
      userDataDir,
      launchOptions: {
        channel: 'chrome',
        chromiumSandbox: true,
        headless: false,
      },
    },
  }, null, 2)
}

class BrowserSessionManager {
  private static instance: BrowserSessionManager
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private startPromise: Promise<void> | null = null
  private sessionActive = false
  private viewModeBeforeSession: ViewMode | null = null
  private configPath: string | null = null
  private userDataDir: string | null = null
  private shutdownInstalled = false

  static getInstance(): BrowserSessionManager {
    if (!BrowserSessionManager.instance) {
      BrowserSessionManager.instance = new BrowserSessionManager()
      BrowserSessionManager.instance.installShutdownHook()
    }
    return BrowserSessionManager.instance
  }

  /**
   * Best-effort shutdown so the spawned MCP server (and the Chrome process
   * it owns) doesn't outlive the IDE. `beforeunload` fires when the Tauri
   * webview is asked to close — synchronously enough that our stop request
   * gets sent. Without this hook the process leaks until the OS reaps it
   * (Mac/Linux) or stays around indefinitely (Windows).
   */
  private installShutdownHook(): void {
    if (this.shutdownInstalled || typeof window === 'undefined') return
    this.shutdownInstalled = true
    window.addEventListener('beforeunload', () => {
      // Fire-and-forget — beforeunload doesn't await promises, but the
      // mcp_stop_server invoke fires off a kill on the Rust side.
      void this.stop().catch(() => { /* noop on shutdown */ })
    })
  }

  isRunning(): boolean {
    const server = useMcpStore.getState().servers.find(s => s.name === BROWSER_SERVER_NAME)
    return server?.status === 'running'
  }

  isSessionActive(): boolean {
    return this.sessionActive
  }

  /**
   * Mark the start of a browser-driven turn. Idempotent within a session.
   * Closes the preview pane (the user's app + the agent's headless Chrome
   * race the same dev server URL — running both produces confusing UI),
   * remembers the previous view mode so we can restore on session end.
   *
   * Safe to call from a tool execute path: dynamic import avoids dragging
   * a React component into the agent service module graph at parse time.
   */
  async beginSession(): Promise<void> {
    if (this.sessionActive) return
    this.sessionActive = true
    const layout = useLayoutStore.getState()
    this.viewModeBeforeSession = layout.viewMode
    if (layout.viewMode === 'preview') {
      const { closePreviewWebview } = await import('../components/ui/TauriWebview')
      closePreviewWebview()
      layout.setViewMode('chat')
    }
  }

  /**
   * Mark the end of a browser-driven turn. Restores the user to whatever
   * view they were on (typically `preview`) so they can resume inspecting
   * their app the moment the agent stops driving the browser.
   */
  endSession(): void {
    if (!this.sessionActive) return
    this.sessionActive = false
    const restoreTo = this.viewModeBeforeSession
    this.viewModeBeforeSession = null
    if (restoreTo && restoreTo !== useLayoutStore.getState().viewMode) {
      useLayoutStore.getState().setViewMode(restoreTo)
    }
  }

  /**
   * Idempotent on-demand start. Concurrent callers share the same boot.
   * Resets the idle timer regardless of whether we spawned or reused.
   */
  async start(): Promise<void> {
    if (this.isRunning()) {
      this.resetIdle()
      return
    }
    if (this.startPromise) {
      await this.startPromise
      this.resetIdle()
      return
    }
    this.startPromise = this.boot()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
    this.resetIdle()
  }

  private async boot(): Promise<void> {
    // Gate the spawn behind browser detection — without a Chromium-based
    // browser, the MCP server crashes on first navigate. The dialog gives
    // the user a path forward; if they cancel, we abort cleanly.
    const browser = await ensureTestBrowser()
    if (!browser) {
      throw new Error('No Chromium-based browser available. Install Chrome and retry.')
    }

    const configPath = await this.ensureConfigFile()
    // Wipe orphaned Chrome lock files. These remain when the IDE crashed
    // or was force-killed mid-session; without removal the next launch
    // fails with a cryptic "profile in use" error and the user has no
    // recovery path. Safe to do unconditionally because the IDE owns this
    // profile dir exclusively — we never share with the user's real
    // Chrome installation.
    await this.cleanupOrphanProfileLocks()

    const serverConfig: MCPServerConfig = {
      command: 'npx',
      args: ['-y', MCP_PACKAGE_SPEC, '--config', configPath],
      transport: 'stdio',
    }

    const mcp = MCPService.getInstance()
    try {
      await mcp.startServer(BROWSER_SERVER_NAME, serverConfig)
      logger.info('browser-session', `Browser session up (using ${browser.name})`)
    } catch (err) {
      logger.error('browser-session', 'Failed to start browser session', err)
      throw err
    }
  }

  private async cleanupOrphanProfileLocks(): Promise<void> {
    if (!this.userDataDir) return
    const lockNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket']
    for (const name of lockNames) {
      const path = `${this.userDataDir}/${name}`
      try {
        // delete_file is idempotent — non-existent files don't error in our
        // wrapper. Failing to delete (e.g. permission issues) is logged but
        // not fatal: Chrome will surface its own message if the lock survives.
        await invoke('delete_file', { path })
      } catch {
        // Non-existent file → success path, ignore.
      }
    }
  }

  private async ensureConfigFile(): Promise<string> {
    if (this.configPath) return this.configPath
    const home = await invoke<string>('get_home_directory')
    const root = `${home}/.toquemedia-studio`
    const userDataDir = `${root}/browser-profile`
    // Both dirs are idempotent — create_directories_all is a no-op if they
    // already exist. The profile dir survives between sessions so cookies
    // and login state persist.
    await invoke('create_directories_all', { path: root }).catch(() => {})
    await invoke('create_directories_all', { path: userDataDir }).catch(() => {})
    const path = `${root}/browser-session.json`
    await invoke('write_file', { path, content: buildConfigJson(userDataDir) })
    this.configPath = path
    this.userDataDir = userDataDir
    return path
  }

  /**
   * Wraps an MCP `callTool` function so that any call routed to the
   * browser server resets the idle timer. Pass-through for everything
   * else. Plug this in at the call sites where `toolExecutor.registerMCPTools`
   * is configured.
   */
  wrapCallTool<F extends (serverName: string, toolName: string, args: Record<string, unknown>) => Promise<string>>(
    originalFn: F,
  ): F {
    const self = this
    return (async (serverName: string, toolName: string, args: Record<string, unknown>) => {
      if (serverName === BROWSER_SERVER_NAME) {
        self.touch()
      }
      return originalFn(serverName, toolName, args)
    }) as F
  }

  /**
   * Reset the idle countdown. Called from the agent's MCP dispatch wrapper
   * on every browser tool call so the server stays alive while
   * the agent is actively using it.
   */
  touch(): void {
    if (!this.isRunning()) return
    this.resetIdle()
  }

  private resetIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      void this.stop().catch(err =>
        logger.warn('browser-session', 'Idle stop failed', err),
      )
    }, IDLE_TIMEOUT_MS)
  }

  async stop(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (!this.isRunning()) return
    try {
      await MCPService.getInstance().stopServer(BROWSER_SERVER_NAME)
      logger.info('browser-session', 'Browser session stopped')
    } catch (err) {
      logger.warn('browser-session', 'Stop failed', err)
    }
  }
}

export const browserSession = BrowserSessionManager.getInstance()
