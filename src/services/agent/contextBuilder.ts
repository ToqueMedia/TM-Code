import { invoke } from '@tauri-apps/api/core'
import { TemplateManifest } from '../templateService'
import { detectSystemPackageManager } from '../packageManagerDetector'
import SkillService from './skillService'

interface MCPToolSummary {
  name: string
  description: string
  serverName: string
}

interface PackageSummary {
  name: string
  scripts: string[]
  dependencies: string[]
  devDependencies: string[]
  packageManager: string
}

/**
 * Sanitize user-controlled content before embedding in the system prompt.
 * Prevents prompt injection via project files (README.md, TMS.md, etc.)
 * by escaping XML-like tags that could confuse section boundaries.
 */
function sanitizeProjectContent(content: string): string {
  return content
    .replace(/</g, '＜')
    .replace(/>/g, '＞')
}

class ContextBuilder {
  private static instance: ContextBuilder

  static getInstance(): ContextBuilder {
    if (!ContextBuilder.instance) {
      ContextBuilder.instance = new ContextBuilder()
    }
    return ContextBuilder.instance
  }

  async buildSystemPrompt(projectPath: string, projectType: string, mcpTools?: MCPToolSummary[], coreToolCount?: number): Promise<string> {
    // Gather context in parallel for speed
    const [treeString, pkgSummary, readme, templateManifest, tmsContent, planContent, todoContent] = await Promise.all([
      this.buildFileTree(projectPath),
      this.extractPackageSummary(projectPath),
      this.safeReadFile(`${projectPath}/README.md`),
      this.readTemplateManifest(projectPath),
      this.safeReadFile(`${projectPath}/TMS.md`),
      this.safeReadFile(`${projectPath}/PLAN.md`),
      this.safeReadFile(`${projectPath}/TODO.md`),
    ])

    const pmDetected = pkgSummary?.packageManager || await this.detectPackageManager(projectPath)
    const isTemplateProject = templateManifest !== null
    const hasFrameworkDeps = pkgSummary
      ? [...pkgSummary.dependencies, ...pkgSummary.devDependencies].some(d =>
          ['react', 'next', 'vue', 'nuxt', 'svelte', '@angular/core', 'astro', 'solid-js', 'express', 'fastify', '@nestjs/core'].includes(d)
        )
      : false
    const isVanillaWeb = !isTemplateProject && !hasFrameworkDeps

    // === U-Curve: critical constraints at START and END, context data in the middle ===

    const sections: string[] = []

    // ── 1. COMPLETION CONTRACT (primacy) ──
    sections.push(`<completion_rule>
Complete every file the task requires. No placeholders — output goes to disk as-is. Omitted code is deleted code.
</completion_rule>`)

    // ── 2. ROLE ──
    const agentLangMap: Record<string, string> = {
      en: 'English', pt: 'Portuguese', zh: '中文', es: 'Español', fr: 'Français', de: 'Deutsch', ja: '日本語'
    }
    let agentLang = 'en'
    try {
      const { useSettingsStore } = await import('../../stores/settingsStore')
      agentLang = useSettingsStore.getState().agentLanguage || 'en'
    } catch {}
    const langInstruction = agentLang === 'en'
      ? 'Respond in English.'
      : `Always respond in ${agentLangMap[agentLang] || agentLangMap.en}. All explanations, comments, and messages must be in ${agentLangMap[agentLang] || agentLangMap.en}. Code identifiers remain in English.`

    // Load model profile for model-specific behavior
    let modelProfile: import('./modelProfiles').ModelProfile | null = null
    try {
      const { getModelProfile } = await import('./modelProfiles')
      const { useSettingsStore } = await import('../../stores/settingsStore')
      const modelId = useSettingsStore.getState().agentModel || 'deepseek-v3.2'
      modelProfile = getModelProfile(modelId)
    } catch { /* fallback: no profile */ }

    // Minimal system prompt for models that degrade with verbose system prompts (DeepSeek in thinking mode).
    // Include only: role, environment (factual data the model needs), constraints, file tree.
    // Skip: examples, standards, memory, skills, verbose role description.
    const isMinimalPrompt = modelProfile?.skipSystemPromptInThinking && modelProfile?.supportsThinking
    if (isMinimalPrompt) {
      // U-Curve: completion rule at START
      // (sections[0] is already <completion_rule> — pushed above)

      sections.push(`<role>Senior software engineer. Autonomous coding agent in TM Code IDE. ${langInstruction}</role>`)

      const minEnv = [`project_path: ${projectPath}`, `package_manager: ${pmDetected}`]
      if (pkgSummary) {
        if (pkgSummary.scripts.length) minEnv.push(`scripts: ${pkgSummary.scripts.join(', ')}`)
        if (pkgSummary.dependencies.length) minEnv.push(`deps: ${pkgSummary.dependencies.join(', ')}`)
      }
      sections.push(`<environment>\n${minEnv.join('\n')}\n</environment>`)
      sections.push(`<project_structure>\n${treeString}\n</project_structure>`)

      sections.push(`<constraints>
- All paths absolute under "${projectPath}". write_file replaces entire file. No placeholders.
- Frontend port 7773, backend port 7777. Backend binds 0.0.0.0.
- .env files blocked. Use ${pmDetected} for packages.
</constraints>`)

      // U-Curve: reminder at END
      sections.push(`<reminder>Complete every file. No placeholders. .env blocked. Use ${pmDetected}.</reminder>`)
      return sections.join('\n\n')
    }

    sections.push(`<role>
Senior software engineer. Autonomous coding agent inside TM Code — an agent-first IDE where the developer interacts through chat. Your code changes appear as diffs for the developer to approve or reject. You write complete, production-quality code.
If a task is ambiguous or you lack information to proceed safely, ask the developer for clarification instead of guessing.
${langInstruction}
</role>`)

    // ── 2b. MODEL-SPECIFIC INSTRUCTIONS ──
    if (modelProfile?.modelSpecificPrompt) {
      sections.push(`<model_instructions>\n${modelProfile.modelSpecificPrompt}\n</model_instructions>`)
    }

    // ── 3. TEMPLATE CONTEXT (before environment — sets the mental model for the project) ──
    if (templateManifest) {
      sections.push(`<template_context>
This project was scaffolded from the "${templateManifest.name}" template.
Framework: ${templateManifest.framework}
Dev command: ${templateManifest.devCommand}
Install command: ${templateManifest.installCommand}
The base structure is in place. Build on top of it. Use the framework's entry points and conventions.
</template_context>`)
    }

    // ── 4. ENVIRONMENT (long context data) ──
    const envLines = [
      `project_path: ${projectPath}`,
      `project_type: ${projectType}`,
      `os: macOS (Tauri 2)`,
      `package_manager: ${pmDetected}`,
    ]
    if (pkgSummary) {
      envLines.push(`name: ${pkgSummary.name}`)
      if (pkgSummary.scripts.length) envLines.push(`scripts: ${pkgSummary.scripts.join(', ')}`)
      if (pkgSummary.dependencies.length) envLines.push(`deps: ${pkgSummary.dependencies.join(', ')}`)
    }
    sections.push(`<environment>\n${envLines.join('\n')}\n</environment>`)

    sections.push(`<project_structure>\n${treeString}\n</project_structure>`)

    // ── Git commit signature ──
    sections.push(`<git_rules>
When making git commits, ALWAYS append this co-author trailer to the commit message:

Co-Authored-By: TM Code <tm.code@toquemedia.net>

Example: git commit -m "feat: add user auth

Co-Authored-By: TM Code <tm.code@toquemedia.net>"
</git_rules>`)

    if (readme) {
      sections.push(`<readme_summary>\n${sanitizeProjectContent(readme.slice(0, 400))}\n</readme_summary>`)
    }

    // ── 5. PROJECT MEMORY — TMS.md, PLAN.md, TODO.md ──
    // Content is sanitized to prevent prompt injection via project files.
    if (tmsContent) {
      const truncatedTms = tmsContent.length > 6000
        ? tmsContent.slice(0, 6000) + '\n\n[... truncated — read TMS.md for full content]'
        : tmsContent
      sections.push(`<project_memory>\n${sanitizeProjectContent(truncatedTms)}\n</project_memory>`)
    }
    if (planContent) {
      const truncatedPlan = planContent.length > 4000
        ? planContent.slice(0, 4000) + '\n\n[... plan truncated — read PLAN.md for full content]'
        : planContent
      sections.push(`<active_plan>\n${sanitizeProjectContent(truncatedPlan)}\n</active_plan>`)
    }
    if (todoContent) {
      const truncatedTodo = todoContent.length > 2000
        ? todoContent.slice(0, 2000) + '\n\n[... task list truncated — read TODO.md for full content]'
        : todoContent
      sections.push(`<task_list>\n${sanitizeProjectContent(truncatedTodo)}\n</task_list>`)
    }
    if (tmsContent) {
      sections.push(`<memory_instructions>
Keep TMS.md updated with milestones (with dates) and architectural decisions (with rationale) as you complete work. Preserve the "Project Analysis" and "Custom Instructions" sections as-is.
</memory_instructions>`)
    }

    // ── 6. SKILLS ──
    try {
      const detectedType = this.detectProjectType(pkgSummary)
        ?? await this.detectProjectTypeFromFiles(projectPath)
      const skillService = SkillService.getInstance()
      const skills = await skillService.loadSkills(projectPath, detectedType)
      const skillsBlock = skillService.buildSkillsPromptBlock(skills)
      if (skillsBlock) {
        sections.push(skillsBlock)
      }
    } catch {
      // Skills are optional — don't break prompt building
    }

    // ── 7. CONSTRAINTS (WHAT contract — boundaries the agent must respect) ──
    sections.push(`<constraints>
Files:
- All paths absolute, starting with "${projectPath}". Operations outside this directory are blocked.
- Read files before modifying them. For new files, write directly.
- write_file replaces the entire file — omitted code is deleted. Use edit_file for small changes.
- Output complete code — placeholders ("...", "// rest of code") become literal text on disk.
- File changes require developer approval via diff UI. Wait for confirmation before assuming changes were applied.
- create_file is for new files only. Use write_file to overwrite existing files.

Dev servers:
- Frontend → port 7773, server_type: "frontend" (opens iframe preview).
- Backend → port 7777, server_type: "backend" (opens HTTP Client panel).
- server_type is required. The IDE sets the PORT env var automatically.
- Backend servers bind to "0.0.0.0" because the project may run inside Docker where localhost is unreachable.
- Use only ports 7773 and 7777 — these are the only mapped ports.

Safety:
- .env files are mechanically blocked by the IDE (all operations rejected) because they contain secrets. Ask the developer for env var values. You may create .env.example with placeholders.
- .pem, .key, credentials.json, .npmrc, *_secret* files require explicit developer authorization.
- Keep secrets out of text output and tool arguments.

Commands:
- Use the package_manager shown in <environment> for all install/run/add commands.
- Install all dependencies in a single command. Add everything to package.json first, then run install once.
- The system blocks duplicate install commands automatically — move on after a successful install.

Judgment:
- Modify only what the task requires. Preserve untouched code as-is.
- When an approach fails, try a different strategy. When a tool error occurs, read the message and adapt. After two failures, ask the developer.
</constraints>`)

    // ── 8. TOOL SEMANTICS (only non-obvious gotchas the model can't infer from schemas) ──
    const activeMcpTools = mcpTools || []
    const totalTools = (coreToolCount ?? 15) + activeMcpTools.length
    const mcpSection = activeMcpTools.length > 0
      ? `\nMCP tools (external — require developer approval):\n${activeMcpTools.map(t => `- mcp__${t.serverName}__${t.name} → ${t.description}`).join('\n')}`
      : ''

    sections.push(`<tool_semantics>
${totalTools} tools available. Non-obvious behavior you cannot infer from tool schemas:
- execute_command: blocks until the process exits. start_dev_server: returns immediately, runs in background.
- edit_file: replaces a specific string in a file — safer for small changes (~20 lines).
- research: parallel sub-agent with read+write access. Blocks your turn until complete.
- spawn_background_agent: read-only sub-agent. Runs independently, does not block your turn. Results via check_background_agents.
- Only one dev server at a time. Starting a new one stops the previous.${mcpSection}
</tool_semantics>`)

    // ── 8b. BACKGROUND AGENTS STATUS ──
    try {
      const { useBackgroundAgentStore } = await import('../../stores/backgroundAgentStore')
      const bgAgents = useBackgroundAgentStore.getState().getAll()
      if (bgAgents.length > 0) {
        const statusLines = bgAgents.map(a => {
          if (a.status === 'completed') return `- [DONE] "${a.question}": ${a.result?.slice(0, 500)}`
          if (a.status === 'running') return `- [RUNNING] "${a.question}" (${a.progressText})`
          return `- [${a.status.toUpperCase()}] "${a.question}"`
        })
        sections.push(`<background_agents>\n${statusLines.join('\n')}\n</background_agents>`)
      }
    } catch { /* store not loaded yet */ }

    // ── 9. OUTPUT FORMAT ──
    sections.push(`<output_format>
- Lead with action: call the tool first, explain briefly after (1-2 sentences).
- The developer reads diffs for details — do not narrate code changes line by line.
- When creating multiple files: create all files first, then summarize what was built.
- Code comments: only where logic is non-obvious. One line per comment block, no inline narration.
</output_format>`)

    // ── 10. FEW-SHOT EXAMPLES ──
    sections.push(`<examples>
<example>
<user_prompt>Cria uma calculadora com HTML e CSS</user_prompt>
<assistant_output>
Vou criar os ficheiros da calculadora.
[creates index.html — structure and buttons]
[creates style.css — grid layout, dark theme]
Pronto. Dois ficheiros: index.html com a estrutura e botões, style.css com layout em grid e tema escuro.
</assistant_output>
</example>

<example>
<user_prompt>Fix the bug in the login form</user_prompt>
<assistant_output>
Let me read the login component.
[reads Login.tsx]
The submit handler isn't preventing default — fixing it.
[edits Login.tsx — adds e.preventDefault()]
Fixed. The form was reloading because e.preventDefault() was missing in handleSubmit.
</assistant_output>
</example>

<example>
<user_prompt>Add a dark mode toggle to the header</user_prompt>
<assistant_output>
Let me check the header and styles.
[reads Header.tsx]
[searches for CSS files]
[edits Header.tsx — adds toggle button and theme logic]
[edits global.css — adds CSS variables for dark mode]
Done. Dark mode toggle in Header, switches CSS variables on root. Light is default, persists in localStorage.
</assistant_output>
</example>

<example>
<user_prompt>Cria uma API REST de tarefas com Express</user_prompt>
<assistant_output>
Vou criar a API com Express e TypeScript.
[creates package.json — express, typescript, tsx; "dev": "tsx watch src/index.ts"]
[creates src/index.ts — PORT from env var, binds 0.0.0.0]
[creates src/routes/tasks.ts — CRUD endpoints]
[installs dependencies]
[starts dev server as backend]
API criada: index.ts (Express, porta 7777, bind 0.0.0.0), routes/tasks.ts (CRUD), package.json. HTTP Client abriu — teste GET /api/tasks.
</assistant_output>
</example>
</examples>`)

    // ── 11. ERROR RECOVERY ──
    sections.push(`<error_recovery>
When a tool call fails or code breaks after your edit:
1. Read the error message — identify the specific violation.
2. Fix only the broken part. Do not regenerate the entire file.
3. Verify the fix addresses the specific error before moving on.
</error_recovery>`)

    // ── 12. QUALITY STANDARDS (WHAT — outcomes, not implementation) ──
    const vanillaWebRule = isVanillaWeb
      ? `\nVanilla web projects (no framework/bundler):\n- Use index.html as entry point. Link CSS/JS via relative paths — the IDE inlines them for preview.\n`
      : ''

    sections.push(`<standards>
${vanillaWebRule}UI quality:
- The developer sees a live preview. Ship polished, styled UI.
- Default to a modern dark theme with good contrast, spacing, and transitions.
- Make opinionated design choices — professional look with intentional colors, typography, and layout.

Existing projects:
- Match existing code style. Preserve untouched code as-is.

Debugging:
- Diagnose before fixing. Fix only the broken part.
</standards>`)

    // ── 12. REMINDER (recency — U-Curve) ──
    sections.push(`<reminder>
1. Complete every file — output goes to disk as-is.
2. Dev servers: server_type "frontend" → 7773, "backend" → 7777. Backend binds 0.0.0.0.
3. .env files are blocked — ask the developer for values.
4. Use ${pmDetected} for all package operations.
5. Read the error, fix only the broken part, verify.
</reminder>`)

    return sections.join('\n\n')
  }

