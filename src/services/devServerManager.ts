import { invoke } from '@tauri-apps/api/core'
import { listen, UnlistenFn } from '@tauri-apps/api/event'
import { useLayoutStore, type ProjectKind } from '../stores/layoutStore'
import { useChatStore } from '../stores/chatStore'
import { logger } from '../utils/logger'
import {
  URL_REGEX_GLOBAL,
  PORT_REGEX,
  PORT_FAILURE_REGEX,
  resolveIsWrapper,
  classifyProbedUrl,
  type ProbeKind,
} from './devServerDetection'

/**
 * Preferred host in preview URLs.
 *
 * Uses "localhost" on ALL platforms:
 *  - macOS: WKWebView grants ATS exemption only for that hostname.
 *  - Windows: WebView2 (Chromium-based) uses Happy Eyeballs to try BOTH IPv4
 *    and IPv6, so "localhost" works whether the dev server binds to ::1,
 *    127.0.0.1, or both. Pinning 127.0.0.1 broke preview when Vite bound
 *    IPv6-only (default when the user's script lacks --host 0.0.0.0 and the
 *    top-level command is a wrapper that swallows TM Code's injection).
 *  - Linux: both work.
 */
const PREFERRED_HOST = 'localhost'

type InternalStatus = 'starting' | 'running' | 'stopped' | 'error'

interface InternalSlot {
  pid: number
  projectKind: ProjectKind
  projectPath: string
  command: string
  status: InternalStatus
  /** Bumped on every start/stop; guards stale invoke/poll returns. */
  generation: number
  /** Optional hint for the classifier: when content-type probe is ambiguous,
   *  treat a URL on this port as frontend. The model passes this on
   *  `start_dev_server` only when the natural content-type detection is
   *  unreliable for the project's setup. Most projects don't need it. */
  frontendPortHint?: number
  /** URLs seen in the stream (deduped). We probe each one and classify. */
  detectedUrls: Set<string>
  /** URLs already assigned to frontend or backend slot — skip re-classifying. */
  classifiedUrls: Set<string>
  frontendUrl: string | null
  backendUrl: string | null
  /** True when backendUrl was set by mirroring frontendUrl (monolithic fullstack
   *  best-guess). A later distinct JSON URL can still replace it. False means
   *  backendUrl came from a real JSON probe and should not be overwritten. */
  backendUrlMirrored: boolean
  eaddrinuseRetried: boolean
  /** One-shot flag: set after the first cross-origin "Script error. (:0)" hint
   *  is emitted to the console. Prevents the helper text from repeating on
   *  every popup retry attempt during the same dev-server slot. */
  scriptErrorHintShown: boolean
}

/** Options for starting a dev server. The model picks ports naturally
 *  (Vite=5173, Next=3000, Express=whatever) — the IDE detects URLs from
 *  log output and classifies them by content-type. Pass `frontendPortHint`
 *  only when the content-type probe is ambiguous and you need to force
 *  the iframe target to a specific port. */
export interface StartOptions {
  projectKind?: ProjectKind
  /** Optional override for ambiguous fullstack content-type probes. When
   *  set, a probed URL on this port is treated as frontend regardless of
   *  what the server returned. Most projects do not need it. */
  frontendPortHint?: number
}

interface DevServerOutputPayload {
  pid: number
  stream: string
  data: string
}

interface ServerProbeResult {
  ok: boolean
  content_type: string | null
  kind: 'html' | 'json' | 'other' | null
}

const READY_TIMEOUT = 15_000
const READY_POLL_INTERVAL = 500

/**
 * Read the project's package.json once and produce a synchronous script
 * lookup function for the detection layer. Caches per-projectPath so a user
 * editing package.json mid-session picks up changes on next `start()`.
 *
 * Returns an always-empty lookup on any failure (missing file, permission,
 * malformed JSON) — `resolveIsWrapper` falls back to string-only detection.
 */
