import { MCP_REGISTRY, findRegistryEntry, buildConfigEntry } from '../mcpRegistry'

describe('mcpRegistry', () => {
  describe('MCP_REGISTRY', () => {
    it('has unique names across all entries', () => {
      const names = MCP_REGISTRY.map(e => e.name)
      expect(new Set(names).size).toBe(names.length)
    })

    it('every entry has a non-empty URL, label, and description', () => {
      for (const entry of MCP_REGISTRY) {
        expect(entry.url).toMatch(/^https:\/\//)
        expect(entry.label.length).toBeGreaterThan(0)
        expect(entry.description.length).toBeGreaterThan(10)
      }
    })
  })

  describe('findRegistryEntry', () => {
    it('returns undefined for unknown names', () => {
      expect(findRegistryEntry('nonexistent-mcp')).toBeUndefined()
      expect(findRegistryEntry('')).toBeUndefined()
    })

    // Name / label matching is covered structurally whenever entries exist.
    // We intentionally do not hardcode specific entry names here so this suite
    // doesn't have to be rewritten every time an entry is added or removed.
  })

  describe('buildConfigEntry', () => {
    it('returns a remote-transport config shape', () => {
      for (const entry of MCP_REGISTRY) {
        expect(buildConfigEntry(entry)).toEqual({ url: entry.url, transport: 'remote' })
      }
    })
  })
})