  private detectProjectType(pkg: PackageSummary | null): string | undefined {
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
  private async detectProjectTypeFromFiles(projectPath: string): Promise<string | undefined> {
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
        const content = await this.safeReadFile(`${projectPath}/${file}`)
        return content !== null ? type : null
      })
    )

    return results.find(t => t !== null) ?? undefined
  }

  private async buildFileTree(projectPath: string): Promise<string> {
    try {
      const fileTree = await invoke('build_file_tree', {
        rootPath: projectPath,
        filter: { showHidden: false, maxDepth: 2 }
      })
      return this.formatFileTree(fileTree as Record<string, unknown>)
    } catch {
      return '(Could not read project structure)'
    }
  }

  private async extractPackageSummary(projectPath: string): Promise<PackageSummary | null> {
    const raw = await this.safeReadFile(`${projectPath}/package.json`)
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
  private async readTemplateManifest(projectPath: string): Promise<TemplateManifest | null> {
    const raw = await this.safeReadFile(`${projectPath}/.toquemedia-template`)
    if (!raw) return null

    try {
      return JSON.parse(raw) as TemplateManifest
    } catch {
      return null
    }
  }

  private async detectPackageManager(projectPath: string): Promise<string> {
    // 1. Check lock files for existing projects (respect user's choice)
    const checks = [
      { file: 'pnpm-lock.yaml', pm: 'pnpm' },
      { file: 'bun.lockb', pm: 'bun' },
      { file: 'yarn.lock', pm: 'yarn' },
      { file: 'package-lock.json', pm: 'npm' },
    ]

    const results = await Promise.all(
      checks.map(async ({ file, pm }) => {
        const content = await this.safeReadFile(`${projectPath}/${file}`)
        return content !== null ? pm : null
      })
    )

    const fromLockFile = results.find(pm => pm !== null)
    if (fromLockFile) return fromLockFile

    // 2. No lock file (new/empty project) — use fastest PM available on system
    return detectSystemPackageManager()
  }

  private async safeReadFile(path: string): Promise<string | null> {
    try {
      return await invoke<string>('read_file', { path })
    } catch {
      return null
    }
  }

  private formatFileTree(node: Record<string, unknown>, indent: string = ''): string {
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
        result += this.formatFileTree(child, childIndent)
      }
    }

    return result
  }
}

export default ContextBuilder
