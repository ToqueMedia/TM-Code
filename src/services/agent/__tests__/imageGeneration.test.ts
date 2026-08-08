/**
 * Geração de imagens — contrato com o data-plane e com o provider.
 *
 * Este caminho é o único do cliente cujo corpo NÃO é chat, e as três coisas
 * que o podem partir em silêncio são exactamente as que aqui se trancam:
 *   1. o request-type tem de existir no mapa do worker (senão degrada para o
 *      modelo de chat e a resposta vem em texto);
 *   2. o download NÃO pode passar por `fetch` do browser (CORS: o WebView de
 *      produção corre em localhost:14300 e o bucket do provider não tem de nos
 *      autorizar) — vai pelo comando Rust;
 *   3. um pedido servido por OUTRA config não pode ser aceite como imagem.
 */
import * as fs from 'fs'
import * as path from 'path'

jest.mock('../../../utils/devUrls', () => ({
  resolveAIWorkerUrl: () => 'https://worker.test',
}))
jest.mock('../byokRouting', () => ({ resolveAuxByokRoute: jest.fn(() => null) }))
jest.mock('../../auth/firebaseAuth', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getIdToken: async () => 'id-token' }) },
}))
const mockInvoke = jest.fn(async () => 2_100_000)
jest.mock('../../../utils/invokeMetrics', () => ({ invoke: (...a: unknown[]) => mockInvoke(...(a as [])) }))

import {
  generateImages, saveImageTo, ImageGenerationError, SIZE_PRESETS, NEGATIVE_PROMPT_MAX,
} from '../imageGeneration'

/** Resposta NATIVA do qwen-image (forma confirmada ao vivo 2026-08-08). */
function nativeResponse(opts: { images?: number; tier?: string } = {}) {
  const images = opts.images ?? 1
  return {
    output: {
      choices: [{
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: Array.from({ length: images }, (_, i) => ({ image: `https://oss.test/i${i}.png` })),
        },
      }],
    },
    usage: {
      input_image_count: 0,
      output_image_count: images,
      output_image_type: opts.tier ?? 'qima_output_2k',
      output_width: 2752,
      output_height: 1536,
    },
  }
}

interface FetchCall { url: string; init?: RequestInit }

/** Mock de fetch: 1º pedido = worker; seguintes = download do OSS. */
function mockFetch(opts: {
  body?: unknown
  status?: number
  configKey?: string | null
  text?: string
} = {}) {
  const calls: FetchCall[] = []
  const fn = jest.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, init })
    const status = opts.status ?? 200
    const headers = new Map<string, string>()
    const key = opts.configKey === undefined ? 'sidecar:image' : opts.configKey
    if (key !== null) headers.set('x-tm-config-key', key)
    headers.set('x-tm-model', 'qwen-image-3.0-pro')
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h: string) => headers.get(h.toLowerCase()) ?? null },
      json: async () => opts.body ?? nativeResponse(),
      text: async () => opts.text ?? '',
    } as unknown as Response
  })
  ;(globalThis as unknown as { fetch: unknown }).fetch = fn
  return { fn, calls }
}

