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
import { invoke } from '@/utils/invokeMetrics'
import FirebaseAuthService, { getAppCheckHeader } from './auth/firebaseAuth'
import { resolveDeployUrl } from '../utils/devUrls'
import { IS_VITE_DEV } from '../utils/viteEnv'
import { useDeployStore, type DeployStep } from '../stores/deployStore'
import { detectFromProjectPath } from './deploy/runtimeDetector'
import {
  loadDeployPlan,
  saveDeployPlan,
  type StaticSpaPlan,
  type CompositePlan,
  type NextStandalonePlan,
} from './deploy/deployPlan'
import { ensureSupported } from './deploy/planNarrow'

/**
 * Dev-mode bypass header. The production Worker's `authenticateRequest`
 * falls back to unsigned JWT decode when it sees `TM-Code: dev-deploy`,
 * allowing dev Firebase tokens (different project/audience) to pass.
 * Empty object in production — zero overhead on the wire.
 */
const DEV_DEPLOY_HEADER: Record<string, string> = IS_VITE_DEV
  ? { 'TM-Code': 'dev-deploy' }
  : {}


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
  has_file_storage: boolean
  migration_sql?: string
}

/** Mirror of the Rust `NextDbMeta` struct (collect_next_db_meta). */
interface NextDbMeta {
  has_database: boolean
  has_file_storage: boolean
  migration_sql?: string
  schema_file_content?: string
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
  /** TM Code File Storage credentials — present only when the bundle ships
   *  `backend/src/files.ts`. Injected into the Cloud Run env so user-app
   *  code can fetch them via `process.env.TM_FILES_URL` / `TM_FILES_TOKEN`. */
  filesUrl: string | null
  filesToken: string | null
  filesPublicBase: string | null
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
  /** Custom domain hostname (e.g. "pool.momenu.online"), if configured and SSL active. */
  customDomain: string | null
  /** SSL status of the custom domain — 'active' means the domain is ready to serve. */
  customDomainSslStatus: string | null
  /** Which hosting pool this summary reflects: 'team' (you're the team admin in
   *  team consumption mode) or 'personal'. Optional — older workers omit it. */
  scope?: 'team' | 'personal'
  /** Team id when scope === 'team'. */
  teamId?: string | null
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

// Canonical Next.js standalone image. Generated at deploy time when the
// project has no Dockerfile (see ensureNextDockerfile). The IDE builds the
// app locally and ships the PREBUILT output, so the image only copies the
// standalone server + assets and runs it — no build step, no source, no
// package manager. Static assets also live in R2 (edge cache); the container
// serves them only as a fallback on R2 misses.
const NEXT_STANDALONE_DOCKERFILE = `# Auto-generated by TM Code — Next.js standalone container image.
# Safe to commit and edit; TM Code never overwrites an existing Dockerfile.
# The build runs on your machine; this image just runs the prebuilt server.
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# The platform injects PORT=8080; the standalone server honours PORT + HOSTNAME.
# HOSTNAME=0.0.0.0 is required — the default loopback bind fails the probe.
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
# .next/static is NOT copied — it's served from R2 (edge), never read
# server-side. The container serves SSR/API; static assets live in R2.
COPY public ./public
COPY .next/standalone ./
EXPOSE 8080
CMD ["node", "server.js"]
`

const NEXT_DOCKERIGNORE = `node_modules
.next
.git
.env
.env.*
npm-debug.log*
yarn-error.log*
*.log
.DS_Store
`

// Minimal next.config written when a Next project has none at all.
const NEXT_CONFIG_MINIMAL = `/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
}

export default nextConfig
`

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

