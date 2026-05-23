/**
 * Plan mode access control — verifies the architect-mode allowlist and
 * path restriction.
 *
 * The contract:
 *   - Tools NOT in PLAN_MODE_ALLOWED_TOOLS are blocked unconditionally.
 *   - Allowed read tools (read_file, list_directory, etc.) pass through.
 *   - Write tools (write_file, create_file, edit_file) require the path to
 *     resolve to PLAN.md or TODO.md AT THE PROJECT ROOT, not nested.
 *   - The block message is descriptive (the model reads it as a tool result
 *     and uses it to redirect its next action), not a bare error string.
 */

import { checkPlanModeAccess, isPlanArtefactAtRoot, PLAN_MODE_ALLOWED_TOOLS } from '../planMode'

const ROOT = '/Users/dev/projects/myapp'

describe('checkPlanModeAccess', () => {
  describe('tool allowlist', () => {
    test('blocks implementation tools', () => {
      const blocked = ['provision_auth', 'request_credentials', 'execute_command', 'start_dev_server', 'delete_file', 'rename_file', 'create_directory', 'spawn_background_agent', 'verify', 'read_dev_server_logs']
      for (const tool of blocked) {
        const msg = checkPlanModeAccess(tool, '', ROOT)
        expect(msg).not.toBeNull()
        expect(msg).toContain('Blocked in /plan architect mode')
        expect(msg).toContain(tool)
      }
    })

    test('allows read tools without a filePath check', () => {
      const allowed = ['read_file', 'list_directory', 'glob', 'search_files', 'get_diagnostics', 'read_skill', 'read_large_result']
      for (const tool of allowed) {
        // Read tools should pass even with arbitrary paths — they only consume.
        expect(checkPlanModeAccess(tool, 'src/components/App.tsx', ROOT)).toBeNull()
        expect(checkPlanModeAccess(tool, '', ROOT)).toBeNull()
      }
    })

    test('allows update_tasks and check_background_agents (no file paths)', () => {
      expect(checkPlanModeAccess('update_tasks', '', ROOT)).toBeNull()
      expect(checkPlanModeAccess('check_background_agents', '', ROOT)).toBeNull()
    })

    test('allows research tools (web_search, web_fetch, research)', () => {
      expect(checkPlanModeAccess('web_search', '', ROOT)).toBeNull()
      expect(checkPlanModeAccess('web_fetch', '', ROOT)).toBeNull()
      expect(checkPlanModeAccess('research', '', ROOT)).toBeNull()
    })

    test('allowlist is exhaustive vs. expectation', () => {
      // Snapshot guard: if someone adds/removes a tool from the allowlist
      // they have to update the test, forcing a conscious decision.
      expect([...PLAN_MODE_ALLOWED_TOOLS].sort()).toEqual([
        'ask_user_question',
        'check_background_agents',
        'create_file',
        'edit_file',
        'get_diagnostics',
        'glob',
        'list_directory',
        'read_file',
        'read_large_result',
        'read_skill',
        'research',
        'search_files',
        'update_tasks',
        'web_fetch',
        'web_search',
        'write_file',
      ])
    })
  })

  describe('write path restriction', () => {
    test('allows PLAN.md and TODO.md at project root (relative)', () => {
      for (const tool of ['write_file', 'create_file', 'edit_file']) {
        expect(checkPlanModeAccess(tool, 'PLAN.md', ROOT)).toBeNull()
        expect(checkPlanModeAccess(tool, 'TODO.md', ROOT)).toBeNull()
      }
    })

    test('allows PLAN.md and TODO.md at project root (absolute)', () => {
      for (const tool of ['write_file', 'create_file', 'edit_file']) {
        expect(checkPlanModeAccess(tool, `${ROOT}/PLAN.md`, ROOT)).toBeNull()
        expect(checkPlanModeAccess(tool, `${ROOT}/TODO.md`, ROOT)).toBeNull()
      }
    })

    test('handles Windows-style paths', () => {
      const winRoot = 'C:\\Users\\dev\\projects\\myapp'
      // checkPlanModeAccess normalises backslashes internally
      expect(checkPlanModeAccess('write_file', `${winRoot}\\PLAN.md`, winRoot)).toBeNull()
    })

    test('rejects PLAN.md / TODO.md in subdirectories', () => {
      const cases = [
        'src/PLAN.md',
        'docs/PLAN.md',
        'node_modules/some-pkg/PLAN.md',
        `${ROOT}/src/PLAN.md`,
        `${ROOT}/node_modules/PLAN.md`,
        `${ROOT}/docs/TODO.md`,
      ]
      for (const path of cases) {
        const msg = checkPlanModeAccess('write_file', path, ROOT)
        expect(msg).not.toBeNull()
        expect(msg).toContain('Blocked in /plan architect mode')
        expect(msg).toContain(path)
      }
    })

    test('rejects source files that would mutate the project', () => {
      const cases = ['package.json', 'src/main.ts', `${ROOT}/vite.config.ts`, 'README.md', '.env.example']
      for (const path of cases) {
        for (const tool of ['write_file', 'create_file', 'edit_file']) {
          expect(checkPlanModeAccess(tool, path, ROOT)).not.toBeNull()
        }
      }
    })

    test('rejects empty/missing path on write tools', () => {
      expect(checkPlanModeAccess('write_file', '', ROOT)).not.toBeNull()
    })

    test('rejects absolute write outside project root', () => {
      // Even if filename matches, an absolute path under a DIFFERENT root must not pass.
      expect(checkPlanModeAccess('write_file', '/tmp/PLAN.md', ROOT)).not.toBeNull()
      expect(checkPlanModeAccess('write_file', '/etc/PLAN.md', ROOT)).not.toBeNull()
    })

    test('rejects when projectRoot is empty and path is absolute', () => {
      // No anchor for the absolute-path comparison. Refuse to allow rather
      // than fall through to basename match.
      expect(checkPlanModeAccess('write_file', '/somewhere/PLAN.md', '')).not.toBeNull()
    })

    test('still allows bare PLAN.md when projectRoot is empty', () => {
      // Project-relative form has no path component; basename check is sufficient.
      // Edge case but consistent with how `write_file` accepts relative paths.
      expect(checkPlanModeAccess('write_file', 'PLAN.md', '')).toBeNull()
    })
  })

  describe('block message content', () => {
    test('directs the agent toward PLAN.md instead of retrying the blocked tool', () => {
      const msg = checkPlanModeAccess('execute_command', '', ROOT)
      expect(msg).toContain('PLAN.md')
      expect(msg).toContain('Implementation Phases')
    })

    test('write-path rejection mentions File Structure section', () => {
      const msg = checkPlanModeAccess('write_file', 'src/main.ts', ROOT)
      expect(msg).toContain('File Structure')
    })
  })
})

