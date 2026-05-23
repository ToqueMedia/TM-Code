import { invoke } from '@/utils/invokeMetrics'
import { listen, UnlistenFn } from '@tauri-apps/api/event'
import { useLayoutStore, type ProjectKind } from '../stores/layoutStore'
import { useChatStore } from '../stores/chatStore'
import { useAgentStore } from '../stores/agentStore'
import { logger } from '../utils/logger'
import {
  URL_REGEX_GLOBAL,
  PORT_REGEX,
  PORT_FAILURE_REGEX,
  resolveIsWrapper,
  classifyProbedUrl,
  detectLineRole,
  type LineRoleHint,
  type ProbeKind,
} from './devServerDetection'
import { coalesceLogLines } from './devServerLogCoalesce'

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
  eaddrinuseRetries: number
  /** One-shot flag: set after the first cross-origin "Script error. (:0)" hint
   *  is emitted to the console. Prevents the helper text from repeating on
   *  every popup retry attempt during the same dev-server slot. */
  scriptErrorHintShown: boolean
  /** One-shot flag for the GIS-popup-blocked hint (mirrors scriptErrorHintShown).
   *  GIS retries the popup on every button click — without throttling, the
   *  user gets a wall of identical hints in the log panel. */
  gsiPopupHintShown: boolean
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
  status: number
  /** True iff status is 2xx AND content-type is HTML. False for error pages,
   *  JSON responses, and unreachable servers. The classifier uses this as the
   *  ground-truth signal for "real frontend page" — content-type alone is
   *  ambiguous because Express's default 404 page is text/html too. */
  usable_as_frontend: boolean
  content_type: string | null
  kind: 'html' | 'json' | 'other' | null
}

const READY_TIMEOUT = 15_000
const READY_POLL_INTERVAL = 500
/**
 * Once the server is reachable but the first response is HTML-error (4xx/5xx
 * text/html), keep polling for this long to see if it stabilises to 2xx HTML.
 * Vite cold-starts can briefly serve a 503 overlay; we don't want to mis-
 * classify that as a backend URL. Three seconds is more than enough for the
 * typical Vite/Next boot transition and well under the hard READY_TIMEOUT.
 */
