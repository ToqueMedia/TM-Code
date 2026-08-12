/**
 * Global Tool-Result Budget — caps the TOTAL tool-result tokens sent to the
 * provider in a single request, compacting OLDER results with a structured
 * summary instead of the full body.
 *
 * WHY
 * ───
 * The agent loop (`query.ts`) accumulates `assistantMessage + toolResultMessage`
 * every turn and re-sends the full history on the next request. Tool results
 * (file reads, command output, search hits) that were useful 6 turns ago are
 * still billed as input tokens on every subsequent turn — even though the model
 * rarely needs the exact body again. The per-message `applyToolResultBudget`
 * (200K chars) and `microcompact` (clears to a flat "[cleared]" string) are
 * coarse: one never limits the cross-message total, the other throws away ALL
 * identifying info (tool name, path, size, hash) so the model can't decide
 * whether a re-read is worth it.
 *
 * This module sits in the pipeline right before `toOpenAIMessages`. It:
 *   1. Collects every tool_result block across all messages, paired with the
 *      tool_call that produced it (for name + args → path/command extraction).
 *   2. Under the global budget (40K tokens) it compacts NOTHING — the model
 *      keeps its full working set. The budget is a real gate, not a pretext:
 *      the original version compacted everything older than the last 4
 *      results UNCONDITIONALLY, which starved multi-file tasks (the model's
 *      working set was hardcoded to 4 tool results) and forced a re-read →
 *      dedup-stub → force:true dance costing 1–2 full round-trips per file
 *      (root-cause analysis, 2026-07-13).
 *   3. Over budget, replaces the CONTENT of the OLDEST results first — never
 *      the `keepRecent` most recent ones — with a compact structured block,
 *      only until the total is back under budget:
 *        [tool-result-summary]
 *        tool: read_file | path: /foo/bar.ts offset: 1 limit: 50
 *        original: 15234 chars (~5078 tokens) | hash: a1b2c3d4
 *        preview (first 800 chars):
 *        <…first 800 chars…>
 *        [re-read via read_file(path) or read_large_result(refId) if needed]
 *   4. If the total STILL exceeds the budget after all old results are
 *      compacted, compacts progressively older "recent" results — but NEVER
 *      the single most recent one (the model needs it to continue the
 *      current step).
 *
 *   The re-read hint in the summary is honoured downstream: query.ts records
 *   which tool_results were sent compacted (toolResultVisibility registry),
 *   and the read-dedup layers serve content directly — no stub, no force —
 *   for anything this module evicted.
 *
 * CRITICAL — what this does NOT do
 * ───────────────────────────────
 *   - Does NOT remove tool_result blocks or messages. Only replaces `content`.
 *     The tool_call / tool_result pairing the provider requires stays intact.
 *   - Does NOT touch the most recent result (the one the model just received).
 *   - Does NOT compact results whose source path is in `pinnedPaths` (files the
 *     user @-mentioned or that were just edited — the model needs full context
 *     for those until the task moves on).
 *   - Does NOT lose access to the full body: the structured block tells the
 *     model exactly how to re-fetch it (read_file, read_large_result, search).
 */

import type { ContentBlockAPI } from '../../types/chat'
import { GREP_ALIAS, READ_ALIAS, canonicalToolName, normalizeToolInputForCanonical } from './toolNames'
import { VITE_TOOL_RESULT_BUDGET_MODE, VITE_TOOL_RESULT_BUDGET_TRIGGER_PCT } from '../../utils/viteEnv'

// ── QUANDO o orçamento corre (os três braços da experiência) ──

