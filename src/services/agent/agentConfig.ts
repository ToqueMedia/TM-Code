/**
 * Agent configuration constants — single source of truth for all tunables.
 *
 * SRP: this file changes ONLY when configuration values change.
 * All behavioural logic lives elsewhere.
 */

// ── Model / sampling ──

export const MAX_OUTPUT_TOKENS = 32_768
export const DEFAULT_MODEL = 'mimo-v2.5-pro-1m'
export const MIMO_CONTEXT_WINDOW = 1_000_000
export const DEFAULT_CONTEXT_WINDOW = 131_072 // Conservative fallback (128K)

// ── Loop control ──

/** Max auto-continuations when model hits token limit mid-response. */
export const MAX_CONTINUATIONS = 3

/** Max retries when the upstream→worker SSE drops mid-stream. */
export const MAX_INTERRUPT_RETRIES = 3
export const INTERRUPT_BACKOFF_BASE_MS = 500

/** Non-streaming fallback timeout (5 min — claude-vaz uses 300s). */
export const NON_STREAMING_TIMEOUT_MS = 300_000

/** Max retries for completion enforcement (dev-server errors, etc.). */
export const MAX_ENFORCEMENT_RETRIES = 3

// ── Stall detection ──

export const INITIAL_STALL_TIMEOUT_MS = 300_000  // 5 min — first token
export const STREAM_STALL_TIMEOUT_MS = 120_000   // 2 min — between events

// ── Loop detection ──

export const LOOP_DETECTION_THRESHOLD = 3
export const LOOP_SIMILARITY_MIN_LENGTH = 200
export const LOOP_SIMILARITY_RATIO = 0.7

/**
 * Repetições IDÊNTICAS de uma ronda de tool calls (mesmos nomes, mesmos args)
 * antes de o loop intervir. O detector de TEXTO acima nunca via isto: ele só
 * corre em turns SEM tool calls, e qualquer tool call fazia reset do estado —
 * portanto um modelo a repetir a mesma chamada falhada para sempre nunca
 * terminava (run momenu, 151 pedidos). Auditoria 2026-07-28.
 *
 * Nudge primeiro (o modelo costuma recuperar quando lhe dizem o que está a
 * fazer), stop só quando ignora o aviso o dobro das vezes.
 */
export const TOOL_LOOP_NUDGE_THRESHOLD = 3
export const TOOL_LOOP_STOP_THRESHOLD = 6

// ── Context compression ──

export const MIN_KEEP_RECENT_TURNS = 4
export const MAX_KEEP_RECENT_TURNS = 12
export const MAX_BACKPRESSURE_RETRIES = 2

// ── Microcompaction ──

export const MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 8
export const MICROCOMPACT_KEEP_RECENT_DENSE = 16
export const MICROCOMPACT_GAP_THRESHOLD_MS = 60 * 60 * 1000 // 60 min (cache TTL)
export const MICROCOMPACT_GAP_KEEP_RECENT = 5

// ── Post-compaction recovery ──

export const POST_COMPACTION_REREAD_FILES = 5
export const POST_COMPACTION_FILE_MAX_CHARS = 8000
export const POST_COMPACTION_REREAD_RANGES = 12
export const POST_COMPACTION_RANGES_PER_FILE = 4
export const POST_COMPACTION_RANGE_MAX_LINES = 160

/**
 * Teto do bloco INTEIRO de recuperação pós-compactação (~16K tokens).
 *
 * Os tectos por parte (5 ficheiros × 8000 chars, skills 100K chars) somam pior
 * caso ~140K caracteres — injetados logo a seguir a uma compactação que existiu
 * precisamente para libertar espaço, e por cima dos 3 turnos recentes que o
 * compactNow preserva. Sem um teto global a recuperação podia voltar a cruzar
 * o limiar e disparar outra compactação no turno seguinte.
 *
 * As partes são acrescentadas por ordem de valor (skills → ficheiros → log de
 * operações); a primeira que não cabe corta o resto, e o bloco diz ao modelo o
 * que ficou de fora para ele reler em vez de assumir.
 */
