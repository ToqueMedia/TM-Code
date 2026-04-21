import { MCP_REGISTRY, findRegistryEntry, buildConfigEntry } from '../mcpRegistry'
import { CANVA_MCP_CONFIG, CANVA_MCP_URL, CANVA_MCP_NAME } from '../canvaMcp'

describe('mcpRegistry', () => {
  describe('MCP_REGISTRY', () => {
    it('includes Canva as the first entry (backward compat expectations)', () => {
      expect(MCP_REGISTRY[0].name).toBe(CANVA_MCP_NAME)
      expect(MCP_REGISTRY[0].url).toBe(CANVA_MCP_URL)
    })

    it('has unique names across all entries', () => {
      const names = MCP_REGISTRY.map(e => e.name)
      expect(new Set(names).size).toBe(names.length)
    })

    it('covers the curated categories with at least one entry', () => {
      const categories = new Set(MCP_REGISTRY.map(e => e.category))
      // Registry currently ships: design (Canva, Figma), docs (Notion), dev-tools (Linear).
      // Presentation-category entries were removed pending stdio + api-key support.
      expect(categories.has('design')).toBe(true)
      expect(categories.has('docs')).toBe(true)
      expect(categories.has('dev-tools')).toBe(true)
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
    it('matches by exact name', () => {
      expect(findRegistryEntry('canva')?.label).toBe('Canva')
      expect(findRegistryEntry('figma')?.label).toBe('Figma')
    })

    it('matches case-insensitively on name and label', () => {
      expect(findRegistryEntry('CANVA')?.name).toBe('canva')
      expect(findRegistryEntry('Figma')?.name).toBe('figma')
    })

    it('returns undefined for unknown names', () => {
      expect(findRegistryEntry('nonexistent-mcp')).toBeUndefined()
      expect(findRegistryEntry('')).toBeUndefined()
    })
  })

  describe('buildConfigEntry', () => {
    it('returns the pre-exported Canva config for the Canva entry (referential identity)', () => {
      const canva = MCP_REGISTRY.find(e => e.name === CANVA_MCP_NAME)!
      expect(buildConfigEntry(canva)).toEqual(CANVA_MCP_CONFIG)
    })

    it('returns a remote-transport config for other entries', () => {
      const figma = MCP_REGISTRY.find(e => e.name === 'figma')!
      expect(buildConfigEntry(figma)).toEqual({ url: figma.url, transport: 'remote' })
    })

    it('only ships URLs verified against each vendor\'s official documentation', () => {
      // Guard rail: refuse to let someone casually add a fabricated URL in a future PR.
      const expectedUrls: Record<string, string> = {
        canva: 'https://mcp.canva.com/mcp',
        figma: 'https://mcp.figma.com/mcp',
        notion: 'https://mcp.notion.com/mcp',
        linear: 'https://mcp.linear.app/mcp',
      }
      for (const entry of MCP_REGISTRY) {
        expect(entry.url).toBe(expectedUrls[entry.name])
      }
    })
  })
})
