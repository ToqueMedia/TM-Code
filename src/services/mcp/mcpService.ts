import { invoke } from '@/utils/invokeMetrics'
import { useMcpStore, McpToolInfo } from '../../stores/mcpStore'
import { discoverRemoteTools as discoverRemote, callRemoteTool as callRemote } from './remoteTransport'
import { serializeStructuredForPromptDetailed } from '@/services/agent/promptSerialize'
import { t } from '@/i18n'
import { appHomePath, legacyAppHomePath } from '../../utils/appHomeDir'

// === Types ===

export interface MCPServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  transport?: 'stdio' | 'remote'
}

/** Infer transport from config: has command → stdio, has url → remote */
function inferTransport(config: MCPServerConfig): 'stdio' | 'remote' {
  if (config.transport) return config.transport
  if (config.command) return 'stdio'
  if (config.url) return 'remote'
  return 'stdio'
}

export interface MCPTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  serverName: string
  /**
   * MCP spec annotation: tool does not modify its environment.
   * When true, the tool can run in parallel with other read-only tools
   * (mapped to OpenAIToolDefinition.concurrencySafe in toolExecutor.registerMCPTools).
   * Undefined or false → tool runs serially (defensive default).
   */
  readOnlyHint?: boolean
}

/** One image block from an MCP tool result (e.g. Playwright screenshot). */
export interface MCPImageContent {
  mimeType: string
  /** Raw base64 (no data: URI prefix). */
  data: string
}

export interface MCPToolResult {
  text: string
  images: MCPImageContent[]
}

/**
 * Parse a tools/call JSON-RPC result into text + images. Shared by the
 * text-only and detailed call paths so screenshot tools don't silently
 * drop image blocks.
 */
export function parseMcpToolResult(result: unknown): MCPToolResult {
  const mcpContent = result as {
    content?: Array<{
      type?: string
      text?: string
      data?: string
      mimeType?: string
      source?: { type?: string; data?: string; media_type?: string; mimeType?: string }
    }>
  }
  if (!mcpContent?.content || !Array.isArray(mcpContent.content)) {
    // Structured MCP payloads: TOON only when it wins on size vs JSON mini.
    return {
      text: typeof result === 'string' ? result : serializeStructuredForPromptDetailed(result).text,
      images: [],
    }
  }

  const textParts: string[] = []
  const images: MCPImageContent[] = []
  for (const c of mcpContent.content) {
    if (c.type === 'text' && c.text) {
      textParts.push(c.text)
      continue
    }
    if (c.type === 'image') {
      const data = c.data ?? c.source?.data
      const mimeType = c.mimeType ?? c.source?.mimeType ?? c.source?.media_type ?? 'image/png'
      if (data) images.push({ mimeType, data })
    }
  }
  return {
    text: textParts.join('\n')
      || (images.length > 0 ? '' : serializeStructuredForPromptDetailed(result).text),
    images,
  }
}

interface MCPConfigFile {
  mcpServers?: Record<string, MCPServerConfig>
}

/** Scope for global (non-project) MCP servers — mirrors Rust GLOBAL_SCOPE. */
export const MCP_GLOBAL_SCOPE = '__global__'

// === Service ===

class MCPService {
  private static instance: MCPService
  /** Tools keyed by scope → (`${server}__${tool}` → MCPTool). */
  private toolsByScope: Map<string, Map<string, MCPTool>> = new Map()
  /** Remote server URLs keyed by `${scope}\u001f${name}`. */
  private serverUrls: Map<string, string> = new Map()
  /** Scope currently mirrored into useMcpStore (UI / status bar). */
  private viewScope: string = MCP_GLOBAL_SCOPE
  private initPromise: Promise<void> | null = null

  static getInstance(): MCPService {
    if (!MCPService.instance) {
      MCPService.instance = new MCPService()
    }
    return MCPService.instance
  }

  /** Normalize project path → scope key (or global). */
  scopeOf(projectPath?: string | null): string {
    if (projectPath && projectPath.length > 0) return projectPath
    return MCP_GLOBAL_SCOPE
  }

