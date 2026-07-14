import { classifyExecuteCommandPurpose, convertShellReadCommand } from '../commandPurpose'
import { formatShellReadRedirect } from '../shellReadRedirect'

describe('classifyExecuteCommandPurpose', () => {
  it.each([
    ['cat src/App.tsx'],
    ['sed -n "1,80p" src/App.tsx'],
    ['head -n 20 package.json'],
    ['tail -n 50 logs.txt'],
    ['awk "{print}" src/App.tsx'],
    ['grep -n "foo" src/App.tsx'],
    ['rg -n "foo" src'],
    ['find src -name "*.ts"'],
    ['ls src/services'],
    ['tree src/services/agent'],
    ['node -e "const fs=require(\'fs\'); console.log(fs.readFileSync(\'src/App.tsx\', \'utf8\'))"'],
    ['python3 -c "print(open(\'src/App.tsx\').read())"'],
    ['/bin/zsh -lc "sed -n \'1,20p\' src/App.tsx"'],
  ])('classifies source inspection shell reads: %s', (command) => {
    expect(classifyExecuteCommandPurpose(command)).toBe('file_read')
  })

  it.each([
    ['yarn test'],
    ['npm run build'],
    ['npx tsc --noEmit'],
    ['pnpm lint'],
    ['vitest run'],
  ])('classifies validation commands: %s', (command) => {
    expect(classifyExecuteCommandPurpose(command)).toBe('validation')
  })

  it('leaves unrelated commands unknown', () => {
    expect(classifyExecuteCommandPurpose('git status --short')).toBe('unknown')
    expect(classifyExecuteCommandPurpose('wc -l src/App.tsx')).toBe('unknown')
  })
})

describe('convertShellReadCommand', () => {
  it.each([
    [
      'cat src/App.tsx',
      { toolName: 'read_file', input: { file_path: 'src/App.tsx' } },
    ],
    [
      'head -n 20 package.json',
      { toolName: 'read_file', input: { file_path: 'package.json', limit: 20 } },
    ],
    [
      'sed -n "10,20p" src/App.tsx',
      { toolName: 'read_file', input: { file_path: 'src/App.tsx', offset: 10, limit: 11 } },
    ],
    [
      '/bin/zsh -lc "sed -n \'1,20p\' src/App.tsx"',
      { toolName: 'read_file', input: { file_path: 'src/App.tsx', offset: 1, limit: 20 } },
    ],
    [
      'rg -n "foo" src',
      { toolName: 'search_files', input: { query: 'foo', directory: 'src', caseSensitive: false, useRegex: true } },
    ],
    [
      'grep -R --include "*.ts" "foo" src',
      { toolName: 'search_files', input: { query: 'foo', directory: 'src', caseSensitive: false, useRegex: true, includePatterns: ['*.ts'] } },
    ],
    [
      'ls src/services',
      { toolName: 'list_directory', input: { file_path: 'src/services', maxDepth: 1 } },
    ],
    [
      'ls -R src/services',
      { toolName: 'list_directory', input: { file_path: 'src/services', maxDepth: 3 } },
    ],
    [
      'tree -L 2 src',
      { toolName: 'list_directory', input: { file_path: 'src', maxDepth: 2 } },
    ],
    [
      'find src -type f -name "*.ts"',
      { toolName: 'glob', input: { pattern: '**/*.ts', directory: 'src' } },
    ],
  ])('converts simple source inspection shell command: %s', (command, expected) => {
    expect(convertShellReadCommand(command)).toEqual(expected)
  })

  it.each([
    ['tail -n 50 logs.txt'],
    ['awk "{print}" src/App.tsx'],
    ['cat src/App.tsx src/main.tsx'],
    ['cat "$(pwd)/src/App.tsx"'],
    ['sed -i "s/a/b/" src/App.tsx'],
    ['rg "foo" src | head'],
    ['node -e "require(\'fs\').readFileSync(\'src/App.tsx\', \'utf8\')"'],
    ['wc -l src/App.tsx'],
  ])('does not convert ambiguous or non-equivalent shell command: %s', (command) => {
    expect(convertShellReadCommand(command)).toBeNull()
  })
})

describe('formatShellReadRedirect', () => {
  it('suggests the canonical Read alias instead of silently converting cat', () => {
    const converted = convertShellReadCommand('cat src/App.tsx')

    expect(formatShellReadRedirect('cat src/App.tsx', converted)).toContain(
      'Suggested next tool call:\nRead {"file_path":"src/App.tsx"}',
    )
  })

  it('suggests the canonical Grep alias instead of silently converting rg', () => {
    const converted = convertShellReadCommand('rg -n "foo" src')

    expect(formatShellReadRedirect('rg -n "foo" src', converted)).toContain(
      'Suggested next tool call:\nGrep {"pattern":"foo","path":"src","caseSensitive":false,"useRegex":true}',
    )
  })

  it('blocks ambiguous shell inspection without pretending it ran', () => {
    const msg = formatShellReadRedirect('rg "foo" src | head', null)

    expect(msg).toContain('ambiguous or compound')
    expect(msg).toContain('TM Code did not execute it')
    expect(msg).not.toContain('Suggested next tool call')
  })
})
