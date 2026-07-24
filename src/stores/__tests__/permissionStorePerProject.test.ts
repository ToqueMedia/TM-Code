import {
  getProjectGrants,
  hydrateApprovedScopes,
  usePermissionStore,
} from '@/stores/permissionStore'

/**
 * F1#3 — permissões por projecto (MDI / multi-project in-window).
 *
 * Um run de fundo do Projecto A NÃO pode ler nem escrever grants do Projecto B
 * (o que está em foco). hydrate deve GUARDAR sob o projectId em vez de
 * substituir o estado global; requestPermission/approve resolvem pelo projectId
 * do pedido.
 */

jest.mock('../chatStore', () => ({
  useChatStore: {
    getState: () => ({
      addSystemMessage: jest.fn(),
      sessions: new Map(),
      activeSessionId: null,
      streamingSessionId: null,
    }),
  },
}))

jest.mock('../../services/agent/permissionClassifier', () => ({
  classifyPermissionAction: jest.fn(),
}))

const mockInvoke = jest.fn().mockResolvedValue(undefined)
jest.mock('@/utils/invokeMetrics', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

jest.mock('../../services/agent/permissionPersistence', () => ({
  savePermissionsToDisk: jest.fn().mockResolvedValue(undefined),
}))

function resetStore(): void {
  usePermissionStore.setState({
    activeProjectId: null,
    byProject: {},
    projectPath: null,
    approvedScopes: new Set(),
    projectToolAllowlist: new Set<string>(),
    globalToolAllowlist: new Set<string>(),
    projectCommandAllowlist: new Set<string>(),
    globalCommandAllowlist: new Set<string>(),
    additionalDirectories: new Set<string>(),
    autoModePermissions: false,
    classifierChecking: null,
    autoDenyAll: false,
    pendingPermission: null,
    permissionQueue: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  mockInvoke.mockClear()
}

describe('permissionStore — per-project grants (F1#3)', () => {
  beforeEach(() => {
    resetStore()
  })

  it('hydrate de B NÃO apaga grants de A em byProject', () => {
    hydrateApprovedScopes(
      new Set(['core']),
      '/work/proj-a',
      new Set(['execute_command']),
      new Set(['/shared/a']),
      false,
      new Set(['git status']),
      'proj-a',
    )

    expect(usePermissionStore.getState().activeProjectId).toBe('proj-a')
    expect(getProjectGrants('proj-a').projectToolAllowlist.has('execute_command')).toBe(true)

    hydrateApprovedScopes(
      new Set(['mcp']),
      '/work/proj-b',
      new Set(['web_search']),
      new Set(['/shared/b']),
      true,
      new Set(),
      'proj-b',
    )

    // Focused view is B
    expect(usePermissionStore.getState().activeProjectId).toBe('proj-b')
    expect(usePermissionStore.getState().projectToolAllowlist.has('web_search')).toBe(true)
    expect(usePermissionStore.getState().projectToolAllowlist.has('execute_command')).toBe(false)
    expect(usePermissionStore.getState().autoModePermissions).toBe(true)

    // A still intact under byProject
    const a = getProjectGrants('proj-a')
    expect(a.projectPath).toBe('/work/proj-a')
    expect(a.approvedScopes.has('core')).toBe(true)
    expect(a.projectToolAllowlist.has('execute_command')).toBe(true)
    expect(a.additionalDirectories.has('/shared/a')).toBe(true)
    expect(a.projectCommandAllowlist.has('git status')).toBe(true)
    expect(a.autoModePermissions).toBe(false)

    // B isolated
    const b = getProjectGrants('proj-b')
    expect(b.approvedScopes.has('mcp')).toBe(true)
    expect(b.projectToolAllowlist.has('web_search')).toBe(true)
    expect(b.additionalDirectories.has('/shared/b')).toBe(true)
    expect(b.autoModePermissions).toBe(true)
  })

  it('requestPermission com origin.projectId A usa grants de A com B em foco', async () => {
    hydrateApprovedScopes(new Set(['core']), '/work/a', new Set(), new Set(), false, new Set(), 'proj-a')
    hydrateApprovedScopes(new Set(), '/work/b', new Set(), new Set(), false, new Set(), 'proj-b')

    // Focused is B (no core grant). A still has core scope — non-safe tool
    // must auto-approve from A's approvedScopes, not B's empty set.
    const decisionShell = await usePermissionStore.getState().requestPermission(
      'start_dev_server',
      { command: 'npm run dev' },
      false,
      { taskId: 'run-a', label: 'Agent A', projectId: 'proj-a' },
    )
    // A has approvedScopes.core → auto-approve without dialog
    expect(decisionShell).toEqual(expect.objectContaining({
      approved: true,
      source: 'approved_scope',
      prompted: false,
    }))
    expect(usePermissionStore.getState().pendingPermission).toBeNull()

    // Same tool for focused B (no core grant) → dialog
    void usePermissionStore.getState().requestPermission(
      'start_dev_server',
      { command: 'npm run dev' },
      false,
      { taskId: 'run-b', label: 'Agent B', projectId: 'proj-b' },
    )
    expect(usePermissionStore.getState().pendingPermission?.toolName).toBe('start_dev_server')
    expect(usePermissionStore.getState().pendingPermission?.projectId).toBe('proj-b')
  })

  it('approveAlwaysInProject escreve no projectId do pending, não no activo', () => {
    hydrateApprovedScopes(new Set(), '/work/a', new Set(), new Set(), false, new Set(), 'proj-a')
    hydrateApprovedScopes(new Set(), '/work/b', new Set(), new Set(), false, new Set(), 'proj-b')

    const resolve = jest.fn()
    usePermissionStore.setState({
      pendingPermission: {
        id: 'p1',
        toolName: 'start_dev_server',
        args: {},
        promptReason: null,
        projectId: 'proj-a',
        origin: { taskId: 'run-a', label: 'A', projectId: 'proj-a' },
        resolve,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    usePermissionStore.getState().approveAlwaysInProject()

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ approved: true }))
    // Focused is still B — flat allowlist must NOT have the tool
    expect(usePermissionStore.getState().projectToolAllowlist.has('start_dev_server')).toBe(false)
    // A got the grant
    expect(getProjectGrants('proj-a').projectToolAllowlist.has('start_dev_server')).toBe(true)
    // B untouched
    expect(getProjectGrants('proj-b').projectToolAllowlist.has('start_dev_server')).toBe(false)
  })

  it('getProjectGrants de projectId desconhecido devolve vazio (fail-closed)', () => {
    hydrateApprovedScopes(new Set(['core']), '/work/b', new Set(['x']), new Set(), false, new Set(), 'proj-b')
    const unknown = getProjectGrants('proj-missing')
    expect(unknown.approvedScopes.size).toBe(0)
    expect(unknown.projectToolAllowlist.size).toBe(0)
    // Must NOT leak B's grants
    expect(unknown.projectToolAllowlist.has('x')).toBe(false)
  })

  it('syncAllowedDirectoriesToRust passa projectId do projecto hidratado', async () => {
    hydrateApprovedScopes(
      new Set(),
      '/work/a',
      new Set(),
      new Set(['/extra/a']),
      false,
      new Set(),
      'proj-a',
    )
    // Fire-and-forget dynamic import — flush microtasks before asserting.
    await new Promise((r) => setTimeout(r, 0))
    expect(mockInvoke).toHaveBeenCalledWith(
      'set_agent_allowed_directories',
      expect.objectContaining({
        directories: ['/extra/a'],
        projectId: 'proj-a',
      }),
    )
  })

  it('requestPathAccess de A não herda dirs de B', async () => {
    hydrateApprovedScopes(
      new Set(),
      '/work/a',
      new Set(),
      new Set(),
      false,
      new Set(),
      'proj-a',
    )
    hydrateApprovedScopes(
      new Set(),
      '/work/b',
      new Set(),
      new Set(['/shared/mobile']),
      false,
      new Set(),
      'proj-b',
    )

    // B has /shared/mobile. A's path access to the same dir must still prompt
    // (A's grants are empty).
    void usePermissionStore.getState().requestPathAccess(
      '/shared/mobile/App.kt',
      '/shared/mobile',
      'proj-a',
    )
    expect(usePermissionStore.getState().pendingPermission?.promptReason).toBe('path_access')
    expect(usePermissionStore.getState().pendingPermission?.projectId).toBe('proj-a')

    // B already has it → silent pass
    const bDecision = await usePermissionStore.getState().requestPathAccess(
      '/shared/mobile/App.kt',
      '/shared/mobile',
      'proj-b',
    )
    expect(bDecision).toEqual(expect.objectContaining({ approved: true, prompted: false }))
  })

  it('resetAutoApprove limpa só o projecto activo', () => {
    hydrateApprovedScopes(
      new Set(['core']),
      '/work/a',
      new Set(['execute_command']),
      new Set(['/extra/a']),
      false,
      new Set(),
      'proj-a',
    )
    hydrateApprovedScopes(
      new Set(['mcp']),
      '/work/b',
      new Set(['web_search']),
      new Set(['/extra/b']),
      false,
      new Set(),
      'proj-b',
    )

    usePermissionStore.getState().resetAutoApprove()

    // B (active) cleared
    expect(getProjectGrants('proj-b').approvedScopes.size).toBe(0)
    expect(getProjectGrants('proj-b').projectToolAllowlist.size).toBe(0)
    expect(getProjectGrants('proj-b').additionalDirectories.size).toBe(0)
    // A intact
    expect(getProjectGrants('proj-a').approvedScopes.has('core')).toBe(true)
    expect(getProjectGrants('proj-a').projectToolAllowlist.has('execute_command')).toBe(true)
    expect(getProjectGrants('proj-a').additionalDirectories.has('/extra/a')).toBe(true)
  })
})