describe('imageGeneration — contrato com o worker', () => {
  it('o request-type "image" existe no mapa do worker e é STRICT', () => {
    // Lê a fonte do worker, no mesmo repositório. Se alguém lá mexer, isto
    // acusa — o mesmo padrão do fetchSidecarRequestType.
    const cfg = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', 'workers', 'ai-pass-through', 'src', 'activeConfig.ts'),
      'utf8',
    )
    expect(cfg).toMatch(/'image':\s*'sidecar:image'/)

    // STRICT importa mais do que parece: sem isso, um workspace sem o modelo
    // publicado mandava o corpo nativo (que não tem `messages`) para um modelo
    // de CHAT, e o agente recebia texto onde esperava uma imagem.
    const index = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', 'workers', 'ai-pass-through', 'src', 'index.ts'),
      'utf8',
    )
    const strict = /strictSidecarRequestType = \[([^\]]*)\]/.exec(index)
    expect(strict).not.toBeNull()
    expect(strict![1]).toContain("'image'")
  })

  it('envia o corpo NATIVO (input.messages + parameters), não um corpo de chat', async () => {
    const { calls } = mockFetch()
    await generateImages({ prompt: 'hero', size: '1200*630', seed: 7 })

    const sent = JSON.parse(String(calls[0].init!.body))
    expect(calls[0].url).toBe('https://worker.test/v1/chat/completions')
    expect((calls[0].init!.headers as Record<string, string>)['X-Request-Type']).toBe('image')
    // Corpo nativo: nada de `messages` no topo, nada de `stream`.
    expect(sent.messages).toBeUndefined()
    expect(sent.stream).toBeUndefined()
    expect(sent.input.messages[0].content[0].text).toBe('hero')
    expect(sent.parameters.size).toBe('1200*630')
    expect(sent.parameters.seed).toBe(7)
  })

  it('watermark fica sempre OFF e prompt_extend só liga a pedido', async () => {
    // A marca de água iria para dentro do produto do developer; o
    // prompt_extend (cujo default do PROVIDER é true) reescreve o briefing
    // de arte por baixo e torna o resultado não-reprodutível.
    const { calls } = mockFetch()
    await generateImages({ prompt: 'x' })
    let sent = JSON.parse(String(calls[0].init!.body))
    expect(sent.parameters.watermark).toBe(false)
    expect(sent.parameters.prompt_extend).toBe(false)

    const second = mockFetch()
    await generateImages({ prompt: 'x', promptExtend: true })
    sent = JSON.parse(String(second.calls[0].init!.body))
    expect(sent.parameters.prompt_extend).toBe(true)
  })

  it('trunca o negative_prompt no limite documentado e clampa n a 6', async () => {
    const { calls } = mockFetch({ body: nativeResponse({ images: 6 }) })
    await generateImages({ prompt: 'x', negativePrompt: 'a'.repeat(900), n: 99 })
    const sent = JSON.parse(String(calls[0].init!.body))
    expect(sent.parameters.negative_prompt).toHaveLength(NEGATIVE_PROMPT_MAX)
    expect(sent.parameters.n).toBe(6)
  })

  it('devolve as URLs do provider com as dimensões reais', async () => {
    const { calls } = mockFetch({ body: nativeResponse({ images: 2 }) })
    const result = await generateImages({ prompt: 'x', n: 2 })

    expect(result.images).toHaveLength(2)
    expect(result.images[0].url).toBe('https://oss.test/i0.png')
    expect(result.images[0].width).toBe(2752)
    expect(result.tier).toBe('qima_output_2k')
    // Só o pedido ao worker sai por `fetch`. O download é do Rust — se algum
    // dia voltar para aqui, este número muda e o teste acusa.
    expect(calls).toHaveLength(1)
  })

  it('o download passa pelo Rust, NUNCA por fetch do browser', async () => {
    // A regressão que isto tranca: em produção o WebView corre em
    // localhost:14300 e um fetch ao bucket do provider morre em CORS. Foi
    // assim que a primeira versão desta funcionalidade foi escrita — verde
    // nos testes, morta na primeira execução real.
    mockInvoke.mockClear()
    const { calls } = mockFetch()
    const result = await generateImages({ prompt: 'x' })
    const bytes = await saveImageTo(result.images[0].url, '/proj/public/hero.png')

    expect(mockInvoke).toHaveBeenCalledWith('download_to_file', expect.objectContaining({
      url: 'https://oss.test/i0.png',
      path: '/proj/public/hero.png',
    }))
    expect(bytes).toBe(2_100_000)
    expect(calls.some(c => c.url.startsWith('https://oss.test/'))).toBe(false)
  })

  it('um download falhado diz que a imagem JÁ FOI cobrada', async () => {
    // Sem isto o modelo reporta "falhou" e o developer não sabe que pagou.
    mockInvoke.mockRejectedValueOnce(new Error('path outside project'))
    await expect(saveImageTo('https://oss.test/i0.png', '/etc/passwd.png'))
      .rejects.toMatchObject({ code: 'tm_download_failed' })
    await expect(saveImageTo('https://oss.test/i0.png', '/etc/passwd.png'))
      .resolves.toBe(2_100_000)
  })

  it('recusa uma resposta servida por OUTRA config', async () => {
    mockFetch({ configKey: 'active' })
    await expect(generateImages({ prompt: 'x' })).rejects.toMatchObject({ code: 'tm_wrong_config' })
  })

  it('distingue "sidecar não publicado" de uma falha do modelo', async () => {
    // Erros diferentes pedem respostas diferentes do agente: um diz-lhe para
    // avisar o developer que falta publicar o modelo; o outro é transitório.
    mockFetch({ status: 503, text: '{"error":"tm_sidecar_unavailable"}' })
    await expect(generateImages({ prompt: 'x' }))
      .rejects.toMatchObject({ code: 'tm_sidecar_unavailable' })

    mockFetch({ status: 429, text: '{"code":"Throttling.RateQuota"}' })
    await expect(generateImages({ prompt: 'x' })).rejects.toMatchObject({ code: 'tm_rate_limited' })
  })

  it('falha ALTO quando não vem imagem (não devolve vazio em silêncio)', async () => {
    // Ao contrário do sidecar de visão, que degrada para texto: aqui um
    // "sucesso vazio" deixaria o agente a escrever <img src> para um ficheiro
    // que nunca foi criado.
    mockFetch({ body: { output: { choices: [] } } })
    await expect(generateImages({ prompt: 'x' })).rejects.toBeInstanceOf(ImageGenerationError)
  })

  it('BYOK auto-financiado não paga infra da TM', async () => {
    const { resolveAuxByokRoute } = jest.requireMock('../byokRouting')
    ;(resolveAuxByokRoute as jest.Mock).mockReturnValueOnce({ provider: 'x' })
    mockFetch()
    await expect(generateImages({ prompt: 'x' })).rejects.toMatchObject({ code: 'tm_byok_no_image' })
  })
})

