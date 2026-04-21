import { buildConfigEntry, MCP_REGISTRY } from '../mcpRegistry'
import { CANVA_MCP_NAME } from '../canvaMcp'

/**
 * These tests exercise the pure config-merge logic that /canva-connect and
 * /mcp-install both perform. We re-implement the merge inline (not imported
 * from the command module — that module pulls in Zustand + Tauri and is hard
 * to unit-test in isolation) and assert the invariants we care about:
 *   - existing mcpServers are preserved
 *   - new entries are added
 *   - re-installing the same integration is idempotent (no duplicates, latest config wins)
 *   - unrelated keys at the top level are preserved
 */
function mergeRegistryEntry(existing: unknown, entryName: string) {
  const entry = MCP_REGISTRY.find(e => e.name === entryName)!
  const existingObj = (existing as { mcpServers?: Record<string, unknown> }) || {}
  return {
    ...existingObj,
    mcpServers: {
      ...(existingObj.mcpServers || {}),
      [entry.name]: buildConfigEntry(entry),
    },
  }
}

describe('MCP config merge (shared by /canva-connect and /mcp-install)', () => {
  it('writes a fresh config when none exists', () => {
    const merged = mergeRegistryEntry({}, CANVA_MCP_NAME)
    expect(merged.mcpServers).toBeDefined()
    expect(merged.mcpServers[CANVA_MCP_NAME]).toEqual({
      url: 'https://mcp.canva.com/mcp',
      transport: 'remote',
    })
  })

  it('preserves existing MCP entries when adding a new one', () => {
    const existing = {
      mcpServers: {
        'my-custom-mcp': { command: 'python', args: ['server.py'] },
      },
    }
    const merged = mergeRegistryEntry(existing, 'figma')
    expect(merged.mcpServers['my-custom-mcp']).toEqual({
      command: 'python',
      args: ['server.py'],
    })
    expect(merged.mcpServers['figma']).toBeDefined()
  })

  it('is idempotent — installing twice yields one entry with the latest config', () => {
    const first = mergeRegistryEntry({}, CANVA_MCP_NAME)
    const second = mergeRegistryEntry(first, CANVA_MCP_NAME)
    expect(Object.keys(second.mcpServers)).toEqual([CANVA_MCP_NAME])
    expect(second.mcpServers[CANVA_MCP_NAME]).toEqual(first.mcpServers[CANVA_MCP_NAME])
  })

  it('preserves non-mcpServers top-level keys (settings, metadata)', () => {
    const existing = {
      $schema: 'https://some-schema.json',
      version: 1,
      mcpServers: {},
    }
    const merged = mergeRegistryEntry(existing, 'figma') as typeof existing & {
      mcpServers: Record<string, unknown>
    }
    expect(merged.$schema).toBe('https://some-schema.json')
    expect(merged.version).toBe(1)
    expect(merged.mcpServers['figma']).toBeDefined()
  })

  it('uses the canonical URL for each registry entry (no drift from registry)', () => {
    for (const entry of MCP_REGISTRY) {
      const merged = mergeRegistryEntry({}, entry.name)
      const written = merged.mcpServers[entry.name] as { url?: string }
      expect(written.url).toBe(entry.url)
    }
  })
})
