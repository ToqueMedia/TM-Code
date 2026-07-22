import { invoke } from '@/utils/invokeMetrics'
import { parseSkillFrontmatter } from './skillFrontmatter'

// Re-export so existing imports (`import { parseSkillFrontmatter } from './skillService'`) keep working.
export { parseSkillFrontmatter } from './skillFrontmatter'

// === Types ===

export interface Skill {
  id: string
  name: string
  /** One-line description from YAML frontmatter (or fallback derived from H1 + first paragraph).
   *  This is what appears in the system-prompt skill index — call read_skill(name) for full content. */
  description: string
  path: string
  /** Full markdown content WITHOUT the YAML frontmatter block. */
  content: string
  references: string[]
  scope: 'bundled' | 'global' | 'project'
}

interface SkillEntry {
  name: string
  path: string
}

interface SkillContent {
  content: string
  references: string[]
}

interface SkillCache {
  skills: Skill[]
  timestamp: number
  projectPath: string
  mode: PromptMode
  /** Filesystem version captured when the cache was filled. Cache misses when
   *  the global fsVersion advances — i.e., any write happened since. Catches
   *  the project-level skill edits (.toquemedia-studio/skills/*.md) without
   *  needing a path-specific watcher. */
  fsVersion: number
}

export type PromptMode = 'chat' | 'cmd'

// === Constants ===

const CACHE_TTL_MS = 30_000 // 30 seconds
// Index-only mode: prompts carry a 1-line description per skill (~150 bytes each).
// Full content is fetched on-demand via the read_skill tool. Budget is now generous
// enough that no realistic project hits it — but kept as a safety rail.
const MAX_SKILL_INDEX_CHARS = 6000

// Project-level skill directories, scanned in priority order (first occurrence
// of a given skill name wins). `.toquemedia-studio/skills` is canonical — it
// mirrors the global `~/.toquemedia-studio/skills` so the project and global
// names match. `.tms/skills` (the old hard-coded path) was REMOVED — project
// skills live in `.toquemedia-studio/skills`, not `.tms`. `.toquemedia/skills`
// stays only as a legacy fallback for the name older docs once used. Layout-
// tolerant matching (nested SKILL.md or flat *.md, any case) is in
// loadSkillsFromDirectory.
const PROJECT_SKILL_DIRS = ['.toquemedia-studio/skills', '.toquemedia/skills'] as const

// Canonical location for newly-created project skills (must be one of PROJECT_SKILL_DIRS).
const CANONICAL_PROJECT_SKILL_DIR = PROJECT_SKILL_DIRS[0]

// === Invoked-skills state (post-compaction recovery) ===
//
// Mirrors claude-vaz's `STATE.invokedSkills`: when the agent calls read_skill,
// we cache the skill's full content in a module-level Map. After context
// compression collapses the conversation history (and the original tool-result
// containing the verbatim skill text), this state lets us re-inject the full
// CRITICAL blocks into the next API call so the model doesn't fall back to its
// training prior (e.g. "use GoogleAuthProvider" when the skill explicitly
// forbids it).
//
// Lifecycle: cleared at session/project boundary (chatStore.clearAllSessions);
// SURVIVES compression deliberately. Per-skill truncated to ~5K tokens (~20K
// chars) so the post-compact attachment stays bounded.
export interface InvokedSkill {
  name: string
  content: string
  invokedAt: number
}
const invokedSkills = new Map<string, InvokedSkill>()
const INVOKED_SKILL_MAX_CHARS = 20_000   // ~5K tokens per skill
const INVOKED_SKILLS_TOTAL_BUDGET = 100_000 // ~25K tokens across all skills

export function trackInvokedSkill(name: string, content: string): void {
  const trimmed = content.length > INVOKED_SKILL_MAX_CHARS
    ? content.slice(0, INVOKED_SKILL_MAX_CHARS) + '\n\n[... skill truncated for post-compaction recovery]'
    : content
  invokedSkills.set(name, { name, content: trimmed, invokedAt: Date.now() })
  // Persist to disk so a reload mid-session doesn't lose the post-compaction
  // recovery payload. Otherwise the next turn after a microcompaction
  // (which collapses tool-results) would have NO record of which skills
  // were authoritative for this session, and the agent would fall back to
  // its training prior — exactly what `invokedSkills` exists to prevent.
  schedulePersistInvokedSkills()
}

export function getInvokedSkills(): InvokedSkill[] {
  // Most-recently invoked first so truncation in caller drops the oldest.
  return Array.from(invokedSkills.values()).sort((a, b) => b.invokedAt - a.invokedAt)
}

