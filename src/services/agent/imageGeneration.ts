/**
 * Geração de imagens — o caminho que põe assets REAIS nas apps que o agente
 * constrói (hero, og:image, favicon, ilustrações de empty state, seed data).
 *
 * Porquê um serviço próprio e não mais um sidecar como o de visão: este é o
 * único caminho do data-plane cujo corpo NÃO é chat. A DashScope não serve
 * geração de imagens no modo OpenAI-compatible — `/compatible-mode/v1/images/
 * generations` devolve 404 (sondado ao vivo 2026-08-08). O que responde é a API
 * NATIVA, `/api/v1/services/aigc/multimodal-generation/generation`, com:
 *
 *   { model, input: { messages: [{ role, content: [{ text }] }] },
 *     parameters: { size, n, seed, watermark, prompt_extend, negative_prompt } }
 *
 * O worker deixa este corpo passar intacto (o caminho de chat só mexe em
 * `body.messages` e em `stream`, que aqui não existem) e carimba o `model` da
 * config — por isso o cliente manda um placeholder, como em todo o resto.
 *
 * A RESPOSTA É UMA URL QUE EXPIRA EM 24 HORAS. Não há opção de base64 nesta
 * API. Por isso o asset é descarregado no próprio turno: se ficasse
 * referenciado por URL estaria partido no dia seguinte, dentro de uma app que
 * o developer entretanto fez deploy.
 *
 * O download NÃO passa por `fetch`: em produção o WebView corre em
 * `http://localhost:14300` e o bucket que serve as imagens não tem obrigação
 * nenhuma de nos mandar `Access-Control-Allow-Origin`. Vai pelo comando Rust
 * `download_to_file` (reqwest, sem CORS) — a mesma razão pela qual todo o
 * control-plane passa pelo `tauriFetch`. A primeira versão disto descarregava
 * no browser e teria falhado na primeira execução real, com a suite verde.
 *
 * Custos REAIS (rate card oficial 2026-08-08), porque isto não é um sidecar
 * barato como o utility: $0,04 por imagem no escalão 1K e $0,075 no 2K. O
 * escalão NÃO se escolhe nem se prevê pelo pedido — o provider decide e
 * reporta-o (ver a nota nos SIZE_PRESETS). Daí a tool ser explícita e nunca
 * automática.
 */
import { resolveAIWorkerUrl } from '../../utils/devUrls'
import { logger } from '../../utils/logger'

/**
 * Tecto de espera, com folga deliberada: falhar por timeout uma geração que o
 * provider vai cobrar à mesma é o pior desfecho possível.
 *
 * O `n` NÃO multiplica o tempo — o provider gera em paralelo. Medido a
 * 2026-08-08: n=1 → 6-9s, n=2 → 9s, n=3 → 7s. O pior caso observado em seis
 * sondagens foi 58s (uma resposta no escalão 2K), portanto 300s dá ~5x de
 * margem sobre o pior caso conhecido.
 *
 * ATENÇÃO se algum dia isto subir: o worker tem o SEU próprio tecto até aos
 * headers em pedidos não-streaming (UPSTREAM_NONSTREAM_HEADER_TIMEOUT_MS,
 * default 300000). Aumentar só aqui não serve de nada — quem corta primeiro é
 * o worker, e o cliente veria um erro de rede em vez de um timeout honesto.
 */
const IMAGE_GENERATION_TIMEOUT_MS = 300_000
/** Segundos para o Rust descarregar a imagem do bucket do provider. */
const IMAGE_DOWNLOAD_TIMEOUT_SECS = 60

/** Limite documentado do `negative_prompt` (500 caracteres). */
export const NEGATIVE_PROMPT_MAX = 500
/** `n` documentado: 1 a 6 imagens por pedido. */
export const MAX_IMAGES_PER_REQUEST = 6

export interface GenerateImagesOptions {
  prompt: string
  /** "L*A". Ver SIZE_PRESETS — o valor decide o escalão de preço. */
  size?: string
  n?: number
  seed?: number
  negativePrompt?: string
  /** Reescrita "inteligente" do prompt pelo provider (default DELA é true). */
  promptExtend?: boolean
  signal?: AbortSignal
}

export interface GeneratedImage {
  /** URL do provider — VÁLIDA 24H. Descarregar com `saveImageTo`. */
  url: string
  width: number
  height: number
}

export interface GenerateImagesResult {
  images: GeneratedImage[]
  /** 'qima_output_1k' | 'qima_output_2k' — o escalão que o provider reportou. */
  tier: string | null
  model: string | null
}

