/**
 * Tests for Session Memory feature (Gap 1).
 *
 * Session memory is a structured markdown field on ChatSession that:
 * - The agent updates via `update_session_memory` tool
 * - Survives context compaction (re-injected post-compact)
 * - Persists to disk alongside the session
 * - Appears in the system prompt as a dynamic section
 * - Resets on new session creation
 */

// ─── Section rendering (pure functions, no mocks needed) ──────────

import { getSessionMemorySection } from '../contextBuilder/sections/chatSections'
import type { PromptContext } from '../contextBuilder/types'

describe('getSessionMemorySection', () => {
  const baseCtx = {
    sessionMemory: null,
  } as unknown as PromptContext

  it('returns null when sessionMemory is null', () => {
    expect(getSessionMemorySection(baseCtx)).toBeNull()
  })

  it('returns null when sessionMemory is empty string', () => {
    const ctx = { ...baseCtx, sessionMemory: '' } as unknown as PromptContext
    expect(getSessionMemorySection(ctx)).toBeNull()
  })

  it('renders session memory content with header', () => {
    const ctx = {
      ...baseCtx,
      sessionMemory: '- Working on auth module\n- Next: add tests',
    } as unknown as PromptContext
    const result = getSessionMemorySection(ctx)
    expect(result).not.toBeNull()
    expect(result!).toContain('# Session memory')
    expect(result!).toContain('- Working on auth module')
    expect(result!).toContain('- Next: add tests')
  })

  it('includes instruction text about compaction survival', () => {
    const ctx = {
      ...baseCtx,
      sessionMemory: 'test notes',
    } as unknown as PromptContext
    const result = getSessionMemorySection(ctx)
    expect(result).not.toBeNull()
    expect(result!).toContain('compaction')
  })

  it('returns null when the context carries no sessionMemory field at all', () => {
    const ctx = {} as unknown as PromptContext
    expect(getSessionMemorySection(ctx)).toBeNull()
  })
})