/**
 * Os três regimes possíveis para o orçamento de tool results.
 *
 * PORQUÊ ISTO EXISTE (2026-08-07)
 * ───────────────────────────────
 * Está MEDIDO que o orçamento é a causa das releituras — no caso
 * `context-loss-rereads`, 5 dos 8 ficheiros foram relidos com ele, 2 sem ele.
 * E está igualmente medido que TIRÁ-LO piorou o resultado (2/3 correctos → 1/3):
 * sem nada a aparar tool results, o prompt cresce até compactar, e a
 * compactação é mais destrutiva que limpar resultados antigos. Troca-se
 * "releio cinco ficheiros" por "tenho uma narrativa da conversa".
 *
 * A hipótese por bater é o meio-termo, e é isso que `trigger` é: manter o
 * orçamento, mas só o accionar quando a ocupação REAL se aproxima do limiar de
 * compactação — em vez de a cada pedido, por os tool results sozinhos passarem
 * 30% da janela. A previsão é ficar com as releituras baixas do braço `off`
 * sem a compactação precoce que o afundou.
 *
 * Nenhum destes braços é opinião: são para correr `yarn evals:agent --only
 * context-loss-rereads` com n ≥ 10 e comparar. O defeito continua `always`
 * (o comportamento que já está em produção) até haver números — ver docs/
 * PLAN-CONTEXT-BUDGET.md, "O que NÃO fazer".
 */
export type ToolResultBudgetMode =
  /** Avalia-se em TODOS os pedidos. */
  | 'always'
  /** Só quando a ocupação se aproxima do limiar de compactação. */
  | 'trigger'
  /** DEFEITO: nunca. Modelo cli-vaz — a compactação é a única válvula. */
  | 'off'

/**
 * DEFEITO: `off` — não se microcompacta (decisão do produto, 2026-08-07).
 *
 * PORQUÊ, e porque é que a medição desta sessão NÃO o contradiz
 * ────────────────────────────────────────────────────────────
 * A matriz de 07-08 deu vantagem ao `always` (10/10 contra 6/10 e 1/3). Mas
 * essa medição correu com uma janela EFECTIVA pequena: com os 1M que as
 * personas declaram (`PERSONA_*_CONFIG_JSON.contextWindow`), o orçamento seria
 * `min(980K × 30%, 250K)` = 250.000 tokens, e a fixture de oito ficheiros
 * (~80K de tool results) **nunca lá chegaria** — `always` e `off` seriam o
 * mesmo braço. O que a matriz mediu foi o regime de janela apertada, não o de
 * produção.
 *
 * O critério passa a ser o do cli-vaz e assenta na mesma premissa: com janela
 * grande, o limiar de compactação está longe e aparar a cada pedido só serve
 * para reescrever o prefixo, partir a cache e obrigar o modelo a reler o que
 * já tinha. A janela é gerida pelo admin e é grande por decisão, não por sorte.
 *
 * A válvula que resta é a auto-compactação — exactamente como no cli-vaz.
 * `always` e `trigger` continuam disponíveis por knob: se algum dia for
 * publicado um modelo de janela pequena, o aparo volta a fazer sentido e o
 * braço já está escrito e medido.
 */
export const DEFAULT_TOOL_RESULT_BUDGET_MODE: ToolResultBudgetMode = 'off'

/**
 * A que fracção do limiar de auto-compactação o modo `trigger` acorda.
 *
 * 0,75 e não 1,0 por causa de um desfasamento real: a ocupação ancora no
 * `prompt_tokens` do turno ANTERIOR, portanto os tool results produzidos no
 * turno corrente ainda não estão contados. Acordar em cima do limiar chegaria
 * tarde de mais para evitar a compactação — que é a única coisa que o braço C
 * existe para evitar.
 */
export const TOOL_RESULT_BUDGET_TRIGGER_RATIO = 0.75

const VALID_MODES: ReadonlySet<string> = new Set<ToolResultBudgetMode>(['always', 'trigger', 'off'])

/**
 * Override de RUNTIME, posto pelo runner headless a partir dos `knobs` do job
 * (`TM_RUN_KNOB_BUDGET_MODE`, `TM_RUN_KNOB_BUDGET_TRIGGER_PCT`).
 *
 * Manda sobre a env de build. PORQUÊ (2026-08-07): a env do vite é de BUILD e
 * amarra a corrida ao processo que a serve — um vite já vivo não a ganha, e a
 * corrida mede a árvore errada sem o dizer. Os `knobs` viajam por processo,
 * portanto o mesmo vite serve braços diferentes. A env de build fica como
 * recurso, para quem queira exercitar isto fora do runner.
 */
