import { FALLBACK_CONTEXT_WINDOW, resolveContextWindow } from '../contextWindow'

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