async function buildScriptLookup(projectPath: string): Promise<(name: string) => string | null> {
  try {
    const pkgPath = `${projectPath}${projectPath.includes('\\') ? '\\' : '/'}package.json`
    const content = await invoke<string>('read_file', { path: pkgPath })
    const pkg = JSON.parse(content)
    const scripts: Record<string, string> = pkg?.scripts ?? {}
    return (name: string) => (typeof scripts[name] === 'string' ? scripts[name] : null)
  } catch {
    return () => null
  }
}

/**
 * Resolve whether `command` effectively runs a fullstack wrapper. Handles the
 * common case where the top-level command is `npm run dev` but the `dev`
 * script internally uses concurrently — AND the deeper case where `dev` calls
 * another script that wraps. Follows up to 3 levels of script indirection
 * (guards against circular scripts).
 */
async function isFullstackWrapper(command: string, projectPath: string): Promise<boolean> {
  const lookup = await buildScriptLookup(projectPath)
  return resolveIsWrapper(command, lookup)
}

class DevServerManager {
  private static instance: DevServerManager
  private server: InternalSlot | null = null
  private unlistenOutput: UnlistenFn | null = null
  private unlistenExit: UnlistenFn | null = null
  private unsubPreviewDefer: (() => void) | null = null

  static getInstance(): DevServerManager {
    if (!DevServerManager.instance) {
      DevServerManager.instance = new DevServerManager()
    }
    return DevServerManager.instance
  }

  /**
   * Inject `--host 0.0.0.0` for frontend dev servers on platforms where it
   * matters. Critical on Windows: Node 18+ resolves "localhost" to IPv6
   * `::1`, so Vite/Next without explicit host bind only to `[::1]` and the
   * Tauri preview webview (IPv4) can't reach them.
   *
   * Port is NOT injected — the model's command stands as-written. The IDE
   * detects whatever URL the server prints and classifies by content-type.
   *
   * Wrappers (concurrently, npm-run-all, turbo, pnpm -r, workspaces fanout)
   * swallow injected flags as their own args, so we don't inject for them.
   */
  private injectHost(command: string, projectKind: ProjectKind, isWrapper: boolean): string {
    if (projectKind === 'backend') return command
    if (isWrapper) return command

    if (/^(npm|yarn|pnpm|bun)\s+(run\s+\w+|start|dev)\b/.test(command)) {
      return `${command} -- --host 0.0.0.0`
    }
    if (/^(npx\s+)?(ng\s+serve|next\s+dev|vite|nuxt\s+dev|astro\s+dev|svelte-kit\s+dev)\b/.test(command)) {
      return `${command} --host 0.0.0.0`
    }
    return command
  }

  private normalizeUrl(url: string): string {
    // Rewrite to the platform's preferred host (see PREFERRED_HOST comment).
    const target = `://${PREFERRED_HOST}`
    let normalized = url
      .replace('://localhost', target)
      .replace('://0.0.0.0', target)
      .replace('://[::1]', target)
      .replace('://[::1:]', target)
      .replace('://[0:0:0:0:0:0:0:1]', target)
      .replace('://127.0.0.1', target)
    if (!normalized.endsWith('/')) normalized += '/'
    return normalized
  }

