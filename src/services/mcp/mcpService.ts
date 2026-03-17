import { invoke } from '@tauri-apps/api/core'
import { useMcpStore, McpToolInfo } from '../../stores/mcpStore'
import { discoverRemoteTools as discoverRemote, callRemoteTool as callRemote } from './remoteTransport'

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
}

interface MCPConfigFile {
  mcpServers?: Record<string, MCPServerConfig>
}

// === Service ===

class MCPService {
  private static instance: MCPService
  private tools: Map<string, MCPTool> = new Map()
  private serverUrls: Map<string, string> = new Map()
  private initialized = false

  static getInstance(): MCPService {
    if (!MCPService.instance) {
      MCPService.instance = new MCPService()
    }
    return MCPService.instance
  }

  /**
   * Initialize MCP servers from project and global config.
   */
  async initialize(projectPath: string): Promise<void> {
    // Shutdown existing servers first
    if (this.initialized) {
      await this.shutdown()
    }

    useMcpStore.getState().setInitializing(true)

    try {
      const config = await this.loadConfig(projectPath)

      if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
        useMcpStore.getState().setInitializing(false)
        this.initialized = true
        return
      }

      // Start servers concurrently — awaits all (including tool discovery)
      const startPromises = Object.entries(config.mcpServers).map(
        async ([name, serverConfig]) => {
          try {
            await this.startServer(name, serverConfig)
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            useMcpStore.getState().addServer({
              name,
              status: 'error',
              error: msg,
              tools: [],
              transport: inferTransport(serverConfig),
            })
          }
        }
      )

      await Promise.allSettled(startPromises)
      this.initialized = true
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      useMcpStore.getState().setError(msg)
    } finally {
      useMcpStore.getState().setInitializing(false)
    }
  }

  /**
   * Start a single MCP server.
   */
  async startServer(name: string, config: MCPServerConfig): Promise<void> {
    const transport = inferTransport(config)
    const store = useMcpStore.getState()

    store.addServer({
      name,
      status: 'starting',
      tools: [],
      transport,
    })

    if (transport === 'stdio') {
      await this.startStdioServer(name, config)
    } else {
      await this.startRemoteServer(name, config)
    }
  }

  /**
   * Stop a running server.
   */
  async stopServer(name: string): Promise<void> {
    try {
      await invoke('mcp_stop_server', { name })
    } catch {
      // Server may already be stopped
    }

    // Remove tools for this server
    for (const [toolKey, tool] of this.tools) {
      if (tool.serverName === name) {
        this.tools.delete(toolKey)
      }
    }

    useMcpStore.getState().updateServer(name, { status: 'stopped', tools: [] })
  }

  /**
   * List tools available from a specific server.
   * Throws on failure so callers can surface the error.
   */
  async listTools(serverName: string): Promise<MCPTool[]> {
    const result = await invoke<Record<string, unknown>>('mcp_send_request', {
      name: serverName,
      method: 'tools/list',
      params: {},
    })

    const toolList = (result as { tools?: Array<Record<string, unknown>> })?.tools || []

    return toolList.map((t) => ({
      name: (t.name as string) || '',
      description: (t.description as string) || '',
      inputSchema: (t.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
      serverName,
    }))
  }

  /**
   * Call a tool on a specific server.
   */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const server = useMcpStore.getState().servers.find((s) => s.name === serverName)

    if (!server || server.status !== 'running') {
      throw new Error(`MCP server '${serverName}' is not running`)
    }

    if (server.transport === 'remote') {
      const serverUrl = this.serverUrls.get(serverName)
      if (!serverUrl) throw new Error(`No URL stored for remote server '${serverName}'`)
      return callRemote(serverUrl, toolName, args)
    }

    const result = await invoke<Record<string, unknown>>('mcp_send_request', {
      name: serverName,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    })

    // Extract text content from MCP response
    const content = result as { content?: Array<{ type: string; text?: string }> }
    if (content?.content) {
      return content.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text)
        .join('\n')
    }

    return JSON.stringify(result)
  }

  /**
   * Add and start a single server without restarting existing ones.
   * Reads config from disk, starts only the named server.
   */
  async addSingleServer(projectPath: string, serverName: string): Promise<void> {
    const config = await this.loadConfig(projectPath)
    const serverConfig = config.mcpServers?.[serverName]
    if (!serverConfig) {
      throw new Error(`Server '${serverName}' not found in config`)
    }

    // Stop if already exists
    const existing = useMcpStore.getState().servers.find(s => s.name === serverName)
    if (existing) {
      await this.stopServer(serverName)
    }

    try {
      await this.startServer(serverName, serverConfig)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      useMcpStore.getState().addServer({
        name: serverName,
        status: 'error',
        error: msg,
        tools: [],
        transport: inferTransport(serverConfig),
      })
    }

    this.initialized = true
  }

  /**
   * Remove a server: stop it, remove from config file, clean up state.
   */
  async removeServer(projectPath: string, serverName: string): Promise<void> {
    // Stop if running
    await this.stopServer(serverName)

    // Remove from store
    useMcpStore.getState().removeServer(serverName)

    // Remove URL if remote
    this.serverUrls.delete(serverName)

    // Remove from config file
    try {
      const configPath = `${projectPath}/.tms/mcp.json`
      const raw = await invoke<string>('read_file', { path: configPath })
      const config = JSON.parse(raw) as MCPConfigFile
      if (config.mcpServers?.[serverName]) {
        delete config.mcpServers[serverName]
        await invoke('write_file', { path: configPath, content: JSON.stringify(config, null, 2) })
      }
    } catch {
      // Config file may not exist — server was only in global config or already removed
    }
  }

  /**
   * Get all tools from all running servers.
   */
  getAllTools(): MCPTool[] {
    return Array.from(this.tools.values())
  }

  /**
   * Shutdown all running servers.
   */
  async shutdown(): Promise<void> {
    try {
      await invoke('mcp_stop_all_servers')
    } catch {
      // Best effort
    }
    this.tools.clear()
    this.serverUrls.clear()
    useMcpStore.getState().reset()
    this.initialized = false
  }

  // === Private Methods ===

  private async startStdioServer(name: string, config: MCPServerConfig): Promise<void> {
    if (!config.command) {
      throw new Error(`MCP server '${name}' requires a command for stdio transport`)
    }

    // Resolve environment variables
    const envVars = config.env
      ? Object.entries(config.env).map(([key, value]) => ({ key, value }))
      : []

    await invoke('mcp_start_server', {
      name,
      command: config.command,
      args: config.args || [],
      env: envVars,
    })

    // Send initialize request (JSON-RPC request with id — expects response)
    try {
      await invoke('mcp_send_request', {
        name,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'tm-code', version: '0.1.0' },
        },
      })

      // Send initialized notification (no id, no response — fire and forget)
      await invoke('mcp_send_notification', {
        name,
        method: 'notifications/initialized',
        params: {},
      }).catch(() => {
        // Best effort — some servers don't need this
      })
    } catch (error) {
      // Some servers don't require initialize, continue
      console.warn(`MCP initialize for '${name}' failed:`, error)
    }

    // Discover tools — if this fails, server started but tools are unknown
    try {
      const tools = await this.listTools(name)
      for (const tool of tools) {
        this.tools.set(`${name}__${tool.name}`, tool)
      }

      const toolInfos: McpToolInfo[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        serverName: name,
      }))

      useMcpStore.getState().updateServer(name, {
        status: 'running',
        tools: toolInfos,
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      useMcpStore.getState().updateServer(name, {
        status: 'error',
        error: `Server started but tool discovery failed: ${msg}`,
      })
    }
  }

  private async startRemoteServer(name: string, config: MCPServerConfig): Promise<void> {
    if (!config.url) {
      throw new Error(`MCP server '${name}' requires a url for remote transport`)
    }

    // Store the URL for later tool calls
    this.serverUrls.set(name, config.url)

    // Keep status as 'starting' until tool discovery completes
    // (addServer already set it to 'starting' in startServer)

    // Discover tools via the remote transport proxy
    try {
      const remoteTools = await discoverRemote(config.url)
      const mcpTools: MCPTool[] = remoteTools.map((t) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
        serverName: name,
      }))

      for (const tool of mcpTools) {
        this.tools.set(`${name}__${tool.name}`, tool)
      }

      const toolInfos: McpToolInfo[] = mcpTools.map((t) => ({
        name: t.name,
        description: t.description,
        serverName: name,
      }))

      // Only now mark as 'running' — tools are discovered
      useMcpStore.getState().updateServer(name, { status: 'running', tools: toolInfos })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      useMcpStore.getState().updateServer(name, { status: 'error', error: msg })
    }
  }

  private async loadConfig(projectPath: string): Promise<MCPConfigFile> {
    const configs: MCPConfigFile[] = []

    // Load global config
    try {
      const homeDir = await invoke<string>('get_home_directory')
      const globalConfigPath = `${homeDir}/.toquemedia-studio/mcp.json`
      const globalRaw = await invoke<string>('read_file', { path: globalConfigPath })
      configs.push(JSON.parse(globalRaw) as MCPConfigFile)
    } catch {
      // No global config
    }

    // Load project config (overrides global)
    try {
      const projectConfigPath = `${projectPath}/.tms/mcp.json`
      const projectRaw = await invoke<string>('read_file', { path: projectConfigPath })
      configs.push(JSON.parse(projectRaw) as MCPConfigFile)
    } catch {
      // No project config
    }

    // Merge: project overrides global
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