  private urlKey(scope: string, name: string): string {
    return `${scope}\u001f${name}`
  }

  private toolsOf(scope: string): Map<string, MCPTool> {
    let m = this.toolsByScope.get(scope)
    if (!m) {
      m = new Map()
      this.toolsByScope.set(scope, m)
    }
    return m
  }

  /**
   * Initialize MCP servers from global config (and optionally project config).
   * F4: each projectPath is an isolated scope — switching projects does NOT
   * stop another project's servers. Global init uses scope `__global__`.
   * Serialized: concurrent calls wait for the previous one to finish.
   */
  async initialize(projectPath?: string): Promise<void> {
    if (this.initPromise) {
      await this.initPromise
    }

    this.initPromise = this._doInitialize(projectPath)
    try {
      await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  private async _doInitialize(projectPath?: string): Promise<void> {
    const scope = this.scopeOf(projectPath)
    // Focused project (or global) becomes the UI view.
    this.viewScope = scope
    useMcpStore.getState().setInitializing(true)

    try {
      const config = await this.loadConfig(projectPath)
      const desiredServers = new Set(Object.keys(config.mcpServers || {}))

      // Stop only THIS scope's servers that are no longer desired — never
      // touch other open projects' MCP processes.
      const runningInScope = useMcpStore.getState().servers
        .filter(s => s.status === 'running' && (s.scope ?? MCP_GLOBAL_SCOPE) === scope)
      for (const server of runningInScope) {
        if (!desiredServers.has(server.name)) {
          await this.stopServer(server.name, scope)
          useMcpStore.getState().removeServer(server.name)
        }
      }

      if (!config.mcpServers || desiredServers.size === 0) {
        this.syncStoreFromScope(scope)
        return
      }

      const runningNames = new Set(
        useMcpStore.getState().servers
          .filter(s => s.status === 'running' && (s.scope ?? MCP_GLOBAL_SCOPE) === scope)
          .map(s => s.name),
      )
      // Also treat tools map as evidence of already-started server in this scope.
      for (const tool of this.toolsOf(scope).values()) {
        runningNames.add(tool.serverName)
      }

      const startPromises = Object.entries(config.mcpServers)
        .filter(([name]) => !runningNames.has(name))
        .map(async ([name, serverConfig]) => {
          try {
            await this.startServer(name, serverConfig, scope)
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            useMcpStore.getState().addServer({
              name,
              status: 'error',
              error: msg,
              tools: [],
              transport: inferTransport(serverConfig),
              scope,
            })
          }
        })

      await Promise.allSettled(startPromises)
      this.syncStoreFromScope(scope)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      useMcpStore.getState().setError(msg)
    } finally {
      useMcpStore.getState().setInitializing(false)
    }
  }

  /**
   * Rebuild the flat mcpStore view for a scope (UI). Called after init and
   * when the focused project changes without re-init.
   */
  setViewScope(projectPath?: string | null): void {
    const scope = this.scopeOf(projectPath)
    this.viewScope = scope
    this.syncStoreFromScope(scope)
  }

  private syncStoreFromScope(scope: string): void {
    // Rebuild from tools map + existing store entries for this scope.
    const byName = new Map<string, { tools: McpToolInfo[]; transport: 'stdio' | 'remote' }>()
    for (const tool of this.toolsOf(scope).values()) {
      let entry = byName.get(tool.serverName)
      if (!entry) {
        entry = { tools: [], transport: this.serverUrls.has(this.urlKey(scope, tool.serverName)) ? 'remote' : 'stdio' }
        byName.set(tool.serverName, entry)
      }
      entry.tools.push({
        name: tool.name,
        description: tool.description,
        serverName: tool.serverName,
      })
    }
    // Preserve error/starting entries already in store for this scope.
    const prev = useMcpStore.getState().servers.filter(s => (s.scope ?? MCP_GLOBAL_SCOPE) === scope)
    const servers: import('../../stores/mcpStore').McpServerState[] = Array.from(byName.entries()).map(
      ([name, { tools, transport }]) => {
        const old = prev.find(s => s.name === name)
        return {
          name,
          status: 'running' as const,
          tools,
          transport: old?.transport ?? transport,
          scope,
        }
      },
    )
    for (const s of prev) {
      if (s.status !== 'running' && !byName.has(s.name)) {
        servers.push({ ...s, scope })
      }
    }
    useMcpStore.getState().setServers(servers)
  }

  /**
   * Start a single MCP server in a scope (default: current view scope).
   */
  async startServer(name: string, config: MCPServerConfig, scope?: string): Promise<void> {
    const sc = scope ?? this.viewScope
    const transport = inferTransport(config)
    const store = useMcpStore.getState()

    store.addServer({
      name,
      status: 'starting',
      tools: [],
      transport,
      scope: sc,
    })

    if (transport === 'stdio') {
      await this.startStdioServer(name, config, sc)
    } else {
      await this.startRemoteServer(name, config, sc)
    }
  }

  /**
   * Stop a running server in a scope.
   */
  async stopServer(name: string, scope?: string): Promise<void> {
    const sc = scope ?? this.viewScope
    try {
      await invoke('mcp_stop_server', { name, scope: sc === MCP_GLOBAL_SCOPE ? null : sc })
    } catch {
      // Server may already be stopped
    }

    const tools = this.toolsOf(sc)
    for (const [toolKey, tool] of tools) {
      if (tool.serverName === name) tools.delete(toolKey)
    }
    this.serverUrls.delete(this.urlKey(sc, name))

    if (this.viewScope === sc) {
      useMcpStore.getState().updateServer(name, { status: 'stopped', tools: [] })
    }
  }

  /**
   * List tools available from a specific server in a scope.
   */
  async listTools(serverName: string, scope?: string): Promise<MCPTool[]> {
    const sc = scope ?? this.viewScope
    const result = await invoke<Record<string, unknown>>('mcp_send_request', {
      name: serverName,
      method: 'tools/list',
      params: {},
      scope: sc === MCP_GLOBAL_SCOPE ? null : sc,
    })

    const toolList = (result as { tools?: Array<Record<string, unknown>> })?.tools || []

    return toolList.map((t) => {
      const annotations = (t.annotations as { readOnlyHint?: boolean } | undefined)
      return {
        name: (t.name as string) || '',
        description: (t.description as string) || '',
        inputSchema: (t.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
        serverName,
        readOnlyHint: annotations?.readOnlyHint === true ? true : undefined,
      }
    })
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>, projectPath?: string): Promise<string> {
    const detailed = await this.callToolDetailed(serverName, toolName, args, projectPath)
    return detailed.text
  }

  async callToolDetailed(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    projectPath?: string,
  ): Promise<MCPToolResult> {
    const sc = this.resolveScopeForServer(serverName, projectPath)

    // Prefer remote if we have a URL for this scope.
    const url = this.serverUrls.get(this.urlKey(sc, serverName))
    if (url) {
      const text = await callRemote(url, toolName, args)
      return { text, images: [] }
    }

    // Fall back: view-store check for running (legacy path when only UI knows).
    if (this.viewScope === sc) {
      const server = useMcpStore.getState().servers.find((s) => s.name === serverName)
      if (server && server.status !== 'running' && server.transport === 'remote') {
        throw new Error(t('mcp.serverNotRunning').replace('{name}', serverName))
      }
    }

    const result = await invoke<Record<string, unknown>>('mcp_send_request', {
      name: serverName,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
      scope: sc === MCP_GLOBAL_SCOPE ? null : sc,
    })

    return parseMcpToolResult(result)
  }

  /**
   * Prefer project scope if the server is registered there; else global; else
   * the requested project path / view scope.
   */
  private resolveScopeForServer(serverName: string, projectPath?: string): string {
    const preferred = this.scopeOf(projectPath ?? (this.viewScope === MCP_GLOBAL_SCOPE ? null : this.viewScope))
    if (this.scopeHasServer(preferred, serverName)) return preferred
    if (preferred !== MCP_GLOBAL_SCOPE && this.scopeHasServer(MCP_GLOBAL_SCOPE, serverName)) {
      return MCP_GLOBAL_SCOPE
    }
    return preferred
  }

  private scopeHasServer(scope: string, serverName: string): boolean {
    for (const tool of this.toolsOf(scope).values()) {
      if (tool.serverName === serverName) return true
    }
    if (this.serverUrls.has(this.urlKey(scope, serverName))) return true
    return false
  }

  async addSingleServer(projectPath: string | undefined, serverName: string): Promise<void> {
    const scope = this.scopeOf(projectPath)
    const config = await this.loadConfig(projectPath)
    const serverConfig = config.mcpServers?.[serverName]
    if (!serverConfig) {
      throw new Error(`Server '${serverName}' not found in config`)
    }

    if (this.scopeHasServer(scope, serverName)) {
      await this.stopServer(serverName, scope)
    }

    try {
      await this.startServer(serverName, serverConfig, scope)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      useMcpStore.getState().addServer({
        name: serverName,
        status: 'error',
        error: msg,
        tools: [],
        transport: inferTransport(serverConfig),
        scope,
      })
    }
    if (this.viewScope === scope) this.syncStoreFromScope(scope)
  }

  async removeServer(_projectPath: string | undefined, serverName: string): Promise<void> {
    const scope = this.scopeOf(_projectPath)
    const configPaths: string[] = []
    try {
      const homeDir = await invoke<string>('get_home_directory')
      configPaths.push(appHomePath(homeDir, 'mcp.json'))
      configPaths.push(legacyAppHomePath(homeDir, 'mcp.json'))
    } catch { /* */ }
    if (_projectPath) {
      configPaths.push(`${_projectPath}/.tms/mcp.json`)
    }

    for (const configPath of configPaths) {
      try {
        const raw = await invoke<string>('read_file', { path: configPath })
        const config = JSON.parse(raw) as MCPConfigFile
        if (config.mcpServers?.[serverName]) {
          delete config.mcpServers[serverName]
          await invoke('write_file', { path: configPath, content: JSON.stringify(config, null, 2) })
        }
      } catch {
        // Config file may not exist
      }
    }

    await this.stopServer(serverName, scope)
    useMcpStore.getState().removeServer(serverName)
    this.serverUrls.delete(this.urlKey(scope, serverName))
  }

  /**
   * Tools for a project run: project-scope servers + global servers
   * (project tools win on name collision for the same tool key).
   * When projectPath is omitted, returns the current UI view scope only.
   */
  getAllTools(projectPath?: string): MCPTool[] {
    if (projectPath === undefined && this.viewScope === MCP_GLOBAL_SCOPE) {
      return Array.from(this.toolsOf(MCP_GLOBAL_SCOPE).values())
    }
    const projectScope = this.scopeOf(projectPath ?? (this.viewScope === MCP_GLOBAL_SCOPE ? null : this.viewScope))
    const merged = new Map<string, MCPTool>()
    // Global first, then project overrides.
    if (projectScope !== MCP_GLOBAL_SCOPE) {
      for (const [k, t] of this.toolsOf(MCP_GLOBAL_SCOPE)) merged.set(k, t)
    }
    for (const [k, t] of this.toolsOf(projectScope)) merged.set(k, t)
    return Array.from(merged.values())
  }

  getServerUrl(name: string, projectPath?: string): string | undefined {
    const sc = this.resolveScopeForServer(name, projectPath)
    return this.serverUrls.get(this.urlKey(sc, name))
  }

  /**
   * Shutdown MCP servers. With projectPath: only that project scope (F4 —
   * close project while others keep running). Without: kill everything
   * (expel / app teardown).
   */
  async shutdown(projectPath?: string): Promise<void> {
    if (projectPath) {
      const scope = this.scopeOf(projectPath)
      try {
        await invoke('mcp_stop_all_servers', { scope })
      } catch { /* best effort */ }
      this.toolsByScope.delete(scope)
      for (const key of Array.from(this.serverUrls.keys())) {
        if (key.startsWith(`${scope}\u001f`)) this.serverUrls.delete(key)
      }
      if (this.viewScope === scope) {
        useMcpStore.getState().reset()
      }
      return
    }
    try {
      await invoke('mcp_stop_all_servers', { scope: null })
    } catch { /* best effort */ }
    this.toolsByScope.clear()
    this.serverUrls.clear()
    useMcpStore.getState().reset()
  }

  // === Private Methods ===

  private async startStdioServer(name: string, config: MCPServerConfig, scope: string): Promise<void> {
    if (!config.command) {
      throw new Error(t('mcp.needsCommand').replace('{name}', name))
    }

    const envVars = config.env
      ? Object.entries(config.env).map(([key, value]) => ({ key, value }))
      : []

    await invoke('mcp_start_server', {
      name,
      command: config.command,
      args: config.args || [],
      env: envVars,
      scope: scope === MCP_GLOBAL_SCOPE ? null : scope,
    })

    try {
      await invoke('mcp_send_request', {
        name,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'tm-code', version: '0.1.0' },
        },
        scope: scope === MCP_GLOBAL_SCOPE ? null : scope,
      })

      await invoke('mcp_send_notification', {
        name,
        method: 'notifications/initialized',
        params: {},
        scope: scope === MCP_GLOBAL_SCOPE ? null : scope,
      }).catch(() => { /* best effort */ })
    } catch (error) {
      console.warn(`MCP initialize for '${name}' failed:`, error)
    }

    try {
      const tools = await this.listTools(name, scope)
      const map = this.toolsOf(scope)
      for (const tool of tools) {
        map.set(`${name}__${tool.name}`, tool)
      }

      const toolInfos: McpToolInfo[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        serverName: name,
      }))

      if (this.viewScope === scope) {
        useMcpStore.getState().updateServer(name, {
          status: 'running',
          tools: toolInfos,
        })
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (this.viewScope === scope) {
        useMcpStore.getState().updateServer(name, {
          status: 'error',
          error: t('mcp.discoveryFailed').replace('{message}', msg),
        })
      }
    }
  }

