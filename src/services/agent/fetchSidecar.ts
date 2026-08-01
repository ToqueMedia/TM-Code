/**
 * Sidecar de web fetch — processa a página com um modelo pequeno em vez de a
 * despejar no contexto do agente.
 *
 * PORTE do `cli-vaz/tools/WebFetchTool`. O contrato lá é diferente do que o TM
 * Code tinha: recebe `url` **e um `prompt`**, converte a página a markdown,
 * passa-a a um modelo rápido com essa pergunta, e devolve a RESPOSTA — não a
 * página.
 *
 * O ganho é de arquitectura, não de afinação:
 *  - uma página de 200 KB entra no contexto do agente como três linhas de
 *    resposta, em vez de 50 000 caracteres truncados a meio;
 *  - conteúdo irrelevante (navegação, rodapés, cookie banners) nunca chega ao
 *    transcript, portanto também não sobrevive à compactação;
 *  - o custo do texto bruto é pago por um modelo barato, uma vez, em vez de
 *    ocupar a janela do modelo principal em todos os turnos seguintes.
 *
 * Custo: uma chamada extra ao modelo por fetch. É deliberado — a alternativa
 * era continuar a pagar o texto integral em cada turno até à compactação.
 *
 * Degradação: sem sidecar disponível (BYOK auto-financiado, worker em baixo,
 * modelo activo sem config), devolve `null` e o caller entrega o texto
 * extraído como antes. Nunca falha o fetch por causa do sumarizador.
 */
import { resolveAIWorkerUrl } from '../../utils/devUrls'
// firebaseAuth lê `import.meta.env` no topo do módulo, que o Jest não parseia.
// Import DINÂMICO (como o byokRouting abaixo) para que a cache deste ficheiro
// seja importável sem arrastar a stack de auth — e testável sem a mockar.
import { logger } from '../../utils/logger'

const FETCH_SIDECAR_TIMEOUT_MS = 60_000
/** Tecto do que se manda ao sumarizador. Acima disto corta-se: um modelo
 *  pequeno com 400 KB de markdown responde pior, não melhor. */
const MAX_CONTENT_CHARS = 120_000

/**
 * Guia de resposta. Porte quase literal do `makeSecondaryModelPrompt`, sem o
 * ramo de domínios pré-aprovados: a restrição de citação de 125 caracteres
 * existe para conteúdo de terceiros e aplicá-la sempre é o lado seguro.
 */
const GUIDELINES = `Provide a concise response based only on the content above. In your response:
 - Enforce a strict 125-character maximum for quotes from any source document. Open Source Software is ok as long as we respect the license.
 - Use quotation marks for exact language from articles; any language outside of the quotation should never be word-for-word the same.
 - You are not a lawyer and never comment on the legality of your own prompts and responses.
 - Never produce or reproduce exact song lyrics.`

const SYSTEM = 'You answer questions about web page content. Be precise and concise. '
  + 'If the content does not answer the question, say so plainly instead of guessing — '
  + 'the developer needs to know the page did not have it.'

// ── Cache de conteúdo por URL (porte do URL_CACHE do claude-vaz) ──
//
// Não a tinha portado, e com o contrato novo ela passou a valer MAIS: repetir
// um URL custava rede + uma chamada ao modelo. Cacheia-se o CONTEÚDO, não a
// resposta — o mesmo `prompt` raramente se repete, mas a mesma página sim
// (o agente volta ao mesmo doc com perguntas diferentes). Assim a segunda
// pergunta poupa a rede e só paga o modelo.
const CACHE_TTL_MS = 15 * 60 * 1000
/** Tecto de entradas: isto vive no renderer, não num processo dedicado. */
const CACHE_MAX_ENTRIES = 24
/** Não cachear páginas enormes — a memória é do editor do developer. */
const CACHE_MAX_ENTRY_CHARS = 400_000

const contentCache = new Map<string, { content: string; at: number }>()

/** Conteúdo cacheado deste URL, se ainda fresco. */
export function getCachedPageContent(url: string): string | null {
  const hit = contentCache.get(url)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    contentCache.delete(url)
    return null
  }
  // LRU pobre mas suficiente: re-inserir põe no fim da ordem de iteração.
  contentCache.delete(url)
  contentCache.set(url, hit)
  return hit.content
}

export function cachePageContent(url: string, content: string): void {
  if (!content || content.length > CACHE_MAX_ENTRY_CHARS) return
  contentCache.delete(url)
  contentCache.set(url, { content, at: Date.now() })
  while (contentCache.size > CACHE_MAX_ENTRIES) {
    const oldest = contentCache.keys().next().value
    if (oldest === undefined) break
    contentCache.delete(oldest)
  }
}

export function clearPageCache(): void {
  contentCache.clear()
}

export interface FetchSidecarResult {
  answer: string
  /** Modelo que respondeu, para o rasto no resultado da tool. */
  model: string | null
}