const PROBE_STABILIZATION_MS = 3_000

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
    await this.stop()

    // Preemptive port cleanup for known framework defaults.
    // If a zombie process from a previous TM Code crash (or another app)
    // holds a well-known port, kill it before the dev server tries to bind.
    // This avoids the EADDRINUSE → retry → restart cycle for the common case.
    const knownPorts = this.guessFrameworkPorts(devCommand)
    if (knownPorts.length > 0) {
      await Promise.allSettled(knownPorts.map(p => invoke('kill_port', { port: p })))
    }

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
      eaddrinuseRetries: 0,
      scriptErrorHintShown: false,
      gsiPopupHintShown: false,
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
    const layoutStore = useLayoutStore.getState()

    // ── Pass 1: per-line side-effects ──
    // URL detection, EADDRINUSE auto-recovery, Script-error hint. These run
    // per RAW line because the regex shapes were designed for that, and a
    // URL/EADDRINUSE/Script-error signal can live inside what later becomes
    // a multi-line block (e.g. a stack trace ending in "EADDRINUSE :::3001").
    // Synthetic hints are pushed to `synthetics` and appended after the
    // coalesced entries so they don't pollute block boundaries.
    const synthetics: Array<{ text: string; level: 'info' | 'warn' | 'error' }> = []

    for (const line of lines) {
      if (!line.trim()) continue

      if (/Cannot find module.*rollup|Error:.*optional dependencies/i.test(line)) {
        synthetics.push({
          text: 'Fix: Run "rm -rf node_modules package-lock.json && npm install" in the terminal to reinstall dependencies for this platform.',
          level: 'error',
        })
      }

      // Cross-origin "Script error" — opaque error masked by the browser
      // when a popup window's script throws. Most common signature for
      // OAuth popup flows running inside the embedded TauriWebview.
      // One-shot per slot to avoid spamming on every popup retry.
      if (/\[runtime\]\s+Script error\.\s+\(:0\)/.test(line) && !slot.scriptErrorHintShown) {
        slot.scriptErrorHintShown = true
        synthetics.push({
          text: 'Hint: "Script error. (:0)" with no detail usually means a popup or third-party script crashed cross-origin (common with auth/OAuth popups inside the embedded preview). Test this flow in your default browser via "Open in browser" — the popup will work there.',
          level: 'warn',
        })
      }

      // Google Identity Services popup blocked. The GIS button approach
      // is supposed to render the credential picker inline (FedCM), but
      // when FedCM is not available it falls back to a popup, which the
      // Tauri WebView2/WKWebView blocks. Same fix as the Script-error
      // hint: test in a real browser. Throttled per slot to avoid spam.
      if (/\[GSI_LOGGER\]:\s*Failed to open popup window/i.test(line) && !slot.gsiPopupHintShown) {
        slot.gsiPopupHintShown = true
        synthetics.push({
          text: 'Hint: "[GSI_LOGGER]: Failed to open popup window" means the Google Identity Services library tried to open a popup but the IDE preview webview blocked it. The GIS button falls back to popup when FedCM is unavailable (which it usually is inside the embedded preview). Test Google sign-in via "Open in browser" — popups work in your default browser. This is not a bug in your code; the auth flow is fine for production deploys.',
          level: 'warn',
        })
      }

      // EADDRINUSE auto-recovery — up to 2 retries per slot.
      const eaddrinuse = line.match(/EADDRINUSE.*(?:port|address)[:\s]*(\d+)/i)
        || line.match(/EADDRINUSE.*:::(\d+)/i)
        || line.match(/EADDRINUSE.*:(\d+)/i)
        || line.match(/address already in use\s+(?:::)?(\d+)/i)
        || line.match(/listen\s+EADDRINUSE\s+\S+:(\d+)/i)
      const MAX_EADDRINUSE_RETRIES = 2
      if (eaddrinuse && slot.eaddrinuseRetries < MAX_EADDRINUSE_RETRIES) {
        const blockedPort = parseInt(eaddrinuse[1], 10)
        if (blockedPort > 0) {
          slot.eaddrinuseRetries++
          const { projectPath, command, projectKind } = slot
          // Flush whatever we have collected so far before the restart so
          // the user sees the EADDRINUSE line and the recovery message.
          const coalescedSoFar = coalesceLogLines(lines).map((e) => ({ text: e.text, level: e.level }))
          coalescedSoFar.push({
            text: `Port ${blockedPort} in use — killing and restarting (attempt ${slot.eaddrinuseRetries}/${MAX_EADDRINUSE_RETRIES})...`,
            level: 'warn',
          })
          if (coalescedSoFar.length > 0) layoutStore.addDevServerLogs(coalescedSoFar)
          this.stop().then(async () => {
            try { await invoke('kill_port', { port: blockedPort }) } catch {}
            await new Promise(r => setTimeout(r, 800))
            await this.start(projectPath, command, projectKind).catch(() => {})
          })
          return
        }
      }

      // URL detection — skip entirely for failure lines (EADDRINUSE, retrying).
      if (!PORT_FAILURE_REGEX.test(line)) {
        const lineRole = detectLineRole(line)
        const matches = line.match(URL_REGEX_GLOBAL)
        if (matches) {
          for (const raw of matches) {
            const url = this.normalizeUrl(raw)
            if (lineRole !== null) {
              this.probeAndClassify(url, slot, lineRole)
            } else if (!slot.detectedUrls.has(url)) {
              slot.detectedUrls.add(url)
              this.probeAndClassify(url, slot)
            }
          }
        } else {
          const portMatch = line.match(PORT_REGEX)
          if (portMatch) {
            const url = this.normalizeUrl(`http://localhost:${portMatch[1]}`)
            if (lineRole !== null) {
              this.probeAndClassify(url, slot, lineRole)
            } else if (!slot.detectedUrls.has(url)) {
              slot.detectedUrls.add(url)
              this.probeAndClassify(url, slot)
            }
          }
        }
      }
    }

    // ── Pass 2: coalesce raw lines into multi-line blocks ──
    // Without coalescing, a single `console.log({...})` from the user's app
    // becomes N separate DevServerLogEntry rows in the UI, and the per-row
    // "send to agent" button only ships one fragment. coalesceLogLines
    // groups indented / bracket-balanced continuations into ONE entry so
    // the whole object travels together.
    const coalesced = coalesceLogLines(lines).map((e) => ({ text: e.text, level: e.level }))
    const toLog = [...coalesced, ...synthetics]
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
  private async probeAndClassify(url: string, slot: InternalSlot, lineRoleHint?: LineRoleHint): Promise<void> {
    const gen = slot.generation
    const start = Date.now()
    let probe: ServerProbeResult | null = null
    let ipcErrors = 0
    const MAX_IPC_ERRORS = 5
    const layoutStore = useLayoutStore.getState()

    // Two-phase probe.
    // Phase 1 — reachability: poll until probe.ok (any HTTP response received).
    // Phase 2 — stabilisation: if the first usable response is HTML-error
    //           (4xx/5xx text/html — Vite's overlay during HMR boot, or
    //           Express returning its default 404 page), keep polling for a
    //           short window to see if it settles to 2xx HTML. The dev server
    //           we care about (Vite/Next) typically goes 503→200 within a
    //           second of boot. The wrong answer here is the regression the
    //           previous design had: classify on the first probe and never
    //           look again, which assigned Express's 404 HTML to frontendUrl.
    let stabilizingSince: number | null = null
    while (Date.now() - start < READY_TIMEOUT) {
      if (this.server !== slot || slot.generation !== gen) return
      try {
        const next = await invoke<ServerProbeResult>('probe_server', { url })
        ipcErrors = 0
        if (next.ok) {
          probe = next
          if (next.usable_as_frontend || next.kind !== 'other') {
            // Either a real frontend page or a definitive backend response —
            // both are stable signals, classify on this result.
            break
          }
          // Got an HTML error response. Give the server a settle window before
          // accepting "kind=other" as final — it may transition to 2xx HTML.
          if (stabilizingSince === null) stabilizingSince = Date.now()
          if (Date.now() - stabilizingSince > PROBE_STABILIZATION_MS) break
        }
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
    // Re-classification policy:
    //   - With a line-role hint: always allowed (hint carries strong signal).
    //   - Without a hint: allowed only when the previous classification was
    //     based on a non-usable HTML response (an error page that won the
    //     slot in error). The probe stabilisation phase above should usually
    //     prevent this, but the guard is here as defense-in-depth: if a
    //     URL was classified during a brief HMR error window and the server
    //     later recovers, we want to re-evaluate.
    const previouslyClassified = slot.classifiedUrls.has(url)
    if (previouslyClassified && !lineRoleHint && slot.frontendUrl !== null) {
      return
    }
    slot.classifiedUrls.add(url)

    const kind = probe.kind || 'other'
    const kindLabel = kind === 'html' ? 'frontend' : kind === 'json' ? 'backend' : 'generic'
    const roleSuffix = lineRoleHint ? `, role=${lineRoleHint}` : ''
    layoutStore.addDevServerLog(`Server ready at ${url} (${kindLabel}, ${probe.content_type ?? '?'}${roleSuffix})`, 'info')

    // Delegate to the pure classifier — line role > port hint > content-type.
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
      lineRoleHint ?? null,
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
    //
    // Gate on agent status NOT being 'error' — when a turn ends with an
    // upstream 5xx / network drop, the chat indicator drops isStreaming back
    // to false but the work the user asked for never landed. The auto-switch
    // used to fire anyway and open the preview, misleading the user into
    // thinking the agent had finished successfully. With this gate, the
    // preview stays out of the way and the error banner / system message
    // remain the dominant signal.
    const isStreaming = useChatStore.getState().isStreaming
    const agentErrored = useAgentStore.getState().status === 'error'
    if (!isStreaming && !agentErrored) {
      layoutStore.setViewMode('preview')
    } else if (!this.unsubPreviewDefer) {
      const unsub = useChatStore.subscribe((state, prev) => {
        if (prev.isStreaming && !state.isStreaming) {
          unsub()
          this.unsubPreviewDefer = null
          // Re-check the agent status at the moment streaming actually
          // ends — a 5xx mid-stream can flip isStreaming→false while
          // agentStore.status='error', and we don't want the deferred
          // subscriber to leak the user to preview after that race.
          if (useAgentStore.getState().status !== 'error') {
            useLayoutStore.getState().setViewMode('preview')
          }
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

    // Best-effort port cleanup on exit — prevents zombie processes from
    // blocking the port if the process tree wasn't fully killed.
    const portsToClean: number[] = []
    for (const url of [slot.frontendUrl, slot.backendUrl]) {
      if (!url) continue
      const m = url.match(/:(\d+)/)
      if (m) {
        const p = parseInt(m[1], 10)
        if (p && !portsToClean.includes(p)) portsToClean.push(p)
      }
    }
    // Also clean known framework ports if no URL was detected yet (server
    // crashed before becoming ready).
    if (portsToClean.length === 0) {
      portsToClean.push(...this.guessFrameworkPorts(slot.command))
    }
    for (const port of portsToClean) {
      invoke('kill_port', { port }).catch(() => {})
    }

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

  /** Guess the default ports a framework will bind to based on the dev
   *  command string. Returns an empty array when no known framework is
   *  detected — the caller should fall back to EADDRINUSE recovery. */
  private guessFrameworkPorts(devCommand: string): number[] {
    const cmd = devCommand.toLowerCase()
    const ports: number[] = []

    // Next.js → 3000
    if (cmd.includes('next dev') || cmd.includes('next start')) ports.push(3000)
    // Nuxt → 3000
    if (cmd.includes('nuxt dev') || cmd.includes('nuxi dev')) ports.push(3000)
    // Angular → 4200
    if (cmd.includes('ng serve')) ports.push(4200)
    // Vite → 5173 (most common default)
    if (cmd.includes('vite') && !cmd.includes('next') && !cmd.includes('nuxt')) ports.push(5173)
    // Astro → 4321
    if (cmd.includes('astro dev')) ports.push(4321)
    // NOTE: Express/Fastify/NestJS use port 3000 by default, but we do NOT
    // preemptively kill that port — it's too common and could terminate
    // unrelated services. EADDRINUSE recovery handles this case instead.

    // If the command is a wrapper like "npm run dev", check package.json
    // for the underlying framework. This is async so we can't do it here,
    // but the EADDRINUSE retry will catch it as a fallback.

    // Deduplicate
    return [...new Set(ports)]
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