let overrideMode: ToolResultBudgetMode | null = null
let overrideTriggerRatio: number | null = null

/** Chamado só pelo runner headless. Valores inválidos são ignorados. */
export function setToolResultBudgetOverrides(knobs: {
  mode?: string
  triggerPct?: string
}): void {
  const m = knobs.mode?.trim().toLowerCase()
  if (m && VALID_MODES.has(m)) overrideMode = m as ToolResultBudgetMode
  const pct = knobs.triggerPct ? parseFloat(knobs.triggerPct) : NaN
  if (Number.isFinite(pct) && pct > 0 && pct <= 100) overrideTriggerRatio = pct / 100
}

/** Limpa os overrides — usado pelos testes. */
export function clearToolResultBudgetOverrides(): void {
  overrideMode = null
  overrideTriggerRatio = null
}

/**
 * Braço activo: override de runtime → env de BUILD → defeito. Valor ausente ou
 * desconhecido → `always`: um override mal escrito não pode DESLIGAR o
 * orçamento em silêncio (o prompt ficaria sem tecto nenhum), tal como o
 * override do limiar de compactação só encurta e nunca adia.
 */
export function resolveToolResultBudgetMode(): ToolResultBudgetMode {
  if (overrideMode) return overrideMode
  const raw = VITE_TOOL_RESULT_BUDGET_MODE?.trim().toLowerCase()
  return raw && VALID_MODES.has(raw)
    ? (raw as ToolResultBudgetMode)
    : DEFAULT_TOOL_RESULT_BUDGET_MODE
}

/** Fracção do limiar em que o modo `trigger` acorda; override em (0, 100]. */
export function resolveToolResultBudgetTriggerRatio(): number {
  if (overrideTriggerRatio !== null) return overrideTriggerRatio
  const pct = VITE_TOOL_RESULT_BUDGET_TRIGGER_PCT
    ? parseFloat(VITE_TOOL_RESULT_BUDGET_TRIGGER_PCT)
    : NaN
  return Number.isFinite(pct) && pct > 0 && pct <= 100
    ? pct / 100
    : TOOL_RESULT_BUDGET_TRIGGER_RATIO
}

export interface BudgetGateInput {
  mode: ToolResultBudgetMode
  /** Ocupação resolvida (real ancorado + estimativa do que veio depois). */
  occupancyTokens?: number | null
  /** Limiar a que a auto-compactação dispara, para o mesmo modelo activo. */
  autoCompactThreshold?: number | null
  /** Defeito: TOOL_RESULT_BUDGET_TRIGGER_RATIO. */
  triggerRatio?: number
}

/**
 * Decide se o orçamento corre NESTE pedido. Pura, para o portão ser testável
 * sem montar um loop de agente.
 *
 * O ramo de incerteza inclina para APLICAR: sem ocupação ou sem limiar
 * (turno 1 pré-handshake, modelo sem janela publicada) o modo `trigger`
 * comporta-se como `always`. A alternativa — não aparar por não se conseguir
 * medir a pressão — é a única que pode estourar a janela, e o custo de a
 * aplicar de mais é uma releitura.
 */
export function shouldApplyToolResultBudget(input: BudgetGateInput): boolean {
  if (input.mode === 'off') return false
  if (input.mode === 'always') return true

  const occupancy = input.occupancyTokens
  const threshold = input.autoCompactThreshold
  if (typeof occupancy !== 'number' || occupancy <= 0) return true
  if (typeof threshold !== 'number' || threshold <= 0) return true

  const ratio = input.triggerRatio ?? TOOL_RESULT_BUDGET_TRIGGER_RATIO
  return occupancy >= Math.floor(threshold * ratio)
}

// ── Constants ──