export function clearInvokedSkills(): void {
  invokedSkills.clear()
  schedulePersistInvokedSkills()
}

/**
 * Re-seed the in-memory map from a previously-persisted set. Called at
 * session-load time so the post-compaction recovery payload survives an
 * IDE restart in the middle of a long multi-skill session.
 */
export function hydrateInvokedSkills(entries: InvokedSkill[]): void {
  invokedSkills.clear()
  for (const entry of entries) {
    invokedSkills.set(entry.name, entry)
  }
}

// === Persistence ===
//
// Per-session disk file in app-managed project state.
// Debounced 500ms — track/clear are infrequent (only fire on `read_skill`
// tool calls) so the debounce mostly serves to coalesce a burst at the
// start of a turn where the agent reads several skills back-to-back.
let invokedSkillsPersistTimeout: ReturnType<typeof setTimeout> | null = null
const INVOKED_SKILLS_PERSIST_DEBOUNCE_MS = 500

function schedulePersistInvokedSkills(): void {
  if (invokedSkillsPersistTimeout) clearTimeout(invokedSkillsPersistTimeout)
  invokedSkillsPersistTimeout = setTimeout(() => {
    invokedSkillsPersistTimeout = null
    void persistInvokedSkillsNow()
  }, INVOKED_SKILLS_PERSIST_DEBOUNCE_MS)
}

async function persistInvokedSkillsNow(): Promise<void> {
  // Lazy imports — skillService is loaded by the prompt builder and we
  // don't want to drag chatStore + queueOperationLog into its eager
  // module graph.
  const [{ useChatStore }, { saveInvokedSkillsToDisk }] = await Promise.all([
    import('../../stores/chatStore'),
    import('./invokedSkillsPersistence'),
  ])
  const state = useChatStore.getState()
  const sessionId = state.activeSessionId
  if (!sessionId) return
  const session = state.sessions.get(sessionId)
  if (!session?.projectPath) return
  await saveInvokedSkillsToDisk(session.projectPath, sessionId, getInvokedSkills())
}

/**
 * Build the post-compaction recovery payload — concatenated skill bodies with
 * a clear instruction wrapper. Bound by INVOKED_SKILLS_TOTAL_BUDGET; truncates
 * the LEAST recently invoked skills first if over budget. Returns null when no
 * skills have been invoked this session (no recovery needed).
 */
export function buildPostCompactionSkillsBlock(): string | null {
  const skills = getInvokedSkills()
  if (skills.length === 0) return null

  let total = 0
  const sections: string[] = []
  for (const skill of skills) {
    const section = `## Skill: ${skill.name}\n\n${skill.content}`
    if (total + section.length > INVOKED_SKILLS_TOTAL_BUDGET) break
    sections.push(section)
    total += section.length
  }

  return [
    '<post_compaction_skills>',
    'The conversation was compacted; verbatim skill content from earlier turns may have been summarized. The full text of the skills you previously read is restored below — TREAT IT AS AUTHORITATIVE for any decision in its domain. The CRITICAL blocks at the top of each skill apply to all code you write going forward.',
    '',
    sections.join('\n\n---\n\n'),
    '</post_compaction_skills>',
  ].join('\n')
}

// Bundled skill categories — drive mode-aware loading in isBundledSkillRelevant.
const CODE_PATTERN_SKILLS = new Set([
  'react-patterns', 'vue-patterns', 'angular-patterns', 'svelte-patterns',
  'nextjs-patterns', 'go-conventions', 'python-conventions',
])
const RICH_ARTIFACT_SKILLS = new Set([
  'pdf-document', 'docx-document', 'xlsx-spreadsheet',
  'pptx-presentation', 'slidev-presentation', 'html-document',
])
// Managed-platform skill sets (auth-proxy/google-signin, publish-backend)
// removed in the dev-only pivot (v1.0.0) — those recipes live in TM Code Web.

// parseSkillFrontmatter + MAX_DESCRIPTION_CHARS live in ./skillFrontmatter (zero-deps)
// so that scripts/verify-skills.ts can import the same implementation.

// === Service ===

class SkillService {
  private static instance: SkillService
  private cache: SkillCache | null = null

  static getInstance(): SkillService {
    if (!SkillService.instance) {
      SkillService.instance = new SkillService()
    }
    return SkillService.instance
  }

