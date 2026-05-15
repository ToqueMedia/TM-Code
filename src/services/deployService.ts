/**
 * Deploy service — orchestrates the multi-phase deploy against the backend.
 *
 * The backend was split into phase endpoints to escape Cloudflare's per-
 * request CPU budget. This service walks them in order, chunks the asset
 * upload into sub-10MB batches, and reports progress to deployStore between
 * calls.
 *
 *   1. init      → reserves slug, mints GIP tenant, optional D1 + migrations
 *   2. upload    → R2 file batches (called N times, parallel-safe)
 *   3. finalize  → Firestore deployment record
 *
 * The v1 Hono Worker phase was removed in Phase 0 of PLAN-DEPLOY-V2. v2
 * backend strategies (workers-container, cf-ssr) plug in alongside upload
 * via their own strategy modules.
 *
 * Failure handling:
 *   - On any step failure we POST /v1/projects/deploy/cleanup to drop any
 *     R2 files we already wrote, before surfacing the error. Best-effort.
 *   - The deployStore phase flips to 'error' with the message; the modal's
 *     ErrorStep offers Retry which restarts from init.
 */
import { invoke } from '@tauri-apps/api/core'
import FirebaseAuthService from './auth/firebaseAuth'
import { resolveDeployUrl } from '../utils/devUrls'
import { useDeployStore, type DeployStep } from '../stores/deployStore'
import { detectFromProjectPath } from './deploy/runtimeDetector'
import { loadDeployPlan, saveDeployPlan, type StaticSpaPlan, type CompositePlan } from './deploy/deployPlan'
import { ensureSupported } from './deploy/planNarrow'

function frontendOutputDir(plan: StaticSpaPlan | CompositePlan): string {
  if (plan.kind === 'static-spa') return plan.outputDir
  return plan.frontend.kind === 'static-spa' ? plan.frontend.outputDir : plan.frontend.assetsDir
}

interface DeployBundleFile {
  path: string
  content: string
  encoding: 'utf8' | 'base64'
}

interface DeployBundle {
  files: DeployBundleFile[]
  has_database: boolean
  has_api_routes: boolean
  migration_sql?: string
}

interface AuthConfig {
  apiKey: string
  authDomain: string
  projectId: string
  tenantId: string
}

interface InitResponse {
  slug: string
  authConfig: AuthConfig
  databaseId: string | null
  databaseName: string | null
  warnings: string[]
}

interface FinalizeResponse {
  serviceUrl: string
  provider: string
}

export interface DeployOptions {
  projectId: string
  projectName: string
  customSubdomain?: string
  userPlan?: string
}

export interface DomainRecord {
  type: string
  name: string
  value: string
}

export interface DomainStatusResponse {
  success: boolean
  hostname?: string
  status?: string
  sslStatus?: string
  cnameTarget?: string
  sslVerificationRecord?: DomainRecord
  trafficRecord?: DomainRecord
  ownershipVerificationRecord?: DomainRecord
  error?: string
}

// ── Lifecycle types (mirrors toquemedia-studio-api/src/deploysLifecycle.ts) ──
export type DeployStatus = 'active' | 'suspended' | 'archived'

export interface DeploysSummaryResponse {
  plan: string
  quota: number
  activeCount: number
  isReDeploy: boolean
  overQuota: boolean
  existingSlug: string | null
}

export interface DeploysListItem {
  projectId: string
  slug: string
  serviceUrl: string
  status: DeployStatus
  customDomain: string | null
  lastDeployedAt: string | null
  suspendedAt: string | null
  /** Days remaining before auto-archive. Only set when status==='suspended'. */
  daysUntilArchive: number | null
}

export interface DeploymentSummary {
  exists: boolean
  projectId: string
  slug?: string
  serviceUrl?: string
  provider?: string
  customDomain?: string
  domainStatus?: string
  sslStatus?: string
  cnameTarget?: string
  sslVerificationRecord?: DomainRecord
  trafficRecord?: DomainRecord
  lastDeployedAt?: string
}

