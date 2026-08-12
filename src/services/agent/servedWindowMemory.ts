/**
 * Memória da janela servida, por CONFIG (provider + modelo) — não por modelo.
 *
 * PORQUE EXISTE (2026-08-10)
 * ──────────────────────────
 * `MODEL_PROFILES` é indexado pelo id do modelo, mas o mesmo modelo é servido
 * por vários provedores com janelas diferentes: o `glm-5.2` vem do z.AI, do
 * DashScope e — desde agora — do Cloudflare Workers AI, que dá 262.144. Um
 * único `contextWindow` no perfil não pode ser verdade para os três.
 *
 * A verdade viva é o header `X-Model-Context-Window`, mas ele só chega DEPOIS
 * da primeira resposta. Até lá o resolver caía no perfil por modelo e, no caso
 * do Cloudflare, calculava um limiar de 931.000 onde o correcto é 229.144 — o
 * portão de envio do composer deixava passar um prompt que só podia voltar em
 * `prompt_too_long`. É o mesmo defeito que já mordeu três vezes nesta base de
 * código: uma capacidade presa a um literal indexado pela dimensão errada.
 *
 * Isto guarda o que o servidor JÁ DISSE sobre cada config e devolve-o no
 * arranque seguinte. Fica ABAIXO da persona na cadeia de resolução: a persona
 * é o que o admin publica AGORA (e pode reflectir uma troca de provedor),
 * enquanto isto é histórico. E fica ACIMA do perfil, porque um valor medido
 * para esta config exacta vale mais que uma tabela por nome de modelo.
 *
 * Best-effort: falhas de storage nunca propagam — sem memória volta-se
 * exactamente ao comportamento anterior.
 */

const STORAGE_KEY = 'tm.servedWindowMemory.v1'
/** Tecto de entradas: o catálogo é pequeno e isto não é uma cache quente. */
const MAX_ENTRIES = 50

export interface ServedWindowEntry {
  contextWindow: number | null
  maxOutputTokens: number | null
  seenAt: number
}

type Store = Record<string, ServedWindowEntry>

/**
 * Chave da config. `provider` pode faltar (nem toda a resposta o declara) —
 * nesse caso o modelo sozinho é melhor que nada, e os ids do Cloudflare já
 * trazem o autor no nome (`@cf/zai-org/glm-5.2`), portanto não colidem com o
 * `glm-5.2` do z.AI.
 */
export function servedWindowKey(provider: string | null | undefined, model: string | null | undefined): string | null {
  const m = (model ?? '').trim().toLowerCase()
  if (!m) return null
  const p = (provider ?? '').trim().toLowerCase()
  return p ? `${p}:${m}` : m
}

/**
 * Cache em memória do que está no storage.
 *
 * `recallServedWindow` é chamado no CORPO DO RENDER do pill de contexto, que
 * re-renderiza durante o streaming — sem isto era um `localStorage.getItem` +
 * `JSON.parse` síncronos na main thread por render. O mesmo tipo de custo que
 * esta ronda passou a eliminar; escrevê-lo aqui por descuido seria irónico.
 *
 * Esta é a ÚNICA porta de escrita, logo a cache não pode ficar obsoleta por
 * outra via dentro do processo. Uma janela irmã a escrever a sua não é
 * problema: cada processo aprende a sua no primeiro header que receber.
 */
let cache: Store | null = null

function read(): Store {
  if (cache) return cache
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) { cache = {}; return cache }
    const parsed = JSON.parse(raw)
    cache = parsed && typeof parsed === 'object' ? (parsed as Store) : {}
  } catch {
    cache = {}
  }
  return cache
}

function write(store: Store): void {
  cache = store
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    /* storage cheio ou indisponível — a memória é um luxo, não um requisito */
  }
}

/** Grava o que o servidor declarou para esta config. No-op sem modelo. */
export function rememberServedWindow(
  provider: string | null | undefined,
  model: string | null | undefined,
  contextWindow: number | null | undefined,
  maxOutputTokens: number | null | undefined,
): void {
  const key = servedWindowKey(provider, model)
  if (!key) return
  // `undefined` = o header não veio nesta resposta → não toca no que já sabemos.
  if (contextWindow === undefined && maxOutputTokens === undefined) return

  const store = read()
  const prev = store[key]
  const next: ServedWindowEntry = {
    contextWindow: contextWindow === undefined ? (prev?.contextWindow ?? null) : contextWindow,
    maxOutputTokens: maxOutputTokens === undefined ? (prev?.maxOutputTokens ?? null) : maxOutputTokens,
    seenAt: Date.now(),
  }
  if (
    prev
    && prev.contextWindow === next.contextWindow
    && prev.maxOutputTokens === next.maxOutputTokens
  ) {
    return // nada mudou: poupa uma escrita por turno
  }

  store[key] = next

  const keys = Object.keys(store)
  if (keys.length > MAX_ENTRIES) {
    // Evicção pelo mais antigo — o catálogo é pequeno, isto quase nunca corre.
    keys
      .sort((a, b) => (store[a].seenAt ?? 0) - (store[b].seenAt ?? 0))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach(k => { delete store[k] })
  }
  write(store)
}

/** O que sabemos desta config, ou null. */
export function recallServedWindow(
  provider: string | null | undefined,
  model: string | null | undefined,
): ServedWindowEntry | null {
  const key = servedWindowKey(provider, model)
  if (!key) return null
  return read()[key] ?? null
}

/** Só para testes — limpa a memória. */
export function clearServedWindowMemory(): void {
  cache = null
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
