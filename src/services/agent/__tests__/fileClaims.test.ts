import {
  beginMainRunClaims,
  endMainRunClaims,
  registerFileClaim,
  releaseOwnerClaims,
  findBlockingClaim,
  MAIN_CLAIM_OWNER,
  __resetFileClaimsForTests,
} from '../fileClaims'
import { useParallelTaskStore } from '../../../stores/parallelTaskStore'

export {}

function liveTask(description: string): string {
  const id = useParallelTaskStore.getState().createQueued(`prompt: ${description}`, description)
  useParallelTaskStore.getState().markRunning(id)
  return id
}

describe('fileClaims — registry único de propriedade (main + tarefas)', () => {
  beforeEach(() => {
    __resetFileClaimsForTests()
  })

  it('main VIVO bloqueia uma tarefa no ficheiro que o main tocou', () => {
    beginMainRunClaims()
    registerFileClaim(MAIN_CLAIM_OWNER, 'src/App.tsx')
    const blocking = findBlockingClaim('src/App.tsx', 'task-x')
    expect(blocking?.owner).toBe(MAIN_CLAIM_OWNER)
    expect(blocking?.label).toContain('main')
  })

  it('fim do run principal liberta os claims dele', () => {
    beginMainRunClaims()
    registerFileClaim(MAIN_CLAIM_OWNER, 'src/App.tsx')
    endMainRunClaims()
    expect(findBlockingClaim('src/App.tsx', 'task-x')).toBeNull()
  })

  it('tarefa VIVA bloqueia o main (com a descrição dela) e espelha em modifiedFiles', () => {
    const id = liveTask('Adicionar login')
    registerFileClaim(id, 'web/src/auth.ts')
    const blocking = findBlockingClaim('web/src/auth.ts', MAIN_CLAIM_OWNER)
    expect(blocking?.owner).toBe(id)
    expect(blocking?.label).toBe('Adicionar login')
    expect(useParallelTaskStore.getState().runs.get(id)?.modifiedFiles).toContain('web/src/auth.ts')
  })

  it('tarefa TERMINADA deixa de bloquear (liveness), mesmo sem release', () => {
    const id = liveTask('Tarefa efémera')
    registerFileClaim(id, 'web/a.ts')
    useParallelTaskStore.getState().finalize(id, 'done', { input: 0, output: 0 })
    expect(findBlockingClaim('web/a.ts', MAIN_CLAIM_OWNER)).toBeNull()
  })

  it('releaseOwnerClaims remove os claims da tarefa', () => {
    const id = liveTask('Outra tarefa')
    registerFileClaim(id, 'web/b.ts')
    releaseOwnerClaims(id)
    expect(findBlockingClaim('web/b.ts', MAIN_CLAIM_OWNER)).toBeNull()
  })

  it('o próprio dono nunca é bloqueado por si', () => {
    const id = liveTask('Self')
    registerFileClaim(id, 'web/self.ts')
    expect(findBlockingClaim('web/self.ts', id)).toBeNull()
  })

  it('novo run principal começa com claims frescos', () => {
    beginMainRunClaims()
    registerFileClaim(MAIN_CLAIM_OWNER, 'stale.ts')
    beginMainRunClaims()
    expect(findBlockingClaim('stale.ts', 'task-x')).toBeNull()
  })
})