/**
 * Orçamento por omissão — usado SÓ quando a janela real é desconhecida (turno 1
 * pré-handshake, modelo sem perfil). O valor a sério vem de
 * `getToolResultBudgetTokens(janela)` em utils/contextWindow.ts e segue a janela
 * publicada pelo admin: era esta constante fixa a última peça da gestão de
 * contexto que ignorava se o modelo tinha 128K ou 1M.
 */
export const GLOBAL_TOOL_RESULT_BUDGET_TOKENS = 40_000

/** Number of most-recent tool results kept COMPLETE (never compacted). */
export const DEFAULT_KEEP_RECENT = 4

/**
 * Marca de água BAIXA: uma vez ultrapassado o budget, evicta-se até AQUI, não
 * até um fio abaixo do teto.
 *
 * PORQUÊ (medido 2026-07-31)
 * ──────────────────────────
 * Evictar o mínimo indispensável significa voltar a cruzar o teto no turno
 * seguinte, e no seguinte, e no seguinte: uma reescrita do histórico POR TURNO,
 * sempre perto da cabeça do array. Todos os providers que temos fazem cache por
 * PREFIXO — a primeira mudança de bytes invalida tudo o que vem depois. Reescrever
 * o bloco mais antigo a cada pedido é, na prática, garantir 0% de cache num
 * histórico longo (sessão katondo-queue, 29-07: 12,36M tokens de input, valor
 * cacheado parado em 31.808 desde o turno 11).
 *
 * É esta a resposta portável ao "microcompact com edição de cache" do claude-vaz:
 * não temos a API para apagar de dentro do prefixo cacheado, mas podemos deixar
 * de lhe mexer. Com a banda de histerese a evicção passa de todos os turnos para
 * um em cada N — e como se evicta do mais ANTIGO para o mais recente, a cabeça
 * do histórico estabiliza de vez e o prefixo que sobrevive vai crescendo.
 *
 * O custo é evictar mais working set de cada vez. `keepRecent` continua a
 * proteger o que o modelo tem em mãos.
 */
export const BUDGET_LOW_WATER_RATIO = 0.7

/** Preview chars included in the compact summary. */
const SUMMARY_PREVIEW_CHARS = 800

/**
 * Cabeçalho do bloco de substituição. Serve de MARCA: um resultado que já o tem
 * não volta a ser compactado.
 *
 * Sem esta marca a compactação não era idempotente — cada turno embrulhava o
 * sumário anterior num sumário novo. Medido com uma sonda: ao turno 7 o
 * resultado mais antigo tinha SETE camadas de `[tool-result-summary]`, o preview
 * mostrava o cabeçalho da camada anterior em vez do ficheiro, e o total
 * ULTRAPASSAVA o budget (3303 → 6247 tokens com teto de 5000) porque cada volta
 * ACRESCENTAVA bytes em vez de os tirar. A dica de releitura continuava lá, mas
 * já não havia conteúdo nenhum por baixo para reler.
 */
const SUMMARY_MARKER = '[tool-result-summary]'

/** Um resultado já substituído por um sumário estruturado. */
function isAlreadyCompacted(content: string): boolean {
  return content.startsWith(SUMMARY_MARKER)
}

// ── Token estimate (matches compact/autoCompact.ts) ──
function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 3)
}

// ── FNV-1a 32-bit hash (same as payloadInspector) ──
function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// ── Types ──

interface MessageLike {
  role: 'user' | 'assistant'
  content: string | ContentBlockAPI[] | null
}

interface ToolCallInfo {
  name: string
  args: Record<string, unknown>
}

interface CollectedToolResult {
  /** Index in the messages array. */
  messageIndex: number
  /** Index within the content array of that message. */
  blockIndex: number
  toolCallId: string
  content: string
  tokens: number
  /** Paired tool info (may be undefined if the tool_call was compacted away). */
  toolName?: string
  toolArgs?: Record<string, unknown>
}

export interface GlobalBudgetResult {
  messages: MessageLike[]
  compactedCount: number
  tokensBefore: number
  tokensAfter: number
}

