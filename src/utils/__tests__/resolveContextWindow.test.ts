import {
  FALLBACK_CONTEXT_WINDOW,
  resolveContextWindow,
  getAutoCompactThreshold,
  getWarningThreshold,
} from '../contextWindow'
import { MODEL_PROFILES } from '../../services/agent/modelProfiles'

/**
 * A cadeia da janela de contexto estava escrita QUATRO vezes com ordens
 * diferentes (pill, /context, runtime do auto-compact, portão de envio). Numa
 * sessão de 1M o /context lia contra 200K e imprimia "94% cheio" onde o pill
 * mostrava 19%, e o portão de envio ficava desligado sempre que a janela não
 * viesse do header. Estes testes fixam a ordem única.
 */
describe('resolveContextWindow', () => {
  it('BYOK manda sobre tudo — o pedido não passa pelo worker', () => {
    expect(resolveContextWindow({
      byokContextWindow: 128_000,
      headerContextWindow: 1_000_000,
      personaContextWindow: 1_000_000,
      profileContextWindow: 200_000,
    }).contextWindow).toBe(128_000)
  })

  it('sem BYOK, o header servido manda', () => {
    expect(resolveContextWindow({
      headerContextWindow: 1_000_000,
      personaContextWindow: 200_000,
      profileContextWindow: 128_000,
    }).contextWindow).toBe(1_000_000)
  })

  it('a persona vale antes da 1ª resposta (ainda sem header)', () => {
    expect(resolveContextWindow({
      personaContextWindow: 1_000_000,
      profileContextWindow: 200_000,
    }).contextWindow).toBe(1_000_000)
  })

  it('sem nada conhecido, cai no fallback conservador', () => {
    expect(resolveContextWindow({}).contextWindow).toBe(FALLBACK_CONTEXT_WINDOW)
  })

  it('zero e negativo NÃO contam como valor conhecido', () => {
    // `setModelInfo` deixa 0 quando o header falta; tratá-lo como janela real
    // dava divisão por zero no pill e um limiar absurdo no auto-compact.
    expect(resolveContextWindow({
      headerContextWindow: 0,
      personaContextWindow: -1,
      profileContextWindow: 256_000,
    }).contextWindow).toBe(256_000)
  })

  it('o tecto de output segue a mesma disciplina: servido → perfil → null', () => {
    expect(resolveContextWindow({
      headerMaxOutputTokens: 65_536,
      profileMaxOutputTokens: 8_192,
    }).maxOutputTokens).toBe(65_536)
    expect(resolveContextWindow({
      profileMaxOutputTokens: 8_192,
    }).maxOutputTokens).toBe(8_192)
    expect(resolveContextWindow({}).maxOutputTokens).toBeNull()
  })

  it('cenário real: BYOK de 128K com persona gerida de 1M publicada', () => {
    // O caso que estourava no provedor: o auto-compact não lia o snapshot BYOK
    // e decidia pela janela da persona GERIDA, muito maior que a do modelo do
    // utilizador.
    const limits = resolveContextWindow({
      byokContextWindow: 128_000,
      personaContextWindow: 1_000_000,
      headerContextWindow: null,
    })
    expect(limits.contextWindow).toBe(128_000)
  })
})

/**
 * Sessão byok-ctxx (2026-08-10, MiMo, janela declarada 200K).
 *
 * O developer reportou "o contexto livre chegou a 0% e a compactação nunca
 * disparou". Os números do export dizem o contrário: pico REAL de 141 615,
 * abaixo do limiar de aviso — o pill nem devia estar visível, quanto mais a
 * mostrar 0%. A compactação estava correcta; o que mentia era o indicador, por
 * cair em `currentPromptTokens` (máximo corrente ao nível do STORE, que
 * atravessa sessões) quando a sessão não tem `lastPromptTokens`.
 *
 * Estes números ficam fixos aqui para que a próxima leitura de "0% livre" se
 * possa confrontar com o limiar em vez de se discutir de memória.
 */
describe('limiares da sessão byok-ctxx (regressão)', () => {
  const WINDOW = 200_000
  const PEAK_REAL_INPUT = 141_615

  it('o pico real fica ABAIXO do limiar de aviso — pill escondido', () => {
    expect(getWarningThreshold(WINDOW, null)).toBe(147_000)
    expect(PEAK_REAL_INPUT).toBeLessThan(getWarningThreshold(WINDOW, null))
  })

  it('o pico real fica ABAIXO do limiar de compactação — não compactar estava certo', () => {
    expect(getAutoCompactThreshold(WINDOW, null)).toBe(167_000)
    expect(PEAK_REAL_INPUT).toBeLessThan(getAutoCompactThreshold(WINDOW, null))
  })

  it('se o pill tivesse aparecido, diria 15% — nunca 0%', () => {
    const thr = getAutoCompactThreshold(WINDOW, null)
    const percentLeft = Math.max(0, Math.round(((thr - PEAK_REAL_INPUT) / thr) * 100))
    expect(percentLeft).toBe(15)
  })
})

/**
 * glm-5.2 servido por TRÊS provedores (2026-08-10). A tabela de perfis é
 * indexada pelo id do modelo; o Cloudflare Workers AI reporta um id próprio
 * (`@cf/zai-org/glm-5.2`) e uma janela menor (262 144), portanto a tabela
 * consegue distingui-lo. Onde não conseguir — z.AI e DashScope reportam ambos
 * `glm-5.2` — entra a memória por config (servedWindowMemory).
 */
describe('glm-5.2 multi-provider', () => {
  it('o perfil do Cloudflare não herda o 1M do z.AI', () => {
    expect(MODEL_PROFILES['@cf/zai-org/glm-5.2'].contextWindow).toBe(262_144)
    expect(MODEL_PROFILES['glm-5.2'].contextWindow).toBe(1_000_000)
  })

  it('o alias sem prefixo @cf aponta para o mesmo perfil', () => {
    expect(MODEL_PROFILES['zai-org/glm-5.2'].contextWindow).toBe(262_144)
  })
})
