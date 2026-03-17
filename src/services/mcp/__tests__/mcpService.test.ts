import { invoke } from '@tauri-apps/api/core'
import MCPService from '../mcpService'
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
          if (path === '/home/user/.toquemedia-studio/mcp.json') {
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
    it('throws when server is not running', async () => {
      useMcpStore.setState({
        servers: [{ name: 'srv', status: 'stopped', tools: [], transport: 'stdio' }],
        isInitializing: false,
        error: null,
      })

      await expect(
        service.callTool('srv', 'some_tool', {})
      ).rejects.toThrow("MCP server 'srv' is not running")
    })

    it('throws when server does not exist', async () => {
      await expect(
        service.callTool('nonexistent', 'tool', {})
      ).rejects.toThrow("not running")
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
})
