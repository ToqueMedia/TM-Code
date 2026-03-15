import { invoke } from '@tauri-apps/api/core'

interface PackageSummary {
  name: string
  scripts: string[]
  dependencies: string[]
  devDependencies: string[]
  packageManager: string
}

class ContextBuilder {
  private static instance: ContextBuilder

  static getInstance(): ContextBuilder {
    if (!ContextBuilder.instance) {
      ContextBuilder.instance = new ContextBuilder()
    }
    return ContextBuilder.instance
  }

  async buildSystemPrompt(projectPath: string, projectType: string): Promise<string> {
    // Gather context in parallel for speed
    const [treeString, pkgSummary, readme] = await Promise.all([
      this.buildFileTree(projectPath),
      this.extractPackageSummary(projectPath),
      this.safeReadFile(`${projectPath}/README.md`),
    ])

    // Detect package manager from lock files
    const pmDetected = pkgSummary?.packageManager || await this.detectPackageManager(projectPath)

    // === Build prompt following U-Curve: critical rules at START + REMINDER at END ===

    const sections: string[] = []

    // ── 1. COMPLETION RULE (primacy — U-Curve) ──
    sections.push(`<completion_rule>
Complete every file the task requires. Do not stop early. Do not skip files.
</completion_rule>`)

    // ── 2. ROLE ──
    sections.push(`<role>
Senior software engineer. Autonomous coding agent inside Diamond IDE.
</role>`)

    // ── 3. ENVIRONMENT (long data at top — Context Engineering) ──
    sections.push(`<environment>
project_path: ${projectPath}
project_type: ${projectType}
os: macOS (Tauri 2)
package_manager: ${pmDetected}
${pkgSummary ? `name: ${pkgSummary.name}` : ''}
${pkgSummary?.scripts.length ? `scripts: ${pkgSummary.scripts.join(', ')}` : ''}
${pkgSummary?.dependencies.length ? `deps: ${pkgSummary.dependencies.join(', ')}` : ''}
</environment>`)

    sections.push(`<project_structure>
${treeString}
</project_structure>`)

    if (readme) {
      sections.push(`<readme_summary>
${readme.slice(0, 400)}
</readme_summary>`)
    }

    // ── 4. CONSTRAINTS (contract — no preamble) ──
    sections.push(`<constraints>
- All paths absolute, starting with "${projectPath}"
- read_file before write_file. Never modify unread files.
- write_file replaces entire file. Omitting code deletes it. Always emit complete content.
- Do not use placeholders ("...", "// rest of code"). Output goes directly to disk.
- File changes require user approval. Do not assume applied.
- Do not run long-lived processes (dev servers, watchers) via execute_command — it blocks until exit.
- Do not install dependencies unless the task requires it.
- If unsure, read the file. Do not speculate.
</constraints>`)

    // ── 5. TOOL EXAMPLES (few-shot — highest ROI) ──
    sections.push(`<examples>
<example>
<task>Create a calculator with HTML and CSS</task>
<steps>
1. write_file → ${projectPath}/index.html (complete HTML, links style.css)
2. write_file → ${projectPath}/style.css (complete CSS)
</steps>
</example>

<example>
<task>Fix a bug in an existing file</task>
<steps>
1. read_file → examine current code
2. search_files → find related usages if needed
3. write_file → corrected full file content
</steps>
</example>

<example>
<task>Add feature across multiple files</task>
<steps>
1. list_directory → understand layout
2. read_file → each relevant file
3. write_file → each modified file (complete content)
4. execute_command → run tests if they exist
</steps>
</example>
</examples>`)

    // ── 6. TASK RULES ──
    sections.push(`<task_rules>
Web projects (HTML/CSS/JS):
- index.html as entry point
- Link CSS/JS via relative paths (href="style.css", src="script.js") — IDE inlines them for preview
- HTML must be functional and self-contained

Existing projects:
- Match existing code style. Do not refactor untouched code. Do not add comments unless asked.

Debugging:
- Diagnose before fixing. Fix only the broken part.

Response style:
- Respond in the user's language
- 1–2 sentences per step. No preamble, no summaries.
</task_rules>`)

    // ── 7. ERROR RECOVERY ──
    sections.push(`<error_recovery>
Tool call fails → read error → fix that step → retry. Do not restart from scratch. If unsure, verify with read_file or list_directory.
</error_recovery>`)

    // ── 8. REMINDER (recency — U-Curve) ──
    sections.push(`<reminder>
Absolute paths: "${projectPath}". Read before write. Complete file content only — partial = data loss. Do not stop early.
</reminder>`)

    return sections.join('\n\n')
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

  private async detectPackageManager(projectPath: string): Promise<string> {
    const checks = [
      { file: 'yarn.lock', pm: 'yarn' },
      { file: 'pnpm-lock.yaml', pm: 'pnpm' },
      { file: 'bun.lockb', pm: 'bun' },
      { file: 'package-lock.json', pm: 'npm' },
    ]

    // Check all lock files in parallel for speed
    const results = await Promise.all(
      checks.map(async ({ file, pm }) => {
        const content = await this.safeReadFile(`${projectPath}/${file}`)
        return content !== null ? pm : null
      })
    )

    return results.find(pm => pm !== null) ?? 'npm'
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