      // ── Next.js standalone: container-only path ────────────
      // Next builds to a self-contained Node server (`output: 'standalone'`)
      // that serves SSR pages, route handlers AND its own static assets. So
      // there is no R2 upload — Cloud Build runs `next build` inside the
      // container (reusing the composite container pipeline) and the worker
      // routes EVERY request to it (proxyMode: 'all'). Skips the local build
      // (Cloud Build is authoritative) and the asset-batch phases entirely.
      if (plan.kind === 'next-standalone') {
        const url = await this.deployNextStandalone(projectPath, opts, idToken, () => {
          // Past init: R2/slug/container artifacts may exist → cleanup on fail.
          needsCleanup = true
        })
        needsCleanup = false
        saveDeployPlan(projectPath, plan).catch(() => {})
        return url
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
        hasFileStorage: bundle.has_file_storage,
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

      // Persist the authoritative TM_FILES_* values to .env so local dev
      // (`npm run dev` reading via dotenv) uses the SAME slug the deploy
      // pinned. Without this, the developer's local backend keeps the
      // candidate slug from the IDE-side `provision_files` call — and
      // `publicUrlFor()` in dev builds URLs against a slug that no longer
      // matches the real R2 prefix. The deploy already overrides Cloud Run
      // env with these values; this line closes the dev gap.
      if (initResult.filesUrl && initResult.filesToken && initResult.filesPublicBase) {
        try {
          await invoke('write_env_vars', {
            projectPath,
            vars: [
              { key: 'TM_FILES_URL', value: initResult.filesUrl },
              { key: 'TM_FILES_TOKEN', value: initResult.filesToken },
              { key: 'TM_FILES_PUBLIC_BASE', value: initResult.filesPublicBase },
            ],
          })
        } catch {
          // .env write failures are non-fatal — Cloud Run env still got the
          // correct values via the injection in container/deploy. Local dev
          // staying on the stale slug is annoying but recoverable (run
          // provision_files again, or edit .env manually).
        }
      }

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
        // Pre-deploy lint — catches the Express 5 wildcard crash and
        // `express@^5` pins before we pay for a Cloud Build that's
        // destined to fail at the Cloud Run TCP probe. Findings come back
        // as `file:line — explanation` strings; surface them verbatim so
        // the agent can act on the same content the user sees.
        const lintFindings = await invoke<string[]>('validate_backend_for_cloud_run', {
          projectPath,
        })
        if (lintFindings.length > 0) {
          throw new Error(
            'Your backend has issues that would crash when it runs:\n' +
              lintFindings.map((f) => `  • ${f}`).join('\n'),
          )
        }
        const sourceTarballBase64 = await invoke<string>('collect_backend_tarball', {
          projectPath,
        })
        store.updateProgress(opts.projectId, {
          step: stepIdx,
          totalSteps,
          stepName: 'container/build',
          status: 'in_progress',
          detail: 'uploading your backend',
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
        // Inject TM Files credentials returned by `init`. We override (rather
        // than merge) any .env-supplied values so the deploy is always the
        // source of truth — local .env may be stale if the user copied the
        // project, .env may be missing on a CI deploy, etc.
        if (initResult.filesUrl && initResult.filesToken && initResult.filesPublicBase) {
          const filesVars = new Map([
            ['TM_FILES_URL', initResult.filesUrl],
            ['TM_FILES_TOKEN', initResult.filesToken],
            ['TM_FILES_PUBLIC_BASE', initResult.filesPublicBase],
          ])
          for (let i = envVars.length - 1; i >= 0; i--) {
            if (filesVars.has(envVars[i].name)) envVars.splice(i, 1)
          }
          for (const [name, value] of filesVars) envVars.push({ name, value })
        }
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
   * Next.js standalone deploy — build locally once, split the output:
   *   - static assets (`.next/static` + `public`) → R2/CDN (edge cache),
   *   - the standalone server (`.next/standalone`) → a Cloud Run container
   *     built from a trivial copy+run image (no build step in the container).
   *
   * The worker serves `/_next/static/*` and public assets from R2 and proxies
   * everything else (pages, SSR, route handlers) to the container
   * (`proxyMode: 'static-r2'`); the container also carries the static assets,
   * so an R2 miss falls back to it rather than 404ing.
   *
   * Flow: build → init → upload(static→R2) → container/build → container/deploy
   * → finalize. `markCleanupNeeded` flips the caller's cleanup flag once init
   * has reserved the slug / pushed artifacts.
   */
  private async deployNextStandalone(
    projectPath: string,
    opts: DeployOptions,
    idToken: string,
    markCleanupNeeded: () => void,
  ): Promise<string> {
    const store = useDeployStore.getState()

    // Ensure `output: 'standalone'` before anything else — the build won't
    // emit the server we ship otherwise. Auto-injected (with a warning) so
    // Publish stays one-click, mirroring the generated Dockerfile.
    const configChanged = await this.ensureNextStandaloneConfig(projectPath)
    if (configChanged) {
      store.addWarning(
        opts.projectId,
        "Enabled `output: 'standalone'` in your next.config (required for the container build). Commit the change to version it.",
      )
    }

    // Pre-flight lint — same Cloud Run crash-class checks as composite
    // (base64-in-DB, Express 5 wildcards if the app mixes one in). Cheap, and
    // saves a doomed Cloud Build.
    const lintFindings = await invoke<string[]>('validate_backend_for_cloud_run', { projectPath })
    if (lintFindings.length > 0) {
      throw new Error(
        'Your project has issues that would crash when it runs:\n' +
          lintFindings.map((f) => `  • ${f}`).join('\n'),
      )
    }

    // ── build (local) ─────────────────────────────────────
    // Authoritative `next build`: emits .next/standalone (→ container) and
    // .next/static + public (→ R2). Honours the one-click promise.
    let stepIdx = 1
    let totalSteps = 5 // build + init + (≥1 asset batch) + container/build + container/deploy + finalize; bumped after batchify
    const reportStep = (name: string, status: DeployStep['status'], detail?: string) => {
      store.updateProgress(opts.projectId, { step: stepIdx, totalSteps, stepName: name, status, detail })
    }
    reportStep('build', 'in_progress')
    await this.runBuild(projectPath)
    reportStep('build', 'complete')

    // ── bundle static + detect data layer ─────────────────
    const staticFiles = await invoke<DeployBundleFile[]>('collect_next_static_bundle', { projectPath })
    const dbMeta = await invoke<NextDbMeta>('collect_next_db_meta', { projectPath })
    const batches = this.batchify(staticFiles)
    // build + init + N batches + container/build + container/deploy + finalize
    totalSteps = 1 + 1 + batches.length + 1 + 1 + 1

    // ── init ──────────────────────────────────────────────
    stepIdx = 2
    reportStep('init', 'in_progress')
    const initResult = await this.callPhase<InitResponse>('init', idToken, {
      projectId: opts.projectId,
      projectName: opts.projectName,
      customSubdomain: opts.customSubdomain,
      hasDatabase: dbMeta.has_database,
      // Next always ships a server (route handlers / server actions / SSR) —
      // the container is the API surface, so this is always true.
      hasApiRoutes: true,
      hasFileStorage: dbMeta.has_file_storage,
      migrationSql: dbMeta.migration_sql,
      schemaFileContent: dbMeta.schema_file_content,
    })
    markCleanupNeeded()
    for (const w of initResult.warnings) store.addWarning(opts.projectId, w)
    reportStep('init', 'complete', `Subdomain: ${initResult.slug}`)

    // Persist TM_FILES_* to .env so local `next dev` uses the same slug the
    // deploy pinned (mirrors the composite path).
    if (initResult.filesUrl && initResult.filesToken && initResult.filesPublicBase) {
      try {
        await invoke('write_env_vars', {
          projectPath,
          vars: [
            { key: 'TM_FILES_URL', value: initResult.filesUrl },
            { key: 'TM_FILES_TOKEN', value: initResult.filesToken },
            { key: 'TM_FILES_PUBLIC_BASE', value: initResult.filesPublicBase },
          ],
        })
      } catch {
        /* non-fatal — Cloud Run env still gets the authoritative values below */
      }
    }

    // ── assets (static → R2, chunked/parallel) ────────────
    const isFreeTier = !opts.userPlan || opts.userPlan === 'explorer'
    let uploadedSoFar = 0
    await this.runBatchesWithLimit(batches, UPLOAD_BATCH_CONCURRENCY, async (batch, i) => {
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
        slug: initResult.slug,
        authConfig: initResult.authConfig,
        files: batch,
        isFreeTier,
      })
      uploadedSoFar += batch.length
      store.updateProgress(opts.projectId, {
        step: myStep,
        totalSteps,
        stepName: 'assets',
        status: 'complete',
        detail: `${uploadedSoFar}/${staticFiles.length} files`,
      })
    })

    // ── container/build (prebuilt) ────────────────────────
    stepIdx++
    reportStep('container/build', 'in_progress', 'preparing image')
    // The Next standalone Dockerfile is pure boilerplate (copy+run prebuilt
    // output) — generate it when absent so Publish stays one-click. Never
    // overwrite a user's own.
    const generated = await this.ensureNextDockerfile(projectPath)
    if (generated) {
      store.addWarning(
        opts.projectId,
        'Added a Dockerfile for your Next.js app at the project root. Commit it to version your deploy config.',
      )
    }

    // Stage the prebuilt tarball. Small enough → inline it through the Worker's
    // container/build phase (as before). Too big → push it straight to GCS via
    // a resumable session (Rust → GCS: no Worker body limit, no browser CORS)
    // and have the build reference the uploaded object.
    type BuildTrigger = {
      buildId: string
      imageRef: string
      region: string
      sourceObjectName: string
    }
    const INLINE_MAX_BYTES = 20 * 1024 * 1024 // keeps base64 + JSON under the Worker's 30MB container/build cap
    const staged = await invoke<{
      sizeBytes: number
      base64: string | null
      tempPath: string | null
    }>('stage_next_prebuilt_tarball', { projectPath, inlineMaxBytes: INLINE_MAX_BYTES })

    let trigger: BuildTrigger
    if (staged.base64 != null) {
      reportStep('container/build', 'in_progress', 'uploading your app')
      trigger = await this.callPhase<BuildTrigger>('container/build', idToken, {
        projectId: opts.projectId,
        slug: initResult.slug,
        sourceTarballBase64: staged.base64,
      })
    } else {
      if (!staged.tempPath) throw new Error('Failed to stage the build image.')
      const mb = (staged.sizeBytes / 1024 / 1024).toFixed(0)
      reportStep('container/build', 'in_progress', `uploading your app (${mb} MB)`)
      const session = await this.callPhase<{
        sessionUri: string
        objectName: string
        sourceTag: string
      }>('container/source-init', idToken, {
        projectId: opts.projectId,
        slug: initResult.slug,
      })
      await invoke('upload_file_put', {
        path: staged.tempPath,
        url: session.sessionUri,
        contentType: 'application/gzip',
      })
      reportStep('container/build', 'in_progress', 'starting the build')
      trigger = await this.callPhase<BuildTrigger>('container/build', idToken, {
        projectId: opts.projectId,
        slug: initResult.slug,
        sourceObjectName: session.objectName,
        sourceTag: session.sourceTag,
      })
    }
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
        `Build ${buildStatus.status.toLowerCase()}: ${buildStatus.failureMessage ?? 'something went wrong while building your Next.js app'}` +
          (buildStatus.logUrl ? ` (details: ${buildStatus.logUrl})` : ''),
      )
    }
    reportStep('container/build', 'complete', `image: ${trigger.buildId.slice(0, 8)}…`)

