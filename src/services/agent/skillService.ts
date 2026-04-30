import { invoke } from '@tauri-apps/api/core'
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
}

export type PromptMode = 'chat' | 'cmd'

// === Constants ===

const CACHE_TTL_MS = 30_000 // 30 seconds
// Index-only mode: prompts carry a 1-line description per skill (~150 bytes each).
// Full content is fetched on-demand via the read_skill tool. Budget is now generous
// enough that no realistic project hits it — but kept as a safety rail.
const MAX_SKILL_INDEX_CHARS = 6000

// Bundled skill categories — drive mode-aware loading in isBundledSkillRelevant.
const CODE_PATTERN_SKILLS = new Set([
  'react-patterns', 'vue-patterns', 'angular-patterns', 'svelte-patterns',
  'nextjs-patterns', 'go-conventions', 'python-conventions',
])
const RICH_ARTIFACT_SKILLS = new Set([
  'pdf-document', 'docx-document', 'xlsx-spreadsheet',
  'pptx-presentation', 'slidev-presentation', 'html-document',
])
const FRONTEND_PROJECT_TYPES = new Set([
  'react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxt',
])
// Auth-scaffolding skills. Index-only entries (~150B in prompt each); the agent
// only fetches the body via read_skill if it decides to wire up auth. Loaded
// for any frontend project so the agent knows the recipe is available.
const AUTH_SKILLS = new Set(['auth-proxy-gip', 'google-signin'])

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
   *             in cmd mode since CMD is for cross-cutting tasks, not codebase work.
   */
  async loadSkills(
    projectPath: string,
    projectType?: string,
    mode: PromptMode = 'chat',
  ): Promise<Skill[]> {
    // Check cache — invalidate when mode changes to avoid leaking chat-only skills into cmd or vice-versa
    if (
      this.cache &&
      this.cache.projectPath === projectPath &&
      this.cache.mode === mode &&
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
    const skillDir = `${projectPath}/.tms/skills`
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
      return await this.loadSkillsFromDirectory(skillsDir, 'global')
    } catch {
      return []
    }
  }

  private async loadProjectSkills(projectPath: string): Promise<Skill[]> {
    try {
      const skillsDir = `${projectPath}/.tms/skills`
      return await this.loadSkillsFromDirectory(skillsDir, 'project')
    } catch {
      return []
    }
  }

  private async loadSkillsFromDirectory(
    directory: string,
    scope: 'global' | 'project'
  ): Promise<Skill[]> {
    try {
      const entries = await invoke<string[]>('glob_files', {
        pattern: '*/SKILL.md',
        directory,
      })

      // Read all skills in parallel (avoids N+1 sequential IPC)
      const results = await Promise.all(
        entries.map(async (skillFilePath): Promise<Skill | null> => {
          const skillDir = skillFilePath.replace(/\/SKILL\.md$/, '')
          const name = skillDir.split('/').pop() || ''

          try {
            const content = await invoke<string>('read_file', { path: skillFilePath })

            // Try to read references in parallel too
            let references: string[] = []
            try {
              const refFiles = await invoke<string[]>('glob_files', {
                pattern: '*.md',
                directory: `${skillDir}/references`,
              })
              const refContents = await Promise.all(
                refFiles.map(refPath =>
                  invoke<string>('read_file', { path: refPath }).catch(() => null)
                )
              )
              references = refContents.filter((r): r is string => r !== null)
            } catch {
              // No references directory
            }

            const parsed = parseSkillFrontmatter(content, name)
            return {
              id: `${scope}:${name}`,
              name: parsed.name,
              description: parsed.description,
              path: skillDir,
              content: parsed.body,
              references,
              scope,
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

  private isBundledSkillRelevant(
    skillName: string,
    projectType?: string,
    mode: PromptMode = 'chat',
  ): boolean {
    // general-coding is always relevant in both modes — it carries cross-cutting hygiene rules.
    if (skillName === 'general-coding') return true

    // Rich-artifact skills are CMD-only: they assume direct disk writes and broader scope
    // (PDF, Word, Excel, PowerPoint, HTML deliverables) that don't belong in code-focused chat.
    if (RICH_ARTIFACT_SKILLS.has(skillName)) {
      return mode === 'cmd'
    }

    // frontend-design loads in BOTH modes when working with a frontend project,
    // and always in CMD (CMD users may scaffold UI ad-hoc outside a typed project).
    if (skillName === 'frontend-design') {
      if (mode === 'cmd') return true
      return projectType ? FRONTEND_PROJECT_TYPES.has(projectType) : false
    }

    // Auth-scaffolding skills (auth-proxy-gip, google-signin): chat-only, frontend
    // projects only. The agent reads the index entry and only fetches the body
    // via read_skill when the user asks for login/auth.
    if (AUTH_SKILLS.has(skillName)) {
      if (mode !== 'chat' || !projectType) return false
      return FRONTEND_PROJECT_TYPES.has(projectType)
    }

    // Code-pattern skills (react-patterns, vue-patterns, …) are CHAT-only — they apply
    // to ongoing codebase work, not to one-off CMD tasks.
    if (CODE_PATTERN_SKILLS.has(skillName)) {
      if (mode !== 'chat' || !projectType) return false
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