// ── Tunables ──────────────────────────────────────────────
//
// Per-batch payload cap for the upload phase. The backend's per-request size
// limit is 12MB; we stay under that with margin for JSON envelope + base64
// inflation. Files larger than this individually still go in their own batch
// (handled below) but a >12MB single asset will fail at the backend size guard.
const UPLOAD_BATCH_BYTES = 8 * 1024 * 1024 // 8 MB
// Max files per batch — caps per-call CPU even when payloads are tiny
// (e.g. hundreds of small JS chunks).
const UPLOAD_BATCH_FILES = 50
// Concurrency for upload batches. Workers handle parallel R2 puts well; this
// just bounds how many concurrent backend requests we make.
const UPLOAD_BATCH_CONCURRENCY = 3

class DeployService {
  /** Run a full deploy. Reports progress via deployStore; resolves with the
   *  final service URL or throws with a user-facing error message. */
  async deploy(projectPath: string, opts: DeployOptions): Promise<string> {
    const store = useDeployStore.getState()
    store.startDeploy(opts.projectId)

    let needsCleanup = false
    let initResult: InitResponse | null = null

    try {
      // ── Phase 0: resolve DeployPlan ────────────────────────
      // Prefer the persisted plan from `.toquemedia-deploy.json`; fall back
      // to live detection. The plan is saved at the end of a successful
      // deploy so subsequent runs skip detection entirely.
      const plan = await this.resolvePlan(projectPath)

      // Force-refresh: deploy is user-initiated and rare. The 1h Firebase
      // ID-token lifetime + intermittent auto-refresh failures (when App
      // Check enforcement on Identity Toolkit blocks the refresh path)
      // produced 401s on summary/init that read as "Invalid token" on the
      // worker. A single fresh fetch here keeps the entire deploy flow on
      // one valid token.
      const idToken = await FirebaseAuthService.getInstance().getIdToken(true)
      if (!idToken) throw new Error('Not signed in to TM Code. Sign in and retry.')

      // Step plan up-front so the modal can render a stable progress bar.
      // 1: build, 2: init, 3..N: assets batches, N+1: finalize. Batches
      // counted after the build runs (Phase 1 below).
      let stepIdx = 0
      let totalSteps = 0
      const reportStep = (name: string, status: DeployStep['status'], detail?: string) => {
        store.updateProgress(opts.projectId, {
          step: stepIdx,
          totalSteps,
          stepName: name,
          status,
          detail,
        })
      }

      // ── Phase 1: build ────────────────────────────────────
      // Auto-run the project's build script before bundling. Honours the
      // "one-click deploy" promise — users shouldn't have to babysit the
      // terminal to publish.
      totalSteps = 3 // initial estimate: build + init + finalize. Bumped after batchify.
      stepIdx++
      reportStep('build', 'in_progress')
      await this.runBuild(projectPath)
      reportStep('build', 'complete')

      // ── Phase 2: bundle ───────────────────────────────────
      const isComposite = plan.kind === 'composite'
      const outputDir = frontendOutputDir(plan)
      const bundle = await invoke<DeployBundle>('collect_deploy_bundle', {
        projectPath,
        outputDir,
      })
      if (bundle.files.length === 0) {
        throw new Error('The build ran but produced no output. Check the build script.')
      }

      const staticFileCount = bundle.files.filter(
        (f) => !f.path.startsWith('standalone/'),
      ).length
      const batches = this.batchify(bundle.files)
      // build + init + N batches + (composite: container/build + container/deploy) + finalize
      const compositeSteps = isComposite ? 2 : 0
      totalSteps = 1 + 1 + batches.length + compositeSteps + 1

      // ── Phase 3: init ─────────────────────────────────────
      stepIdx++
      reportStep('init', 'in_progress')
      initResult = await this.callPhase<InitResponse>('init', idToken, {
        projectId: opts.projectId,
        projectName: opts.projectName,
        customSubdomain: opts.customSubdomain,
        hasDatabase: bundle.has_database,
        hasApiRoutes: bundle.has_api_routes,
        migrationSql: bundle.migration_sql,
        schemaFileContent: bundle.files.find(
          (f) => f.path === 'src/lib/schema.ts' || f.path.endsWith('/schema.ts'),
        )?.content,
      })
      // From this point any failure means we may have written R2 prefix entries
      // or pushed a worker — flag for cleanup.
      needsCleanup = true
      for (const w of initResult.warnings) store.addWarning(opts.projectId, w)
      reportStep('init', 'complete', `Subdomain: ${initResult.slug}`)

      // ── Phase 4: assets (chunked, parallelized) ───────────
      const isFreeTier = !opts.userPlan || opts.userPlan === 'explorer'
      let uploadedSoFar = 0
      await this.runBatchesWithLimit(batches, UPLOAD_BATCH_CONCURRENCY, async (batch, i) => {
        // Step index increments per batch start so the bar moves smoothly even
        // when batches resolve out of order.
        const myStep = ++stepIdx
        store.updateProgress(opts.projectId, {
          step: myStep,
          totalSteps,
          stepName: 'assets',
          status: 'in_progress',
          detail: `batch ${i + 1}/${batches.length}`,
        })
        await this.callPhase<{ uploaded: number }>('upload', idToken, {
          projectId: opts.projectId,
          slug: initResult!.slug,
          authConfig: initResult!.authConfig,
          files: batch,
          isFreeTier,
        })
        uploadedSoFar += batch.length
        store.updateProgress(opts.projectId, {
          step: myStep,
          totalSteps,
          stepName: 'assets',
          status: 'complete',
          detail: `${uploadedSoFar}/${staticFileCount} files`,
        })
      })

      // ── Phase 4.5: backend (composite only) ───────────────
      // Tar up server-side files, ship to the container/build endpoint
      // (Cloud Build picks it up from GCS), then ask container/deploy to
      // provision the Cloud Run service. The Worker proxies /api/* to
      // the resulting service URL — frontend keeps using same-origin paths.
      if (isComposite) {
        stepIdx++
        reportStep('container/build', 'in_progress', 'preparing source')
        const sourceTarballBase64 = await invoke<string>('collect_backend_tarball', {
          projectPath,
        })
        store.updateProgress(opts.projectId, {
          step: stepIdx,
          totalSteps,
          stepName: 'container/build',
          status: 'in_progress',
          detail: 'uploading source to cloud build',
        })
        const trigger = await this.callPhase<{
          buildId: string
          imageRef: string
          region: string
          sourceObjectName: string
        }>('container/build', idToken, {
          projectId: opts.projectId,
          slug: initResult.slug,
          sourceTarballBase64,
        })

        // Poll the build status every ~3s, updating `detail` with the
        // current step from Cloud Build so the progress bar reads
        // "Step X of N: <name>". Stops when `done` is true; failure
        // surfaces as a thrown error consumed by the outer try/catch.
        const buildStatus = await this.pollContainerBuild(
          opts.projectId,
          trigger.buildId,
          trigger.region,
          trigger.sourceObjectName,
          idToken,
          (detail) => {
            store.updateProgress(opts.projectId, {
              step: stepIdx,
              totalSteps,
              stepName: 'container/build',
              status: 'in_progress',
              detail,
            })
          },
        )
        if (buildStatus.status !== 'SUCCESS') {
          throw new Error(
            `Backend build ${buildStatus.status.toLowerCase()}: ${buildStatus.failureMessage ?? 'something went wrong while building your backend'}` +
              (buildStatus.logUrl ? ` (details: ${buildStatus.logUrl})` : ''),
          )
        }
        reportStep('container/build', 'complete', `image: ${trigger.buildId.slice(0, 8)}…`)

        stepIdx++
        reportStep('container/deploy', 'in_progress', 'starting service')
        // Read .env so we can pass the runtime vars (GIP_*, APP_ID, etc.)
        // through to the Cloud Run service.
        const envVars = await this.readBackendEnvVars(projectPath)
        const deployRes = await this.callPhase<{ serviceUrl: string }>(
          'container/deploy',
          idToken,
          {
            projectId: opts.projectId,
            slug: initResult.slug,
            imageRef: trigger.imageRef,
            envVars,
          },
        )

        // Health-check gate. Cloud Run's revision can be `Ready=True`
        // before the container actually serves traffic, and a crashlooping
        // container will surface as "deploy successful" otherwise. Probe
        // the service URL with a short ceiling — if it never responds 2xx
        // or 3xx, fail the deploy with the real error rather than letting
        // the user click into a 503.
        store.updateProgress(opts.projectId, {
          step: stepIdx,
          totalSteps,
          stepName: 'container/deploy',
          status: 'in_progress',
          detail: 'waiting for backend to come online',
        })
        await this.waitForBackendReady(deployRes.serviceUrl)
        reportStep('container/deploy', 'complete', deployRes.serviceUrl)
      }

      // ── Phase 5: finalize ─────────────────────────────────
      stepIdx++
      reportStep('finalize', 'in_progress')
      const finalize = await this.callPhase<FinalizeResponse>('finalize', idToken, {
        projectId: opts.projectId,
        slug: initResult.slug,
        databaseId: initResult.databaseId,
        databaseName: initResult.databaseName,
      })
      reportStep('finalize', 'complete', finalize.serviceUrl)

      store.completeDeploy(opts.projectId, {
        serviceUrl: finalize.serviceUrl,
        provider: finalize.provider,
        databaseId: initResult.databaseId,
      })
      // Persist the resolved plan so the next deploy skips detection.
      // Best-effort: a failed write doesn't undo the successful deploy.
      saveDeployPlan(projectPath, plan).catch(() => {})
      // Past the point of needing cleanup — the deploy succeeded.
      needsCleanup = false
      return finalize.serviceUrl
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      store.failDeploy(opts.projectId, message)
      if (needsCleanup) {
        // Best-effort: orphaned R2 files cost storage. Cleanup is fire-and-forget;
        // failures here are logged but never surfaced to the caller.
        this.callCleanup(opts.projectId).catch(() => {})
      }
      throw new Error(message)
    }
  }

