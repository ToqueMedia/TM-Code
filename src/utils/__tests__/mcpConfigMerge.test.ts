import type { McpRegistryEntry } from '../mcpRegistry'
import { buildConfigEntry } from '../mcpRegistry'

/**
 * These tests exercise the pure config-merge logic that /mcp-install performs.
 * We re-implement the merge inline (not imported from the command module —
 * that module pulls in Zustand + Tauri and is hard to unit-test in isolation)
 * and assert the invariants we care about:
 *   - existing mcpServers are preserved
 *   - new entries are added
 *   - re-installing the same integration is idempotent (no duplicates, latest config wins)
 *   - unrelated keys at the top level are preserved
 *
 * Uses a hand-built fixture (not MCP_REGISTRY) so the merge invariants stay
 * verifiable even when the registry is empty (today, until OAuth lands).
 */

const FIXTURE: McpRegistryEntry = {
  name: 'test-mcp',
  label: 'Test MCP',
  url: 'https://example.com/mcp',
  description: 'Fixture entry used only by config-merge tests.',
  category: 'dev-tools',
  auth: 'oauth-browser',
}

function mergeRegistryEntry(existing: unknown, entry: McpRegistryEntry) {
  const existingObj = (existing as { mcpServers?: Record<string, unknown> }) || {}
  return {
    ...existingObj,
    mcpServers: {
      ...(existingObj.mcpServers || {}),
      [entry.name]: buildConfigEntry(entry),
    },
  }
}

describe('MCP config merge (/mcp-install)', () => {
  it('writes a fresh config when none exists', () => {
    const merged = mergeRegistryEntry({}, FIXTURE)
    expect(merged.mcpServers).toBeDefined()
    expect(merged.mcpServers[FIXTURE.name]).toEqual({
      url: FIXTURE.url,
      transport: 'remote',
    })
  })

  it('preserves existing MCP entries when adding a new one', () => {
    const existing = {
      mcpServers: {
        'my-custom-mcp': { command: 'python', args: ['server.py'] },
      },
    }
    const merged = mergeRegistryEntry(existing, FIXTURE)
    expect(merged.mcpServers['my-custom-mcp']).toEqual({
      command: 'python',
      args: ['server.py'],
    })
    expect(merged.mcpServers[FIXTURE.name]).toBeDefined()
  })

  it('is idempotent — installing twice yields one entry with the latest config', () => {
    const first = mergeRegistryEntry({}, FIXTURE)
    const second = mergeRegistryEntry(first, FIXTURE)
    expect(Object.keys(second.mcpServers)).toEqual([FIXTURE.name])
    expect(second.mcpServers[FIXTURE.name]).toEqual(first.mcpServers[FIXTURE.name])
  })

  it('preserves non-mcpServers top-level keys (settings, metadata)', () => {
    const existing = {
      $schema: 'https://some-schema.json',
      version: 1,
      mcpServers: {},
    }
    const merged = mergeRegistryEntry(existing, FIXTURE) as typeof existing & {
      mcpServers: Record<string, unknown>
    }
    expect(merged.$schema).toBe('https://some-schema.json')
    expect(merged.version).toBe(1)
    expect(merged.mcpServers[FIXTURE.name]).toBeDefined()
  })
})