    // ── container/deploy ──────────────────────────────────
    stepIdx++
    reportStep('container/deploy', 'in_progress', 'starting service')
    const envVars = await this.readBackendEnvVars(projectPath)
    if (initResult.filesUrl && initResult.filesToken && initResult.filesPublicBase) {
      const filesVars = new Map([
        ['TM_FILES_URL', initResult.filesUrl],
        ['TM_FILES_TOKEN', initResult.filesToken],
        ['TM_FILES_PUBLIC_BASE', initResult.filesPublicBase],
      ])
      for (let i = envVars.length - 1; i >= 0; i--) {
        if (filesVars.has(envVars[i].name)) envVars.splice(i, 1)
      }
      for (const [name, value] of filesVars) envVars.push({ name, value })
    }
    const deployRes = await this.callPhase<{ serviceUrl: string }>('container/deploy', idToken, {
      projectId: opts.projectId,
      slug: initResult.slug,
      imageRef: trigger.imageRef,
      envVars,
      // Static assets are in R2; everything dynamic (pages, SSR, /api) is the
      // container. The worker serves /_next/static/* + public from R2 and
      // proxies the rest here.
      proxyMode: 'static-r2',
    })
    store.updateProgress(opts.projectId, {
      step: stepIdx,
      totalSteps,
      stepName: 'container/deploy',
      status: 'in_progress',
      detail: 'waiting for app to come online',
    })
    await this.waitForBackendReady(deployRes.serviceUrl)
    reportStep('container/deploy', 'complete', deployRes.serviceUrl)

