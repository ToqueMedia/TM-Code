import { usePermissionStore } from '@/stores/permissionStore'

/**
 * Regressão do "aprovar duas vezes" + "pasta-mãe não cobre os filhos".
 *
 * Causa: o prompt de acesso fora-do-projeto (`path_access`) oferece 3 botões
 * (sessão / sempre-no-projeto / sempre-global). `approve` e
 * `approveAlwaysInProject` adicionavam a pasta a `additionalDirectories`, mas
 * `approveAll` e `approveAlwaysGlobal` devolviam `approved:true` SEM conceder a
 * pasta → o acesso seguinte voltava a pedir, e os filhos da pasta-mãe nunca
 * ficavam cobertos. Estes testes fixam que TODOS os caminhos de aprovação
 * concedem a pasta, e que um filho de uma pasta já concedida não re-pede.
 */

function setPathAccessPending(target: string): jest.Mock {
  const resolve = jest.fn()
  usePermissionStore.setState({
    pendingPermission: {
      id: 'p1',
      toolName: 'path_access',
      args: { file_path: `${target}/sub/file.kt` },
      promptReason: 'path_access',
      pathAccessTarget: target,
      resolve,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  return resolve
}

describe('permissionStore — concessão de path_access', () => {
  beforeEach(() => {
    usePermissionStore.setState({
      pendingPermission: null,
      permissionQueue: [],
      additionalDirectories: new Set<string>(),
      approvedScopes: new Set(),
      globalToolAllowlist: new Set(),
      projectToolAllowlist: new Set(),
      autoDenyAll: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  })

  it('approveAll concede a pasta-mãe (antes era no-op → duplo pedido)', () => {
    const resolve = setPathAccessPending('/Users/me/dev/mobile')
    usePermissionStore.getState().approveAll()

    expect(usePermissionStore.getState().additionalDirectories.has('/Users/me/dev/mobile')).toBe(true)
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ approved: true }))
    expect(usePermissionStore.getState().pendingPermission).toBeNull()
  })

  it('approveAlwaysGlobal concede a pasta-mãe (antes só mexia no allowlist de tools)', () => {
    const resolve = setPathAccessPending('/Users/me/dev/mobile')
    usePermissionStore.getState().approveAlwaysGlobal()

    expect(usePermissionStore.getState().additionalDirectories.has('/Users/me/dev/mobile')).toBe(true)
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ approved: true }))
  })

  it('um filho de uma pasta já concedida NÃO volta a pedir (sem duplo prompt)', async () => {
    usePermissionStore.setState({
      additionalDirectories: new Set(['/Users/me/dev/mobile']),
      pendingPermission: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    const decision = await usePermissionStore
      .getState()
      .requestPathAccess('/Users/me/dev/mobile/katondo-queue/app/Main.kt', '/Users/me/dev/mobile')

    expect(decision.approved).toBe(true)
    expect(decision.prompted).toBe(false) // resolveu sem mostrar prompt
    expect(usePermissionStore.getState().pendingPermission).toBeNull() // nenhum pending criado
  })
})
