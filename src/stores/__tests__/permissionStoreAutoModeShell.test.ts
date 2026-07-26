import { usePermissionStore } from '@/stores/permissionStore'

/**
 * Modo YOLO (ex-Auto): autonomia total — zero diálogos de permissão.
 *
 * ON  → requestPermission / forcePrompt / shell / path access always approve.
 * OFF → allowlists, scopes e forcePrompt pedem como no fluxo normal.
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

function resetStore(partial: Record<string, unknown> = {}): void {
  usePermissionStore.setState({
    activeProjectId: null,
    byProject: {},
    projectPath: null,
    approvedScopes: new Set(),
    projectToolAllowlist: new Set<string>(),
    globalToolAllowlist: new Set<string>(),
    additionalDirectories: new Set<string>(),
    autoModePermissions: false,
    autoDenyAll: false,
    pendingPermission: null,
    permissionQueue: [],
    ...partial,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

describe('permissionStore — Modo YOLO (sem diálogos)', () => {
  beforeEach(() => {
    resetStore()
  })

  it('YOLO ON: shell + grant por nome → approve sem classificador nem diálogo', async () => {
    resetStore({
      autoModePermissions: true,
      projectToolAllowlist: new Set(['execute_command']),
    })

    const decision = await usePermissionStore.getState().requestPermission(
      'execute_command',
      { command: 'gcloud secrets versions add AGT_BASIC_AUTH --data-file=-' },
    )

    expect(decision).toEqual(expect.objectContaining({
      approved: true,
      prompted: false,
      source: 'yolo',
    }))
    expect(usePermissionStore.getState().pendingPermission).toBeNull()
  })

  it('YOLO ON: forcePrompt (dangerous_command) também não pede', async () => {
    resetStore({ autoModePermissions: true })

    const decision = await usePermissionStore.getState().requestPermission(
      'execute_command',
      { command: 'rm -rf /' },
      'dangerous_command',
    )

    expect(decision.approved).toBe(true)
    expect(decision.prompted).toBe(false)
    expect(usePermissionStore.getState().pendingPermission).toBeNull()
  })

  it('isYoloModeEnabled reflects the project flag', () => {
    const { isYoloModeEnabled } = require('@/stores/permissionStore') as typeof import('@/stores/permissionStore')
    resetStore({ autoModePermissions: false })
    expect(isYoloModeEnabled()).toBe(false)
    resetStore({ autoModePermissions: true })
    expect(isYoloModeEnabled()).toBe(true)
  })

  it('YOLO ON: sensitive_file forcePrompt não pede', async () => {
    resetStore({ autoModePermissions: true })

    const decision = await usePermissionStore.getState().requestPermission(
      'read_file',
      { file_path: '/proj/.env' },
      'sensitive_file',
    )

    expect(decision.approved).toBe(true)
    expect(usePermissionStore.getState().pendingPermission).toBeNull()
  })

  it('YOLO OFF: forcePrompt continua a enfileirar diálogo', async () => {
    resetStore()
    void usePermissionStore.getState().requestPermission(
      'read_file',
      { file_path: '/proj/.env' },
      'sensitive_file',
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(usePermissionStore.getState().pendingPermission?.promptReason).toBe('sensitive_file')
  })

  it('YOLO OFF: o fast-path por nome mantém-se (grant do developer é lei)', async () => {
    resetStore({ projectToolAllowlist: new Set(['execute_command']) })

    const decision = await usePermissionStore.getState().requestPermission(
      'execute_command',
      { command: 'gcloud secrets versions add AGT_BASIC_AUTH --data-file=-' },
    )

    expect(decision).toEqual(expect.objectContaining({ approved: true, source: 'user' }))
  })

  it('advanceQueue: YOLO ON drena a fila sem diálogo (incluindo forcePrompt)', () => {
    const resolveHead = jest.fn()
    const resolveQueued = jest.fn()
    resetStore({
      autoModePermissions: true,
      pendingPermission: {
        id: 'p0',
        toolName: 'rename_file',
        args: {},
        promptReason: null,
        resolve: resolveHead,
      },
      permissionQueue: [{
        id: 'p1',
        toolName: 'execute_command',
        args: { command: 'firebase deploy --only functions' },
        promptReason: 'dangerous_command',
        resolve: resolveQueued,
      }],
    })

    usePermissionStore.getState().approve()

    expect(resolveQueued).toHaveBeenCalledWith(expect.objectContaining({
      approved: true,
      source: 'yolo',
    }))
    expect(usePermissionStore.getState().pendingPermission).toBeNull()
  })

  it('ligar YOLO com diálogo aberto aprova o pedido e drena a fila do projecto', () => {
    const resolvePending = jest.fn()
    const resolveQueued = jest.fn()
    resetStore({
      activeProjectId: 'proj-a',
      autoModePermissions: false,
      pendingPermission: {
        id: 'p0',
        toolName: 'execute_command',
        args: { command: 'rm -rf /' },
        promptReason: 'dangerous_command',
        projectId: 'proj-a',
        resolve: resolvePending,
      },
      permissionQueue: [{
        id: 'p1',
        toolName: 'read_file',
        args: { file_path: '/proj/.env' },
        promptReason: 'sensitive_file',
        projectId: 'proj-a',
        resolve: resolveQueued,
      }],
    })

    usePermissionStore.getState().setAutoModePermissions(true)

    expect(usePermissionStore.getState().autoModePermissions).toBe(true)
    expect(resolvePending).toHaveBeenCalledWith(expect.objectContaining({
      approved: true,
      source: 'yolo',
    }))
    expect(resolveQueued).toHaveBeenCalledWith(expect.objectContaining({
      approved: true,
      source: 'yolo',
    }))
    expect(usePermissionStore.getState().pendingPermission).toBeNull()
    expect(usePermissionStore.getState().permissionQueue).toEqual([])
  })

  it('advanceQueue: fora do YOLO, o allowlist continua a auto-resolver a fila', () => {
    const resolveHead = jest.fn()
    const resolveQueued = jest.fn()
    resetStore({
      projectToolAllowlist: new Set(['execute_command']),
      pendingPermission: {
        id: 'p0',
        toolName: 'rename_file',
        args: {},
        promptReason: null,
        resolve: resolveHead,
      },
      permissionQueue: [{
        id: 'p1',
        toolName: 'execute_command',
        args: { command: 'yarn test' },
        promptReason: null,
        resolve: resolveQueued,
      }],
    })

    usePermissionStore.getState().approve()

    expect(resolveQueued).toHaveBeenCalledWith(expect.objectContaining({ approved: true, source: 'user' }))
    expect(usePermissionStore.getState().pendingPermission).toBeNull()
  })
})