  /**
   * Loads skills from all three levels: bundled, global, project.
   * Returns cached result if within TTL and same project + mode.
   *
   * @param mode 'chat' (default) loads code-pattern skills relevant to projectType.
   *             'cmd' loads rich-artifact skills (pdf/docx/xlsx/pptx/html) plus
   *             frontend-design when applicable. Code-pattern skills are skipped
   *             in cwd-scoped prompts since those are for cross-cutting tasks,
   *             not only codebase work.
   */
  async loadSkills(
    projectPath: string,
    projectType?: string,
    mode: PromptMode = 'chat',
  ): Promise<Skill[]> {
    // Check cache — invalidate when mode changes to avoid leaking chat-only
    // skills into cmd or vice-versa. The fsVersion check catches project-
    // level skill edits without needing a per-path watcher: any write to the
    // filesystem advances fsVersion, the cache misses, project skills are
    // re-read. Cheap because the skill loaders read ~10 small markdown files.
    const { getFsVersion } = await import('../fsVersion')
    const fsVersion = getFsVersion()
    if (
      this.cache &&
      this.cache.projectPath === projectPath &&
      this.cache.mode === mode &&
      this.cache.fsVersion === fsVersion &&
      Date.now() - this.cache.timestamp < CACHE_TTL_MS
    ) {
      return this.cache.skills
    }

    const [bundled, global, project] = await Promise.all([
      this.loadBundledSkills(projectType, mode),
      this.loadGlobalSkills(),
      this.loadProjectSkills(projectPath),
    ])

    const skills = [...bundled, ...global, ...project]

    this.cache = {
      skills,
      timestamp: Date.now(),
      projectPath,
      mode,
      fsVersion,
    }

    return skills
  }

  /**
   * Invalidates the cache — call when user creates/deletes skills.
   */
  invalidateCache(): void {
    this.cache = null
  }

  /**
   * Skills the user/system has explicitly opted into for this session, even
   * when the relevance heuristic would otherwise skip them. Populated by
   * the prompt-bar hashtag handler (e.g. `#auth-google` triggers
   * `forceLoadSkill('frontend-design')`) so the `read_skill` tool, system-
   * prompt skill index, and the agent's mental model stay consistent.
   *
   * Without this, the hashtag flow would inject skill bodies inline into the
   * user prompt while `loadSkills` left them out of the cache → `read_skill`
   * returned "not loaded" → agent fell back to training-data implementation
   * and ignored the skill.
   *
   * Persists for the lifetime of the SkillService singleton (app session).
   * Cleared automatically on app restart; no API to reset mid-session today.
   */
  private forceLoadedSkillNames: Set<string> = new Set()

  /**
   * Mark a bundled skill as required for this session. Bypasses the relevance
   * heuristic in `isBundledSkillRelevant`. Invalidates the cache so the next
   * `loadSkills` call picks the skill up.
   */
  forceLoadSkill(name: string): void {
    if (this.forceLoadedSkillNames.has(name)) return
    this.forceLoadedSkillNames.add(name)
    this.invalidateCache()
  }

  /**
   * Builds the skill INDEX block for the system prompt. Each skill contributes
   * one line (name + description). Full content is fetched on demand via the
   * read_skill tool — this keeps the system prompt lean and eliminates silent
   * truncation/dropping of skills that previously caused hallucination risk.
   *
   * The mode parameter is preserved for compatibility with the mode-aware
   * `loadSkills` cache key, but no longer affects formatting (index is the same shape in both modes).
   */
  buildSkillsPromptBlock(skills: Skill[], _mode: PromptMode = 'chat'): string {
    if (skills.length === 0) return ''

    // Priority: project > global > bundled (so user-authored skills appear first in the index)
    const sorted = [...skills].sort((a, b) => {
      const priority: Record<string, number> = { project: 0, global: 1, bundled: 2 }
      return (priority[a.scope] ?? 2) - (priority[b.scope] ?? 2)
    })

    const lines: string[] = []
    let totalChars = 0
    for (const skill of sorted) {
      const scopeTag = skill.scope === 'bundled' ? '' : ` [${skill.scope}]`
      const line = `- ${skill.name}${scopeTag} — ${skill.description}`
      if (totalChars + line.length + 1 > MAX_SKILL_INDEX_CHARS) {
        // Even the index has a safety cap, but at ~150 bytes per skill it would
        // need ~40+ skills to trigger. Lower-priority entries get the cut.
        continue
      }
      lines.push(line)
      totalChars += line.length + 1
    }
    if (lines.length === 0) return ''

    return `# Skills available

The following skills are available for the current task. Each line is a one-line summary; the full content (process, examples, verification steps) is fetched on demand via the read_skill tool. Call read_skill(name) ONCE when you decide a skill is relevant — the content stays in conversation history afterward.

${lines.join('\n')}`
  }