export interface GlobalBudgetOptions {
  /** Max combined tool-result tokens. Default: 40_000. */
  budgetTokens?: number
  /** Recent results kept complete. Default: 4. */
  keepRecent?: number
  /** File paths that must NOT be compacted (user-mentioned or just-edited). */
  pinnedPaths?: Set<string>
}

// ── Helpers ──

/** Extract a path/identifier from tool args, for the compact summary. */
function extractContextFromArgs(
  toolName: string | undefined,
  args: Record<string, unknown> | undefined,
): string {
  if (!toolName || !args) return ''
  args = normalizeToolInputForCanonical(toolName, args)
  toolName = canonicalToolName(toolName)
  switch (toolName) {
    case 'read_file':
    case 'edit_file':
    case 'write_file':
    case 'create_file':
    case 'delete_file': {
      const path = (args.file_path ?? args.oldPath) as string | undefined
      if (!path) return ''
      let ctx = `path: ${path}`
      if (args.offset) ctx += ` offset: ${args.offset}`
      if (args.limit) ctx += ` limit: ${args.limit}`
      return ctx
    }
    case 'execute_command':
    case 'execute_command_background': {
      const cmd = args.command as string | undefined
      return cmd ? `command: ${cmd.length > 120 ? cmd.slice(0, 117) + '...' : cmd}` : ''
    }
    case 'search_files': {
      const q = args.query as string | undefined
      const dir = args.directory as string | undefined
      let ctx = ''
      if (q) ctx += `query: "${q.length > 60 ? q.slice(0, 57) + '...' : q}"`
      if (dir) ctx += ` in: ${dir}`
      return ctx
    }
    case 'glob': {
      const pat = args.pattern as string | undefined
      return pat ? `pattern: ${pat}` : ''
    }
    case 'list_directory': {
      const p = args.file_path as string | undefined
      return p ? `dir: ${p}` : ''
    }
    default:
      return ''
  }
}

/** Build the compact structured replacement for a tool_result's content. */
function buildCompactSummary(
  original: string,
  toolName: string | undefined,
  toolArgs: Record<string, unknown> | undefined,
): string {
  const canonicalName = toolName ? canonicalToolName(toolName) : undefined
  const canonicalArgs = toolName && toolArgs
    ? normalizeToolInputForCanonical(toolName, toolArgs)
    : toolArgs
  const chars = original.length
  const tokens = roughTokenEstimate(original)
  const hash = fnv1aHex(original)
  const context = extractContextFromArgs(toolName, toolArgs)

  const previewEnd = Math.min(SUMMARY_PREVIEW_CHARS, chars)
  const preview = original.slice(0, previewEnd)

  // Tell the model HOW to re-fetch the full content based on the tool type.
  let reReadHint: string
  if (canonicalName === 'read_file') {
    const path = (canonicalArgs?.file_path as string | undefined) ?? ''
    reReadHint = path
      ? `Re-read via ${READ_ALIAS} on "${path}" — optionally with offset/limit for a specific range.`
      : `Re-read via ${READ_ALIAS} if needed.`
  } else if (canonicalName === 'search_files') {
    reReadHint = `Re-run ${GREP_ALIAS} with a narrower pattern or includePatterns if needed.`
  } else if (canonicalName === 'execute_command' || canonicalName === 'execute_command_background') {
    reReadHint = 'Re-run the command if you need the full output; errors are preserved in this summary.'
  } else if (canonicalName === 'read_large_result') {
    const id = (canonicalArgs?.id as string | undefined) ?? ''
    reReadHint = id
      ? `Re-read via read_large_result("${id}", offset: 0) for the full content.`
      : 'Re-read via read_large_result(id) if needed.'
  } else {
    reReadHint = 'Re-invoke the tool if you need the full output.'
  }

  const lines: string[] = [
    SUMMARY_MARKER,
    `tool: ${toolName ?? 'unknown'}${canonicalName && canonicalName !== toolName ? ` (${canonicalName})` : ''}${context ? ` | ${context}` : ''} | original: ${chars} chars (~${tokens} tokens) | hash: ${hash}`,
  ]
  if (chars > 0) {
    lines.push(`preview (first ${previewEnd} chars):`, preview)
  }
  lines.push(
    `[end summary — full content compacted to stay under the global tool-result budget. ${reReadHint}]`,
  )
  return lines.join('\n')
}

