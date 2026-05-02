/**
 * Deploy service — orchestrates the multi-phase deploy against the backend.
 *
 * The backend was split into 4 phase endpoints to escape Cloudflare's per-
 * request CPU budget (init / upload / worker / finalize). This service walks
 * them in order, chunks the asset upload into sub-10MB batches, and reports
 * progress to deployStore between calls.
 *
 *   1. init      → reserves slug, mints GIP tenant, optional D1 + migrations
 *   2. upload    → R2 file batches (called N times, parallel-safe)
 *   3. worker    → Hono Worker bundle + route (only if backend ships)
 *   4. finalize  → Firestore deployment record
 *
 * Failure handling:
 *   - On any step failure we POST /v1/projects/deploy/cleanup to drop any
 *     R2 files we already wrote, before surfacing the error. Best-effort.
 *   - The deployStore phase flips to 'error' with the message; the modal's
 *     ErrorStep offers Retry which restarts from init.
 */
import { invoke } from '@tauri-apps/api/core'
import FirebaseAuthService from './auth/firebaseAuth'
import { resolveWorkerUrl } from '../utils/devUrls'
import { useDeployStore, type DeployStep } from '../stores/deployStore'

interface DeployBundleFile {
  path: string
  content: string
  encoding: 'utf8' | 'base64'
}

interface DeployBundle {
  files: DeployBundleFile[]
  worker_file?: DeployBundleFile
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
      const bundle = await invoke<DeployBundle>('collect_deploy_bundle', { projectPath })
      if (bundle.files.length === 0 && !bundle.worker_file) {
        throw new Error('dist/ is empty — run the build first.')
      }

      const idToken = await FirebaseAuthService.getInstance().getIdToken()
      if (!idToken) throw new Error('Not signed in to TM Code. Sign in and retry.')

      const hasWorker = !!bundle.worker_file

      // Compute step list up-front so the modal can render a stable progress bar.
      // 1: init, 2..N: assets batches, N+1?: worker, last: finalize
      const staticFileCount = bundle.files.filter(
        (f) => f.path !== 'worker.js' && !f.path.startsWith('standalone/'),
      ).length
      const batches = this.batchify(bundle.files)
      const totalSteps = 1 + batches.length + (hasWorker ? 1 : 0) + 1
      let stepIdx = 0

      const reportStep = (name: string, status: DeployStep['status'], detail?: string) => {
        store.updateProgress(opts.projectId, {
          step: stepIdx,
          totalSteps,
          stepName: name,
          status,
          detail,
        })
      }

      // ── Phase 1: init ─────────────────────────────────────
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

      // ── Phase 2: assets (chunked, parallelized) ───────────
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

      // ── Phase 3: worker (conditional) ─────────────────────
      if (hasWorker && bundle.worker_file) {
        stepIdx++
        reportStep('worker', 'in_progress')
        await this.callPhase<{ ok: true }>('worker', idToken, {
          projectId: opts.projectId,
          slug: initResult.slug,
          workerFile: bundle.worker_file,
          authConfig: initResult.authConfig,
          databaseId: initResult.databaseId,
        })
        reportStep('worker', 'complete')
      }

      // ── Phase 4: finalize ─────────────────────────────────
      stepIdx++
      reportStep('finalize', 'in_progress')
      const finalize = await this.callPhase<FinalizeResponse>('finalize', idToken, {
        projectId: opts.projectId,
        slug: initResult.slug,
        hasWorker,
        databaseId: initResult.databaseId,
        databaseName: initResult.databaseName,
      })
      reportStep('finalize', 'complete', finalize.serviceUrl)

      store.completeDeploy(opts.projectId, {
        serviceUrl: finalize.serviceUrl,
        provider: finalize.provider,
        databaseId: initResult.databaseId,
      })
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

  // ── Batching helpers ────────────────────────────────────

  private batchify(files: DeployBundleFile[]): DeployBundleFile[][] {
    const staticFiles = files.filter(
      (f) => f.path !== 'worker.js' && !f.path.startsWith('standalone/'),
    )
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

  // ── Phase invocation ─────────────────────────────────────

  private async callPhase<T>(
    phase: 'init' | 'upload' | 'worker' | 'finalize',
    idToken: string,
    body: unknown,
  ): Promise<T> {
    const workerUrl = resolveWorkerUrl()
    const res = await fetch(`${workerUrl}/v1/projects/deploy/${phase}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(body),
    })
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
    const workerUrl = resolveWorkerUrl()
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
    const workerUrl = resolveWorkerUrl()
    const url = `${workerUrl}/v1/projects/${encodeURIComponent(projectId)}/deployment`
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${idToken}` },
    })
    if (!res.ok) return { exists: false, projectId }
    return (await res.json()) as DeploymentSummary
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
    const workerUrl = resolveWorkerUrl()
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
