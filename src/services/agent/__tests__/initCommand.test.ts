jest.mock('../agentRunner', () => ({
  runAgentWithCallbacks: jest.fn(),
}))

jest.mock('@/utils/invokeMetrics', () => ({
  invoke: jest.fn(),
}))

jest.mock('../../../i18n', () => ({
  t: (key: string) => key,
}))

jest.mock('../../../stores/chatStore', () => ({
  useChatStore: {
    getState: jest.fn(() => ({
      addSystemMessage: jest.fn(),
    })),
  },
}))

import { invoke } from '@/utils/invokeMetrics'
import { runAgentWithCallbacks } from '../agentRunner'
import { buildInitPrompt, executeInit } from '../commands/initCommand'

const mockedInvoke = invoke as jest.Mock
const mockedRunAgentWithCallbacks = runAgentWithCallbacks as jest.Mock

describe('buildInitPrompt', () => {
  it('creates a concise TMS.md setup prompt with the required TMS sections', () => {
    const prompt = buildInitPrompt('/repo/app', null, 'focus on worker deployment')

    expect(prompt).toContain('Set up a minimal TM Code project memory file')
    expect(prompt).toContain('/repo/app/TMS.md')
    expect(prompt).toContain('Developer-provided /init context:')
    expect(prompt).toContain('focus on worker deployment')
    expect(prompt).toContain('Search/list before reading')
    expect(prompt).toContain('Do not use execute_command for source inspection')
    expect(prompt).toContain('## EntryPoints')
    expect(prompt).toContain('## Agent Rules')
    expect(prompt).toContain('## sourceFilesUsed')
    expect(prompt).toContain('do not list every file')
    expect(prompt).not.toContain('Project Analysis')
  })

  it('refreshes an existing TMS.md while preserving human-authored sections', () => {
    const prompt = buildInitPrompt('/repo/app', '# TMS.md\n\n## Custom Instructions\nKeep deploy notes.', '')

    expect(prompt).toContain('Refresh the project')
    expect(prompt).toContain('Read the existing TMS.md first with Read')
    expect(prompt).toContain('Preserve human-authored information')
    expect(prompt).toContain('legacy "Memory", "Decisions", "Pending Tasks", or "Custom Instructions"')
    expect(prompt).toContain('## Pending Confirmation')
    expect(prompt).toContain('Write the updated file with write_file')
  })
})

describe('executeInit', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
    mockedRunAgentWithCallbacks.mockReset()
  })

  it('runs /init with the project_bootstrap profile', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('not found'))

    await executeInit('focus on worker deployment', '/repo/app')

    expect(mockedRunAgentWithCallbacks).toHaveBeenCalledWith(
      expect.stringContaining('Set up a minimal TM Code project memory file'),
      expect.objectContaining({
        userMessageText: '/init',
        intentOverride: expect.objectContaining({
          profile: 'project_bootstrap',
          readOnly: false,
          reason: expect.stringContaining('/init selected project_bootstrap'),
        }),
      }),
    )
  })

  it('treats an empty TMS.md as existing and refreshes it', async () => {
    mockedInvoke.mockResolvedValueOnce('')

    await executeInit('', '/repo/app')

    expect(mockedRunAgentWithCallbacks).toHaveBeenCalledWith(
      expect.stringContaining('Refresh the project'),
      expect.objectContaining({
        userMessageText: '/init',
      }),
    )
  })
})