/**
 * Responde a `prompt` a partir de `content`. `null` quando o sidecar não está
 * disponível — o caller cai para o texto bruto.
 */
export async function answerFromPageViaSidecar(
  content: string,
  prompt: string,
  sourceUrl: string,
  /** Sinal do RUN. Sem ele, um Stop deixava o sumarizador a correr até aos
   *  60s de timeout enquanto o agente já tinha parado — e o custo era
   *  facturado na mesma. O fetch já corre em corrida com este sinal; o
   *  sumarizador tinha ficado de fora. */
  signal?: AbortSignal,
): Promise<FetchSidecarResult | null> {
  // TODAS as saídas dizem porquê, e TODAS estão dentro do try.
  //
  // A primeira versão tinha três `return null` silenciosos ANTES do try. Em
  // produção o resultado foi: nem uma linha no console e texto bruto no
  // resultado — indistinguível de "nunca correu". Pior: uma excepção nesta
  // zona propagava para o caller, que a engolia no seu próprio catch, e o
  // sintoma era idêntico. É o mesmo defeito que corrigi no editDiagnostics
  // umas horas antes e reproduzi aqui.
  if (!content.trim() || !prompt.trim()) {
    logger.info('fetch-sidecar', 'sem conteúdo ou sem prompt — nada a sumarizar')
    return null
  }
  if (signal?.aborted) {
    logger.info('fetch-sidecar', 'run já abortado — sumarização saltada')
    return null
  }

  let token: string | null = null
  try {
    // BYOK auto-financiado não paga sidecars de infra-estrutura TM — mesma
    // regra do sidecar de visão.
    const { resolveAuxByokRoute } = await import('./byokRouting')
    if (resolveAuxByokRoute()) {
      logger.info('fetch-sidecar', 'BYOK auto-financiado (plano free) — sem sidecar, texto bruto')
      return null
    }
    const { default: FirebaseAuthService } = await import('../auth/firebaseAuth')
    token = await FirebaseAuthService.getInstance().getIdToken()
  } catch (err) {
    logger.warn('fetch-sidecar', 'pré-voo falhou (auth/byok) — texto bruto:', err)
    return null
  }
  if (!token) {
    logger.warn('fetch-sidecar', 'sem token de autenticação — texto bruto')
    return null
  }

  const trimmed = content.length > MAX_CONTENT_CHARS
    ? `${content.slice(0, MAX_CONTENT_CHARS)}\n…[content truncated]`
    : content

  const body = {
    model: 'tm-active-model',
    stream: false,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `Web page content (${sourceUrl}):\n---\n${trimmed}\n---\n\n${prompt}\n\n${GUIDELINES}`,
      },
    ],
  }

  try {
    const res = await fetch(`${resolveAIWorkerUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        // `summarize`, não `utility`: o worker mapeia NOMES DE REQUEST-TYPE
        // para sidecars (REQUEST_TYPE_TO_SIDECAR_KEY em activeConfig.ts), e
        // `utility` não é um deles — é o nome do SIDECAR, não do pedido.
        // Enviá-lo fazia `sidecarKeyForRequestType` devolver null, o worker
        // degradava para a config activa, e este cliente descartava a
        // resposta por o header não bater: chamada paga e deitada fora.
        // `summarize` já existe e aponta para `sidecar:utility`, que é
        // exactamente o modelo barato que este caminho quer.
        'X-Request-Type': 'summarize',
      },
      body: JSON.stringify(body),
      // Timeout OU Stop, o que vier primeiro.
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_SIDECAR_TIMEOUT_MS)])
        : AbortSignal.timeout(FETCH_SIDECAR_TIMEOUT_MS),
    })
    if (!res.ok) {
      logger.warn('fetch-sidecar', `HTTP ${res.status} — a devolver texto bruto`)
      return null
    }
    // Mesma verificação do sidecar de visão: sem a config certa, o worker
    // serviu OUTRA coisa e a resposta não é de confiança.
    const served = res.headers.get('x-tm-config-key')
    if (served !== 'sidecar:utility') {
      // Diz QUAL config respondeu. "não é utility" não distingue "sidecar não
      // publicado" de "request-type que o worker não conhece" — e foi
      // precisamente essa ambiguidade que escondeu o bug do nome durante
      // três runs.
      logger.warn('fetch-sidecar', `servido por "${served ?? 'sem header'}" em vez de sidecar:utility — texto bruto`)
      return null
    }
    const data = (await res.json().catch(() => null)) as
      { choices?: Array<{ message?: { content?: string } }> } | null
    const answer = data?.choices?.[0]?.message?.content?.trim()
    if (!answer) return null
    const model = res.headers.get('x-tm-model')
    logger.info('fetch-sidecar', `página respondida por modelo=${model ?? '?'} (${trimmed.length} chars → ${answer.length})`)
    return { answer, model }
  } catch (err) {
    logger.warn('fetch-sidecar', 'sumarização falhou — texto bruto:', err)
    return null
  }
}