  /**
   * Look up a loaded skill's full content by name. Used by the read_skill tool.
   * Returns null when the skill is not present in the current cache (the agent
   * should not try to read skills that were not loaded for the active context).
   */
  getCachedSkillContent(name: string): { name: string; content: string; references: string[] } | null {
    if (!this.cache) return null
    const skill = this.cache.skills.find(s => s.name === name)
    if (!skill) return null
    return {
      name: skill.name,
      content: skill.content,
      references: skill.references,
    }
  }

  /** All currently-loaded skill names (for diagnostics / tool error messages). */
  getCachedSkillNames(): string[] {
    return this.cache?.skills.map(s => s.name) ?? []
  }

  /**
   * Creates a new project-level skill.
   */
  async createProjectSkill(projectPath: string, name: string, content: string): Promise<void> {
    const skillDir = `${projectPath}/${CANONICAL_PROJECT_SKILL_DIR}`
    await this.ensureDirectory(skillDir)

    const sanitized = this.sanitizeName(name)
    const skillPath = `${skillDir}/${sanitized}`
    await this.ensureDirectory(skillPath)
    await invoke('write_file', { path: `${skillPath}/SKILL.md`, content })
    this.invalidateCache()
  }

  /**
   * Creates a new global skill.
   */
  async createGlobalSkill(name: string, content: string): Promise<void> {
    const homeDir = await invoke<string>('get_home_directory')
    const skillDir = `${homeDir}/.toquemedia-studio/skills`
    await this.ensureDirectory(skillDir)

    const sanitized = this.sanitizeName(name)
    const skillPath = `${skillDir}/${sanitized}`
    await this.ensureDirectory(skillPath)
    await invoke('write_file', { path: `${skillPath}/SKILL.md`, content })
    this.invalidateCache()
  }

  /**
   * Deletes a skill (only global and project skills).
   */
  async deleteSkill(skill: Skill): Promise<void> {
    if (skill.scope === 'bundled') {
      throw new Error('Cannot delete bundled skills')
    }
    await invoke('delete_file_or_directory', { path: skill.path })
    this.invalidateCache()
  }

  // === Private Methods ===

  private async loadBundledSkills(projectType?: string, mode: PromptMode = 'chat'): Promise<Skill[]> {
    try {
      const entries = await invoke<SkillEntry[]>('list_skills_bundled')
      const relevant = entries.filter(e => this.isBundledSkillRelevant(e.name, projectType, mode))

      // Read all relevant skills in parallel (avoids N+1 sequential IPC)
      const results = await Promise.all(
        relevant.map(async (entry): Promise<Skill | null> => {
          try {
            const content = await invoke<SkillContent>('read_skill_content', {
              skillPath: entry.path,
            })
            const parsed = parseSkillFrontmatter(content.content, entry.name)
            return {
              id: `bundled:${entry.name}`,
              name: parsed.name,
              description: parsed.description,
              path: entry.path,
              content: parsed.body,
              references: content.references,
              scope: 'bundled',
            }
          } catch {
            return null
          }
        })
      )

      return results.filter((s): s is Skill => s !== null)
    } catch {
      return []
    }
  }

  private async loadGlobalSkills(): Promise<Skill[]> {
    try {
      const homeDir = await invoke<string>('get_home_directory')
      const skillsDir = `${homeDir}/.toquemedia-studio/skills`
      // Ensure the global skills dir EXISTS so users always have a discoverable
      // place to drop skills. It was only ever created lazily by createGlobalSkill
      // (when a skill is made through the app), so a user who wants to add global
      // skills by hand had no folder to put them in. ensureDirectory is idempotent.
      await this.ensureDirectory(skillsDir)
      return await this.loadSkillsFromDirectory(skillsDir, 'global')
    } catch {
      return []
    }
  }

  private async loadProjectSkills(projectPath: string): Promise<Skill[]> {
    try {
      // Scan every accepted project-skill dir and merge (first name wins).
      const perDir = await Promise.all(
        PROJECT_SKILL_DIRS.map(rel =>
          this.loadSkillsFromDirectory(`${projectPath}/${rel}`, 'project'),
        ),
      )
      return this.dedupeByName(perDir.flat())
    } catch {
      return []
    }
  }