  async start(projectPath: string, devCommand: string, options: StartOptions | ProjectKind = {}): Promise<void> {
    // Back-compat: allow positional ProjectKind (older call sites).
    const opts: StartOptions = typeof options === 'string' ? { projectKind: options } : options
    const projectKind: ProjectKind = opts.projectKind ?? 'frontend'
    const frontendPortHint = opts.frontendPortHint

    // One server per project. Stop any existing before launching.
    // Stop() cleanly tears down the previous slot; no preemptive kill_port —
    // we don't know which ports the server will choose. If a zombie blocks
    // a port from a previous TM Code crash, the dev server itself surfaces
    // EADDRINUSE in the log and the user can act on it.
    await this.stop()

    // Resolve wrapper status NOW (may inspect package.json asynchronously).
    const isWrapper = await isFullstackWrapper(devCommand, projectPath)
    const resolvedCommand = this.injectHost(devCommand, projectKind, isWrapper)

    const slot: InternalSlot = {
      pid: 0,
      projectKind,
      projectPath,
      command: devCommand,
      status: 'starting',
      generation: Date.now() + Math.random(),
      frontendPortHint,
      detectedUrls: new Set(),
      classifiedUrls: new Set(),
      frontendUrl: null,
      backendUrl: null,
      backendUrlMirrored: false,
      eaddrinuseRetried: false,
      scriptErrorHintShown: false,
    }
    this.server = slot

    useLayoutStore.getState().initDevServer({ pid: 0, projectKind })

    await this.ensureListeners()

    try {
      // Pass `skipPortEnv: true` for ALL commands now — the model picks the
      // port via its own command (Vite default 5173, Next 3000, etc.). The
      // Rust side won't override with a fixed PORT env. `port` is unused
      // when skipPortEnv is true but kept for API back-compat.
      const pid = await invoke<number>('start_dev_server', {
        command: resolvedCommand,
        cwd: projectPath,
        port: 0,
        skipPortEnv: true,
      })

      if (this.server !== slot || slot.generation !== this.server.generation) {
        try { await invoke('kill_process', { pid }) } catch {}
        return
      }

      slot.pid = pid
      // Update store with real PID now that we have it.
      useLayoutStore.setState(state =>
        state.devServer ? { devServer: { ...state.devServer, pid } } : {}
      )
      console.warn(`[dev-server] STARTED: kind=${projectKind}, PID=${pid}, command="${resolvedCommand}"`)
      logger.info('devServer', `Started ${projectKind} server (PID ${pid}): ${devCommand}`)
    } catch (error) {
      if (this.server === slot) {
        this.server = null
        useLayoutStore.getState().clearDevServer()
        this.cleanup()
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
    const slot = this.server
    if (!slot) return
    // Demux by PID; during startup (pid=0) accept output from the single slot.
    if (slot.pid !== 0 && slot.pid !== payload.pid) return

    const lines = payload.data.split('\n')
    const toLog: Array<{ text: string; level: 'info' | 'warn' | 'error' }> = []
    const layoutStore = useLayoutStore.getState()

    for (const line of lines) {
      if (line.trim()) {
        const isWarn = /\bwarn(ing)?\b/i.test(line) || /\bnpm warn\b/i.test(line)
        const isError = !isWarn && (
          /\berror\b/i.test(line)
          || /\bERR[!_]/i.test(line)
          || /\bfailed\b/i.test(line)
          || /\bEADDRINUSE\b/.test(line)
        )
        const level: 'info' | 'warn' | 'error' = isError ? 'error' : isWarn ? 'warn' : 'info'
        toLog.push({ text: line, level })

        if (/Cannot find module.*rollup|Error:.*optional dependencies/i.test(line)) {
          toLog.push({
            text: 'Fix: Run "rm -rf node_modules package-lock.json && npm install" in the terminal to reinstall dependencies for this platform.',
            level: 'error',
          })
        }

        // Cross-origin "Script error" — opaque error masked by the browser
        // when a popup window's script throws. Most common signature for
        // OAuth popup flows (Firebase signInWithPopup, googleapis OAuth
        // window) running inside the embedded TauriWebview, where
        // `window.opener` is null and `postMessage` cross-origin breaks.
        // The error itself carries no detail (`(:0)` line number is the
        // cross-origin masking signature). Surface a one-shot hint so the
        // user knows to test in their default browser instead. Throttled per
        // server slot to avoid spamming the console with the same hint on
        // every popup attempt.
        if (/\[runtime\]\s+Script error\.\s+\(:0\)/.test(line) && !slot.scriptErrorHintShown) {
          slot.scriptErrorHintShown = true
          toLog.push({
            text: 'Hint: "Script error. (:0)" with no detail usually means a popup or third-party script crashed cross-origin (common with Firebase signInWithPopup / OAuth popups inside the embedded preview). Test this flow in your default browser via "Open in browser" — the popup will work there.',
            level: 'warn',
          })
        }
      }

      // EADDRINUSE auto-recovery — once per slot.
      const eaddrinuse = line.match(/EADDRINUSE.*(?:port|address)[:\s]*(\d+)/i)
        || line.match(/EADDRINUSE.*:::(\d+)/i)
        || line.match(/address already in use\s+(?:::)?(\d+)/i)
      if (eaddrinuse && !slot.eaddrinuseRetried) {
        const blockedPort = parseInt(eaddrinuse[1], 10)
        if (blockedPort > 0) {
          slot.eaddrinuseRetried = true
          const { projectPath, command, projectKind } = slot
          toLog.push({ text: `Port ${blockedPort} in use — killing and restarting...`, level: 'warn' })
          if (toLog.length > 0) layoutStore.addDevServerLogs(toLog)
          this.stop().then(async () => {
            try { await invoke('kill_port', { port: blockedPort }) } catch {}
            await new Promise(r => setTimeout(r, 500))
            await this.start(projectPath, command, projectKind).catch(() => {})
          })
          return
        }
      }

      // URL detection — skip entirely for failure lines (EADDRINUSE, retrying).
      if (!PORT_FAILURE_REGEX.test(line)) {
        const matches = line.match(URL_REGEX_GLOBAL)
        if (matches) {
          for (const raw of matches) {
            const url = this.normalizeUrl(raw)
            if (!slot.detectedUrls.has(url)) {
              slot.detectedUrls.add(url)
              this.probeAndClassify(url, slot)
            }
          }
        } else {
          const portMatch = line.match(PORT_REGEX)
          if (portMatch) {
            const url = this.normalizeUrl(`http://localhost:${portMatch[1]}`)
            if (!slot.detectedUrls.has(url)) {
              slot.detectedUrls.add(url)
              this.probeAndClassify(url, slot)
            }
          }
        }
      }
    }

    if (toLog.length > 0) layoutStore.addDevServerLogs(toLog)
  }

  /**
   * Probe a detected URL and classify it as frontend (HTML) or backend (JSON/
   * other) based on Content-Type. Assigns to the correct slot field and
   * emits a log line so the user sees the classification.
   *
   * For monolithic fullstack (single URL serving both HTML and API), the URL
   * classifies as 'html' and goes to frontendUrl; backendUrl also gets the
   * same URL so the HTTP Client drawer has a baseUrl.
   */
  private async probeAndClassify(url: string, slot: InternalSlot): Promise<void> {
    const gen = slot.generation
    const start = Date.now()
    let probe: ServerProbeResult | null = null
    let ipcErrors = 0
    const MAX_IPC_ERRORS = 5
    const layoutStore = useLayoutStore.getState()

    while (Date.now() - start < READY_TIMEOUT) {
      if (this.server !== slot || slot.generation !== gen) return
      try {
        probe = await invoke<ServerProbeResult>('probe_server', { url })
        if (probe.ok) break
        ipcErrors = 0  // reset on any successful IPC call
      } catch {
        ipcErrors++
        if (ipcErrors >= MAX_IPC_ERRORS) {
          logger.warn('devServer', `probe_server IPC failed ${ipcErrors}× for ${url}, giving up`)
          break
        }
      }
      await new Promise(r => setTimeout(r, READY_POLL_INTERVAL))
    }

    if (!probe || !probe.ok) {
      // Timed out without the server responding — don't promote the URL.
      // Another URL (or a later log line) may still succeed.
      if (this.server === slot && slot.frontendUrl === null && slot.backendUrl === null) {
        layoutStore.setPreviewServerTimedOut(true)
      }
      return
    }

    if (this.server !== slot || slot.generation !== gen) return
    if (slot.classifiedUrls.has(url)) return
    slot.classifiedUrls.add(url)

    const kind = probe.kind || 'other'
    const kindLabel = kind === 'html' ? 'frontend' : kind === 'json' ? 'backend' : 'generic'
    layoutStore.addDevServerLog(`Server ready at ${url} (${kindLabel}, ${probe.content_type ?? '?'})`, 'info')

    // Delegate to the pure classifier — content-type drives, hint overrides.
    const actions = classifyProbedUrl(
      url,
      kind as ProbeKind,
      {
        projectKind: slot.projectKind,
        frontendUrl: slot.frontendUrl,
        backendUrl: slot.backendUrl,
        backendUrlMirrored: slot.backendUrlMirrored,
      },
      slot.frontendPortHint,
    )
    for (const action of actions) {
      if (action.type === 'assignFrontend') {
        slot.frontendUrl = action.url
        layoutStore.setDevServerFrontendUrl(action.url)
      } else if (action.type === 'assignBackend') {
        slot.backendUrl = action.url
        slot.backendUrlMirrored = action.mirrored
        layoutStore.setDevServerBackendUrl(action.url)
      }
    }

    slot.status = 'running'

    // Auto-switch to preview view once the first URL lands.
    const shouldSwitch = !useChatStore.getState().isStreaming
    if (shouldSwitch) {
      layoutStore.setViewMode('preview')
    } else if (!this.unsubPreviewDefer) {
      const unsub = useChatStore.subscribe((state, prev) => {
        if (prev.isStreaming && !state.isStreaming) {
          unsub()
          this.unsubPreviewDefer = null
          useLayoutStore.getState().setViewMode('preview')
        }
      })
      this.unsubPreviewDefer = unsub
    }
  }

  private handleExit(pid: number): void {
    const slot = this.server
    if (!slot || slot.pid !== pid) return

    const wasRunning = slot.status === 'running'
    const wasStarting = slot.status === 'starting'
    const kind = slot.projectKind
    console.warn(`[dev-server] EXIT: kind=${kind}, pid=${pid}, wasRunning=${wasRunning}, wasStarting=${wasStarting}`)
    slot.status = 'stopped'
    this.server = null

    const layoutStore = useLayoutStore.getState()
    if (wasStarting) {
      layoutStore.addDevServerLog(`Dev server exited before becoming ready. Check your dev command and dependencies.`, 'error')
    } else if (wasRunning) {
      layoutStore.addDevServerLog(`Dev server stopped`, 'warn')
    }
    layoutStore.clearDevServer()
    this.cleanup()
  }

  async stop(): Promise<void> {
    const slot = this.server
    if (!slot) return

    slot.generation = Date.now() + Math.random()
    const pid = slot.pid
    // Use the actually-detected URLs to derive ports for the post-stop
    // safety kill (handles Windows cmd.exe → concurrently → npm → node
    // chains where tree-kill sometimes loses descendants). If no URL was
    // ever detected, there's nothing to clean up at the port level.
    const portsToClean: number[] = []
    for (const url of [slot.frontendUrl, slot.backendUrl]) {
      if (!url) continue
      const m = url.match(/:(\d+)/)
      if (m) {
        const p = parseInt(m[1], 10)
        if (p && !portsToClean.includes(p)) portsToClean.push(p)
      }
    }
    this.server = null

    // Kill the concurrently-parent tree.
    if (pid) {
      try { await invoke('kill_process', { pid }) } catch { /* may already be dead */ }
    }
    // Backup path: force-kill anything still bound to the ports the server
    // actually used. On Windows the cmd.exe → concurrently → npm → node
    // chain sometimes loses descendants to tree-kill (taskkill /T). This
    // guarantees nothing is left listening on those ports after Stop.
    await Promise.all(
      portsToClean.map(port =>
        invoke<boolean>('kill_port', { port }).catch(() => false)
      )
    )

    this.cleanup()
    useLayoutStore.getState().clearDevServer()
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
    const slot = this.server
    if (!slot) return
    // Preserve frontendPortHint across restart — it's a deliberate user
    // override for content-type ambiguity, dropping it on restart would
    // re-trigger the bug the hint was set to fix.
    const { projectPath, command, projectKind, frontendPortHint } = slot
    await this.stop()
    await this.start(projectPath, command, { projectKind, frontendPortHint })
  }

  /** Best-guess URL for external openers (system browser). */
  getUrl(): string | null {
    return this.server?.frontendUrl ?? this.server?.backendUrl ?? null
  }

  getProjectPath(): string | null {
    return this.server?.projectPath ?? null
  }

  isRunning(): boolean {
    return this.server?.status === 'running'
  }

  isActive(): boolean {
    return !!this.server
  }
}

export const devServerManager = DevServerManager.getInstance()
