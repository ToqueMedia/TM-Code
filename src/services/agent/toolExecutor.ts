import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useFileTreeRepository } from '../../stores/fileTreeStore'
import { useEditorRepository } from '../../stores/editorStore'
import { useProjectStore } from '../../stores/projectStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useCheckpointStore } from '../../stores/checkpointStore'
import FirebaseAuthService from '../auth/firebaseAuth'
import { devServerManager } from '../devServerManager'
import TypeScriptLspService from '../typescriptLspService'
import CheckpointService from './checkpointService'
import type { MCPTool } from '../mcp/mcpService'
import type { AgentCallbacks } from './agentService'
import { useChatStore } from '../../stores/chatStore'

// === Types ===

export interface ToolDefinition {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface OpenAIToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

interface ToolEntry {
  definition: ToolDefinition
  execute: (input: Record<string, unknown>) => Promise<string>
}

// === Tool Executor ===

class ToolExecutor {
  private static instance: ToolExecutor
  private tools: Map<string, ToolEntry> = new Map()
  /** Tracks install commands that completed successfully in this session. */
  private completedInstalls: Set<string> = new Set()

  private constructor() {
    this.registerTools()
  }

  static getInstance(): ToolExecutor {
    if (!ToolExecutor.instance) {
      ToolExecutor.instance = new ToolExecutor()
    }
    return ToolExecutor.instance
  }

  /** Clears session-scoped state (e.g., install command cache). Call on new sessions. */
  resetSessionState(): void {
    this.completedInstalls.clear()
  }

  /** Optional context for the current tool execution (set by agent service). */
  private currentToolCallId: string | null = null

  setCurrentToolCallId(id: string | null): void {
    this.currentToolCallId = id
  }

