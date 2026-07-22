import { discoverExternalAgentSessions, buildExternalAgentSessionsSection } from '../externalAgents'
import { invoke } from '@/utils/invokeMetrics'

jest.mock('@/utils/invokeMetrics', () => ({ invoke: jest.fn() }))
const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>

beforeEach(() => mockedInvoke.mockReset())

describe('discoverExternalAgentSessions', () => {
  it('finds Claude Code sessions at the dash-encoded project dir', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'get_home_directory') return '/Users/x'
      if (cmd === 'glob_files') {
        const { directory } = args as { directory: string }
        // Claude's convention: /Users/x/dev/proj → -Users-x-dev-proj
        if (directory === '/Users/x/.claude/projects/-Users-x-dev-proj') {
          return ['/Users/x/.claude/projects/-Users-x-dev-proj/a.jsonl', '/Users/x/.claude/projects/-Users-x-dev-proj/b.jsonl']
        }
        return []
      }
      if (cmd === 'path_exists') return false
      throw new Error(`unexpected ${cmd}`)
    })

    const found = await discoverExternalAgentSessions('/Users/x/dev/proj')
    const claude = found.find((f) => f.id === 'claude')
    expect(claude).toBeTruthy()
    expect(claude?.fileCount).toBe(2)
    expect(claude?.location).toBe('~/.claude/projects/-Users-x-dev-proj/')
  })

  it('encodes dots and underscores to dashes', async () => {
    const seen: string[] = []
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'get_home_directory') return '/home/u'
      if (cmd === 'glob_files') { seen.push((args as { directory: string }).directory); return [] }
      if (cmd === 'path_exists') return false
      throw new Error(`unexpected ${cmd}`)
    })
    await discoverExternalAgentSessions('/home/u/my_app.v2')
    expect(seen).toContain('/home/u/.claude/projects/-home-u-my-app-v2')
  })

  it('detects an in-tree Aider transcript', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'get_home_directory') return '/Users/x'
      if (cmd === 'glob_files') return []
      if (cmd === 'path_exists') return (args as { path: string }).path === '/proj/.aider.chat.history.md'
      throw new Error(`unexpected ${cmd}`)
    })
    const found = await discoverExternalAgentSessions('/proj')
    expect(found.map((f) => f.id)).toEqual(['aider'])
    expect(found[0].format).toBe('markdown')
  })

  it('returns [] (never throws) when home cannot be resolved', async () => {
    mockedInvoke.mockRejectedValue(new Error('no home'))
    await expect(discoverExternalAgentSessions('/proj')).resolves.toEqual([])
  })

  it('returns [] for an empty project path', async () => {
    await expect(discoverExternalAgentSessions('')).resolves.toEqual([])
    expect(mockedInvoke).not.toHaveBeenCalled()
  })
})

describe('buildExternalAgentSessionsSection', () => {
  it('returns null when nothing is found (section omitted)', () => {
    expect(buildExternalAgentSessionsSection([])).toBeNull()
  })
  it('lists each agent with its location + count', () => {
    const block = buildExternalAgentSessionsSection([
      { id: 'claude', label: 'Claude Code', location: '~/.claude/projects/-p/', absolutePath: '/h/.claude/projects/-p', fileCount: 3, format: 'jsonl', formatHint: 'JSONL.' },
    ])
    expect(block).toContain('Other AI agents')
    expect(block).toContain('Claude Code: 3 session file(s) in ~/.claude/projects/-p/')
  })
})
