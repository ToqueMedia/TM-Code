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

/**
 * Main entry — cascading detection:
 * 1. package.json deps
 * 2. Marker files (go.mod, requirements.txt, etc.)
 * 3. Returns 'unknown'
 */
export async function detectProjectCategory(projectPath: string): Promise<ProjectCategory> {
  const raw = await readTextFile(`${projectPath}/package.json`)
  if (raw) {
    try {
      const pkg = JSON.parse(raw)
      const fromDeps = detectFromDeps(
        Object.keys(pkg.dependencies || {}),
        Object.keys(pkg.devDependencies || {}),
      )
      if (fromDeps) return fromDeps
    } catch { /* malformed package.json */ }
  }

  const fromFiles = await detectFromFiles(projectPath)
  if (fromFiles) return fromFiles

  return 'unknown'
}

/**
 * Convert a ProjectCategory to the server type hint used by devServerManager.
 * Returns undefined for 'fullstack'/'unknown' — let devServerManager auto-detect.
 */
export function categoryToServerHint(category: ProjectCategory): 'frontend' | 'backend' | undefined {
  if (category === 'backend') return 'backend'
  if (category === 'frontend') return 'frontend'
  return undefined
}