/**
 * Presets de tamanho pensados para frontend. O primeiro número é o que separa
 * $0,04 de $0,075, por isso está aqui e não na cabeça de quem chama.
 *
 * NÃO declaram escalão de preço, e isso é deliberado. Seis sondagens a
 * 2026-08-08 mostraram que o escalão NÃO é função do `size`: o mesmo pedido
 * (1664*928, n=1, seed 42, prompt idêntico) devolveu `qima_output_2k` a
 * 2752*1536 em 58s numa altura e `qima_output_1k` a 1664*928 em 8s noutra.
 * Quem decide é o provider, e diz qual foi em `output_image_type`.
 *
 * Consequências, e são as duas que moldam este ficheiro:
 *  - o BILLING tem de ler o escalão reportado, nunca inferi-lo do pedido
 *    (é o que o worker faz — e agora sabe-se que era necessário, não prudente);
 *  - as DIMENSÕES de saída são imprevisíveis, por isso a gravação normaliza-as
 *    com `maxWidth` em vez de confiar no que foi pedido.
 *
 * O que se manteve estável nas sondagens: o tamanho pedido é respeitado
 * exactamente quando o provider serve 1K, e o custo anda entre $0,04 e $0,075
 * por imagem. A latência variou entre ~6s e ~58s para pedidos equivalentes.
 */
export const SIZE_PRESETS: Record<string, { size: string; use: string }> = {
  icon: { size: '1024*1024', use: 'favicon, app icon, avatar — quadrado' },
  square: { size: '1024*1024', use: 'ilustração quadrada, empty state, card' },
  og: { size: '1200*630', use: 'og:image / social preview (1.91:1)' },
  hero: { size: '1664*928', use: 'hero 16:9' },
  portrait: { size: '928*1664', use: 'banner vertical 9:16' },
}

interface NativeImageResponse {
  output?: {
    choices?: Array<{ message?: { content?: Array<{ image?: string }> } }>
  }
  usage?: {
    output_image_type?: string
    output_width?: number
    output_height?: number
  }
  code?: string
  message?: string
}

export class ImageGenerationError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ImageGenerationError'
    this.code = code
  }
}

/**
 * Gera imagens e devolve as URLs do provider (válidas 24h) — quem chama
 * grava-as com `saveImageTo`, que passa pelo Rust.
 *
 * Ao contrário dos outros sidecars, este NÃO degrada em silêncio: um sidecar
 * de visão que falha devolve null e o agente segue com texto, mas uma geração
 * de imagem que "falhe suavemente" deixaria o agente a escrever `<img src>`
 * para um ficheiro que não existe. Falha alto, com a causa.
 */
