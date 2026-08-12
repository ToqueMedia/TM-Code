import {
  rememberServedWindow,
  recallServedWindow,
  clearServedWindowMemory,
  servedWindowKey,
} from '../servedWindowMemory'
import { resolveContextWindow, getAutoCompactThreshold } from '../../../utils/contextWindow'

/**
 * Janela por CONFIG, não por modelo (2026-08-10).
 *
 * O mesmo glm-5.2 é servido por z.AI (1M), DashScope e Cloudflare Workers AI
 * (262 144). `MODEL_PROFILES` é indexado pelo id do modelo, portanto não pode
 * guardar três verdades. Antes da 1ª resposta de cada arranque não há header e
 * o perfil ganhava: limiar calculado 931 000 onde o correcto é 229 144.
 */
describe('servedWindowMemory', () => {
  beforeEach(() => clearServedWindowMemory())

  it('distingue o mesmo modelo servido por provedores diferentes', () => {
    rememberServedWindow('zai', 'glm-5.2', 1_000_000, 131_072)
    rememberServedWindow('cloudflare', '@cf/zai-org/glm-5.2', 262_144, undefined)

    expect(recallServedWindow('zai', 'glm-5.2')?.contextWindow).toBe(1_000_000)
    expect(recallServedWindow('cloudflare', '@cf/zai-org/glm-5.2')?.contextWindow).toBe(262_144)
  })

  it('a chave inclui o provedor — sem ele os dois colidiam', () => {
    expect(servedWindowKey('zai', 'glm-5.2')).toBe('zai:glm-5.2')
    expect(servedWindowKey('dashscope', 'glm-5.2')).toBe('dashscope:glm-5.2')
    expect(servedWindowKey('zai', 'glm-5.2')).not.toBe(servedWindowKey('dashscope', 'glm-5.2'))
  })

  it('sem modelo não grava nem devolve nada', () => {
    expect(servedWindowKey('zai', null)).toBeNull()
    rememberServedWindow('zai', '', 1_000, 1_000)
    expect(recallServedWindow('zai', '')).toBeNull()
  })

  it('header ausente (undefined) não apaga o que já se sabia', () => {
    rememberServedWindow('cloudflare', '@cf/zai-org/glm-5.2', 262_144, 131_072)
    rememberServedWindow('cloudflare', '@cf/zai-org/glm-5.2', undefined, undefined)
    expect(recallServedWindow('cloudflare', '@cf/zai-org/glm-5.2')?.contextWindow).toBe(262_144)
  })

  it('a memória vence o perfil por id e corrige o limiar', () => {
    rememberServedWindow('cloudflare', '@cf/zai-org/glm-5.2', 262_144, undefined)
    const learned = recallServedWindow('cloudflare', '@cf/zai-org/glm-5.2')

    const semMemoria = resolveContextWindow({
      headerContextWindow: null, personaContextWindow: null,
      profileContextWindow: 1_000_000,
    })
    const comMemoria = resolveContextWindow({
      headerContextWindow: null, personaContextWindow: null,
      learnedContextWindow: learned?.contextWindow,
      profileContextWindow: 1_000_000,
    })

    expect(getAutoCompactThreshold(semMemoria.contextWindow, 131_072)).toBe(931_000)
    expect(getAutoCompactThreshold(comMemoria.contextWindow, 131_072)).toBe(229_144)
  })

  it('o header vivo continua a mandar sobre a memória', () => {
    const r = resolveContextWindow({
      headerContextWindow: 262_144,
      learnedContextWindow: 1_000_000,
      profileContextWindow: 1_000_000,
    })
    expect(r.contextWindow).toBe(262_144)
  })

  it('a persona publicada pelo admin manda sobre a memória — pode ser uma troca de provedor', () => {
    const r = resolveContextWindow({
      headerContextWindow: null,
      personaContextWindow: 262_144,
      learnedContextWindow: 1_000_000,
    })
    expect(r.contextWindow).toBe(262_144)
  })
})