/**
 * Walk messages, collect every tool_result block (in order), and pair each
 * with its tool_call (via toolCallId) for name + args extraction.
 */
function collectToolResults(messages: MessageLike[]): CollectedToolResult[] {
  // First pass: build toolCallId → { name, args } map from assistant messages.
  const callInfoMap = new Map<string, ToolCallInfo>()
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const block of msg.content as ContentBlockAPI[]) {
      if (block.type === 'tool_call') {
        let args: Record<string, unknown> = {}
        const rawArgs = (block as { arguments?: string }).arguments
        if (rawArgs) {
          try {
            args = JSON.parse(rawArgs) as Record<string, unknown>
          } catch {
            // leave args as empty object
          }
        }
        callInfoMap.set(block.id, { name: block.name, args })
      }
    }
  }

  // Second pass: collect tool_result blocks in message order.
  const results: CollectedToolResult[] = []
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    const blocks = msg.content as ContentBlockAPI[]
    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi]
      if (block.type !== 'tool_result') continue
      const content = typeof block.content === 'string' ? block.content : ''
      const info = callInfoMap.get(block.toolCallId)
      results.push({
        messageIndex: mi,
        blockIndex: bi,
        toolCallId: block.toolCallId,
        content,
        tokens: roughTokenEstimate(content),
        toolName: info?.name,
        toolArgs: info?.args,
      })
    }
  }
  return results
}

/**
 * Check whether a tool_result's source path is in the pinned set.
 */
function isPinned(tr: CollectedToolResult, pinnedPaths: Set<string>): boolean {
  if (pinnedPaths.size === 0) return false
  const path = (tr.toolArgs?.file_path ?? tr.toolArgs?.oldPath) as string | undefined
  return !!path && pinnedPaths.has(path)
}

// ── Core ──

/**
 * Apply the global tool-result budget to a message array.
 *
 * Compacts the CONTENT of older tool_result blocks (never removes blocks or
 * messages). Keeps the N most recent complete. If the total still exceeds the
 * budget, compacts progressively older "recent" results — but never the single
 * most recent one.
 *
 * @returns New message array (or the same if nothing changed) + stats.
 */