export async function generateImages(opts: GenerateImagesOptions): Promise<GenerateImagesResult> {
  const prompt = opts.prompt?.trim()
  if (!prompt) throw new ImageGenerationError('tm_bad_prompt', 'prompt is empty.')

  const n = Math.min(Math.max(1, Math.floor(opts.n ?? 1)), MAX_IMAGES_PER_REQUEST)

  // BYOK auto-financiado não paga infra-estrutura da TM — mesma regra dos
  // sidecars de visão e de fetch.
  const { resolveAuxByokRoute } = await import('./byokRouting')
  if (resolveAuxByokRoute()) {
    throw new ImageGenerationError(
      'tm_byok_no_image',
      'Image generation is a TM-managed service and is not available on a self-funded BYOK plan.',
    )
  }

  const { default: FirebaseAuthService } = await import('../auth/firebaseAuth')
  const token = await FirebaseAuthService.getInstance().getIdToken()
  if (!token) throw new ImageGenerationError('tm_no_auth', 'Not authenticated.')

  const parameters: Record<string, unknown> = {
    n,
    // Sem marca de água: isto vai para dentro do produto do developer.
    watermark: false,
    // Default OFF, ao contrário do default do provider. A reescrita do prompt
    // dá variedade, mas o agente está a produzir um ASSET com um briefing
    // específico (paleta, estilo, "sem texto") — reescrevê-lo por baixo torna
    // o resultado não-reprodutível e ignora metade das instruções. Quem quiser
    // exploração liga-o explicitamente.
    prompt_extend: opts.promptExtend === true,
  }
  if (opts.size) parameters.size = opts.size
  if (typeof opts.seed === 'number' && Number.isFinite(opts.seed)) {
    parameters.seed = Math.max(0, Math.min(2_147_483_647, Math.floor(opts.seed)))
  }
  if (opts.negativePrompt?.trim()) {
    parameters.negative_prompt = opts.negativePrompt.trim().slice(0, NEGATIVE_PROMPT_MAX)
  }

  const body = {
    // Placeholder: o worker substitui pelo modelo da config `sidecar:image`.
    model: 'tm-image-model',
    input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
    parameters,
  }

  let res: Response
  try {
    res = await fetch(`${resolveAIWorkerUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Request-Type': 'image',
      },
      body: JSON.stringify(body),
      signal: opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS)])
        : AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS),
    })
  } catch (err) {
    if (opts.signal?.aborted) throw new ImageGenerationError('tm_aborted', 'Run stopped.')
    throw new ImageGenerationError('tm_network', `Image request failed: ${String(err)}`)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // O 503 do worker é específico e accionável: quer dizer que o slot
    // `sidecar:image` não está publicado no KV, não que o modelo falhou.
    if (res.status === 503 && detail.includes('tm_sidecar_unavailable')) {
      throw new ImageGenerationError(
        'tm_sidecar_unavailable',
        'No image model is published for this workspace (sidecar:image). An admin must publish it in Settings → Sidecars.',
      )
    }
    // Throttling é comum neste modelo (apanhado em 3 pedidos seguidos na
    // sondagem 08-08) e merece uma mensagem que não pareça um bug.
    if (detail.includes('Throttling') || res.status === 429) {
      throw new ImageGenerationError(
        'tm_rate_limited',
        'The image provider rate-limited this request. Wait a few seconds before trying again.',
      )
    }
    throw new ImageGenerationError('tm_upstream', `Image generation failed (HTTP ${res.status}): ${detail.slice(0, 300)}`)
  }

  // Mesma verificação dos outros sidecars: sem a config certa, respondeu OUTRA
  // coisa e o corpo não é de confiança. Aqui é ainda mais importante — um
  // modelo de chat devolveria `choices[].message.content` em texto.
  const served = res.headers.get('x-tm-config-key')
  if (served !== 'sidecar:image') {
    throw new ImageGenerationError(
      'tm_wrong_config',
      `Request was served by "${served ?? 'an unknown config'}" instead of the image model.`,
    )
  }

  const data = (await res.json().catch(() => null)) as NativeImageResponse | null
  const urls = (data?.output?.choices?.[0]?.message?.content ?? [])
    .map(part => part?.image)
    .filter((u): u is string => typeof u === 'string' && u.length > 0)

  if (urls.length === 0) {
    throw new ImageGenerationError(
      'tm_no_image',
      `The model returned no image${data?.message ? ` (${data.message})` : ''}.`,
    )
  }

  const width = data?.usage?.output_width ?? 0
  const height = data?.usage?.output_height ?? 0

  const images: GeneratedImage[] = urls.map(url => ({ url, width, height }))

  logger.info(
    'image-generation',
    `${images.length} imagem(ns) ${width}x${height} tier=${data?.usage?.output_image_type ?? '?'}`,
  )

  return {
    images,
    tier: data?.usage?.output_image_type ?? null,
    model: res.headers.get('x-tm-model'),
  }
}

/**
 * Descarrega uma imagem gerada para um caminho absoluto e devolve os bytes
 * ESCRITOS (que não são os descarregados, se houve redimensionamento).
 * Passa pelo Rust (`download_to_file`) — ver a nota de CORS no topo.
 *
 * `maxWidth` reduz a imagem antes de gravar, e a extensão do destino escolhe o
 * formato (`.jpg` recodifica com qualidade 82). É isto que torna o resultado
 * publicável: o provider devolve PNGs de 2K com ~2 MB, que ninguém põe numa
 * página. O comando valida o destino com o MESMO clamp de caminhos de todas as
 * escritas do agente, e valida-o ANTES de tocar na rede.
 */
export async function saveImageTo(
  url: string,
  absolutePath: string,
  maxWidth?: number,
): Promise<number> {
  const { invoke } = await import('../../utils/invokeMetrics')
  try {
    return await invoke<number>('download_to_file', {
      url,
      path: absolutePath,
      timeoutSecs: IMAGE_DOWNLOAD_TIMEOUT_SECS,
      maxWidth,
    })
  } catch (err) {
    throw new ImageGenerationError(
      'tm_download_failed',
      `The image was generated (and billed) but could not be saved to ${absolutePath}: ${String(err)}. `
      + 'The provider link is only valid for 24h.',
    )
  }
}