export const POST_COMPACTION_RECOVERY_MAX_CHARS = 60_000

// ── Reminder re-injection ──

export const REMINDER_REINJECT_INTERVAL_TURNS = 5
export const REMINDER_REINJECT_MIN_TOOLS = 10

// ── BYOK thinking ──

export const BYOK_THINKING_BUDGET_TOKENS = 8_192

// ── Summarization ──

// 240s, não 90s: a compactação é NÃO-streaming (contextManager) — os headers
// só chegam quando o resumo inteiro está gerado, e com transcript grande +
// modelo com thinking (Vertex Gemini) 90s não chegavam (timeouts vistos em
// produção 2026-06-12). Tem de ficar ABAIXO do timeout não-streaming do
// worker (300s, UPSTREAM_NONSTREAM_HEADER_TIMEOUT_MS) para o erro local
// limpo chegar antes do 504 do worker.
export const SUMMARIZE_TIMEOUT_MS = 240_000

// ── API retry ──

export const API_MAX_RETRIES = 3
export const API_RETRY_DELAYS = [3000, 5000, 10000]
export const API_CF520_DELAYS = [10000, 20000, 30000]
export const API_RATE_LIMIT_DELAY = 20000

// ── Orçamento de descrições MCP ──
//
// As descrições de ferramentas MCP são texto de TERCEIROS que entra em TODOS
// os pedidos: em `registerMCPTools` vão para as tool definitions da API, e no
// bloco `agent_runtime.mcp_routing` vão para o system prompt. Um servidor
// gerado a partir de OpenAPI pode trazer dezenas de milhares de caracteres
// sem que ninguém neste repo os tenha escrito ou revisto.
//
// Os cortes são SEMPRE marcados (nunca silenciosos) — um corte invisível faz
// o modelo tratar uma descrição truncada como a especificação completa.
//
// NOTA DE ÂMBITO: só a DESCRIÇÃO é limitada. O `input_schema` fica intacto de
// propósito — é JSON estruturado que o provider valida, e cortá-lo por
// caracteres produzia um schema inválido em vez de um schema mais pequeno.
// Reduzir schemas gordos exige podar propriedades, não truncar texto.

/** Teto por descrição de uma ferramenta MCP. */
export const MCP_TOOL_DESCRIPTION_MAX_CHARS = 1_500

/** Teto agregado das descrições de UM servidor MCP. */
export const MCP_SERVER_DESCRIPTIONS_MAX_CHARS = 20_000

/** Teto agregado de TODAS as descrições MCP juntas. */
export const MCP_TOTAL_DESCRIPTIONS_MAX_CHARS = 60_000

// ── Estimativa de tokens ──
//
// Divisor de caracteres→tokens. Era `3` em dois módulos independentes
// (`compact/autoCompact.ts` e `payloadInspector.ts`, este último com um
// comentário a dizer "keeping it identical" ao outro — um contrato de
// sincronização manual sem teste). Agora é um só valor.
//
// MEDIDO (2026-07-31) contra os `usage` reais do provider em duas sessões
// exportadas, 24 pedidos: chars/token real com mediana 4,05, mínimo 3,73,
// máximo 4,16. O rácio DESCE ao longo da sessão (4,16 nos primeiros turnos,
// 3,73 no fim) porque a fatia de tool results e JSON cresce, e esses
// tokenizam mais denso que prosa.
//
// 3,7 e não 4: o estimador é usado onde subestimar custa mais do que
// sobrestimar (decidir compactar). Um divisor ABAIXO do rácio real garante
// estimativa >= realidade, e 3,7 fica abaixo de todas as 24 amostras. O erro
// mediano passa de +35% para +9% — sobra margem, sem a inflação que fazia a
// compactação disparar ~30% cedo.
//
// Isto é uma medição de UM modelo e UM tipo de trabalho. Se os exports
// passarem a mostrar rácios abaixo de 3,7, é este número que se ajusta — não
// se volta a pôr um `Math.max` a tapar o erro.
export const CHARS_PER_TOKEN_ESTIMATE = 3.7
