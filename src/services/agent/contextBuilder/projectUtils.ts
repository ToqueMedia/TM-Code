/**
 * Project-detection helpers — safe-read wrappers around Tauri filesystem
 * commands plus package-manager / project-type inference.
 *
 * Moved here from `contextBuilder.ts` (May 2026 slice). All functions are
 * pure (or async-pure: they only read disk, never write); they used to be
 * instance methods on `ContextBuilder` calling `this.safeReadFile` etc.
 * The orchestrator class now calls these directly.
 */

import { invoke } from '@/utils/invokeMetrics'
import { cachedBuildFileTree, cachedSafeReadFile } from '../ipcCache'
import { LS_ALIAS } from '../toolNames'
import { detectSystemPackageManager } from '../../packageManagerDetector'
import type { TemplateManifest } from '../../templateService'
import type { ProjectManifest } from '../../projectManifestService'
import type { GeneratedPath, GitContext, PackageSummary, PathAlias, RecentFileEntry } from './types'

// Goes through `ipcCache.cachedSafeReadFile` so the dozen-or-so calls a
// single context-build kicks off (README, TMS, PLAN, TODO, .toquemedia-id,
// package.json, lockfiles, project-type markers, …) dedupe with each
// other and with anything the attachment resolver reads in the same turn.
// Cache keys carry fsVersion, so any write path that calls bumpFsVersion()
// invalidates these entries automatically; a 5 s wall-clock TTL protects
// against external-editor mutations that don't bump.
export async function safeReadFile(path: string): Promise<string | null> {
  return cachedSafeReadFile(path)
}

export function formatFileTree(node: Record<string, unknown>, indent: string = ''): string {
  if (!node) return ''

  let result = ''
  const name = (node.name || node.fileName || '') as string
  const isDir = node.is_directory || node.isDirectory || (node.children !== undefined)

  if (name) {
    result += `${indent}${isDir ? name + '/' : name}\n`
  }

  const childIndent = name ? indent + '  ' : indent
  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      result += formatFileTree(child, childIndent)
    }
  }

  // The Rust walker sets `truncated` when a directory's contents were cut —
  // either capped at MAX_CHILDREN_PER_DIR or sliced off at maxDepth. Surfacing
  // it tells the model "there's more here" so it reaches for the listing tool
  // instead of assuming the folder is empty (or, worse, that the project is).
  // Nomeada pelo ALIAS: é o único nome que o modelo vê no schema.
  if (isDir && node.truncated === true) {
    result += `${childIndent}… (truncated — use ${LS_ALIAS} to expand)\n`
  }

  return result
}

export async function buildFileTree(projectPath: string): Promise<string> {
  try {
    const fileTree = await cachedBuildFileTree({
      rootPath: projectPath,
      // respectGitignore: the agent's structure snapshot should mirror what a
      // developer considers "source" — drop generated/ignored paths the repo's
      // .gitignore lists. UI explorer keeps them (opt-in flag, default off).
      filter: { showHidden: false, maxDepth: 2, respectGitignore: true }
    })
    return formatFileTree(fileTree as Record<string, unknown>)
  } catch {
    return '(Could not read project structure)'
  }
}

/**
 * Git orientation snapshot for the prompt: branch, ahead/behind vs upstream,
 * and the changed-file set. Reuses the same Tauri commands the Source-Control
 * UI uses (single source of truth). Returns null when the project isn't a git
 * repo — every command rejects and we swallow it. Capped at 50 files so a
 * massive uncommitted diff can't blow up the prompt.
 */
export async function gatherGitContext(projectPath: string): Promise<GitContext | null> {
  try {
    const [branch, files, divergence, recentCommits] = await Promise.all([
      invoke<string>('git_current_branch', { projectPath }),
      invoke<Array<{ path: string; status: string; staged: boolean }>>('git_status_files', { projectPath }),
      // Returns null when there's no upstream — local-only branch, not an error.
      invoke<{ ahead: number; behind: number } | null>('git_upstream_divergence', { projectPath }).catch(() => null),
      // History headline (git log --oneline -n 5) — empty on fresh repos.
      invoke<string[]>('git_recent_commits', { projectPath, limit: 5 }).catch(() => [] as string[]),
    ])
    return {
      branch,
      ahead: divergence?.ahead ?? 0,
      behind: divergence?.behind ?? 0,
      files: files.slice(0, 50),
      truncatedFiles: files.length > 50 ? files.length - 50 : 0,
      recentCommits,
    }
  } catch {
    // Not a git repo (or git unavailable) — no orientation block.
    return null
  }
}

