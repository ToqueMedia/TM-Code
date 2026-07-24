/**
 * Agent shell UI grouping — one card per PTY session even when reasoning/text
 * is interleaved between write/read tool calls (deploy spam regression).
 */

import type { ToolCallDisplay } from '../../../types/chat'
import {
  groupAgentShellBySession,
  resolveAgentShellSessionId,
} from '../ShellCommandBlock'

function tc(
  id: string,
  toolName: string,
  opts?: { session_id?: string; result?: string; status?: ToolCallDisplay['status'] },
): ToolCallDisplay {
  return {
    id,
    toolName,
    input: opts?.session_id ? { session_id: opts.session_id } : {},
    result: opts?.result,
    status: opts?.status ?? 'completed',
    isError: false,
    timestamp: 0,
  }
}

describe('resolveAgentShellSessionId', () => {
  it('prefers input.session_id', () => {
    expect(
      resolveAgentShellSessionId(tc('1', 'agent_shell_read', { session_id: 'agent-shell-abc' })),
    ).toBe('agent-shell-abc')
  })

  it('parses session_id from start result', () => {
    expect(
      resolveAgentShellSessionId(
        tc('1', 'agent_shell_start', {
          result: 'Agent shell started.\nsession_id: agent-shell-xyz\ncwd: /tmp',
        }),
      ),
    ).toBe('agent-shell-xyz')
  })
})

describe('groupAgentShellBySession', () => {
  it('merges all shell tools of the same session into ONE group', () => {
    const SID = 'agent-shell-1784910399420-zeq5y6'
    const calls = [
      tc('s', 'agent_shell_start', { result: `session_id: ${SID}` }),
      tc('w1', 'agent_shell_write', { session_id: SID }),
      tc('r1', 'agent_shell_read', { session_id: SID }),
      tc('w2', 'agent_shell_write', { session_id: SID }),
      tc('r2', 'agent_shell_read', { session_id: SID }),
      tc('r3', 'agent_shell_read', { session_id: SID }),
      tc('r4', 'agent_shell_read', { session_id: SID }),
      tc('stop', 'agent_shell_stop', { session_id: SID }),
    ]
    // Simulate interleaving: only shell tools here (grouping is by session)
    const groups = groupAgentShellBySession(calls)
    const shell = groups.filter(g => g.kind === 'agent_shell_session')
    expect(shell).toHaveLength(1)
    if (shell[0].kind !== 'agent_shell_session') throw new Error('expected session')
    expect(shell[0].calls).toHaveLength(8)
    expect(shell[0].sessionId).toBe(SID)
  })

  it('keeps non-shell tools as singles between sessions', () => {
    const SID = 'agent-shell-a'
    const calls = [
      tc('s', 'agent_shell_start', { result: `session_id: ${SID}` }),
      tc('w1', 'agent_shell_write', { session_id: SID }),
      tc('edit', 'edit_file'),
      tc('r1', 'agent_shell_read', { session_id: SID }),
    ]
    const groups = groupAgentShellBySession(calls)
    expect(groups.map(g => g.kind)).toEqual([
      'agent_shell_session',
      'single',
      // read is absorbed into the first session group — not re-emitted
    ])
    expect(groups).toHaveLength(2)
    if (groups[0].kind !== 'agent_shell_session') throw new Error('expected session')
    expect(groups[0].calls.map(c => c.toolName)).toEqual([
      'agent_shell_start',
      'agent_shell_write',
      'agent_shell_read',
    ])
    if (groups[1].kind !== 'single') throw new Error('expected single')
    expect(groups[1].call.toolName).toBe('edit_file')
  })

  it('does not create 23 cards for the deploy poll pattern', () => {
    const SID = 'agent-shell-deploy'
    const calls: ToolCallDisplay[] = [
      tc('s', 'agent_shell_start', { result: `session_id: ${SID}` }),
      tc('w', 'agent_shell_write', { session_id: SID }),
    ]
    for (let i = 0; i < 20; i++) {
      calls.push(tc(`r${i}`, 'agent_shell_read', { session_id: SID }))
    }
    const groups = groupAgentShellBySession(calls)
    expect(groups.filter(g => g.kind === 'agent_shell_session')).toHaveLength(1)
  })
})

export {}