describe('isPlanArtefactAtRoot', () => {
  test('matches PLAN.md and TODO.md at root', () => {
    expect(isPlanArtefactAtRoot('PLAN.md', ROOT)).toBe(true)
    expect(isPlanArtefactAtRoot('TODO.md', ROOT)).toBe(true)
    expect(isPlanArtefactAtRoot(`${ROOT}/PLAN.md`, ROOT)).toBe(true)
    expect(isPlanArtefactAtRoot(`${ROOT}/TODO.md`, ROOT)).toBe(true)
  })

  test('rejects nested paths', () => {
    expect(isPlanArtefactAtRoot('src/PLAN.md', ROOT)).toBe(false)
    expect(isPlanArtefactAtRoot(`${ROOT}/src/PLAN.md`, ROOT)).toBe(false)
  })

  test('rejects unknown filenames at root', () => {
    expect(isPlanArtefactAtRoot('SCRATCH.md', ROOT)).toBe(false)
    expect(isPlanArtefactAtRoot(`${ROOT}/notes.md`, ROOT)).toBe(false)
  })

  test('handles trailing slashes on projectRoot', () => {
    expect(isPlanArtefactAtRoot(`${ROOT}/PLAN.md`, `${ROOT}/`)).toBe(true)
    expect(isPlanArtefactAtRoot(`${ROOT}/PLAN.md`, `${ROOT}//`)).toBe(true)
  })

  test('rejects empty filePath', () => {
    expect(isPlanArtefactAtRoot('', ROOT)).toBe(false)
  })
})