/**
 * Most-recently-modified files (project-relative paths, newest first). Points
 * the model at the working set so it doesn't grep around for "where the recent
 * work is". Honours .gitignore + EXCLUDED_DIRS via the Rust walker.
 */
export async function gatherRecentFiles(projectPath: string, limit = 12): Promise<RecentFileEntry[]> {
  try {
    const rows = await invoke<Array<{ path: string; modified: number }>>('list_recent_files', {
      rootPath: projectPath,
      limit,
      respectGitignore: true,
    })
    const prefix = projectPath.replace(/\\/g, '/').replace(/\/$/, '') + '/'
    return rows.map(r => ({
      path: r.path.startsWith(prefix) ? r.path.slice(prefix.length) : r.path,
      modified: r.modified,
    }))
  } catch {
    return []
  }
}

/**
 * Import path aliases from tsconfig.json / jsconfig.json `compilerOptions.paths`
 * (the `@/* → src/*` style). Lets the model resolve aliased imports without
 * grepping for the config. Tolerates JSONC (// and block comments + trailing
 * commas) since tsconfig files commonly carry them.
 */
export async function readPathAliases(projectPath: string): Promise<PathAlias[]> {
  for (const file of ['tsconfig.json', 'jsconfig.json']) {
    const raw = await safeReadFile(`${projectPath}/${file}`)
    if (!raw) continue
    try {
      const stripped = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
        .replace(/(^|[^:])\/\/.*$/gm, '$1') // line comments (not URLs)
        .replace(/,(\s*[}\]])/g, '$1')      // trailing commas
      const json = JSON.parse(stripped)
      const co = json?.compilerOptions ?? {}
      const baseUrl: string = typeof co.baseUrl === 'string' ? co.baseUrl : '.'
      const paths = co.paths
      if (!paths || typeof paths !== 'object') return []
      const aliases: PathAlias[] = []
      for (const [alias, targets] of Object.entries(paths)) {
        const target = Array.isArray(targets) ? targets[0] : undefined
        if (typeof target === 'string') {
          const normBase = baseUrl === '.' ? '' : baseUrl.replace(/^\.\//, '') + '/'
          aliases.push({ alias, target: `${normBase}${target}` })
        }
      }
      return aliases.slice(0, 20)
    } catch {
      return []
    }
  }
  return []
}

/** Parse tolerante de JSONC — tsconfigs trazem comentários e vírgulas finais. */
function parseJsonc(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(
      raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .replace(/,(\s*[}\]])/g, '$1'),
    )
  } catch {
    return null
  }
}

/** Subdirectórios imediatos, sem dot-dirs nem node_modules. */
async function listSubdirs(path: string, limit: number): Promise<string[]> {
  try {
    const entries = await invoke<Array<{ name: string; is_directory: boolean }>>('list_directory', {
      path,
    })
    return entries
      .filter(e => e.is_directory && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => e.name)
      .slice(0, limit)
  } catch {
    return []
  }
}

/**
 * Directórios do projecto que valem uma inspeção: os workspaces DECLARADOS
 * (a resposta certa num monorepo) mais uma varredura de um nível, que apanha
 * os layouts que não os declaram (`functions/`, `server/`).
 *
 * Extraído do readGeneratedPaths porque a detecção de FRAMEWORK precisa
 * exactamente da mesma lista: num monorepo o `package.json` da raiz não tem
 * `react` nenhum — ele vive em `packages/web/package.json`. Ler só a raiz
 * classificava todo o monorepo React como "vanilla web" e injetava-lhe as
 * regras erradas no prompt (auditoria 2026-07-29).
 */
async function resolveProjectSubdirs(projectPath: string): Promise<Set<string>> {
  const rootPkg = parseJsonc((await safeReadFile(`${projectPath}/package.json`)) ?? '')
  const rawWorkspaces = Array.isArray(rootPkg?.workspaces)
    ? rootPkg.workspaces
    : Array.isArray((rootPkg?.workspaces as Record<string, unknown> | undefined)?.packages)
      ? ((rootPkg!.workspaces as Record<string, unknown>).packages as unknown[])
      : []

  const dirs = new Set<string>(await listSubdirs(projectPath, 24))
  for (const entry of rawWorkspaces) {
    if (typeof entry !== 'string') continue
    const spec = entry.replace(/\\/g, '/').replace(/\/+$/, '')
    if (spec.includes('..')) continue
    if (spec.endsWith('/*')) {
      // `packages/*` → expande para os filhos reais (profundidade 2).
      const base = spec.slice(0, -2)
      for (const child of await listSubdirs(`${projectPath}/${base}`, 40)) {
        dirs.add(`${base}/${child}`)
      }
    } else if (!spec.includes('*')) {
      dirs.add(spec)
    }
  }
  return dirs
}

