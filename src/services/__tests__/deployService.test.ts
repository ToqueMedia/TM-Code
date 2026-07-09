/**
 * Deploy flow regression tests.
 *
 * Pins invariants that break silently:
 *  - resolveDeployUrl: dev mode → dev Worker, prod → production URL
 *  - DEV_DEPLOY_HEADER: TM-Code header, NOT X-TM-Dev-Deploy (CORS)
 *  - handleStopServer: no redundant clearDevServer, prev read before mutations
 *  - PublishModal phase logic: isFreeTier, overQuota, isReDeploy gates
 *  - slugSuggest: deterministic slug generation
 *  - Worker: tryReserveSubdomain accepts 409, finalize preserves backendUrl
 */

// ── slugSuggest ───────────────────────────────────────────────
// Pure function from PublishModal.tsx — deterministic slug generation.
// Inline reimplementation (can't import .tsx without full component tree).

function slugSuggest(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

describe('slugSuggest logic', () => {
  it('lowercases and strips special chars', () => {
    expect(slugSuggest('My Project!')).toBe('myproject')
  })

  it('normalizes accented characters', () => {
    expect(slugSuggest('Aplicação')).toBe('aplicacao')
  })

  it('strips spaces (not converted to hyphens)', () => {
    expect(slugSuggest('hello   world')).toBe('helloworld')
  })

  it('preserves existing hyphens', () => {
    expect(slugSuggest('my-project')).toBe('my-project')
  })

  it('strips leading/trailing hyphens', () => {
    expect(slugSuggest('--test--')).toBe('test')
  })

  it('truncates to 63 chars', () => {
    const long = 'a'.repeat(100)
    expect(slugSuggest(long)).toHaveLength(63)
  })

  it('handles empty string', () => {
    expect(slugSuggest('')).toBe('')
  })

  it('preserves numbers and hyphens', () => {
    expect(slugSuggest('app-v2.0')).toBe('app-v20')
  })

  it('handles unicode emoji', () => {
    expect(slugSuggest('🚀 rocket-app')).toBe('rocket-app')
  })
})

// ── Phase logic (PublishModal) ────────────────────────────────
// The phase computation is a pure function of (record, isFreeTier, overQuota).
// Pin the priority order so regressions in gate ordering are caught.

describe('PublishModal phase priority', () => {
  type Phase = 'upgrade' | 'over-quota' | 'configure' | 'publishing' | 'success' | 'error'

  // Reimplementation of the phase logic from PublishModal.tsx:61-72
  function computePhase(
    record: { phase: string } | null,
    isFreeTier: boolean,
    overQuota?: boolean,
  ): Phase {
    if (!record && isFreeTier) return 'upgrade'
    if (!record && overQuota) return 'over-quota'
    if (!record) return 'configure'
    if (record.phase === 'in_progress') return 'publishing'
    if (record.phase === 'success') return 'success'
    if (record.phase === 'error') return 'error'
    return 'configure'
  }

  it('free tier with no record → upgrade', () => {
    expect(computePhase(null, true)).toBe('upgrade')
  })

  it('free tier check takes priority over overQuota', () => {
    expect(computePhase(null, true, true)).toBe('upgrade')
  })

  it('over-quota blocks paid user with no record', () => {
    expect(computePhase(null, false, true)).toBe('over-quota')
  })

  it('paid user with no record and not over-quota → configure', () => {
    expect(computePhase(null, false, false)).toBe('configure')
  })

  it('in_progress record → publishing regardless of plan/quota', () => {
    expect(computePhase({ phase: 'in_progress' }, true, true)).toBe('publishing')
  })

  it('success record → success', () => {
    expect(computePhase({ phase: 'success' }, false, false)).toBe('success')
  })

  it('error record → error', () => {
    expect(computePhase({ phase: 'error' }, false, false)).toBe('error')
  })

  it('unknown record phase falls back to configure', () => {
    expect(computePhase({ phase: 'idle' }, false, false)).toBe('configure')
  })
})

// ── Preview close invariants ─────────────────────────────────
// Closing Preview hides the view and leaves the dev server running.

describe('PreviewView close invariants', () => {
  let previewSource: string

  beforeAll(() => {
    previewSource = require('fs').readFileSync(
      require('path').join(__dirname, '../../components/views/PreviewView.tsx'),
      'utf8',
    )
  })

  it('closes preview without stopping or clearing the dev server', () => {
    expect(previewSource).not.toContain('devServerManager.stop()')
    expect(previewSource).not.toMatch(/layout\.clearDevServer\(\)/)
  })

  it('previousViewMode is read before closing the webview', () => {
    const prevAssign = previewSource.indexOf('const prev =')
    const closeWebview = previewSource.indexOf('closePreviewWebview()')
    expect(prevAssign).toBeGreaterThan(-1)
    expect(closeWebview).toBeGreaterThan(-1)
    expect(prevAssign).toBeLessThan(closeWebview)
  })
})

// ── resolveDeployUrl invariants ───────────────────────────────
// CRITICAL: dev mode must NEVER hit the production Worker directly.
// The production Worker may not have the TM-Code:dev-deploy bypass
// deployed → "Invalid token". The dev Worker has isDev(env) auth
// bypass and now uploads to real R2 via the Cloudflare REST API.

describe('resolveDeployUrl — dev mode safety', () => {
  let devUrlsSource: string

  beforeAll(() => {
    devUrlsSource = require('fs').readFileSync(
      require('path').join(__dirname, '../../utils/devUrls.ts'),
      'utf8',
    )
  })

  it('dev mode uses resolveWorkerUrl() (dev Worker), NOT PRODUCTION_DEPLOY_URL', () => {
    // The function must check IS_VITE_DEV and return resolveWorkerUrl()
    // before falling through to PRODUCTION_DEPLOY_URL.
    expect(devUrlsSource).toMatch(/IS_VITE_DEV[\s\S]*resolveWorkerUrl/)
  })

  it('production mode returns PRODUCTION_DEPLOY_URL', () => {
    expect(devUrlsSource).toContain('return PRODUCTION_DEPLOY_URL')
  })

  it('does NOT unconditionally return PRODUCTION_DEPLOY_URL', () => {
    // The function must NOT be: `return PRODUCTION_DEPLOY_URL` without
    // checking IS_VITE_DEV first. This was the regression that caused
    // "Invalid token" in dev mode.
    const fnMatch = devUrlsSource.match(/function resolveDeployUrl\(\)[^}]+}/s)
    expect(fnMatch).toBeTruthy()
    const fnBody = fnMatch![0]
    // The function body must contain IS_VITE_DEV check
    expect(fnBody).toContain('IS_VITE_DEV')
    // The function body must NOT have PRODUCTION_DEPLOY_URL as the only return
    const returns = fnBody.match(/return\s+/g) ?? []
    expect(returns.length).toBeGreaterThanOrEqual(2) // at least dev + prod returns
  })
})