export function applyGlobalToolResultBudget(
  messages: MessageLike[],
  options?: GlobalBudgetOptions,
): GlobalBudgetResult {
  const budget = options?.budgetTokens ?? GLOBAL_TOOL_RESULT_BUDGET_TOKENS
  const keepRecent = options?.keepRecent ?? DEFAULT_KEEP_RECENT
  const pinnedPaths = options?.pinnedPaths ?? new Set<string>()

  const allResults = collectToolResults(messages)

  // Nothing to do if there are 0 or 1 tool results.
  if (allResults.length <= 1) {
    const totalTokens = allResults.reduce((s, r) => s + r.tokens, 0)
    return { messages, compactedCount: 0, tokensBefore: totalTokens, tokensAfter: totalTokens }
  }

  const tokensBefore = allResults.reduce((s, r) => s + r.tokens, 0)

  // Under budget → compact NOTHING. The budget is the gate, not a pretext:
  // eviction below this line exists to protect the context window and the
  // per-request bill, not to minimise at all costs. Keeping the working set
  // intact is what lets the agent decide its next step without re-reading.
  //
  // O teto é a marca de água ALTA; passada, evicta-se até `target` (a baixa).
  // Ver BUDGET_LOW_WATER_RATIO: é o que transforma "reescrever o histórico
  // todos os turnos" em "reescrever um turno em cada N", que é o mais perto do
  // microcompact-com-edição-de-cache a que se chega sem a API para isso.
  if (tokensBefore <= budget) {
    return { messages, compactedCount: 0, tokensBefore, tokensAfter: tokensBefore }
  }
  const target = Math.floor(budget * BUDGET_LOW_WATER_RATIO)

  // The most recent result (last in array) is ALWAYS kept complete — the model
  // just received it and needs it to continue the current step.
  const recentCount = Math.min(keepRecent, allResults.length)
  const recentSet = new Set(
    allResults.slice(-recentCount).map(r => `${r.messageIndex}:${r.blockIndex}`),
  )

  // Build the compact-candidate list: older results that are NOT recent, NOT
  // pinned e NÃO compactados. Um resultado já compactado é bytes estáveis que
  // valem cache — tocar-lhe outra vez custa o prefixo inteiro e não liberta
  // nada (o sumário já é pequeno). Ordered oldest-first.
  const compactCandidates = allResults.filter(
    r =>
      !recentSet.has(`${r.messageIndex}:${r.blockIndex}`) &&
      !isPinned(r, pinnedPaths) &&
      !isAlreadyCompacted(r.content),
  )

  // Set of results to compact (messageIndex:blockIndex keys).
  const toCompact = new Set<string>()

  // Phase 1: over budget — evict OLDEST-first até à marca BAIXA. Results the
  // model is still working with survive as long as the budget allows, instead
  // of being unconditionally destroyed.
  let projected = tokensBefore
  for (const r of compactCandidates) {
    if (projected <= target) break
    toCompact.add(`${r.messageIndex}:${r.blockIndex}`)
    // Approximate the compact summary size: ~1000 chars (header + 800 preview + footer).
    projected = projected - r.tokens
      + roughTokenEstimate(buildCompactSummary(r.content, r.toolName, r.toolArgs))
  }

  // Phase 2: if still over the HIGH mark, compact progressively older "recent"
  // results (from the oldest recent toward the newest), but NEVER the single
  // most recent. Aqui o alvo é o teto, não a marca baixa: já se está a comer o
  // working set imediato do modelo, portanto tira-se o mínimo.
  if (projected > budget && recentCount > 1) {
    // recentResults ordered oldest-first, excluding the very last (most recent).
    const recentResults = allResults.slice(-recentCount, -1)
    for (const r of recentResults) {
      if (projected <= budget) break
      if (isPinned(r, pinnedPaths) || isAlreadyCompacted(r.content)) continue
      toCompact.add(`${r.messageIndex}:${r.blockIndex}`)
      // Recalculate: this result goes from full tokens to summary tokens.
      const summaryTokens = roughTokenEstimate(buildCompactSummary(r.content, r.toolName, r.toolArgs))
      projected = projected - r.tokens + summaryTokens
    }
  }

  if (toCompact.size === 0) {
    return { messages, compactedCount: 0, tokensBefore, tokensAfter: tokensBefore }
  }

  // Apply compaction: build new messages with compacted content blocks.
  let compactedCount = 0
  const newMessages = messages.map((msg, mi) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg
    const blocks = msg.content as ContentBlockAPI[]
    let touched = false
    const newBlocks = blocks.map((block, bi) => {
      if (
        block.type === 'tool_result' &&
        toCompact.has(`${mi}:${bi}`)
      ) {
        touched = true
        compactedCount++
        // Find the collected result for this block to get tool name + args.
        const collected = allResults.find(r => r.messageIndex === mi && r.blockIndex === bi)
        const summary = buildCompactSummary(
          typeof block.content === 'string' ? block.content : '',
          collected?.toolName,
          collected?.toolArgs,
        )
        return { ...block, content: summary }
      }
      return block
    })
    return touched ? { ...msg, content: newBlocks } : msg
  })

  // Final token count
  let tokensAfter = 0
  for (const r of allResults) {
    if (toCompact.has(`${r.messageIndex}:${r.blockIndex}`)) {
      tokensAfter += roughTokenEstimate(buildCompactSummary(r.content, r.toolName, r.toolArgs))
    } else {
      tokensAfter += r.tokens
    }
  }

  return { messages: newMessages, compactedCount, tokensBefore, tokensAfter }
}
