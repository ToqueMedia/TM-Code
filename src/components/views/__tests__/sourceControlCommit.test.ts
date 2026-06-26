import {
  TM_CODE_COMMIT_SIGNATURE,
  cleanGeneratedCommitMessage,
  ensureTmCodeCommitSignature,
  stripTmCodeCommitSignature,
} from '../sourceControlCommit'

describe('sourceControlCommit helpers', () => {
  it('appends the TM Code trailer at commit time', () => {
    expect(ensureTmCodeCommitSignature('fix: update source control')).toBe(
      `fix: update source control\n\n${TM_CODE_COMMIT_SIGNATURE}`,
    )
  })

  it('does not duplicate an existing TM Code trailer', () => {
    const signed = `fix: update source control\n\n${TM_CODE_COMMIT_SIGNATURE}`
    expect(ensureTmCodeCommitSignature(signed)).toBe(signed)
  })

  it('strips the TM Code trailer from generated textarea content', () => {
    expect(stripTmCodeCommitSignature(`fix: update source control\n\n${TM_CODE_COMMIT_SIGNATURE}`)).toBe(
      'fix: update source control',
    )
  })

  it('removes reasoning, labels, quotes and trailers from generated messages', () => {
    const raw = `<think>hidden</think>\nCommit message:\n"fix(source-control): commit staged files\n\n${TM_CODE_COMMIT_SIGNATURE}"`
    expect(cleanGeneratedCommitMessage(raw)).toBe('fix(source-control): commit staged files')
  })
})