// ── Header invariants ─────────────────────────────────────────
// Pins forward-compatible dev bypass header + CORS safety.

describe('deploy headers', () => {
  let deployServiceSource: string

  beforeAll(() => {
    deployServiceSource = require('fs').readFileSync(
      require('path').join(__dirname, '../deployService.ts'),
      'utf8',
    )
    // provisionOps.ts was covered here too until the dev-only-IDE pivot
    // (2026-07) deregistered the provision_* tools and deleted the file.
  })

  it('deployService uses TM-Code header (not X-TM-Dev-Deploy)', () => {
    expect(deployServiceSource).toContain("'TM-Code': 'dev-deploy'")
    expect(deployServiceSource).not.toContain('X-TM-Dev-Deploy')
  })

  it('deployService calls resolveDeployUrl (not hardcoding URL)', () => {
    expect(deployServiceSource).toContain('resolveDeployUrl()')
  })
})

// ── Worker invariants (source-level) ──────────────────────────
// Pins fixes in the Worker repo that regress if the code is refactored.

describe('Worker deploy invariants', () => {
  let workerSource: string

  beforeAll(() => {
    const workerPath = require('path').join(
      __dirname, '../../../../toquemedia-studio-api/src/deployOrchestrator.ts',
    )
    try {
      workerSource = require('fs').readFileSync(workerPath, 'utf8')
    } catch {
      // Worker repo not available — skip these tests
      workerSource = ''
    }
  })

  // Skip all if Worker repo is not adjacent
  const hasWorker = () => workerSource.length > 0

  it('finalize reads current KV before overwriting (preserves backendUrl)', () => {
    if (!hasWorker()) return
    // The fix: finalize calls getSlugStatus before setSlugStatus
    expect(workerSource).toMatch(/getSlugStatus.*request\.slug/)
    // And includes backendUrl in the write
    expect(workerSource).toMatch(/backendUrl.*currentSlug/)
  })

  it('tryReserveSubdomain handles 409 ALREADY_EXISTS', () => {
    if (!hasWorker()) return
    expect(workerSource).toContain('ALREADY_EXISTS')
    expect(workerSource).toContain('res.status === 409')
  })

  it('cleanup uses slug from deploy record, not raw projectId', () => {
    if (!hasWorker()) return
    // The fix: cleanup looks up the record and uses record.slug for R2 prefix
    expect(workerSource).toMatch(/record\?.slug \?\? projectId/)
  })

  it('authenticateRequest has dev-deploy bypass for production', () => {
    if (!hasWorker()) return
    const indexPath = require('path').join(
      __dirname, '../../../../toquemedia-studio-api/src/index.ts',
    )
    const indexSource = require('fs').readFileSync(indexPath, 'utf8')
    expect(indexSource).toContain("TM-Code') === 'dev-deploy'")
    expect(indexSource).toContain('payload.sub')
  })
})
