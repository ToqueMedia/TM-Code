/**
 * Cache local-first para o painel de Admin.
 *
 * O admin faz múltiplas chamadas ao control-plane (verify, personas, sidecars,
 * catálogo) logo no mount. Cada uma é um round-trip que bloqueia a renderização
 * — o utilizador entra no painel e vê "Loading…" durante 1-3s mesmo que já
 * tenha aberto o painel há minutos e os dados não tenham mudado.
 *
 * Este módulo implementa stale-while-revalidate para o admin:
 *  1. No mount, o componente lê o cache do localStorage SINCRONAMENTE e
 *     renderiza imediatamente (loading=false se o cache existe);
 *  2. Em paralelo, dispara o fetch do servidor em background;
 *  3. Quando o fetch completa, o componente actualiza o state e este módulo
 *     grava o resultado fresco no localStorage para a próxima vez.
 *
 * Não é a fonte de verdade — é uma camada de perceived-performance. O servidor
 * continua autoritativo; o cache só evita o "Loading…" inicial quando já
 * temos dados válidos de uma visita anterior.
 */

const CACHE_PREFIX = 'tm.admin.cache.'

interface CacheEntry<T> {
  data: T
  timestamp: number
}

/**
 * Lê uma chave do cache de admin. Retorna null se a chave não existe, se o
 * JSON está corrompido ou se o browser bloqueou o localStorage (modo privado).
 * É síncrono — feita para ser usada no initializer do useState.
 */
export function readAdminCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key)
    if (!raw) return null
    const entry = JSON.parse(raw) as CacheEntry<T>
    if (!entry || typeof entry.timestamp !== 'number') return null
    return entry.data
  } catch {
    return null
  }
}

/**
 * Escreve uma entrada no cache de admin. Best-effort: falha silenciosamente
 * em modo privado ou quando a quota do localStorage está esgotada (o cache
 * é uma optimização, não uma dependência).
 */
export function writeAdminCache<T>(key: string, data: T): void {
  try {
    const entry: CacheEntry<T> = { data, timestamp: Date.now() }
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entry))
  } catch {
    // Quota excedida ou modo privado — o cache é best-effort.
  }
}

/**
 * Remove uma chave do cache de admin (quando um publish invalida os dados
 * locais, por exemplo). Best-effort.
 */
export function clearAdminCache(key: string): void {
  try {
    localStorage.removeItem(CACHE_PREFIX + key)
  } catch {
    // Modo privado — ignorar.
  }
}

// ─── Chaves de cache (uma por endpoint) ──────────────────────────────────
// Centralizar as chaves evita typos e garante que o componente que lê e o
// que escreve usam a mesma string.

export const ADMIN_CACHE_KEYS = {
  verify: 'verify',
  personas: 'personas',
  sidecars: 'sidecars',
  modelCatalog: 'modelCatalog',
  sidecarCatalog: 'sidecarCatalog',
} as const
