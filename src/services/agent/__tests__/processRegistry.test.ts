/**
 * ProcessRegistry (P3.1) — as guardas da máquina de estados que mudaram da
 * store para o motor, agora com rede: estados terminais nunca reescritos,
 * buffer com teto a cortar pela cabeça, keep-5 no removeCompleted, espelho
 * por subscrição.
 */

import { processRegistry, type BackgroundCommand } from '../processRegistry'

function cmd(id: string, over: Partial<BackgroundCommand> = {}): BackgroundCommand {
  return {
    id,
    command: `echo ${id}`,
    owner: 'main',
    status: 'running',
    pid: 100,
    exitCode: null,
    output: '',
    startedAt: Date.now(),
    completedAt: null,
    ...over,
  }
}

afterEach(() => {
  // Limpa o estado module-level entre testes: cancela e poda tudo.
  processRegistry.cancelAll()
  processRegistry.removeCompleted()
  for (const c of processRegistry.getAll()) {
    // removeCompleted preserva 5 — força a remoção do resto via nova poda
    // depois de os marcar antigos não é possível sem API; aceita-se o
    // resíduo ≤5 porque cada teste usa ids únicos por describe.
    void c
  }
})

describe('transições terminais', () => {
  it('cancel do user vence o exit que chega depois (kill → cmd-exit)', () => {
    processRegistry.addCommand(cmd('t1'))
    processRegistry.cancelCommand('t1')
    processRegistry.completeCommand('t1', 0)
    processRegistry.failCommand('t1', 'boom')
    expect(processRegistry.getById('t1')?.status).toBe('cancelled')
  })

  it('completed é terminal — um fail tardio não o reescreve', () => {
    processRegistry.addCommand(cmd('t2'))
    processRegistry.completeCommand('t2', 0)
    processRegistry.failCommand('t2', 'late')
    expect(processRegistry.getById('t2')?.status).toBe('completed')
    expect(processRegistry.getById('t2')?.exitCode).toBe(0)
  })
})

describe('buffer de output', () => {
  it('appendOutput acumula e corta pela CABEÇA acima de 200k', () => {
    processRegistry.addCommand(cmd('t3'))
    processRegistry.appendOutput('t3', 'x'.repeat(150_000))
    processRegistry.appendOutput('t3', 'TAIL-'.padEnd(60_000, 'y'))
    const out = processRegistry.getById('t3')!.output
    expect(out.length).toBeLessThanOrEqual(200_100)
    expect(out.startsWith('[...earlier output dropped')).toBe(true)
    expect(out).toContain('TAIL-')
  })

  it('não acumula em comandos já terminados', () => {
    processRegistry.addCommand(cmd('t4'))
    processRegistry.completeCommand('t4', 0)
    processRegistry.appendOutput('t4', 'depois do fim')
    expect(processRegistry.getById('t4')!.output).toBe('')
  })
})

describe('espelho por subscrição', () => {
  it('notifica em cada mutação e o unsubscribe pára as notificações', () => {
    const seen: number[] = []
    const off = processRegistry.subscribe((cmds) => seen.push(cmds.size))
    processRegistry.addCommand(cmd('t5'))
    processRegistry.cancelCommand('t5')
    const after = seen.length
    off()
    processRegistry.addCommand(cmd('t6'))
    expect(after).toBeGreaterThanOrEqual(2)
    expect(seen.length).toBe(after)
    processRegistry.cancelCommand('t6')
  })

  it('um subscritor que lança não trava o motor nem os outros', () => {
    const ok = jest.fn()
    const offBoom = processRegistry.subscribe(() => {
      throw new Error('boom')
    })
    const offOk = processRegistry.subscribe(ok)
    expect(() => processRegistry.addCommand(cmd('t7'))).not.toThrow()
    expect(ok).toHaveBeenCalled()
    offBoom()
    offOk()
    processRegistry.cancelCommand('t7')
  })
})

describe('contagens e poda', () => {
  it('getRunningCount conta só os running; removeCompleted preserva 5', () => {
    for (let i = 0; i < 8; i++) {
      processRegistry.addCommand(cmd(`p${i}`))
      processRegistry.completeCommand(`p${i}`, 0)
    }
    processRegistry.addCommand(cmd('alive'))
    expect(processRegistry.getRunningCount()).toBe(1)
    processRegistry.removeCompleted()
    const terminated = processRegistry.getAll().filter(c => c.status !== 'running')
    expect(terminated.length).toBeLessThanOrEqual(5)
    expect(processRegistry.getById('alive')?.status).toBe('running')
    processRegistry.cancelCommand('alive')
  })
})