describe('imageGeneration — presets de tamanho', () => {
  it('NENHUM preset promete um escalão de preço', () => {
    // A regressão que isto tranca é uma afirmação minha que a medição derrubou.
    // A primeira versão destes presets classificava cada tamanho como '1k' ou
    // '2k' com base em duas sondagens. Seis sondagens depois, o MESMO pedido
    // (1664*928, n=1, seed 42, prompt idêntico) tinha devolvido os dois
    // escalões em alturas diferentes — 2752*1536 em 58s uma vez, 1664*928 em
    // 8s nas outras. O escalão é do provider, vem em `output_image_type`, e
    // prometê-lo aqui era enganar o modelo sobre custo e latência.
    for (const preset of Object.values(SIZE_PRESETS)) {
      expect(preset).not.toHaveProperty('tier')
    }
  })

  it('cada preset declara um tamanho válido para a API', () => {
    // Total de pixels entre 512*512 e 2048*2048, por documentação.
    for (const [name, preset] of Object.entries(SIZE_PRESETS)) {
      expect(`${name}:${preset.size}`).toMatch(/:\d{3,4}\*\d{3,4}$/)
      const [w, h] = preset.size.split('*').map(Number)
      expect(`${name}:${w * h >= 512 * 512}`).toBe(`${name}:true`)
      expect(`${name}:${w * h <= 2048 * 2048}`).toBe(`${name}:true`)
    }
  })

  it('og é 1.91:1 e hero/portrait são 16:9 nas duas orientações', () => {
    const ratio = (k: string) => {
      const [w, h] = SIZE_PRESETS[k].size.split('*').map(Number)
      return w / h
    }
    expect(ratio('og')).toBeCloseTo(1.9, 1)
    expect(ratio('hero')).toBeCloseTo(16 / 9, 1)
    expect(ratio('portrait')).toBeCloseTo(9 / 16, 1)
    expect(ratio('icon')).toBe(1)
  })
})