  /** First occurrence of each skill name wins. Scan/priority order is the
   *  caller's responsibility (project dirs are ordered by PROJECT_SKILL_DIRS;
   *  within one dir, a nested SKILL.md beats a flat `<name>.md` of the same name). */
  private dedupeByName(skills: Skill[]): Skill[] {
    const seen = new Set<string>()
    const out: Skill[] = []
    for (const s of skills) {
      const key = s.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(s)
    }
    return out
  }

  /**
   * Layout-tolerant skill discovery for a single directory.
   *
   * A user may legitimately lay a skill out as any of:
   *   <dir>/<name>/SKILL.md   — canonical, nested (case-insensitive: SKILL.md or skill.md)
   *   <dir>/<name>.md         — flat single-file skill (what older docs showed)
   *
   * The shared Rust glob is CASE-SENSITIVE and a star never crosses a slash, so an
   * exact "star-slash-SKILL.md" pattern silently missed every non-canonical layout —
   * that was the v1.0.1 "skills not found" bug. We instead glob the broad shapes
   * (one-level "star/star.md" and flat "star.md") and derive names / filter in JS,
   * which also avoids changing the shared glob's case sensitivity for every other caller.
   */
  private async loadSkillsFromDirectory(
    directory: string,
    scope: 'global' | 'project'
  ): Promise<Skill[]> {
    try {
      const [nestedMd, flatMd] = await Promise.all([
        invoke<string[]>('glob_files', { pattern: '*/*.md', directory }).catch(() => [] as string[]),
        invoke<string[]>('glob_files', { pattern: '*.md', directory }).catch(() => [] as string[]),
      ])

      const isSkillFile = (p: string) => /(^|\/)skill\.md$/i.test(p)

      // Nested: keep only <name>/SKILL.md (any case). Its parent dir IS the skill
      // (and may carry a references/ folder). `*/*.md` can never reach a nested
      // references/*.md (that's two levels deep), so those aren't mistaken for skills.
      const nested = nestedMd.filter(isSkillFile).map(skillFilePath => {
        const skillDir = skillFilePath.replace(/\/[^/]+$/, '')
        return {
          skillFilePath,
          skillPath: skillDir,
          refsDir: skillDir as string | null,
          name: skillDir.split('/').pop() || '',
        }
      })
      const nestedNames = new Set(nested.map(n => n.name.toLowerCase()))

      // Flat: each `<name>.md` directly in the dir is a single-file skill. Skip a
      // stray top-level SKILL.md and anything already covered by a nested skill dir.
      const flat = flatMd
        .filter(p => !isSkillFile(p))
        .map(skillFilePath => ({
          skillFilePath,
          skillPath: skillFilePath, // a single file — Skill.path must be the file, not the dir
          refsDir: null as string | null,
          name: (skillFilePath.split('/').pop() || '').replace(/\.md$/i, ''),
        }))
        .filter(f => f.name && !nestedNames.has(f.name.toLowerCase()))

      const candidates = [...nested, ...flat]
      if (candidates.length === 0) return []

      const results = await Promise.all(
        candidates.map(c =>
          this.loadSkillFromFile(c.skillFilePath, c.skillPath, c.refsDir, c.name, scope),
        ),
      )
      const skills = this.dedupeByName(results.filter((s): s is Skill => s !== null))
      if (skills.length > 0) {
        console.info(`[skills] loaded ${skills.length} ${scope} skill(s) from ${directory}`)
      }
      return skills
    } catch {
      return []
    }
  }

  /** Read + parse one skill file. `skillPath` is what lands in Skill.path (the
   *  skill dir for nested skills, the file itself for flat ones — so deleteSkill
   *  never nukes a whole directory for a single-file skill). `refsDir` is the
   *  directory whose `references/*.md` are attached, or null for flat skills. */
  private async loadSkillFromFile(
    skillFilePath: string,
    skillPath: string,
    refsDir: string | null,
    name: string,
    scope: 'bundled' | 'global' | 'project',
  ): Promise<Skill | null> {
    try {
      const content = await invoke<string>('read_file', { path: skillFilePath })

      let references: string[] = []
      if (refsDir) {
        try {
          const refFiles = await invoke<string[]>('glob_files', {
            pattern: '*.md',
            directory: `${refsDir}/references`,
          })
          const refContents = await Promise.all(
            refFiles.map(refPath =>
              invoke<string>('read_file', { path: refPath }).catch(() => null),
            ),
          )
          references = refContents.filter((r): r is string => r !== null)
        } catch {
          // No references directory
        }
      }

      const parsed = parseSkillFrontmatter(content, name)
      return {
        id: `${scope}:${name}`,
        name: parsed.name,
        description: parsed.description,
        path: skillPath,
        content: parsed.body,
        references,
        scope,
      }
    } catch {
      return null
    }
  }

