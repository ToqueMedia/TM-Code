/**
 * Project-detection helpers — safe-read wrappers around Tauri filesystem
 * commands plus package-manager / project-type inference.
 *
 * Moved here from `contextBuilder.ts` (May 2026 slice). All functions are
 * pure (or async-pure: they only read disk, never write); they used to be
 * instance methods on `ContextBuilder` calling `this.safeReadFile` etc.
 * The orchestrator class now calls these directly.
 */

import { invoke } from '@tauri-apps/api/core'
import { detectSystemPackageManager } from '../../packageManagerDetector'
import type { TemplateManifest } from '../../templateService'
import type { PackageSummary } from './types'

export async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await invoke<string>('read_file', { path })
  } catch {
    return null
  }
}

export function formatFileTree(node: Record<string, unknown>, indent: string = ''): string {
  if (!node) return ''

  let result = ''
  const name = (node.name || node.fileName || '') as string
  const isDir = node.is_directory || node.isDirectory || (node.children !== undefined)

  if (name) {
    result += `${indent}${isDir ? name + '/' : name}\n`
  }

  if (node.children && Array.isArray(node.children)) {
    const childIndent = name ? indent + '  ' : indent
    for (const child of node.children) {
      result += formatFileTree(child, childIndent)
    }
  }

  return result
}

export async function buildFileTree(projectPath: string): Promise<string> {
  try {
    const fileTree = await invoke('build_file_tree', {
      rootPath: projectPath,
      filter: { showHidden: false, maxDepth: 2 }
    })
    return formatFileTree(fileTree as Record<string, unknown>)
  } catch {
    return '(Could not read project structure)'
  }
}

export async function extractPackageSummary(projectPath: string): Promise<PackageSummary | null> {
  const raw = await safeReadFile(`${projectPath}/package.json`)
  if (!raw) return null

  try {
    const pkg = JSON.parse(raw)
    return {
      name: pkg.name || 'unknown',
      scripts: Object.keys(pkg.scripts || {}),
      dependencies: Object.keys(pkg.dependencies || {}).slice(0, 15),
      devDependencies: Object.keys(pkg.devDependencies || {}).slice(0, 10),
      packageManager: pkg.packageManager || '',
    }
  } catch {
    return null
  }
}

/**
 * Reads the .toquemedia-template manifest from the project root.
 * Returns null if the file doesn't exist (project wasn't scaffolded from a template).
 */
export async function readTemplateManifest(projectPath: string): Promise<TemplateManifest | null> {
  const raw = await safeReadFile(`${projectPath}/.toquemedia-template`)
  if (!raw) return null

  try {
    return JSON.parse(raw) as TemplateManifest
  } catch {
    return null
  }
}

export async function detectPackageManager(projectPath: string): Promise<string> {
  // 1. Check lock files for existing projects (respect user's choice)
  const checks = [
    { file: 'pnpm-lock.yaml', pm: 'pnpm' },
    { file: 'bun.lockb', pm: 'bun' },
    { file: 'yarn.lock', pm: 'yarn' },
    { file: 'package-lock.json', pm: 'npm' },
  ]

  const results = await Promise.all(
    checks.map(async ({ file, pm }) => {
      const content = await safeReadFile(`${projectPath}/${file}`)
      return content !== null ? pm : null
    })
  )

  const fromLockFile = results.find(pm => pm !== null)
  if (fromLockFile) return fromLockFile

  // 2. No lock file (new/empty project) — use fastest PM available on system
  return detectSystemPackageManager()
}

export function detectProjectType(pkg: PackageSummary | null): string | undefined {
  if (!pkg) return undefined
  const allDeps = [...pkg.dependencies, ...pkg.devDependencies]

  // Check for specific frameworks first (more specific → less specific)
  if (allDeps.includes('next')) return 'nextjs'
  if (allDeps.includes('nuxt')) return 'nuxt'
  if (allDeps.includes('@angular/core')) return 'angular'
  if (allDeps.includes('svelte')) return 'svelte'
  if (allDeps.includes('vue')) return 'vue'
  if (allDeps.includes('react')) return 'react'

  // Generic categories
  if (pkg.scripts.some(s => s.includes('node') || s.includes('ts-node'))) return 'node'

  return 'node'
}

/**
 * Fallback detection for non-JS projects (Go, Python, Rust, etc.)
 * by checking for characteristic files in the project root.
 */
export async function detectProjectTypeFromFiles(projectPath: string): Promise<string | undefined> {
  // Check multiple markers in parallel for speed
  const checks = [
    { file: 'go.mod', type: 'go' },
    { file: 'requirements.txt', type: 'python' },
    { file: 'pyproject.toml', type: 'python' },
    { file: 'setup.py', type: 'python' },
    { file: 'Pipfile', type: 'python' },
    { file: 'Cargo.toml', type: 'rust' },
  ]

  const results = await Promise.all(
    checks.map(async ({ file, type }) => {
      const content = await safeReadFile(`${projectPath}/${file}`)
      return content !== null ? type : null
    })
  )

  return results.find(t => t !== null) ?? undefined
}

export async function getLangInstruction(): Promise<string> {
  const agentLangMap: Record<string, string> = {
    en: 'English', pt: 'Portuguese', zh: '中文', es: 'Español', fr: 'Français', de: 'Deutsch', ja: '日本語'
  }
  let agentLang = 'en'
  try {
    const { useSettingsStore } = await import('../../../stores/settingsStore')
    agentLang = useSettingsStore.getState().agentLanguage || 'en'
  } catch { /* fallback to English */ }
  const langName = agentLangMap[agentLang] || agentLangMap.en
  // Emphatic phrasing to override conversational inertia: when the language
  // changes mid-conversation, the model's prior replies in the old language
  // create in-context pressure to continue in it. The "OVERRIDE ANY…" line
  // explicitly instructs the model to ignore that pressure.
  return agentLang === 'en'
    ? `LANGUAGE: Respond in English. OVERRIDE ANY PRIOR LANGUAGE in this conversation — the user has just configured English as the response language.`
    : `LANGUAGE: Always respond in ${langName}. All explanations, comments, status updates, and messages MUST be in ${langName}. Code identifiers remain in English. OVERRIDE ANY PRIOR LANGUAGE in this conversation — if earlier turns were in a different language, the user has configured ${langName} and that takes precedence from this turn onward.`
}