/**
 * Bundlers cujo directório de saída é fixo e documentado quando não é
 * sobreposto. NUNCA basta o nome: ver `readGeneratedPaths` para as três
 * condições que têm de coincidir antes de um destes ser declarado.
 */
const BUNDLER_DEFAULT_OUTPUT: Array<{ dep: string; outDir: string }> = [
  { dep: 'vite', outDir: 'dist' },
  { dep: 'next', outDir: '.next' },
  { dep: '@angular/cli', outDir: 'dist' },
  { dep: 'parcel', outDir: 'dist' },
]

/**
 * Caminhos que o projecto declara serem GERADOS.
 *
 * Existe porque um dev humano recebe isto de graça — ao entrar num projecto
 * TypeScript sabe que os `.js` ao lado de `src/` são output do compilador — e
 * o modelo tinha de o inferir do NOME da pasta, que mente nos dois sentidos:
 * `functions/lib` era gerado e `lib/` noutro projecto é fonte legítima.
 *
 * **Precisão antes de cobertura.** Falhar um caminho gerado é uma falha suave
 * (o modelo perde uma dica; o `.gitignore` continua a proteger a busca e a
 * guarda de apagar). Declarar fonte real como gerada é uma falha dura — o
 * modelo recusa-se a editar código verdadeiro. Por isso só entram aqui
 * declarações que se conseguem LER:
 *
 *  1. `outDir` de tsconfig/jsconfig — a raiz, os workspaces declarados no
 *     package.json, e um nível de subdirectórios. (No momenu-fact quem declara
 *     é o `functions/tsconfig.json`; a raiz não tem `outDir` nenhum.)
 *  2. `Cargo.toml` ⇒ `target/` — fixado pela toolchain, não pelo projecto.
 *  3. Default de bundler, e só com TRÊS sinais independentes a coincidir: a
 *     ferramenta é dependência declarada, o directório existe, e o próprio
 *     projecto ignora-o no git. Um `dist/` de fonte real falha o terceiro; um
 *     `outDir` sobreposto para outro sítio falha o segundo.
 *
 * Vite e webpack com saída sobreposta ficam de fora de propósito: o valor vive
 * numa expressão JavaScript e lê-lo por regex seria adivinhar, não ler.
 */
export async function readGeneratedPaths(projectPath: string): Promise<GeneratedPath[]> {
  const configFiles = ['tsconfig.json', 'jsconfig.json']
  const found: GeneratedPath[] = []
  const seen = new Set<string>()

  const push = (rel: string, source: string): void => {
    if (!rel || rel.startsWith('..') || seen.has(rel)) return
    seen.add(rel)
    found.push({ path: rel, source })
  }

  const collectTsconfig = (raw: string | null, relDir: string, fileName: string): void => {
    if (!raw) return
    const json = parseJsonc(raw)
    const outDir = (json?.compilerOptions as Record<string, unknown> | undefined)?.outDir
    if (typeof outDir !== 'string' || !outDir.trim()) return
    // `outDir` é relativo ao tsconfig que o declara, não à raiz do projecto.
    const cleaned = outDir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (!cleaned || cleaned.startsWith('..')) return
    push(relDir ? `${relDir}/${cleaned}` : cleaned, `${relDir ? `${relDir}/` : ''}${fileName} outDir`)
  }

  // ── Que directórios inspeccionar ──
  const dirs = await resolveProjectSubdirs(projectPath)

  // ── 1. outDir declarado ──
  for (const file of configFiles) {
    collectTsconfig(await safeReadFile(`${projectPath}/${file}`), '', file)
  }
  for (const dir of dirs) {
    for (const file of configFiles) {
      collectTsconfig(await safeReadFile(`${projectPath}/${dir}/${file}`), dir, file)
    }
  }

  // ── 2. Cargo: `target/` é da toolchain, não do projecto ──
  for (const dir of ['', ...dirs]) {
    const prefix = dir ? `${dir}/` : ''
    if (await safeReadFile(`${projectPath}/${prefix}Cargo.toml`)) {
      push(`${prefix}target`, `${prefix}Cargo.toml (target de build do Cargo)`)
    }
  }

  // ── 3. Default de bundler, só com os três sinais a coincidir ──
  const rootPkg = parseJsonc((await safeReadFile(`${projectPath}/package.json`)) ?? '')
  const deps = {
    ...(rootPkg?.dependencies as Record<string, unknown> | undefined),
    ...(rootPkg?.devDependencies as Record<string, unknown> | undefined),
  }
  for (const { dep, outDir } of BUNDLER_DEFAULT_OUTPUT) {
    if (!(dep in deps) || seen.has(outDir)) continue
    const absolute = `${projectPath}/${outDir}`
    // Existe? E o próprio projecto declara-o descartável no git?
    const [exists, ignored] = await Promise.all([
      invoke<boolean>('path_exists', { path: absolute }).catch(() => false),
      invoke<boolean>('is_path_gitignored', { projectPath, filePath: absolute }).catch(() => false),
    ])
    if (exists && ignored) {
      push(outDir, `saída por omissão do ${dep}, confirmada por .gitignore`)
    }
  }

  return found.slice(0, 12)
}