    // ── finalize ──────────────────────────────────────────
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
    return finalize.serviceUrl
  }

  /**
   * Ensure the project's next.config opts into `output: 'standalone'` — the
   * container deploy needs it (it's what emits `.next/standalone/server.js`).
   * Returns true iff the config was created or edited. Conservative by design:
   *
   *   - no next.config at all  → write a minimal one,
   *   - `output:'standalone'` already set → no-op,
   *   - a DIFFERENT `output` set → throw (don't silently override the user),
   *   - else inject `output: 'standalone'` right after the config object's
   *     opening brace, but ONLY at an unambiguous anchor (`module.exports = {`,
   *     `export default {`, `const nextConfig|config … = {`). If none match we
   *     throw with a precise manual-fix message rather than risk corrupting
   *     the file.
   */
  private async ensureNextStandaloneConfig(projectPath: string): Promise<boolean> {
    const exts = ['js', 'mjs', 'ts', 'cjs', 'mts', 'cts']
    let path: string | null = null
    let content: string | null = null
    for (const ext of exts) {
      try {
        content = await invoke<string>('read_file', { path: `${projectPath}/next.config.${ext}` })
        path = `${projectPath}/next.config.${ext}`
        break
      } catch {
        // not this extension — try the next
      }
    }

    if (path === null || content === null) {
      await invoke('write_file', {
        path: `${projectPath}/next.config.mjs`,
        content: NEXT_CONFIG_MINIMAL,
      })
      return true
    }

    if (/output\s*:/.test(content)) {
      if (/output\s*:\s*['"`]standalone['"`]/.test(content)) return false
      throw new Error(
        "Your next.config sets `output` to something other than 'standalone'. " +
          "Set `output: 'standalone'` (required for the container build) and Publish again.",
      )
    }

    // Unambiguous anchors only — first `{` of the config object literal.
    const anchors: RegExp[] = [
      /(module\.exports\s*=\s*)\{/,
      /(export\s+default\s+)\{/,
      /(const\s+(?:nextConfig|config)\b[^={]*=\s*)\{/,
    ]
    for (const re of anchors) {
      const m = re.exec(content)
      if (m) {
        const insertAt = m.index + m[0].length
        const updated =
          content.slice(0, insertAt) + "\n  output: 'standalone'," + content.slice(insertAt)
        await invoke('write_file', { path, content: updated })
        return true
      }
    }

    throw new Error(
      "Couldn't automatically add `output: 'standalone'` to your next.config — its shape is " +
        "unusual. Add `output: 'standalone'` to your Next config object manually, then Publish again.",
    )
  }

  /**
   * Write a canonical Next.js standalone Dockerfile + .dockerignore at the
   * project root when none exists. Returns true iff it generated the
   * Dockerfile. Idempotent and non-destructive — a pre-existing Dockerfile
   * (user- or agent-authored) is always left untouched.
   *
   * The image is a 3-stage build:
   *   deps    → install from whichever lockfile is present
   *   builder → `<pm> build` (emits .next/standalone via output:'standalone')
   *   runner  → node:slim running server.js, bound to 0.0.0.0:$PORT for
   *             Cloud Run (PORT=8080 injected at runtime; HOSTNAME=0.0.0.0
   *             so the standalone server doesn't bind loopback).
   */
  private async ensureNextDockerfile(projectPath: string): Promise<boolean> {
    let existing: string | null = null
    try {
      existing = await invoke<string>('read_file', { path: `${projectPath}/Dockerfile` })
    } catch {
      existing = null
    }
    if (existing !== null) {
      // Respect a user-authored Dockerfile untouched. But REFRESH a stale
      // TM Code-generated one (identified by its header marker) so template
      // fixes — e.g. dropping `COPY .next/static` — propagate to projects that
      // were published with an older template. Without this, a project keeps
      // its first generated Dockerfile forever and template bugs never heal.
      const isTmGenerated = existing.includes('Auto-generated by TM Code')
      if (!isTmGenerated || existing === NEXT_STANDALONE_DOCKERFILE) return false
      await invoke('write_file', {
        path: `${projectPath}/Dockerfile`,
        content: NEXT_STANDALONE_DOCKERFILE,
      })
      return true
    }
    await invoke('write_file', {
      path: `${projectPath}/Dockerfile`,
      content: NEXT_STANDALONE_DOCKERFILE,
    })
    // Best-effort .dockerignore — only when absent. Keeps node_modules / .next
    // / .env out of the build context (the build reinstalls + rebuilds; .env
    // secrets reach Cloud Run via env vars, never the image).
    try {
      await invoke<string>('read_file', { path: `${projectPath}/.dockerignore` })
    } catch {
      await invoke('write_file', {
        path: `${projectPath}/.dockerignore`,
        content: NEXT_DOCKERIGNORE,
      }).catch(() => {})
    }
    return true
  }

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
  private async resolvePlan(
    projectPath: string,
  ): Promise<StaticSpaPlan | CompositePlan | NextStandalonePlan> {
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
   * Probe the freshly-provisioned service URL until it answers with anything
   * other than a 5xx / connection error. A crashlooping app returns 5xx;
   * cold-start latency on the first request can take a while — so we retry
   * with a 90s ceiling and a 2s interval.
   *
   * The probe runs through Rust (`probe_url_ready`), NOT a webview fetch: a
   * just-deployed app that doesn't send CORS headers (a vanilla Next.js
   * server) would make a browser fetch reject with "Load failed" even while
   * it's serving fine — a false negative that fails healthy deploys. A
   * server-side GET sees the real status.
   *
   * We don't require a /health endpoint: the app might 404 on `/`, but that's
   * a 404, not a 5xx, and means it IS serving. 5xx and unreachable are the
   * only signals it isn't up.
   */
  private async waitForBackendReady(serviceUrl: string): Promise<void> {
    const PROBE_INTERVAL_MS = 2_000
    const MAX_DURATION_MS = 90_000
    const startedAt = Date.now()
    let lastError = ''

    while (Date.now() - startedAt < MAX_DURATION_MS) {
      try {
        const probe = await invoke<{ reachable: boolean; status: number }>('probe_url_ready', {
          url: serviceUrl,
        })
        if (probe.reachable && probe.status > 0 && probe.status < 500) return
        lastError = probe.reachable ? `HTTP ${probe.status}` : 'no response yet'
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
      await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS))
    }
    throw new Error(
      `Your app didn't respond in time (last: ${lastError}). This usually means it ` +
        `crashed at startup or is missing required configuration. Open Settings → Deploys for details.`,
    )
  }

  // ── Phase invocation ─────────────────────────────────────

  private async callPhase<T>(
    phase:
      | 'init'
      | 'upload'
      | 'worker'
      | 'finalize'
      | 'container/source-init'
      | 'container/build'
      | 'container/build-status'
      | 'container/deploy',
    idToken: string,
    body: unknown,
  ): Promise<T> {
    const workerUrl = resolveDeployUrl()
    const url = `${workerUrl}/v1/projects/deploy/${phase}`
    const serialised = JSON.stringify(body)
    let appCheck: Record<string, string> = {}
    try {
      appCheck = await getAppCheckHeader()
    } catch (err) {
      console.warn('[deployService] failed to get App Check header:', err)
    }
    const headers = (token: string): Record<string, string> => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...DEV_DEPLOY_HEADER,
      ...appCheck,
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
    let appCheck: Record<string, string> = {}
    try {
      appCheck = await getAppCheckHeader()
    } catch (err) {
      console.warn('[deployService] failed to get App Check header:', err)
    }
    await fetch(`${workerUrl}/v1/projects/deploy/cleanup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
        ...DEV_DEPLOY_HEADER,
        ...appCheck,
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
    let appCheck: Record<string, string> = {}
    try {
      appCheck = await getAppCheckHeader()
    } catch (err) {
      console.warn('[deployService] failed to get App Check header:', err)
    }
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${idToken}`,
        ...DEV_DEPLOY_HEADER,
        ...appCheck,
      },
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
    let appCheck: Record<string, string> = {}
    try {
      appCheck = await getAppCheckHeader()
    } catch (err) {
      console.warn('[deployService] failed to get App Check header:', err)
    }
    const first = await fetch(url, {
      ...init,
      headers: { ...DEV_DEPLOY_HEADER, ...appCheck, ...(init.headers || {}), Authorization: `Bearer ${initial}` },
    })
    if (first.status !== 401) return first

    const refreshed = await auth.getIdToken(true)
    if (!refreshed || refreshed === initial) return first
    return fetch(url, {
      ...init,
      headers: { ...DEV_DEPLOY_HEADER, ...appCheck, ...(init.headers || {}), Authorization: `Bearer ${refreshed}` },
    })
  }

  /** All live (active + suspended) deploys owned by the current user. */
  async listDeploys(): Promise<DeploysListItem[]> {
    const idToken = await FirebaseAuthService.getInstance().getIdToken()
    if (!idToken) throw new Error('Not signed in to TM Code.')
    const workerUrl = resolveDeployUrl()
    let appCheck: Record<string, string> = {}
    try {
      appCheck = await getAppCheckHeader()
    } catch (err) {
      console.warn('[deployService] failed to get App Check header:', err)
    }
    const res = await fetch(`${workerUrl}/v1/projects/deploys`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${idToken}`,
        ...DEV_DEPLOY_HEADER,
        ...appCheck,
      },
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
    let appCheck: Record<string, string> = {}
    try {
      appCheck = await getAppCheckHeader()
    } catch (err) {
      console.warn('[deployService] failed to get App Check header:', err)
    }
    const init: RequestInit = {
      method,
      headers: {
        ...DEV_DEPLOY_HEADER,
        ...appCheck,
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
    let appCheck: Record<string, string> = {}
    try {
      appCheck = await getAppCheckHeader()
    } catch (err) {
      console.warn('[deployService] failed to get App Check header:', err)
    }
    const init: RequestInit = {
      method,
      headers: {
        ...DEV_DEPLOY_HEADER,
        ...appCheck,
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
