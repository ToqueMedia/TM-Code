/**
 * Read Range Tracker — que intervalos de que ficheiros foram lidos neste run.
 *
 * O QUE ISTO FOI E O QUE É AGORA
 * ──────────────────────────────
 * Nasceu como dedup de intervalos SOBREPOSTOS: se o modelo já tinha lido as
 * linhas 1-200 e pedia 1-100, a leitura era servida com um stub; se pedia
 * 150-300, o pedido era ESTREITADO em silêncio para a parte que faltava.
 *
 * Essa parte foi REMOVIDA em 2026-07-29, com o resto da supressão de
 * releituras, por paridade com o claude-vaz (cujo Read devolve sempre o que foi
 * pedido) e por causa medida: na sessão katondo-queue foram 175 read_file em
 * 127 turnos, 12,36M tokens de input e a tarefa por acabar, porque o stub
 * afirmava que o conteúdo estava na conversa quando já não estava e a saída
 * documentada (`force: true`) era desaconselhada pela própria descrição. O
 * modelo respondia pedindo janelas cada vez menores, e cada contorno
 * acrescentava contexto.
 *
 * O código dessa dedup — `checkReadRangeOverlap`, os helpers de intervalos, os
 * contadores de sobreposição — ficou aqui sem chamadores durante a limpeza, com
 * textos de stub que instruíam o modelo a usar um `force` que já não existe no
 * schema. Foi apagado nesta auditoria: a estatística `getAndResetOverlapStats`
 * também saiu, porque só podia reportar zero e telemetria que não pode variar
 * mente sobre o que mede.
 *
 * O QUE FICA é o registo: quais intervalos foram lidos, para
 *   · `contextManager` sugerir releituras DEPOIS de uma compactação (aí o
 *     conteúdo saiu de facto do contexto e reler é o gesto certo);
 *   · o campo `readRanges` da telemetria de request-usage.
 *
 * Singleton de módulo (como o fsVersion), limpo no resetSessionState().
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface ReadRange {
  /** 1-based start line. `undefined`/0 treated as 1. */
  offset: number
  /**
   * Number of lines. `undefined` means read-to-EOF (end = +∞ for interval
   * math).
   */
  limit?: number
  /** Global fsVersion captured at read time. */
  fsVersion: number
  /** File mtime captured at read time when available. */
  modifiedMs?: number | null
  /**
   * toolCallId of the read that put this range in the model's context.
   * Overlap dedup only counts ranges whose tool_result went INTACT in the
   * last provider request (toolResultVisibility) — a range whose content was
   * compacted away must not contribute to "already covered" stubs, or the
   * stub lies and forces a force:true round-trip.
   */
  toolCallId?: string
}

// ── Tracker (module-level singleton) ───────────────────────────────────

const byPath = new Map<string, ReadRange[]>()

/** Normalise a path for consistent keys (mirrors FileStateCache.normalizePath). */
function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (s.startsWith('./')) s = s.slice(2)
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/**
 * Record a range that was just read. Called AFTER a successful read_file
 * (the content is now in the model's context). Safe to call multiple times
 * for the same path — the tracker accumulates ranges.
 */
export function recordReadRange(
  filePath: string,
  offset: number | undefined,
  limit: number | undefined,
  fsVersion: number,
  modifiedMs?: number | null,
  toolCallId?: string,
): void {
  const key = normalizePath(filePath)
  const ranges = byPath.get(key) ?? []
  // Avoid storing exact-duplicate ranges (the exact dedup path already
  // handled those; no need to bloat the list). A duplicate range from a NEW
  // read (e.g. re-read after eviction) re-points the entry at the freshest
  // toolCallId — that's the tool_result that is now intact in context.
  const start = Math.max(1, offset ?? 1)
  const existing = ranges.find(
    (r) => r.offset === start && r.limit === limit && r.fsVersion === fsVersion && r.modifiedMs === modifiedMs,
  )
  if (existing) {
    if (toolCallId) existing.toolCallId = toolCallId
  } else {
    ranges.push({ offset: start, limit, fsVersion, modifiedMs, toolCallId })
    byPath.set(key, ranges)
  }
}

/** All recorded ranges, for the `readRanges` export field. Returns a shallow
 *  copy so the caller can't mutate internal state. */
export function getReadRanges(): Array<{ path: string; offset?: number; limit?: number; readToEnd?: boolean }> {
  const out: Array<{ path: string; offset?: number; limit?: number; readToEnd?: boolean }> = []
  for (const [path, ranges] of byPath) {
    for (const r of ranges) {
      out.push({ path, offset: r.offset, limit: r.limit, readToEnd: r.limit === undefined })
    }
  }
  return out
}

/** Clear all tracked ranges. Called on resetSessionState(). */
export function clearReadRangeTracker(): void {
  byPath.clear()
}