  private async startRemoteServer(name: string, config: MCPServerConfig, scope: string): Promise<void> {
    if (!config.url) {
      throw new Error(t('mcp.needsUrl').replace('{name}', name))
    }

    this.serverUrls.set(this.urlKey(scope, name), config.url)

    try {
      const remoteTools = await discoverRemote(config.url)
      const mcpTools: MCPTool[] = remoteTools.map((t) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
        serverName: name,
        readOnlyHint: t.readOnlyHint,
      }))

      const map = this.toolsOf(scope)
      for (const tool of mcpTools) {
        map.set(`${name}__${tool.name}`, tool)
      }

      const toolInfos: McpToolInfo[] = mcpTools.map((t) => ({
        name: t.name,
        description: t.description,
        serverName: name,
      }))

      if (this.viewScope === scope) {
        useMcpStore.getState().updateServer(name, { status: 'running', tools: toolInfos })
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (this.viewScope === scope) {
        useMcpStore.getState().updateServer(name, { status: 'error', error: msg })
      }
    }
  }

  private async loadConfig(projectPath?: string): Promise<MCPConfigFile> {
    const configs: MCPConfigFile[] = []

    try {
      const homeDir = await invoke<string>('get_home_directory')
      let globalRaw: string | null = null
      try {
        globalRaw = await invoke<string>('read_file', { path: appHomePath(homeDir, 'mcp.json') })
      } catch {
        try {
          globalRaw = await invoke<string>('read_file', { path: legacyAppHomePath(homeDir, 'mcp.json') })
        } catch {
          globalRaw = null
        }
      }
      if (globalRaw) {
        configs.push(JSON.parse(globalRaw) as MCPConfigFile)
      }
    } catch {
      // No global config
    }

    if (projectPath) {
      try {
        const projectConfigPath = `${projectPath}/.tms/mcp.json`
        const projectRaw = await invoke<string>('read_file', { path: projectConfigPath })
        configs.push(JSON.parse(projectRaw) as MCPConfigFile)
      } catch {
        // No project config
      }
    }

    const merged: MCPConfigFile = { mcpServers: {} }
    for (const config of configs) {
      if (config.mcpServers) {
        merged.mcpServers = { ...merged.mcpServers, ...config.mcpServers }
      }
    }

    return merged
  }
}

export default MCPService
