import { invoke } from '@tauri-apps/api/core'

export type ProjectCategory = 'frontend' | 'backend' | 'fullstack' | 'unknown'

const FRONTEND_MARKERS = [
  'react', 'vue', 'next', 'nuxt', 'svelte',
  '@angular/core', 'astro', 'solid-js',
]

const BACKEND_MARKERS = [
  'express', 'fastify', '@nestjs/core', 'hono', 'koa', '@hapi/hapi',
]

const BACKEND_FILE_MARKERS = [
  'go.mod', 'requirements.txt', 'pyproject.toml',
  'setup.py', 'Pipfile', 'Cargo.toml', 'pom.xml', 'build.gradle',
]

// Conventional monorepo subdirectories that may contain their own package.json.
// Without this, a root package.json with only backend deps (express in root,
// react/vite isolated in client/package.json) gets misclassified as 'backend'
// and the IDE always opens HttpClientPanel instead of the iframe preview.
//
// Exported because the system prompt instructs the agent to use these exact
// names when scaffolding monorepos — keeping detector and prompt in lock-step
// (any change here propagates automatically into the agent's instructions).
export const MONOREPO_DIRS = ['client', 'server', 'frontend', 'backend', 'web', 'api']

async function fileExists(path: string): Promise<boolean> {
  try {
    await invoke<string>('read_file', { path })
    return true
  } catch {
    return false
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await invoke<string>('read_file', { path })
  } catch {
    return null
  }
}

/**
 * Detect project category from package.json dependencies.
 * Returns 'fullstack' when both frontend and backend deps are present.
 */
function detectFromDeps(dependencies: string[], devDependencies: string[]): ProjectCategory | null {
  const all = [...dependencies, ...devDependencies]
  const hasFrontend = FRONTEND_MARKERS.some(m => all.includes(m))
  const hasBackend = BACKEND_MARKERS.some(m => all.includes(m))

  if (hasFrontend && hasBackend) return 'fullstack'
  if (hasBackend) return 'backend'
  if (hasFrontend) return 'frontend'
  return null
}

/**
 * Detect project category from marker files (Go, Python, Rust, Java).
 * Non-JS projects with these markers are classified as backend.
 */
async function detectFromFiles(projectPath: string): Promise<ProjectCategory | null> {
  const results = await Promise.all(
    BACKEND_FILE_MARKERS.map(file => fileExists(`${projectPath}/${file}`))
  )
  return results.some(Boolean) ? 'backend' : null
}

function depsFromPackageJson(raw: string | null): { deps: string[]; devDeps: string[] } {
  if (!raw) return { deps: [], devDeps: [] }
  try {
    const pkg = JSON.parse(raw)
    return {
      deps: Object.keys(pkg.dependencies || {}),
      devDeps: Object.keys(pkg.devDependencies || {}),
    }
  } catch {
    return { deps: [], devDeps: [] }
  }
}

function workspaceGlobs(raw: string | null): string[] {
  if (!raw) return []
  try {
    const pkg = JSON.parse(raw)
    const ws = pkg.workspaces
    if (Array.isArray(ws)) return ws
    if (ws && Array.isArray(ws.packages)) return ws.packages
  } catch { /* ignore */ }
  return []
}

/**
 * Aggregate dependency names across the root package.json AND any
 * sub-package.json found in conventional monorepo directories
 * (client/, server/, frontend/, backend/, web/, api/) plus yarn-workspace
 * entries. Without this, a root with only backend deps gets misclassified
 * as 'backend' even when the frontend lives in client/package.json.
 */
async function aggregateMonorepoDeps(projectPath: string, rootRaw: string | null): Promise<{ deps: string[]; devDeps: string[] }> {
  const root = depsFromPackageJson(rootRaw)
  const aggregated = { deps: [...root.deps], devDeps: [...root.devDeps] }

  const dirs = new Set<string>(MONOREPO_DIRS)
  for (const glob of workspaceGlobs(rootRaw)) {
    // Only handle simple non-glob paths and "<dir>/*" — full glob support
    // is overkill here. "<dir>/*" expands to convention dirs we already cover.
    if (!glob.includes('*') && !glob.startsWith('!')) {
      dirs.add(glob)
    }
  }

  await Promise.all(
    Array.from(dirs).map(async dir => {
      const sub = await readTextFile(`${projectPath}/${dir}/package.json`)
      if (sub) {
        const { deps, devDeps } = depsFromPackageJson(sub)
        aggregated.deps.push(...deps)
        aggregated.devDeps.push(...devDeps)
      }
    })
  )

  return aggregated
}

/**
 * Main entry — cascading detection:
 * 1. package.json deps (aggregated across monorepo sub-packages)
 * 2. Marker files (go.mod, requirements.txt, etc.)
 * 3. Returns 'unknown'
 */
export async function detectProjectCategory(projectPath: string): Promise<ProjectCategory> {
  const rootRaw = await readTextFile(`${projectPath}/package.json`)
  if (rootRaw) {
    const { deps, devDeps } = await aggregateMonorepoDeps(projectPath, rootRaw)
    const fromDeps = detectFromDeps(deps, devDeps)
    if (fromDeps) return fromDeps
  }

  const fromFiles = await detectFromFiles(projectPath)
  if (fromFiles) return fromFiles

  return 'unknown'
}

/**
 * Convert a ProjectCategory to the project kind used by start_dev_server and
 * devServerManager. Preserves fullstack semantics so port-authoritative
 * classification and the HTTP Client drawer are enabled correctly.
 * Returns undefined for 'unknown' — let the caller apply its own default.
 */
export function categoryToServerHint(category: ProjectCategory): 'frontend' | 'backend' | 'fullstack' | undefined {
  if (category === 'backend') return 'backend'
  if (category === 'frontend') return 'frontend'
  if (category === 'fullstack') return 'fullstack'
  return undefined
}
