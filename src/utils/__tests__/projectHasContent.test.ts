/**
 * Tests for the "does this project have meaningful content" gate that
 * controls the /init button visibility in ChatView.
 *
 * Regression context (May 2026): the gate was firing on freshly-opened
 * empty projects because the Rust `glob_files('*')` returns dot-files
 * (the `glob` crate's `Default` MatchOptions has
 * `require_literal_leading_dot: false`), and the TS allowlist only
 * excluded four named dot entries — leaking the IDE's own
 * `.toquemedia/` state directory on every empty project.
 */

import { isMeaningfulEntry, projectHasMeaningfulContent } from '../projectHasContent'

describe('isMeaningfulEntry', () => {
  it('accepts plain user files', () => {
    expect(isMeaningfulEntry('README.md')).toBe(true)
    expect(isMeaningfulEntry('package.json')).toBe(true)
    expect(isMeaningfulEntry('src')).toBe(true)
    expect(isMeaningfulEntry('main.py')).toBe(true)
  })

  it('rejects all dot-files (the regression class)', () => {
    expect(isMeaningfulEntry('.toquemedia')).toBe(false)       // ← the leak
    expect(isMeaningfulEntry('.toquemedia-id')).toBe(false)
    expect(isMeaningfulEntry('.git')).toBe(false)
    expect(isMeaningfulEntry('.gitignore')).toBe(false)
    expect(isMeaningfulEntry('.gitattributes')).toBe(false)
    expect(isMeaningfulEntry('.DS_Store')).toBe(false)
    expect(isMeaningfulEntry('.env')).toBe(false)
    expect(isMeaningfulEntry('.vscode')).toBe(false)
    expect(isMeaningfulEntry('.idea')).toBe(false)
  })

  it('rejects tool-generated artifact directories', () => {
    expect(isMeaningfulEntry('node_modules')).toBe(false)
    expect(isMeaningfulEntry('dist')).toBe(false)
    expect(isMeaningfulEntry('build')).toBe(false)
    expect(isMeaningfulEntry('target')).toBe(false)        // Rust
    expect(isMeaningfulEntry('__pycache__')).toBe(false)   // Python
    expect(isMeaningfulEntry('venv')).toBe(false)
  })

  it('rejects empty / falsy input defensively', () => {
    expect(isMeaningfulEntry('')).toBe(false)
  })
})

describe('projectHasMeaningfulContent', () => {
  it('returns false for the exact regression case: empty project + IDE state', () => {
    // What glob_files('*') returns on `todo-mimo` after `git init` +
    // TM Code project open. No user files; the gate must NOT fire.
    const entries = [
      '/Users/x/todo-mimo/.git',
      '/Users/x/todo-mimo/.toquemedia',
      '/Users/x/todo-mimo/.toquemedia-id',
    ]
    expect(projectHasMeaningfulContent(entries)).toBe(false)
  })

  it('returns true as soon as one real user file is present', () => {
    expect(projectHasMeaningfulContent([
      '/Users/x/proj/.git',
      '/Users/x/proj/.toquemedia',
      '/Users/x/proj/README.md',  // ← real content
    ])).toBe(true)
  })

  it('returns false for an empty listing', () => {
    expect(projectHasMeaningfulContent([])).toBe(false)
  })

  it('returns false when only artifacts are present (cloned-and-installed but no code)', () => {
    expect(projectHasMeaningfulContent([
      '/Users/x/proj/node_modules',
      '/Users/x/proj/dist',
      '/Users/x/proj/.git',
    ])).toBe(false)
  })

  it('handles plain basenames (not just absolute paths)', () => {
    expect(projectHasMeaningfulContent(['.git', '.toquemedia', 'src'])).toBe(true)
    expect(projectHasMeaningfulContent(['.git', '.toquemedia'])).toBe(false)
  })

  it('handles trailing slashes from glob (directories sometimes have them)', () => {
    expect(projectHasMeaningfulContent(['/Users/x/proj/.toquemedia/'])).toBe(false)
    // basename of "/foo/.toquemedia/" via split('/').pop() returns '' →
    // isMeaningfulEntry('') is false. Safe.
  })
})