  /**
   * Decide whether a bundled skill makes it into the system-prompt index.
   *
   * Design principle: keep this gate MINIMAL. It exists to filter out skills
   * whose tool surface doesn't match the active prompt surface (e.g. PDF
   * authoring without direct disk-write support) — NOT to second-guess relevance. The
   * skill description in the index is self-explanatory; the model decides
   * via `read_skill` whether to load the body. We add ~150B per skill in
   * the index — trivial cost vs the real cost of silently dropping a useful
   * skill (training-data fallback, mediocre output).
   *
   * Heuristics that gate by `projectType` only earn their keep when the
   * filter is genuinely orthogonal (vue-patterns vs react codebase). Even
   * then, fresh/empty projects fall back to "show everything" — the model
   * is about to scaffold and needs to see the options.
   */
  private isBundledSkillRelevant(
    skillName: string,
    projectType?: string,
    mode: PromptMode = 'chat',
  ): boolean {
    // Force-loaded skills bypass every other gate — used by hashtag flows
    // (e.g. `#auth-google`) that pre-commit the agent to a workflow.
    if (this.forceLoadedSkillNames.has(skillName)) return true

    // general-coding is always relevant — cross-cutting hygiene.
    if (skillName === 'general-coding') return true

    // Rich-artifact skills (PDF, Word, Excel, PPT, HTML) require direct disk
    // writes and the full local tool surface. This is a real capabilities gate,
    // not a relevance heuristic.
    if (RICH_ARTIFACT_SKILLS.has(skillName)) {
      return mode === 'cmd'
    }

    // frontend-design: bundled skill, always indexed. Earlier this was gated
    // behind `#design` (force-load only) because we assumed the model wouldn't
    // discover it spontaneously. Empirical evidence showed otherwise — when
    // taste-defaults / read_skill descriptions mention `frontend-design` by
    // name, the model calls `read_skill('frontend-design')` on its own for
    // "polished UI", "Chakra UI", landing/dashboard prompts. The gate caused
    // read_skill misfires (skill exists in bundle, hidden from index → tool
    // returns "not available" → model falls back to react-patterns and
    // generic AI aesthetics). Removing the gate lets discovery succeed.
    // Overuse is bounded by the taste-defaults block in sharedSections.ts
    // which instructs restraint unless the task calls for motion / typography.
    // `#design` is still the strongest signal: authCommand inlines the skill
    // body verbatim, planCommand pins it in Platform Requirements.

    // Code-pattern skills (react-patterns, vue-patterns, …) — chat-only.
    // Project-type filter IS load-bearing here: a vue-patterns entry in a
    // confirmed react codebase is genuine noise. BUT for empty/unknown
    // projects (no manifest yet → projectType undefined), show all — the
    // agent is about to scaffold and needs to see the options before
    // committing to a stack.
    if (CODE_PATTERN_SKILLS.has(skillName)) {
      if (mode !== 'chat') return false
      if (!projectType) return true  // empty/fresh project: model picks
      const mapping: Record<string, string[]> = {
        react: ['react-patterns'],
        vue: ['vue-patterns'],
        angular: ['angular-patterns'],
        svelte: ['svelte-patterns'],
        nextjs: ['nextjs-patterns', 'react-patterns'],
        nuxt: ['vue-patterns'],
        node: [],
        go: ['go-conventions'],
        python: ['python-conventions'],
      }
      return (mapping[projectType] || []).includes(skillName)
    }

    return false
  }

  /**
   * Build the full skill response for the read_skill tool: skill body + references.
   * Wrapped in tags so the agent treats it as authoritative content.
   */
  formatSkillForReading(skill: { name: string; content: string; references: string[] }): string {
    let block = `<skill name="${skill.name}">\n${skill.content}`
    if (skill.references.length > 0) {
      block += '\n\n---\nReferences:\n' + skill.references.join('\n---\n')
    }
    block += '\n</skill>'
    return block
  }

  private sanitizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
  }

  private async ensureDirectory(path: string): Promise<void> {
    try {
      await invoke('create_directories_all', { path })
    } catch {
      // Directory may already exist
    }
  }
}

export default SkillService
