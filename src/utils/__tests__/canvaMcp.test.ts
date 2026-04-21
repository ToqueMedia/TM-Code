import { isCanvaConnected, CANVA_MCP_NAME, CANVA_MCP_URL, CANVA_MCP_CONFIG } from '../canvaMcp'
import type { McpServerState } from '../../stores/mcpStore'

function server(overrides: Partial<McpServerState> = {}): McpServerState {
  return {
    name: 'other',
    status: 'running',
    transport: 'remote',
    tools: [],
    ...overrides,
  }
}

describe('canvaMcp', () => {
  describe('constants', () => {
    it('exposes the canonical Canva MCP URL', () => {
      expect(CANVA_MCP_URL).toBe('https://mcp.canva.com/mcp')
      expect(CANVA_MCP_NAME).toBe('canva')
      expect(CANVA_MCP_CONFIG).toEqual({ url: CANVA_MCP_URL, transport: 'remote' })
    })
  })

  describe('isCanvaConnected', () => {
    it('returns false for an empty server list', () => {
      expect(isCanvaConnected([])).toBe(false)
    })

    it('returns true when a server named "canva" is running', () => {
      expect(isCanvaConnected([server({ name: 'canva' })])).toBe(true)
    })

    it('matches case-insensitively on the server name', () => {
      expect(isCanvaConnected([server({ name: 'Canva' })])).toBe(true)
      expect(isCanvaConnected([server({ name: 'CANVA' })])).toBe(true)
    })

    it('returns false when the canva server is not yet running', () => {
      expect(isCanvaConnected([server({ name: 'canva', status: 'starting' })])).toBe(false)
      expect(isCanvaConnected([server({ name: 'canva', status: 'error' })])).toBe(false)
      expect(isCanvaConnected([server({ name: 'canva', status: 'stopped' })])).toBe(false)
    })

    it('ignores non-Canva servers entirely', () => {
      const servers = [
        server({ name: 'github', tools: [{ name: 'create_pr', description: '', serverName: 'github' }] }),
        server({ name: 'linear', tools: [{ name: 'list_issues', description: '', serverName: 'linear' }] }),
      ]
      expect(isCanvaConnected(servers)).toBe(false)
    })

    describe('with URL lookup (canonical detection)', () => {
      it('returns true when a server URL matches CANVA_MCP_URL even with a non-canonical name', () => {
        const servers = [server({ name: 'my-design-mcp' })]
        const lookup = (name: string) => (name === 'my-design-mcp' ? CANVA_MCP_URL : undefined)
        expect(isCanvaConnected(servers, lookup)).toBe(true)
      })

      it('rejects a server named "canva" that points to a different URL (false positive guard)', () => {
        const servers = [server({ name: 'canva' })]
        const lookup = () => 'https://example.com/some-other-mcp'
        expect(isCanvaConnected(servers, lookup)).toBe(false)
      })

      it('falls back to name match only when no URL lookup is provided', () => {
        const servers = [server({ name: 'canva' })]
        expect(isCanvaConnected(servers)).toBe(true)
        expect(isCanvaConnected(servers, () => undefined)).toBe(false)
      })
    })
  })
})