  async execute(toolName: string, input: Record<string, unknown>, toolCallId?: string): Promise<string> {
    const tool = this.tools.get(toolName)
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`)
    }

    // .env files are ALWAYS blocked — read, write, edit, delete
    const filePath = (input.path || input.oldPath || '') as string
    if (this.isEnvFile(filePath) && ['read_file', 'write_file', 'edit_file', 'create_file', 'delete_file', 'rename_file'].includes(toolName)) {
      return 'Blocked: .env files contain secrets and cannot be read or modified by the agent. Ask the developer what environment variables are needed, or create a .env.example with placeholder values.'
    }

    // Sensitive files require explicit developer authorization
    const isSensitive = toolName === 'read_file' && this.isSensitiveFile(input.path as string)

    const approved = await usePermissionStore.getState().requestPermission(toolName, input, isSensitive)
    if (!approved) {
      const target = (input.path || input.command || input.name || '') as string
      return `Permission denied by user for ${toolName}${target ? ` (${target})` : ''}. Ask the user what they want instead or suggest an alternative approach.`
    }

    // Inject toolCallId for tools that need per-call context (parallel sub-agents)
    const execInput = toolCallId ? { ...input, _toolCallId: toolCallId } : input

    // Set tool call ID context just before execution (after async permission check)
    // Tools capture this synchronously at the start of their execute function.
    if (toolCallId) this.currentToolCallId = toolCallId
    try {
      const result = await tool.execute(execInput)
      return this.truncateResult(result)
    } finally {
      if (toolCallId) this.currentToolCallId = null
    }
  }

  /** Number of core (non-MCP) tools registered. */
  getCoreToolCount(): number {
    return Array.from(this.tools.keys()).filter(k => !k.startsWith('mcp__')).length
  }

  getToolDefinitions(): OpenAIToolDefinition[] {
    return Array.from(this.tools.values()).map(t => ({
      type: 'function' as const,
      function: {
        name: t.definition.name,
        description: t.definition.description,
        parameters: t.definition.input_schema
      }
    }))
  }

  /**
   * Registers MCP tools, replacing any previously registered MCP tools.
   * Tool names use double-underscore separator: mcp__serverName__toolName
   */
  registerMCPTools(mcpTools: MCPTool[], callToolFn: (serverName: string, toolName: string, args: Record<string, unknown>) => Promise<string>): void {
    // Remove old MCP tools
    for (const [name] of this.tools) {
      if (name.startsWith('mcp__')) {
        this.tools.delete(name)
      }
    }

    // Register new MCP tools
    for (const tool of mcpTools) {
      const fullName = `mcp__${tool.serverName}__${tool.name}`

      this.tools.set(fullName, {
        definition: {
          name: fullName,
          description: `[MCP: ${tool.serverName}] ${tool.description}`,
          input_schema: tool.inputSchema as ToolDefinition['input_schema'],
        },
        execute: async (input: Record<string, unknown>) => {
          return await callToolFn(tool.serverName, tool.name, input)
        },
      })
    }
  }

  private truncateResult(result: string, maxChars: number = 30000): string {
    if (result.length <= maxChars) return result
    return result.slice(0, maxChars) + `\n\n[TRUNCATED - showing ${maxChars} of ${result.length} characters]`
  }

  /**
   * Runs install commands via streaming (run_streaming_command) so the user
   * sees real-time logs in the chat via progressText.
   * Includes a 180s timeout to prevent hanging if the process stalls.
   */
  private async executeInstallStreaming(
    command: string,
    cwd: string,
    installKey: string,
    toolCallId?: string,
  ): Promise<string> {
    const tcId = toolCallId || this.currentToolCallId
    const allOutput: string[] = []

    // Register listeners BEFORE spawning
    let targetPid = 0
    let finished = false
    let resolveExit: (code: number) => void
    const exitPromise = new Promise<number>(res => { resolveExit = res })

    const bufferedOutput: { pid: number; data: string }[] = []
    const bufferedExit: { pid: number; code: number }[] = []

    const unOutput = await listen<{ pid: number; stream: string; data: string }>(
      'cmd-output',
      (event) => {
        if (targetPid === 0) {
          bufferedOutput.push({ pid: event.payload.pid, data: event.payload.data })
        } else if (event.payload.pid === targetPid) {
          this.handleInstallOutput(event.payload.data, allOutput, tcId)
        }
      }
    )

    const unExit = await listen<{ pid: number; code: number }>(
      'cmd-exit',
      (event) => {
        if (targetPid === 0) {
          bufferedExit.push({ pid: event.payload.pid, code: event.payload.code })
        } else if (event.payload.pid === targetPid && !finished) {
          finished = true
          cleanup()
          resolveExit(event.payload.code)
        }
      }
    )

    const cleanup = () => { unOutput(); unExit() }

    try {
      if (tcId) {
        useChatStore.getState().updateToolCallProgress(tcId, 'Installing dependencies...')
      }

      const pid = await invoke<number>('run_streaming_command', { command, cwd })
      targetPid = pid

      // Flush buffered events
      for (const ev of bufferedOutput) {
        if (ev.pid === pid) {
          this.handleInstallOutput(ev.data, allOutput, tcId)
        }
      }
      for (const ev of bufferedExit) {
        if (ev.pid === pid && !finished) {
          finished = true
          cleanup()
          resolveExit!(ev.code)
        }
      }

      // Race: exit vs timeout vs abort (user stops agent)
      const INSTALL_TIMEOUT = 300_000 // 5 min — large projects can be slow on first install
      let timeoutTimer: ReturnType<typeof setTimeout>
      const timeoutPromise = new Promise<number>((_, reject) => {
        timeoutTimer = setTimeout(() => reject(new Error(`Install timed out after ${INSTALL_TIMEOUT / 1000}s`)), INSTALL_TIMEOUT)
      })

      // Listen for agent abort (user clicked Stop)
      const { default: AgentService } = await import('./agentService')
      const abortSignal = AgentService.getInstance().getAbortController()?.signal
      const abortPromise = abortSignal
        ? new Promise<number>((_, reject) => {
            if (abortSignal.aborted) reject(new Error('aborted'))
            else abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        : new Promise<number>(() => {}) // never resolves

      let exitCode: number
      try {
        exitCode = await Promise.race([exitPromise, timeoutPromise, abortPromise]) as number
        clearTimeout(timeoutTimer!)
      } catch (raceErr) {
        clearTimeout(timeoutTimer!)
        cleanup()
        try { await invoke('kill_process', { pid: targetPid }) } catch { /* best effort */ }
        const msg = raceErr instanceof Error ? raceErr.message : String(raceErr)
        if (msg === 'aborted') {
          return `Install cancelled by user.\nExit code: 1`
        }
        return `TIMEOUT: ${msg}\n${allOutput.join('')}\nThe install process was killed.`
      }

      const fullOutput = allOutput.join('')

      if (exitCode === 0) {
        this.completedInstalls.add(installKey)
        if (tcId) {
          useChatStore.getState().updateToolCallProgress(tcId, '')
        }
        // Return summary for the model
        const lines = fullOutput.split('\n')
        const tail = lines.slice(-15).join('\n')
        return `${tail}\nExit code: 0\n\nDependencies installed successfully.`
      }

      // Failure: return full output for model to diagnose
      return `${fullOutput}\nExit code: ${exitCode}`
    } catch (error) {
      cleanup()
      const msg = error instanceof Error ? error.message : String(error)
      return `Failed to install dependencies: ${msg}`
    }
  }

  private handleInstallOutput(
    data: string,
    allOutput: string[],
    toolCallId: string | null,
  ): void {
    allOutput.push(data)
    if (!toolCallId) return

    // Show the last meaningful line as progress
    const lines = data.trim().split('\n')
    const lastLine = lines[lines.length - 1] || ''
    if (lastLine.length > 0) {
      const display = lastLine.length > 80 ? lastLine.slice(0, 80) + '...' : lastLine
      useChatStore.getState().updateToolCallProgress(toolCallId, display)
    }
  }

  private detectServerUrl(output: string) {
    const serverPatterns = [
      /Local:\s+(https?:\/\/localhost:\d+)/,
      /ready on (https?:\/\/localhost:\d+)/,
      /Server running at (https?:\/\/localhost:\d+)/,
      /listening on (https?:\/\/localhost:\d+)/,
      /http:\/\/localhost:(\d+)/,
    ]

    for (const pattern of serverPatterns) {
      const match = output.match(pattern)
      if (match) {
        const url = match[1].startsWith('http') ? match[1] : `http://localhost:${match[1]}`
        const layoutStore = useLayoutStore.getState()
        layoutStore.setPreviewServer(url, 0)
        layoutStore.setViewMode('preview')
        break
      }
    }
  }

  private getProjectRoot(): string {
    const project = useProjectStore.getState().currentProject
    if (!project?.path) {
      throw new Error('No project is open. Cannot perform file operations without an active project.')
    }
    return project.path
  }

  private validatePathWithinProject(filePath: string): void {
    const projectRoot = this.getProjectRoot()
    // Normalize: resolve '..' segments and ensure the path is within project root
    const normalizedPath = this.normalizePath(filePath)
    const normalizedRoot = this.normalizePath(projectRoot)

    if (!normalizedPath.startsWith(normalizedRoot + '/') && normalizedPath !== normalizedRoot) {
      throw new Error(`Access denied: path "${filePath}" is outside the project directory.`)
    }
  }

  private normalizePath(p: string): string {
    // Resolve '..' and '.' segments
    const parts = p.split('/')
    const resolved: string[] = []
    for (const part of parts) {
      if (part === '..') {
        resolved.pop()
      } else if (part !== '.' && part !== '') {
        resolved.push(part)
      }
    }
    return '/' + resolved.join('/')
  }

  // Files that may contain secrets — require explicit user authorization
  private static readonly SENSITIVE_FILE_PATTERNS = [
    /^\.env($|\.)/, // .env, .env.local, .env.production, etc.
    /^\.npmrc$/,
    /\.pem$/,
    /\.key$/,
    /credentials\.json$/,
    /_secret/,
  ]

  private isEnvFile(filePath: string): boolean {
    if (!filePath) return false
    const filename = filePath.split('/').pop() || ''
    // Block all .env files EXCEPT exactly ".env.example"
    if (!filename.startsWith('.env')) return false
    return filename !== '.env.example'
  }

  private isSensitiveFile(filePath: string): boolean {
    const filename = filePath.split('/').pop() || ''
    return ToolExecutor.SENSITIVE_FILE_PATTERNS.some(p => p.test(filename))
  }

  private static readonly BLOCKED_COMMANDS = [
    // Destructive filesystem
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force|--recursive)\b/,
    /\brm\s+-rf\b/,
    /\bmkfs\b/,
    /\bdd\s+/,
    /\bformat\b/,
    /\b:\(\)\s*\{\s*:\|:&\s*\}\s*;/,  // fork bomb
    /\bchmod\s+[0-7]*777\b/,
    />\s*\/dev\/sd[a-z]/,
    /\bshutdown\b/,
    /\breboot\b/,

    // Privilege escalation
    /\bsudo\b/,
    /\bsu\s+/,
    /\bdoas\b/,
    /\bpkexec\b/,

    // Remote code execution / exfiltration
    /\bcurl\b.*\|\s*(bash|sh|zsh)/,
    /\bwget\b.*\|\s*(bash|sh|zsh)/,
    /\bpython[23]?\s+-c\b/,
    /\bnode\s+-e\b/,
    /\bperl\s+-e\b/,
    /\bruby\s+-e\b/,
    /\bphp\s+-r\b/,

    // Network tools
    /\bnc\s+/,
    /\bncat\b/,
    /\bsocat\b/,

    // Secret exfiltration
    /\bprintenv\b/,
    /\bcat\b.*\.env\b/,
    /\bbase64\b.*\.env\b/,

    // System services
    /\blaunchctl\b/,
    /\bsystemctl\b/,
    /\bkillall\b/,
  ]

  private validateCommand(command: string): void {
    for (const pattern of ToolExecutor.BLOCKED_COMMANDS) {
      if (pattern.test(command)) {
        throw new Error(`Command blocked for safety: "${command}" matches a destructive pattern.`)
      }
    }
  }

  private refreshFileTree() {
    useFileTreeRepository.getState().refresh()
  }

  private closeEditorIfOpen(path: string) {
    const editorState = useEditorRepository.getState()
    if (editorState.openFiles.some(f => f.path === path)) {
      editorState.closeFile(path)
    }
  }

  private formatFileTreeCompact(node: Record<string, unknown>, indent: string = ''): string {
    if (!node) return ''
    let result = ''
    const name = (node.name || node.fileName || '') as string
    const isDir = node.type === 'directory' || (node.children !== undefined)
    if (name) {
      result += `${indent}${isDir ? name + '/' : name}\n`
    }
    if (node.children && Array.isArray(node.children)) {
      const childIndent = name ? indent + '  ' : indent
      for (const child of node.children) {
        result += this.formatFileTreeCompact(child, childIndent)
      }
    }
    return result || '(empty directory)'
  }

  private registerTools() {
    // === read_file ===
    this.tools.set('read_file', {
      definition: {
        name: 'read_file',
        description: 'Read the contents of a file at the given path.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the file to read' }
          },
          required: ['path']
        }
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.path as string)
        return await invoke<string>('read_file', { path: input.path })
      }
    })

    // === list_directory ===
    this.tools.set('list_directory', {
      definition: {
        name: 'list_directory',
        description: 'List the contents of a directory. Returns a file tree with names and types.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the directory to list' },
            maxDepth: { type: 'number', description: 'Maximum depth to traverse. Default: 3' }
          },
          required: ['path']
        }
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.path as string)
        const filter = { showHidden: false, maxDepth: (input.maxDepth as number) || 3 }
        const tree = await invoke('build_file_tree', { rootPath: input.path, filter })
        return this.formatFileTreeCompact(tree as Record<string, unknown>)
      }
    })

    // === search_files ===
    this.tools.set('search_files', {
      definition: {
        name: 'search_files',
        description: 'Search for text patterns across files in a directory using ripgrep. Returns up to 50 matching lines with file paths and line numbers. If you need more results, narrow your search with includePatterns.',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search pattern (text or regex)' },
            directory: { type: 'string', description: 'Absolute path to search directory' },
            caseSensitive: { type: 'boolean', description: 'Case sensitive search. Default: false' },
            useRegex: { type: 'boolean', description: 'Interpret query as regex. Default: false' },
            includePatterns: { type: 'array', items: { type: 'string' }, description: 'Glob patterns to include (e.g., ["*.tsx", "*.ts"])' }
          },
          required: ['query', 'directory']
        }
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.directory as string)
        const options = {
          case_sensitive: (input.caseSensitive as boolean) || false,
          whole_word: false,
          use_regex: (input.useRegex as boolean) || false,
          include_patterns: (input.includePatterns as string[]) || [],
          exclude_patterns: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
          max_results: 50
        }
        const result = await invoke('search_in_files', {
          query: input.query,
          directory: input.directory,
          options
        })
        return JSON.stringify(result, null, 2)
      }
    })

    // === write_file ===
    this.tools.set('write_file', {
      definition: {
        name: 'write_file',
        description: 'Replace the entire content of an existing file, or create a new file. Always read_file first on existing files to understand what you are replacing. For creating new files, prefer create_file. For small edits (1–20 lines), prefer edit_file instead.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the file to write' },
            content: { type: 'string', description: 'Complete content to write to the file' }
          },
          required: ['path', 'content']
        }
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.path as string)
        const path = input.path as string
        const newContent = input.content as string

        // Read current content to generate diff data
        let oldContent = ''
        let isNewFile = true
        try {
          oldContent = await invoke<string>('read_file', { path })
          isNewFile = false
        } catch {
          isNewFile = true
        }

        // Return diff data as JSON for inline display
        // The file is NOT written yet — user approves via InlineDiff
        return JSON.stringify({
          type: 'diff',
          path,
          oldContent,
          newContent,
          isNewFile,
        })
      }
    })

    // === create_file ===
    this.tools.set('create_file', {
      definition: {
        name: 'create_file',
        description: 'Create a new file with optional content. Fails if the file already exists.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path for the new file' },
            content: { type: 'string', description: 'Initial content for the file. Default: empty' }
          },
          required: ['path']
        }
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.path as string)
        const path = input.path as string
        const content = (input.content as string) || ''

        // Check if file already exists
        try {
          await invoke<string>('read_file', { path })
          return `Error: File already exists: ${path}. Use write_file to overwrite or edit_file for small changes.`
        } catch {
          // File doesn't exist — good, proceed
        }

        // Return diff data as JSON for inline display (consistent with write_file)
        return JSON.stringify({
          type: 'diff',
          path,
          oldContent: '',
          newContent: content,
          isNewFile: true,
        })
      }
    })

    // === create_directory ===
    this.tools.set('create_directory', {
      definition: {
        name: 'create_directory',
        description: 'Create a directory and all necessary parent directories.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path of the directory to create' }
          },
          required: ['path']
        }
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.path as string)
        await invoke('create_directories_all', { path: input.path })
        this.refreshFileTree()
        return `Directory created successfully: ${input.path}`
      }
    })

    // === delete_file ===
    this.tools.set('delete_file', {
      definition: {
        name: 'delete_file',
        description: 'Delete a file or directory. A checkpoint is created automatically so the user can undo if needed. Only use when the user explicitly asks to delete, or when removing a file you just created in error.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to delete' }
          },
          required: ['path']
        }
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.path as string)

        // Capture checkpoint before deleting (capture ID locally for parallel safety)
        const tcId = this.currentToolCallId
        if (tcId) {
          try {
            const content = await invoke<string>('read_file', { path: input.path as string })
            await CheckpointService.getInstance().captureBeforeDelete(
              input.path as string,
              content,
              tcId,
            )
            useCheckpointStore.getState().syncFromService()
          } catch {
            // File might be a directory or unreadable — skip checkpoint
          }
        }

        this.closeEditorIfOpen(input.path as string)
        await invoke('delete_file_or_directory', { path: input.path })
        this.refreshFileTree()
        return `Deleted successfully: ${input.path}`
      }
    })

    // === rename_file ===
    this.tools.set('rename_file', {
      definition: {
        name: 'rename_file',
        description: 'Rename a file or directory.',
        input_schema: {
          type: 'object',
          properties: {
            oldPath: { type: 'string', description: 'Current absolute path' },
            newName: { type: 'string', description: 'New name (not full path, just the name)' }
          },
          required: ['oldPath', 'newName']
        }
      },
      execute: async (input) => {
        this.validatePathWithinProject(input.oldPath as string)
        // Validate newName doesn't contain path traversal
        const newName = input.newName as string
        if (newName.includes('/') || newName.includes('\\') || newName.includes('..')) {
          throw new Error('Access denied: new name cannot contain path separators or "..".')
        }

        // Capture checkpoint before renaming (capture ID locally for parallel safety)
        const tcId = this.currentToolCallId
        if (tcId) {
          try {
            const content = await invoke<string>('read_file', { path: input.oldPath as string })
            const oldPathStr = input.oldPath as string
            const parentDir = oldPathStr.substring(0, oldPathStr.lastIndexOf('/'))
            const newPath = `${parentDir}/${newName}`
            await CheckpointService.getInstance().captureBeforeRename(
              oldPathStr,
              newPath,
              content,
              tcId,
            )
            useCheckpointStore.getState().syncFromService()
          } catch {
            // File might be a directory — skip checkpoint
          }
        }

        await invoke('rename_file_or_directory', {
          oldPath: input.oldPath,
          newName
        })
        this.refreshFileTree()
        return `Renamed successfully: ${input.oldPath} -> ${newName}`
      }
    })

    // === edit_file ===
    this.tools.set('edit_file', {
      definition: {
        name: 'edit_file',
        description: 'Replace a specific string in a file with new content. The old_str must match exactly and appear only once in the file. Use this for surgical edits instead of rewriting entire files with write_file.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the file to edit' },
            old_str: { type: 'string', description: 'Exact string to find and replace. Must be unique in the file.' },
            new_str: { type: 'string', description: 'String to replace old_str with. Use empty string to delete.' }
          },
          required: ['path', 'old_str', 'new_str']
        }
      },
      execute: async (input) => {
        const path = input.path as string
        const oldStr = input.old_str as string
        const newStr = input.new_str as string

        if (!oldStr) {
          return 'Error: old_str cannot be empty. Provide the exact text you want to replace.'
        }

        this.validatePathWithinProject(path)

        const content = await invoke<string>('read_file', { path })

        const occurrences = content.split(oldStr).length - 1

        if (occurrences === 0) {
          return `Error: old_str not found in ${path}. The content you're trying to replace doesn't exist in the file. Read the file first to see the current content.`
        }

        if (occurrences > 1) {
          return `Error: old_str appears ${occurrences} times in ${path}. It must be unique. Include more surrounding context to make it unique.`
        }

        const newContent = content.replace(oldStr, newStr)

        // Return diff data as JSON for inline display
        return JSON.stringify({
          type: 'diff',
          path,
          oldContent: content,
          newContent,
          isNewFile: false,
        })
      }
    })

    // === glob ===
    this.tools.set('glob', {
      definition: {
        name: 'glob',
        description: 'Find files matching a glob pattern. Returns a list of absolute file paths.',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.tsx", "src/**/*.test.ts", "**/package.json")' },
            directory: { type: 'string', description: 'Absolute path to search from. Default: project root' }
          },
          required: ['pattern']
        }
      },
      execute: async (input) => {
        const pattern = input.pattern as string
        const directory = (input.directory as string) || this.getProjectRoot()

        this.validatePathWithinProject(directory)

        const result = await invoke<string[]>('glob_files', {
          pattern,
          directory
        })

        if (result.length === 0) {
          return `No files found matching pattern: ${pattern}`
        }

        return result.join('\n')
      }
    })

    // === web_fetch ===
    this.tools.set('web_fetch', {
      definition: {
        name: 'web_fetch',
        description: 'Fetch the contents of a web URL. Returns the text content of the page. Use this to read documentation, check API endpoints, look up package information on npm, or research technical topics. Cannot access localhost or internal URLs.',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to fetch (must be http or https)' },
            maxLength: { type: 'number', description: 'Maximum characters to return. Default: 50000' }
          },
          required: ['url']
        }
      },
      execute: async (input) => {
        const url = input.url as string
        const maxLength = (input.maxLength as number) || 50000

        const firebaseAuth = FirebaseAuthService.getInstance()
        const idToken = await firebaseAuth.getIdToken()

        if (!idToken) {
          return 'Error: Not authenticated. Cannot fetch web content.'
        }

        const workerUrl = import.meta.env.VITE_WORKER_URL || 'http://localhost:8787'

        const response = await fetch(`${workerUrl}/v1/web-fetch`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${idToken}`
          },
          body: JSON.stringify({ url, maxLength })
        })

        if (!response.ok) {
          return `Error: Failed to fetch ${url} (status: ${response.status})`
        }

        const result = await response.json() as {
          url: string
          status: number
          content: string
          truncated: boolean
          error?: string
        }

        if (result.error) {
          return `Error fetching ${url}: ${result.error}`
        }

        let output = `URL: ${result.url}\nStatus: ${result.status}\n\n${result.content}`

        if (result.truncated) {
          output += '\n\n[Content was truncated to fit context window]'
        }

        return output
      }
    })

    // === execute_command ===
    this.tools.set('execute_command', {
      definition: {
        name: 'execute_command',
        description: 'Execute a shell command in the project directory. Blocks until the command exits or the timeout is reached — do NOT use for dev servers or watchers (they never exit). Use for running tests, installing dependencies, building, linting, or short-lived CLI operations. Returns stdout, stderr, and exit code. Default timeout: 120 seconds.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute (e.g., "pnpm install", "pnpm test", "ls -la")' },
            cwd: { type: 'string', description: 'Working directory. Default: project root' },
            timeout_secs: { type: 'number', description: 'Timeout in seconds. Default: 120. Max: 600.' }
          },
          required: ['command']
        }
      },
      execute: async (input) => {
        const cmd = (input.command as string).trim()
        this.validateCommand(cmd)

        // Scope cwd to project root
        const projectRoot = this.getProjectRoot()
        const cwd = (input.cwd as string) || projectRoot
        this.validatePathWithinProject(cwd)

        // Block repeated install commands that already succeeded.
        // Matches direct ("pnpm install") and compound ("cd server && pnpm install") forms.
        // Key includes effective cwd so monorepo sub-directory installs aren't blocked.
        const normalizedCmd = cmd.replace(/\s+/g, ' ')
        const directInstall = normalizedCmd.match(/^((?:npm|yarn|pnpm|bun)\s+(?:install|ci))\b/)
          || normalizedCmd.match(/^(pip\s+install)\b/)
        const compoundInstall = !directInstall
          ? normalizedCmd.match(/^cd\s+(\S+)\s*&&\s*((?:npm|yarn|pnpm|bun)\s+(?:install|ci))\b/)
          : null
        const isInstallCmd = directInstall !== null || compoundInstall !== null
        const installBaseCmd = directInstall?.[1] || compoundInstall?.[2] || ''
        // For "cd subdir && pnpm install", resolve cwd to the subdirectory.
        // Normalize ./path and trailing slashes so keys match across forms.
        const effectiveCwd = compoundInstall
          ? `${cwd}/${compoundInstall[1]}`.replace(/\/\.\//g, '/').replace(/\/+$/, '')
          : cwd
        const installKey = isInstallCmd ? `${installBaseCmd}@${effectiveCwd}` : ''

        if (isInstallCmd && this.completedInstalls.has(installKey)) {
          return `SKIPPED: "${installBaseCmd}" already completed successfully in ${effectiveCwd}. Dependencies are installed.\nExit code: 0`
        }

        // For install commands: use streaming so the user sees real-time logs in the chat
        if (isInstallCmd) {
          return this.executeInstallStreaming(cmd, cwd, installKey, input._toolCallId as string | undefined)
        }

        // Agent default: 120s. Clamp to max 600s.
        const timeoutSecs = Math.min(Number(input.timeout_secs) || 120, 600)

        const result = await invoke<{ stdout: string; stderr: string; exitCode: number; success: boolean; timedOut: boolean }>('execute_command', {
          command: cmd,
          cwd,
          timeoutSecs,
        })

        if (result.timedOut) {
          return `TIMEOUT: Command exceeded ${timeoutSecs}s limit and was terminated.\nFor long-running processes, use start_dev_server instead.\nSTDERR:\n${result.stderr}`
        }

        let output = ''
        if (result.stdout) output += result.stdout
        if (result.stderr) output += `\nSTDERR:\n${result.stderr}`
        output += `\nExit code: ${result.exitCode}`

        // Detect dev server URL in output
        this.detectServerUrl(output)

        return output
      }
    })

    // === start_dev_server ===
    this.tools.set('start_dev_server', {
      definition: {
        name: 'start_dev_server',
        description: 'Start a dev server as a background process. Returns immediately — the server runs in the background and the preview panel opens automatically when it is ready. Use this instead of execute_command for dev servers, watchers, or any long-running process. Only one dev server can run at a time (starting a new one stops the previous). For backend/API servers, the HTTP Client panel opens instead of the iframe preview.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Dev server command (e.g., "pnpm run dev", "pnpm start", "npx vite")' },
            server_type: { type: 'string', enum: ['frontend', 'backend'], description: 'Optional hint: "frontend" for iframe preview (React, Vue, etc.), "backend" for HTTP Client panel (Express, FastAPI, etc.). Auto-detected if omitted.' }
          },
          required: ['command']
        }
      },
      execute: async (input) => {
        const command = input.command as string
        let serverType = input.server_type as 'frontend' | 'backend' | undefined
        this.validateCommand(command)
        const projectRoot = this.getProjectRoot()

        // If the agent didn't provide a hint, infer from project files
        if (!serverType) {
          try {
            const { detectProjectCategory, categoryToServerHint } = await import('../../services/projectTypeDetector')
            const cat = await detectProjectCategory(projectRoot)
            serverType = categoryToServerHint(cat)
          } catch { /* detection failure is non-fatal */ }
        }

        // Stop any existing server
        if (devServerManager.isActive()) {
          await devServerManager.stop()
        }

        try {
          await devServerManager.start(projectRoot, command, serverType)
          const url = devServerManager.getUrl()
          if (url) {
            return `Dev server started and running at ${url}. The correct preview panel will open automatically.`
          }
          const port = serverType === 'backend' ? 7777 : 7773
          return `Dev server starting with command: ${command}. The preview panel will open automatically when the server is ready (port ${port}).`
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return `Error starting dev server: ${msg}. You can try a different command or check that dependencies are installed.`
        }
      }
    })

    // === get_diagnostics ===
    this.tools.set('get_diagnostics', {
      definition: {
        name: 'get_diagnostics',
        description: 'Get TypeScript/JavaScript diagnostics (type errors, syntax errors, unused variables) for a file. Uses the built-in language service — no compilation step needed. Returns errors and warnings with line numbers. Use after writing/editing code to verify correctness.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the TS/JS file to check' }
          },
          required: ['path']
        }
      },
      execute: async (input) => {
        const filePath = input.path as string
        this.validatePathWithinProject(filePath)

        const ext = filePath.split('.').pop()?.toLowerCase() || ''
        if (!['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
          return `get_diagnostics only supports TypeScript/JavaScript files (.ts, .tsx, .js, .jsx). Got: .${ext}`
        }

        const lspService = TypeScriptLspService.getInstance()
        try {
          const diagnostics = await lspService.getDiagnostics(filePath)
          if (diagnostics.length === 0) {
            return `No errors or warnings in ${filePath.split('/').pop()}`
          }

          const lines = diagnostics.map(d =>
            `${d.severity.toUpperCase()} (line ${d.line}, col ${d.column}): ${d.message} [TS${d.code}]`
          )
          return `${diagnostics.length} diagnostic(s) in ${filePath.split('/').pop()}:\n${lines.join('\n')}`
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return `Could not get diagnostics: ${msg}. Try running "npx tsc --noEmit" via execute_command as a fallback.`
        }
      }
    })

    // === research (sub-agent) ===
    this.tools.set('research', {
      definition: {
        name: 'research',
        description: 'Delegate a task to a parallel sub-agent that can read, create, edit, and search files. Use to investigate code, refactor in parallel, or handle independent sub-tasks. Multiple research calls run concurrently. The sub-agent returns a text summary of what it did.',
        input_schema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The task or question for the sub-agent' },
            context: { type: 'string', description: 'Optional context to help the sub-agent (e.g., relevant file paths, what you already know)' }
          },
          required: ['question']
        }
      },
      execute: async (input) => {
        const question = input.question as string
        const context = (input.context as string) || ''

        // Lazy import to avoid circular dependency
        const { default: AgentService } = await import('./agentService')

        // Sub-agent tools: read, write, create, edit, search, glob, diagnostics
        const subAgentToolNames = new Set([
          'read_file', 'write_file', 'create_file', 'edit_file',
          'list_directory', 'search_files', 'glob', 'get_diagnostics',
        ])
        const subAgentTools = this.getToolDefinitions().filter(t =>
          subAgentToolNames.has(t.function.name)
        )

        // Get the main agent's abort controller so sub-agent stops when parent stops
        const mainAgent = AgentService.getInstance()
        const subAgent = AgentService.createLightweight({
          tools: subAgentTools,
          readOnly: false,
          abortController: mainAgent.getAbortController() || undefined,
        })

        const projectRoot = this.getProjectRoot()
        const systemPrompt = `You are a sub-agent inside TM Code. Complete the task using the available tools. You can read, create, edit, and search files. Be thorough but concise.

Project root: ${projectRoot}`

        subAgent.setSystemPrompt(systemPrompt)

        const prompt = context
          ? `${question}\n\nContext: ${context}`
          : question

        let result = ''
        let totalTokens = 0
        let toolsCalled = 0
        // Use injected ID for parallel execution, fall back to singleton for sequential
        const toolCallId = (input._toolCallId as string) || this.currentToolCallId

        const updateProgress = (status: string) => {
          if (toolCallId) {
            const tokenStr = totalTokens > 0 ? ` | ${Math.round(totalTokens / 1000)}K tokens` : ''
            useChatStore.getState().updateToolCallProgress(toolCallId, `${status}${tokenStr}`)
          }
        }

        updateProgress('Starting research...')

        await subAgent.runAgentLoop(prompt, [], {
          onTextDelta: (delta) => { result += delta },
          onReasoningDelta: () => {
            updateProgress('Thinking...')
          },
          onToolCallPending: (_toolId, toolName) => {
            toolsCalled++
            updateProgress(`Using ${toolName}...`)
          },
          onToolCallStart: (_toolId, toolName, args) => {
            const target = (args.path as string)?.split('/').pop()
              || (args.query as string)
              || (args.pattern as string)
              || ''
            updateProgress(`${toolName}: ${target}`)
          },
          onToolResult: () => {},
          onTurnComplete: () => {},
          onDone: (finalText) => {
            if (finalText && !result) result = finalText
            updateProgress(`Done — ${toolsCalled} tool calls`)
          },
          onError: (error) => {
            result = `Research error: ${error.message}`
            updateProgress('Error')
          },
          onUsageUpdate: (inputTokens, outputTokens) => {
            totalTokens += inputTokens + outputTokens
          },
        } satisfies AgentCallbacks)

        return result || 'No results found.'
      }
    })

    // === spawn_background_agent ===
    this.tools.set('spawn_background_agent', {
      definition: {
        name: 'spawn_background_agent',
        description: 'Start a background sub-agent that works independently while you continue. The sub-agent can read, search, and analyze files but CANNOT write or execute commands. Use for research tasks that do not need immediate results. Returns a tracking ID — use check_background_agents to retrieve results later.',
        input_schema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The task or question for the background agent' },
            context: { type: 'string', description: 'Optional context (file paths, prior knowledge)' },
          },
          required: ['question']
        }
      },
      execute: async (input) => {
        const question = input.question as string
        const context = (input.context as string) || ''

        const { useBackgroundAgentStore } = await import('../../stores/backgroundAgentStore')
        const bgStore = useBackgroundAgentStore.getState()

        if (bgStore.getRunningCount() >= 4) {
          return 'Cannot start: maximum 4 background agents running. Wait for one to complete or use check_background_agents.'
        }

        const { default: AgentService } = await import('./agentService')

        // Read-only tool subset
        const bgToolNames = new Set([
          'read_file', 'list_directory', 'search_files', 'glob',
          'get_diagnostics', 'web_fetch',
        ])
        const bgTools = this.getToolDefinitions().filter(t =>
          bgToolNames.has(t.function.name)
        )

        // Own abort controller, linked to parent
        const bgAbort = new AbortController()
        const mainAgent = AgentService.getInstance()
        const parentAbort = mainAgent.getAbortController()
        if (parentAbort) {
          parentAbort.signal.addEventListener('abort', () => bgAbort.abort(), { once: true })
        }

        const subAgent = AgentService.createLightweight({
          tools: bgTools,
          readOnly: true,
          maxTurns: 30,
          abortController: bgAbort,
        })

        const projectRoot = this.getProjectRoot()
        subAgent.setSystemPrompt(
          `You are a background research agent inside TM Code. Investigate the task using read-only tools. Be thorough and produce a clear summary.\n\nProject root: ${projectRoot}`
        )

        const agentId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        const prompt = context ? `${question}\n\nContext: ${context}` : question

        bgStore.addAgent({
          id: agentId,
          question,
          status: 'running',
          result: null,
          toolsCalled: 0,
          totalTokens: 0,
          progressText: 'Starting...',
          startedAt: Date.now(),
          completedAt: null,
          abortController: bgAbort,
        })

        // Fire and forget — do NOT await
        let resultText = ''
        let tokens = 0
        let calls = 0

        subAgent.runAgentLoop(prompt, [], {
          onTextDelta: (delta) => { resultText += delta },
          onReasoningDelta: () => {
            bgStore.updateProgress(agentId, 'Thinking...', calls, tokens)
          },
          onToolCallPending: (_id, toolName) => {
            calls++
            bgStore.updateProgress(agentId, `Using ${toolName}...`, calls, tokens)
          },
          onToolCallStart: (_id, toolName, args) => {
            const target = (args.path as string)?.split('/').pop()
              || (args.query as string)
              || (args.pattern as string)
              || ''
            bgStore.updateProgress(agentId, `${toolName}: ${target}`, calls, tokens)
          },
          onToolResult: () => {},
          onTurnComplete: () => {},
          onDone: (finalText) => {
            if (finalText && !resultText) resultText = finalText
            useBackgroundAgentStore.getState().completeAgent(agentId, resultText || 'No results found.')
          },
          onError: (error) => {
            useBackgroundAgentStore.getState().failAgent(agentId, error.message)
          },
          onUsageUpdate: (inp, out) => {
            tokens += inp + out
          },
        } satisfies AgentCallbacks).catch((err) => {
          useBackgroundAgentStore.getState().failAgent(
            agentId,
            err instanceof Error ? err.message : String(err),
          )
        })

        return `Background agent "${agentId}" started for: "${question}". Use check_background_agents to see results when ready.`
      }
    })

    // === check_background_agents ===
    this.tools.set('check_background_agents', {
      definition: {
        name: 'check_background_agents',
        description: 'Check the status and results of background agents. Returns all running and recently completed agents with their results.',
        input_schema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      execute: async () => {
        const { useBackgroundAgentStore } = await import('../../stores/backgroundAgentStore')
        const agents = useBackgroundAgentStore.getState().getAll()

        if (agents.length === 0) {
          return 'No background agents have been started.'
        }

        const lines: string[] = []
        for (const agent of agents) {
          const elapsed = agent.completedAt
            ? `${Math.round((agent.completedAt - agent.startedAt) / 1000)}s`
            : `${Math.round((Date.now() - agent.startedAt) / 1000)}s elapsed`

          if (agent.status === 'running') {
            lines.push(`[RUNNING] ${agent.id}: "${agent.question}" (${elapsed}, ${agent.toolsCalled} tools, ${agent.progressText})`)
          } else if (agent.status === 'completed') {
            lines.push(`[DONE] ${agent.id}: "${agent.question}" (${elapsed}, ${agent.toolsCalled} tools)\nResult:\n${agent.result}`)
          } else if (agent.status === 'error') {
            lines.push(`[ERROR] ${agent.id}: "${agent.question}" — ${agent.result}`)
          } else if (agent.status === 'cancelled') {
            lines.push(`[CANCELLED] ${agent.id}: "${agent.question}"`)
          }
        }

        return lines.join('\n\n')
      }
    })
  }
}

export default ToolExecutor
