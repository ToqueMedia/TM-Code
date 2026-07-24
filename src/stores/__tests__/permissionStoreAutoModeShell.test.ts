import { usePermissionStore } from '@/stores/permissionStore'

/**
 * Modo Auto × grants por nome de tool — porte do
 * `stripDangerousPermissionsForAutoMode` do claude-vaz.
 *
 * Incidente 2026-07-22 (momenu-fact): um "always allow" antigo em
 * `execute_command` era um fast-path ANTES do classificador do Modo Auto, e
 * deixou `gcloud secrets versions add` mutar o Secret Manager de produção sem
 * classificação — enquanto o deploy (execute_command_background, sem grant)
 * era corretamente bloqueado. Estes testes fixam a regra nova: em Modo Auto,
 * tools de execução arbitrária de shell NUNCA tomam o fast-path por nome
 * (allowlists/scopes) — o classificador vê sempre o comando. Fora do Modo
 * Auto, e para tools não-shell, o grant do developer continua a ser lei.
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classifyPermissionAction } = require('../../services/agent/permissionClassifier') as {
  classifyPermissionAction: jest.Mock
}

function resetStore(partial: Record<string, unknown> = {}): void {
  usePermissionStore.setState({
    projectPath: null,
    approvedScopes: new Set(),
    projectToolAllowlist: new Set<string>(),
    globalToolAllowlist: new Set<string>(),
    additionalDirectories: new Set<string>(),
    autoModePermissions: false,
    classifierChecking: null,
    autoDenyAll: false,
    pendingPermission: null,
    permissionQueue: [],
    ...partial,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

describe('permissionStore — Modo Auto vs fast-path por nome (tools de shell)', () => {
  beforeEach(() => {
    resetStore()
    classifyPermissionAction.mockReset()
  })

  it('Modo Auto ON: allowlist de execute_command NÃO fura o classificador (allow)', async () => {
    resetStore({
      autoModePermissions: true,
      projectToolAllowlist: new Set(['execute_command']),
    })
    classifyPermissionAction.mockResolvedValue({ decision: 'allow', reason: 'ordinary project command' })

    const decision = await usePermissionStore.getState().requestPermission(
      'execute_command',
      { command: 'gcloud secrets versions add AGT_BASIC_AUTH --data-file=-' },
    )

    expect(classifyPermissionAction).toHaveBeenCalledTimes(1)
    expect(decision).toEqual(expect.objectContaining({ approved: true, source: 'auto_classifier' }))
  })

  it('Modo Auto ON: bloqueio do classificador ESCALA para o diálogo (não nega — pedido 07-23)', async () => {
    resetStore({
      autoModePermissions: true,
      globalToolAllowlist: new Set(['execute_command']),
    })
    classifyPermissionAction.mockResolvedValue({ decision: 'block', reason: 'remote infrastructure mutation' })

    // Não aguardamos: um block pede permissão manual (a promise só resolve no
    // clique). Antes negava ao agente; agora escala para o diálogo humano — a
    // ideia é "não deixar de fazer", o developer aprova (força) ou recusa.
    void usePermissionStore.getState().requestPermission(
      'execute_command',
      { command: 'gcloud secrets versions add AGT_BASIC_AUTH --data-file=-' },
    )
    // Deixa o gate assíncrono (classificador) resolver e enfileirar o diálogo.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(classifyPermissionAction).toHaveBeenCalledTimes(1)
    expect(usePermissionStore.getState().pendingPermission?.toolName).toBe('execute_command')
  })

  it('Modo Auto OFF: o fast-path por nome mantém-se (grant do developer é lei)', async () => {
    resetStore({ projectToolAllowlist: new Set(['execute_command']) })

    const decision = await usePermissionStore.getState().requestPermission(
      'execute_command',
      { command: 'gcloud secrets versions add AGT_BASIC_AUTH --data-file=-' },
    )

    expect(classifyPermissionAction).not.toHaveBeenCalled()
    expect(decision).toEqual(expect.objectContaining({ approved: true, source: 'user' }))
  })

  it('Modo Auto ON: tools não-shell mantêm o fast-path por nome', async () => {
    resetStore({
      autoModePermissions: true,
      projectToolAllowlist: new Set(['delete_file']),
    })

    const decision = await usePermissionStore.getState().requestPermission(
      'delete_file',
      { file_path: '/tmp/x.txt' },
    )

    expect(classifyPermissionAction).not.toHaveBeenCalled()
    expect(decision).toEqual(expect.objectContaining({ approved: true, source: 'user' }))
  })

  it('advanceQueue: em Modo Auto, execute_command escalado NÃO é auto-resolvido pelo allowlist', () => {
    // Um pedido de shell só chega à fila em Modo Auto porque o classificador
    // escalou para humano — o allowlist não pode desfazer essa escalada.
    const resolveHead = jest.fn()
    const resolveQueued = jest.fn()
    resetStore({
      autoModePermissions: true,
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
        args: { command: 'firebase deploy --only functions' },
        promptReason: null,
        resolve: resolveQueued,
      }],
    })

    usePermissionStore.getState().approve()

    expect(resolveQueued).not.toHaveBeenCalled()
    expect(usePermissionStore.getState().pendingPermission?.id).toBe('p1')
  })

  it('advanceQueue: fora do Modo Auto, o allowlist continua a auto-resolver a fila', () => {
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
