import { useMcpStore } from '../mcpStore'

function resetStore() {
  useMcpStore.setState({
    servers: [],
    isInitializing: false,
    error: null,
  })
}

describe('mcpStore', () => {
  beforeEach(resetStore)

  describe('addServer', () => {
    it('adds a new server', () => {
      useMcpStore.getState().addServer({
        name: 'test-server',
        status: 'starting',
        tools: [],
        transport: 'stdio',
      })

      expect(useMcpStore.getState().servers).toHaveLength(1)
      expect(useMcpStore.getState().servers[0].name).toBe('test-server')
    })

    it('replaces server with same name', () => {
      const store = useMcpStore.getState()

      store.addServer({ name: 'srv', status: 'starting', tools: [], transport: 'stdio' })
      store.addServer({ name: 'srv', status: 'running', tools: [{ name: 'tool1', description: 'desc', serverName: 'srv' }], transport: 'stdio' })

      expect(useMcpStore.getState().servers).toHaveLength(1)
      expect(useMcpStore.getState().servers[0].status).toBe('running')
      expect(useMcpStore.getState().servers[0].tools).toHaveLength(1)
    })
  })

  describe('updateServer', () => {
    it('updates matching server', () => {
      useMcpStore.getState().addServer({ name: 'srv', status: 'starting', tools: [], transport: 'stdio' })
      useMcpStore.getState().updateServer('srv', { status: 'running' })

      expect(useMcpStore.getState().servers[0].status).toBe('running')
    })

    it('does not affect non-matching servers', () => {
      const store = useMcpStore.getState()
      store.addServer({ name: 'a', status: 'starting', tools: [], transport: 'stdio' })
      store.addServer({ name: 'b', status: 'starting', tools: [], transport: 'stdio' })

      useMcpStore.getState().updateServer('a', { status: 'error', error: 'fail' })

      expect(useMcpStore.getState().servers.find(s => s.name === 'b')?.status).toBe('starting')
    })
  })

  describe('removeServer', () => {
    it('removes server by name', () => {
      const store = useMcpStore.getState()
      store.addServer({ name: 'a', status: 'running', tools: [], transport: 'stdio' })
      store.addServer({ name: 'b', status: 'running', tools: [], transport: 'stdio' })

      useMcpStore.getState().removeServer('a')

      expect(useMcpStore.getState().servers).toHaveLength(1)
      expect(useMcpStore.getState().servers[0].name).toBe('b')
    })
  })

  describe('getRunningServers', () => {
    it('filters only running servers', () => {
      const store = useMcpStore.getState()
      store.addServer({ name: 'running', status: 'running', tools: [], transport: 'stdio' })
      store.addServer({ name: 'starting', status: 'starting', tools: [], transport: 'stdio' })
      store.addServer({ name: 'error', status: 'error', error: 'fail', tools: [], transport: 'stdio' })

      const running = useMcpStore.getState().getRunningServers()
      expect(running).toHaveLength(1)
      expect(running[0].name).toBe('running')
    })
  })

  describe('getTotalToolCount', () => {
    it('counts tools across all servers', () => {
      const store = useMcpStore.getState()
      store.addServer({
        name: 'a', status: 'running', transport: 'stdio',
        tools: [
          { name: 't1', description: '', serverName: 'a' },
          { name: 't2', description: '', serverName: 'a' },
        ],
      })
      store.addServer({
        name: 'b', status: 'running', transport: 'stdio',
        tools: [
          { name: 't3', description: '', serverName: 'b' },
        ],
      })

      expect(useMcpStore.getState().getTotalToolCount()).toBe(3)
    })

    it('returns 0 with no servers', () => {
      expect(useMcpStore.getState().getTotalToolCount()).toBe(0)
    })
  })

  describe('setInitializing', () => {
    it('sets and clears isInitializing', () => {
      useMcpStore.getState().setInitializing(true)
      expect(useMcpStore.getState().isInitializing).toBe(true)

      useMcpStore.getState().setInitializing(false)
      expect(useMcpStore.getState().isInitializing).toBe(false)
    })
  })

  describe('reset', () => {
    it('clears everything', () => {
      const store = useMcpStore.getState()
      store.addServer({ name: 'srv', status: 'running', tools: [], transport: 'stdio' })
      store.setInitializing(true)
      store.setError('some error')

      useMcpStore.getState().reset()

      const state = useMcpStore.getState()
      expect(state.servers).toEqual([])
      expect(state.isInitializing).toBe(false)
      expect(state.error).toBeNull()
    })
  })
})
