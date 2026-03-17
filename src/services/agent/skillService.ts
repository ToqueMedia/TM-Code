import { invoke } from '@tauri-apps/api/core'

// === Types ===

export interface Skill {
  id: string
  name: string
  path: string
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
}

// === Constants ===

const CACHE_TTL_MS = 30_000 // 30 seconds
const MAX_SKILLS_CHARS = 8000 // ~2K tokens budget

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
   * Returns cached result if within TTL and same project.
   */
  async loadSkills(projectPath: string, projectType?: string): Promise<Skill[]> {
    // Check cache
    if (
      this.cache &&
      this.cache.projectPath === projectPath &&
      Date.now() - this.cache.timestamp < CACHE_TTL_MS
    ) {
      return this.cache.skills
    }

    const [bundled, global, project] = await Promise.all([
      this.loadBundledSkills(projectType),
      this.loadGlobalSkills(),
      this.loadProjectSkills(projectPath),
    ])

    const skills = [...bundled, ...global, ...project]

    this.cache = {
      skills,
      timestamp: Date.now(),
      projectPath,
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
   * Builds a <skills> tagged block for injection into the system prompt.
   * Respects the MAX_SKILLS_CHARS budget, truncating bundled skills first.
   */
  buildSkillsPromptBlock(skills: Skill[]): string {
    if (skills.length === 0) return ''

    // Priority: project > global > bundled
    const sorted = [...skills].sort((a, b) => {
      const priority: Record<string, number> = { project: 0, global: 1, bundled: 2 }
      return (priority[a.scope] ?? 2) - (priority[b.scope] ?? 2)
    })

    const parts: string[] = []
    let totalChars = 0

    for (const skill of sorted) {
      const block = this.formatSkillBlock(skill)
      if (totalChars + block.length > MAX_SKILLS_CHARS) {
        // Skip lower-priority skills if we'd exceed budget
        continue
      }
      parts.push(block)
      totalChars += block.length
    }

    if (parts.length === 0) return ''

    return `<skills>\n${parts.join('\n\n')}\n</skills>`
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

  private async loadBundledSkills(projectType?: string): Promise<Skill[]> {
    try {
      const entries = await invoke<SkillEntry[]>('list_skills_bundled')
      const relevant = entries.filter(e => this.isBundledSkillRelevant(e.name, projectType))

      // Read all relevant skills in parallel (avoids N+1 sequential IPC)
      const results = await Promise.all(
        relevant.map(async (entry): Promise<Skill | null> => {
          try {
            const content = await invoke<SkillContent>('read_skill_content', {
              skillPath: entry.path,
            })
            return {
              id: `bundled:${entry.name}`,
              name: entry.name,
              path: entry.path,
              content: content.content,
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

            return { id: `${scope}:${name}`, name, path: skillDir, content, references, scope }
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

  private isBundledSkillRelevant(skillName: string, projectType?: string): boolean {
    // general-coding is always relevant
    if (skillName === 'general-coding') return true

    // If no project type detected, only include general
    if (!projectType) return false

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

    const relevant = mapping[projectType] || []
    return relevant.includes(skillName)
  }

  private formatSkillBlock(skill: Skill): string {
    let block = `<skill name="${skill.name}" scope="${skill.scope}">\n${skill.content}`
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