/** Ceiling das listas que vão para o prompt. O total real viaja à parte. */
const DEPS_PROMPT_LIMIT = 15
const DEV_DEPS_PROMPT_LIMIT = 10
/** Ceiling da união de workspaces: é para DETECÇÃO, nunca é renderizada. */
const WORKSPACE_DEPS_LIMIT = 400

export async function extractPackageSummary(projectPath: string): Promise<PackageSummary | null> {
  const raw = await safeReadFile(`${projectPath}/package.json`)
  if (!raw) return null

  try {
    const pkg = JSON.parse(raw)
    const deps = Object.keys(pkg.dependencies || {})
    const devDeps = Object.keys(pkg.devDependencies || {})

    // Deps dos sub-pacotes de workspace, para quem DETECTA (framework, stack)
    // e não para quem renderiza. Falha de leitura de um sub-pacote é benigna:
    // perde-se sinal, não se ganha sinal errado.
    const workspaceDeps = new Set<string>()
    try {
      for (const dir of await resolveProjectSubdirs(projectPath)) {
        if (workspaceDeps.size >= WORKSPACE_DEPS_LIMIT) break
        const subRaw = await safeReadFile(`${projectPath}/${dir}/package.json`)
        if (!subRaw) continue
        const sub = parseJsonc(subRaw)
        if (!sub) continue
        for (const name of [
          ...Object.keys((sub.dependencies as Record<string, unknown>) || {}),
          ...Object.keys((sub.devDependencies as Record<string, unknown>) || {}),
        ]) {
          if (workspaceDeps.size >= WORKSPACE_DEPS_LIMIT) break
          workspaceDeps.add(name)
        }
      }
    } catch { /* sub-pacotes ilegíveis: seguimos com o que a raiz declara */ }

    return {
      name: pkg.name || 'unknown',
      scripts: Object.keys(pkg.scripts || {}),
      dependencies: deps.slice(0, DEPS_PROMPT_LIMIT),
      devDependencies: devDeps.slice(0, DEV_DEPS_PROMPT_LIMIT),
      dependencyCount: deps.length,
      devDependencyCount: devDeps.length,
      workspaceDependencies: Array.from(workspaceDeps),
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

/**
 * Reads the canonical TM Code project manifest. This supersedes
 * `.toquemedia-template`: templates say where a project came from; this file
 * says what the IDE can do with it now.
 */
export async function readProjectManifest(projectPath: string): Promise<ProjectManifest | null> {
  const raw = await safeReadFile(`${projectPath}/.toquemedia/project.json`)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as ProjectManifest
    return parsed?.schemaVersion === 1 && parsed.projectKind === 'tm-code-project'
      ? parsed
      : null
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
    : `LANGUAGE: Always respond in ${langName}. All explanations, comments, status updates, messages, AND internal reasoning/thinking (reasoning_content, <think> blocks) MUST be in ${langName}. Code identifiers remain in English. OVERRIDE ANY PRIOR LANGUAGE in this conversation — if earlier turns were in a different language, the user has configured ${langName} and that takes precedence from this turn onward.`
}