  /**
   * Run the project's build script in-process and surface failures to the
   * caller with the last lines of build output. Honours the "one-click
   * deploy" promise — Publish shouldn't require the user to babysit the
   * terminal.
   *
   * Package manager comes from the lockfile (yarn / pnpm / bun / npm).
   * yarn 1.x and pnpm accept the bare script name; npm and bun need `run`.
   */
  /**
   * Read .env and pick out the keys the Cloud Run runtime needs. We don't
   * forward the whole file — VITE_* keys belong to the frontend build,
   * and forwarding them all would surface anything the user pasted in.
   *
   * The selected prefixes / exact matches mirror what the
   * publish-backend skill + provision_deploy + provision_auth
   * write. Firestore auth uses the runtime SA — no Firestore-specific
   * tokens or credentials live in .env.
   */
  private async readBackendEnvVars(projectPath: string): Promise<Array<{ name: string; value: string }>> {
    let raw: string
    try {
      raw = await invoke<string>('read_file', { path: `${projectPath}/.env` })
    } catch {
      return []
    }
    // The auth-proxy skill names `TM_AUTH_KEY` / `TM_TENANT_ID` / `TM_PROJECT_ID`
    // as the canonical names the server reads, with `GIP_*` / `GCP_*` kept as
    // legacy mirrors. Without `TM_` here, fresh projects following the current
    // skill see their server crash at startup with "Variáveis de ambiente em
    // falta: TM_AUTH_KEY, …" because Cloud Run only got the legacy mirrors.
    const SERVER_PREFIXES = ['TM_', 'GIP_', 'GCP_']
    const SERVER_EXACT = new Set(['PORT', 'APP_ID'])
    const out: Array<{ name: string; value: string }> = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      // Strip surrounding quotes if present (dotenv tolerates them).
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      const matchesPrefix = SERVER_PREFIXES.some((p) => key.startsWith(p))
      if (matchesPrefix || SERVER_EXACT.has(key)) {
        out.push({ name: key, value })
      }
    }
    return out
  }

  private async runBuild(projectPath: string): Promise<void> {
    // Confirm a build script exists before spending a subprocess on it.
    let scripts: Record<string, string> | null = null
    try {
      const raw = await invoke<string>('read_file', { path: `${projectPath}/package.json` })
      const parsed = JSON.parse(raw)
      scripts = (parsed?.scripts && typeof parsed.scripts === 'object')
        ? (parsed.scripts as Record<string, string>)
        : null
    } catch {
      throw new Error("Couldn't read package.json — is this a valid Node project?")
    }
    if (!scripts || !scripts.build) {
      throw new Error('Add a `build` script to package.json before publishing.')
    }

    // Pick a package manager from the lockfile. Default to npm.
    const lockChecks: Array<[string, 'yarn' | 'pnpm' | 'bun' | 'npm']> = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['bun.lockb', 'bun'],
      ['yarn.lock', 'yarn'],
      ['package-lock.json', 'npm'],
    ]
    let pm: 'yarn' | 'pnpm' | 'bun' | 'npm' = 'npm'
    for (const [file, candidate] of lockChecks) {
      try {
        await invoke<string>('read_file', { path: `${projectPath}/${file}` })
        pm = candidate
        break
      } catch {
        // not present, try next
      }
    }
    const command = pm === 'yarn' || pm === 'pnpm' ? `${pm} build` : `${pm} run build`

    type CommandResult = {
      stdout: string
      stderr: string
      exitCode: number
      success: boolean
      timedOut: boolean
    }
    const result = await invoke<CommandResult>('execute_command', {
      command,
      cwd: projectPath,
      timeoutSecs: 600,
    })

    if (!result.success || result.exitCode !== 0) {
      // Surface the tail of whichever stream actually has content. Builds
      // typically write errors to stderr (Vite/ESBuild), but some tools
      // (older Webpack, raw tsc) print failures to stdout.
      const errOut = (result.stderr || result.stdout || 'unknown error')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .slice(-12)
        .join('\n')
      throw new Error(`Build failed (\`${command}\`):\n\n${errOut}`)
    }
  }

  /**
   * Resolve which DeployPlan to use for this run:
   *  1. Honour `.toquemedia-deploy.json` if present.
   *  2. Otherwise run the detector. Accept static-spa or composite for
   *     Phase 1; surface a precise error otherwise.
   */
  private async resolvePlan(projectPath: string): Promise<StaticSpaPlan | CompositePlan> {
    const persisted = await loadDeployPlan(projectPath)
    if (persisted) return ensureSupported(persisted)

    const result = await detectFromProjectPath(projectPath)
    if (!result.plan) {
      throw new Error(
        `${result.reason}\n\nPublish supports static frontend projects (React / Vue / Svelte with Vite, Astro, Angular) and fullstack projects. For fullstack apps, ask TM Code to prepare your project for publishing first.`,
      )
    }
    if (!result.phase1Supported) {
      throw new Error(
        `${result.reason}\n\nFor fullstack projects, ask TM Code to prepare your project for publishing first — it will set up the data layer and the build pipeline for you.`,
      )
    }
    return ensureSupported(result.plan)
  }

  // ── Batching helpers ────────────────────────────────────

  private batchify(files: DeployBundleFile[]): DeployBundleFile[][] {
    const staticFiles = files.filter((f) => !f.path.startsWith('standalone/'))
    if (staticFiles.length === 0) return []

    const batches: DeployBundleFile[][] = []
    let current: DeployBundleFile[] = []
    let currentBytes = 0

    for (const file of staticFiles) {
      const fileBytes = file.content.length
      const wouldExceed =
        current.length >= UPLOAD_BATCH_FILES ||
        (currentBytes > 0 && currentBytes + fileBytes > UPLOAD_BATCH_BYTES)
      if (wouldExceed) {
        batches.push(current)
        current = []
        currentBytes = 0
      }
      current.push(file)
      currentBytes += fileBytes
    }
    if (current.length > 0) batches.push(current)
    return batches
  }

  private async runBatchesWithLimit<T>(
    batches: T[],
    concurrency: number,
    handler: (item: T, index: number) => Promise<void>,
  ): Promise<void> {
    let idx = 0
    const workers = Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
      while (true) {
        const myIdx = idx++
        if (myIdx >= batches.length) return
        await handler(batches[myIdx], myIdx)
      }
    })
    await Promise.all(workers)
  }

  // ── Build status polling ─────────────────────────────────

  /**
   * Poll container/build-status every 3s until Cloud Build reaches a
   * terminal state. Calls `onProgress` with a "Step X of N: <name>"
   * label each tick so the modal's progress bar stays live during the
   * 2-8 minute build window. Returns the final status snapshot.
   *
   * Race protection: captures the deployStore's attemptId at start; if
   * a newer deploy of the same projectId bumps the counter, the poll
   * exits silently (throwing an AbortError-style signal the caller can
   * recognise). This stops a zombie loop from a previous deploy from
   * writing stale progress over the new one.
   */
  private async pollContainerBuild(
    projectId: string,
    buildId: string,
    region: string,
    sourceObjectName: string,
    idToken: string,
    onProgress: (detail: string) => void,
  ): Promise<{
    status: string
    failureMessage?: string
    logUrl?: string
  }> {
    const POLL_INTERVAL_MS = 3_000
    const MAX_DURATION_MS = 15 * 60_000 // 15 minutes — slightly past Cloud Build's 600s timeout
    const startedAt = Date.now()
    let lastDetail = ''

    const store = useDeployStore.getState()
    const myAttempt = store.getRecord(projectId).attemptId

    while (true) {
      if (Date.now() - startedAt > MAX_DURATION_MS) {
        throw new Error('Backend build is taking longer than expected (15 min ceiling). Try again or contact support if this persists.')
      }
      // Bail if a newer deploy attempt has started or if the user cleared
      // the deploy state. Cloud Build keeps running on GCP — that's fine,
      // we just stop spamming the store.
      const currentAttempt = useDeployStore.getState().getRecord(projectId).attemptId
      if (currentAttempt !== myAttempt) {
        throw new Error('Deploy superseded by a newer attempt')
      }

      const status = await this.callPhase<{
        status: string
        currentStepIndex: number
        totalSteps: number
        currentStepName: string
        failureMessage?: string
        logUrl?: string
        done: boolean
      }>('container/build-status', idToken, {
        projectId,
        buildId,
        region,
        sourceObjectName,
      })

      const detail =
        status.status === 'SUCCESS'
          ? 'build complete'
          : `step ${Math.min(status.currentStepIndex + 1, status.totalSteps)} of ${status.totalSteps}: ${status.currentStepName}`
      if (detail !== lastDetail) {
        onProgress(detail)
        lastDetail = detail
      }

      if (status.done) {
        return {
          status: status.status,
          failureMessage: status.failureMessage,
          logUrl: status.logUrl,
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
  }

  // ── Backend health probe ──────────────────────────────────

  /**
   * After Cloud Run provisions the revision, probe the service URL until
   * it responds with anything other than a 5xx / connection error. A
   * crashlooping container returns 5xx; cold-start latency on the first
   * request can take a few seconds — so we retry with a short ceiling
   * (45s) and short interval (2s).
   *
   * We don't require a /health endpoint: the user's framework might 404
   * on `/` but that's a 404, not a 5xx, and means the container IS
   * serving. 5xx and network failures are the only signals that the
   * container isn't up.
   */
  private async waitForBackendReady(serviceUrl: string): Promise<void> {
    const PROBE_INTERVAL_MS = 2_000
    const MAX_DURATION_MS = 45_000
    const startedAt = Date.now()
    let lastError = ''

    while (Date.now() - startedAt < MAX_DURATION_MS) {
      try {
        const res = await fetch(serviceUrl, { method: 'GET' })
        if (res.status < 500) return
        lastError = `HTTP ${res.status}`
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
      await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS))
    }
    throw new Error(
      `Your backend didn't come online within 45s (last error: ${lastError}). ` +
        `Common causes: missing env vars, wrong PORT binding, or runtime errors at boot. ` +
        `Check the deploy logs in Settings → Deploys for details.`,
    )
  }

  // ── Phase invocation ─────────────────────────────────────

  private async callPhase<T>(
    phase:
      | 'init'
      | 'upload'
      | 'worker'
      | 'finalize'
      | 'container/build'
      | 'container/build-status'
      | 'container/deploy',
    idToken: string,
    body: unknown,
  ): Promise<T> {
    const workerUrl = resolveDeployUrl()
    const url = `${workerUrl}/v1/projects/deploy/${phase}`
    const serialised = JSON.stringify(body)
    const headers = (token: string): Record<string, string> => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    })

    let res = await fetch(url, { method: 'POST', headers: headers(idToken), body: serialised })

    // 401 retry-on-fresh-token: even though deploy() force-refreshes at the
    // entry point, a long-running deploy (Cloud Build can take 5+ min) may
    // outlive the 1h Firebase ID-token lifetime, and the in-flight token
    // expires mid-flow. Refresh once and retry — this is the same pattern
    // the read paths use (fetchWithFreshAuth). Without it, the user sees
    // "Deploy init failed: Invalid token" and has to restart from scratch.
    if (res.status === 401) {
      const refreshed = await FirebaseAuthService.getInstance().getIdToken(true)
      if (refreshed && refreshed !== idToken) {
        res = await fetch(url, { method: 'POST', headers: headers(refreshed), body: serialised })
      }
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      let parsed: { error?: string } = {}
      try { parsed = JSON.parse(detail) } catch { /* not JSON */ }
      const msg = parsed.error || detail.slice(0, 300) || `HTTP ${res.status}`
      throw new Error(`Deploy ${phase} failed: ${msg}`)
    }
    return (await res.json()) as T
  }

  private async callCleanup(projectId: string): Promise<void> {
    const idToken = await FirebaseAuthService.getInstance().getIdToken()
    if (!idToken) return
    const workerUrl = resolveDeployUrl()
    await fetch(`${workerUrl}/v1/projects/deploy/cleanup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ projectId }),
    })
  }

  // ── Deployment summary ─────────────────────────────────────

  async getDeploymentSummary(projectId: string): Promise<DeploymentSummary> {
    const idToken = await FirebaseAuthService.getInstance().getIdToken()
    if (!idToken) {
      return { exists: false, projectId }
    }
    const workerUrl = resolveDeployUrl()
    const url = `${workerUrl}/v1/projects/${encodeURIComponent(projectId)}/deployment`
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${idToken}` },
    })
    if (!res.ok) return { exists: false, projectId }
    return (await res.json()) as DeploymentSummary
  }

  // ── Deploys lifecycle (quota, list, suspend, resume, archive) ──

  /**
   * Pre-flight call used by PublishModal on open. Tells the UI:
   *   - the current plan + quota
   *   - whether this projectId already has a live deploy (drives the
   *     "Publish" → "Update" label and skips over-quota blocking)
   *   - the existing slug so the modal can pre-fill the subdomain field
   */
  async getDeploysSummary(projectId: string): Promise<DeploysSummaryResponse> {
    const workerUrl = resolveDeployUrl()
    const url = `${workerUrl}/v1/projects/deploys/summary?projectId=${encodeURIComponent(projectId)}`
    const res = await this.fetchWithFreshAuth(url, { method: 'GET' })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Deploys summary failed: ${res.status} ${detail.slice(0, 200)}`)
    }
    return (await res.json()) as DeploysSummaryResponse
  }

  /**
   * Auth-attached fetch with one retry on 401 using a force-refreshed
   * Firebase ID token. Covers the case where the cached token expired but
   * the SDK's auto-refresh failed silently (App Check enforcement on
   * Identity Toolkit can produce this); without the retry, every short
   * idle period leaves the user with a stale token and the worker emits
   * "Invalid token" 401.
   */
  private async fetchWithFreshAuth(url: string, init: RequestInit): Promise<Response> {
    const auth = FirebaseAuthService.getInstance()
    const initial = await auth.getIdToken()
    if (!initial) throw new Error('Not signed in to TM Code.')
    const first = await fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${initial}` },
    })
    if (first.status !== 401) return first

    const refreshed = await auth.getIdToken(true)
    if (!refreshed || refreshed === initial) return first
    return fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${refreshed}` },
    })
  }

  /** All live (active + suspended) deploys owned by the current user. */
  async listDeploys(): Promise<DeploysListItem[]> {
    const idToken = await FirebaseAuthService.getInstance().getIdToken()
    if (!idToken) throw new Error('Not signed in to TM Code.')
    const workerUrl = resolveDeployUrl()
    const res = await fetch(`${workerUrl}/v1/projects/deploys`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${idToken}` },
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Deploys list failed: ${res.status} ${detail.slice(0, 200)}`)
    }
    const body = (await res.json()) as { items: DeploysListItem[] }
    return body.items
  }

  /** Take a live deploy offline. Serves a branded 503 page from that point on. */
  async suspendDeploy(projectId: string): Promise<{ ok: true; status: DeployStatus }> {
    return this.callLifecycle<{ ok: true; status: DeployStatus }>(
      'POST',
      `/v1/projects/deploys/${encodeURIComponent(projectId)}/suspend`,
      { reason: 'user-action' },
    )
  }

  /** Bring a suspended deploy back online. Re-checks quota; may fail. */
  async resumeDeploy(projectId: string): Promise<{ ok: true; status: DeployStatus }> {
    return this.callLifecycle<{ ok: true; status: DeployStatus }>(
      'POST',
      `/v1/projects/deploys/${encodeURIComponent(projectId)}/resume`,
    )
  }

  /** Destructive: R2 cleanup + status flip to archived + slug released. */
  async archiveDeploy(projectId: string): Promise<{ ok: true; status: DeployStatus; deletedAssets: number }> {
    return this.callLifecycle<{ ok: true; status: DeployStatus; deletedAssets: number }>(
      'DELETE',
      `/v1/projects/deploys/${encodeURIComponent(projectId)}`,
    )
  }

  private async callLifecycle<T>(
    method: 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const idToken = await FirebaseAuthService.getInstance().getIdToken()
    if (!idToken) throw new Error('Not signed in to TM Code.')
    const workerUrl = resolveDeployUrl()
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${idToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }
    if (body) init.body = JSON.stringify(body)
    const res = await fetch(`${workerUrl}${path}`, init)
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      let parsed: { error?: string } = {}
      try { parsed = JSON.parse(detail) } catch { /* not JSON */ }
      throw new Error(parsed.error || detail.slice(0, 200) || `HTTP ${res.status}`)
    }
    return (await res.json()) as T
  }

  // ── Custom domain CRUD ─────────────────────────────────────

  async addCustomDomain(projectId: string, hostname: string): Promise<DomainStatusResponse> {
    return this.callDomainEndpoint('POST', projectId, '', { hostname })
  }

  async getCustomDomainStatus(projectId: string): Promise<DomainStatusResponse> {
    return this.callDomainEndpoint('GET', projectId, '/status')
  }

  async removeCustomDomain(projectId: string): Promise<DomainStatusResponse> {
    return this.callDomainEndpoint('DELETE', projectId, '')
  }

  private async callDomainEndpoint(
    method: 'GET' | 'POST' | 'DELETE',
    projectId: string,
    suffix: string,
    body?: Record<string, unknown>,
  ): Promise<DomainStatusResponse> {
    const idToken = await FirebaseAuthService.getInstance().getIdToken()
    if (!idToken) {
      return { success: false, error: 'Not signed in to TM Code.' }
    }
    const workerUrl = resolveDeployUrl()
    const url = `${workerUrl}/v1/projects/${encodeURIComponent(projectId)}/domains${suffix}`
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${idToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }
    if (body) init.body = JSON.stringify(body)
    const res = await fetch(url, init)
    const data = (await res.json().catch(() => ({}))) as DomainStatusResponse
    return data
  }
}

export const deployService = new DeployService()
