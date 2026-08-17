import { invoke } from '@tauri-apps/api/core'
import MCPService, { parseMcpToolResult } from '../mcpService'
import { useMcpStore } from '../../../stores/mcpStore'

const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>

// Reset singleton between tests
function freshService(): MCPService {
  // @ts-expect-error — reset private singleton
  MCPService.instance = undefined
  return MCPService.getInstance()
}

// Reset mcpStore between tests
function resetStore() {
  useMcpStore.setState({
    servers: [],
    isInitializing: false,
    error: null,
  })
}

describe('MCPService', () => {
  let service: MCPService

  beforeEach(() => {
    service = freshService()
    resetStore()
    mockedInvoke.mockReset()
  })

  describe('singleton', () => {
    it('returns the same instance', () => {
      expect(MCPService.getInstance()).toBe(MCPService.getInstance())
    })
  })

  describe('initialize', () => {
    it('does nothing when no config files exist', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'get_home_directory') return '/home/user'
        if (cmd === 'read_file') throw new Error('File not found')
        return null
      })

      await service.initialize('/project')

      const store = useMcpStore.getState()
      expect(store.servers).toHaveLength(0)
      expect(store.isInitializing).toBe(false)
    })

    it('sets isInitializing during startup', async () => {
      let resolveConfig: () => void
      const configPromise = new Promise<void>(r => { resolveConfig = r })

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'get_home_directory') {
          // Delay to observe isInitializing=true
          await configPromise
          return '/home/user'
        }
        throw new Error('Not found')
      })

      const initPromise = service.initialize('/project')

      // Should be initializing now
      expect(useMcpStore.getState().isInitializing).toBe(true)

      resolveConfig!()
      await initPromise

      expect(useMcpStore.getState().isInitializing).toBe(false)
    })

    it('loads and merges global + project config', async () => {
      const startedServers: string[] = []

      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'get_home_directory') return '/home/user'
        if (cmd === 'read_file') {
          const path = (args as Record<string, unknown>)?.path as string
          if (path === '/home/user/.tmcode/mcp.json') {
            return JSON.stringify({
              mcpServers: {
                'global-server': { transport: 'stdio', command: 'echo', args: [] },
              },
            })
          }
          if (path === '/project/.tms/mcp.json') {
            return JSON.stringify({
              mcpServers: {
                'project-server': { transport: 'stdio', command: 'echo', args: [] },
              },
            })
          }
          throw new Error('Not found')
        }
        if (cmd === 'mcp_start_server') {
          startedServers.push((args as Record<string, unknown>)?.name as string)
          return undefined
        }
        if (cmd === 'mcp_send_request') {
          const method = (args as Record<string, unknown>)?.method as string
          if (method === 'initialize') return { capabilities: {} }
          if (method === 'tools/list') return { tools: [] }
          return null
        }
        if (cmd === 'mcp_send_notification') return undefined
        return null
      })

      await service.initialize('/project')

      expect(startedServers).toContain('global-server')
      expect(startedServers).toContain('project-server')
    })

    it('handles server start failure gracefully', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'get_home_directory') return '/home/user'
        if (cmd === 'read_file') {
          return JSON.stringify({
            mcpServers: {
              'broken-server': { transport: 'stdio', command: 'nonexistent' },
            },
          })
        }
        if (cmd === 'mcp_start_server') {
          throw new Error('command not found: nonexistent')
        }
        throw new Error('Not found')
      })

      // Should not throw
      await service.initialize('/project')

      const store = useMcpStore.getState()
      const broken = store.servers.find(s => s.name === 'broken-server')
      expect(broken?.status).toBe('error')
      expect(broken?.error).toContain('nonexistent')
    })
  })

  describe('getAllTools', () => {
    it('returns empty when no servers', () => {
      expect(service.getAllTools()).toEqual([])
    })
  })

  describe('callTool', () => {
    it('throws when Rust reports the server is missing', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'mcp_send_request') {
          throw new Error("MCP server 'srv' not found or not running (scope '__global__')")
        }
        return null
      })
      await expect(
        service.callTool('srv', 'some_tool', {})
      ).rejects.toThrow(/not found or not running/)
    })

    it('throws when server does not exist', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'mcp_send_request') {
          throw new Error("MCP server 'nonexistent' not found or not running")
        }
        return null
      })
      await expect(
        service.callTool('nonexistent', 'tool', {})
      ).rejects.toThrow(/not found or not running/)
    })
  })

  describe('F4 multi-project scopes', () => {
    it('initialize(projectB) does not stop project A servers', async () => {
      const stopped: string[] = []
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'get_home_directory') return '/home/user'
        if (cmd === 'read_file') {
          const path = (args as Record<string, unknown>)?.path as string
          if (path?.endsWith('mcp.json')) {
            return JSON.stringify({
              mcpServers: {
                'shared-name': { transport: 'stdio', command: 'echo', args: [] },
              },
            })
          }
          throw new Error('Not found')
        }
        if (cmd === 'mcp_start_server') return undefined
        if (cmd === 'mcp_stop_server') {
          stopped.push((args as { name?: string; scope?: string })?.scope ?? 'none')
          return undefined
        }
        if (cmd === 'mcp_send_request') {
          const method = (args as Record<string, unknown>)?.method as string
          if (method === 'initialize') return { capabilities: {} }
          if (method === 'tools/list') {
            return { tools: [{ name: 't', description: 'd', inputSchema: {} }] }
          }
          return null
        }
        if (cmd === 'mcp_send_notification') return undefined
        return null
      })

      await service.initialize('/proj-a')
      expect(service.getAllTools('/proj-a').some(t => t.serverName === 'shared-name')).toBe(true)

      await service.initialize('/proj-b')
      // A still has its tools; B also has the same server name under its scope
      expect(service.getAllTools('/proj-a').some(t => t.serverName === 'shared-name')).toBe(true)
      expect(service.getAllTools('/proj-b').some(t => t.serverName === 'shared-name')).toBe(true)
      // Must not have stopped A while opening B
      expect(stopped).toEqual([])
    })
  })

  describe('shutdown', () => {
    it('clears tools and resets store', async () => {
      useMcpStore.setState({
        servers: [{ name: 'srv', status: 'running', tools: [{ name: 't', description: '', serverName: 'srv' }], transport: 'stdio' }],
        isInitializing: false,
        error: null,
      })

      mockedInvoke.mockImplementation(async () => undefined)

      await service.shutdown()

      expect(service.getAllTools()).toEqual([])
      expect(useMcpStore.getState().servers).toEqual([])
    })
  })

  describe('parseMcpToolResult (prompt format policy)', () => {
    it('encodes tabular structured results as TOON', () => {
      const result = {
        tools: [
          { name: 'a', server: 's', description: 'da', inputCount: 1 },
          { name: 'b', server: 's', description: 'db', inputCount: 2 },
        ],
      }
      const parsed = parseMcpToolResult(result)
      expect(parsed.text).toMatch(/tools\[2\]\{/)
      expect(parsed.images).toEqual([])
    })

    it('encodes nested irregular results as minified JSON', () => {
      const result = { ok: true, page: { title: 'x', nested: { a: 1 } } }
      const parsed = parseMcpToolResult(result)
      expect(parsed.text).toBe(JSON.stringify(result))
    })

    it('keeps MCP content-array text parts as plain text', () => {
      const parsed = parseMcpToolResult({
        content: [{ type: 'text', text: 'hello from tool' }],
      })
      expect(parsed.text).toBe('hello from tool')
    })
  })
})
