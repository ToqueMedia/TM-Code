/**
 * Model profiles — per-model *capability* table for the TM Code agent.
 *
 * IMPORTANTE (arquitetura): a IDE NÃO escolhe nem configura modelos. O modelo
 * ativo, o provedor, a chave, o sampling e a forma do thinking vivem na config
 * KV do data-plane (worker ai-pass-through) e são publicados pelo control-plane.
 * O data-plane reporta o nome do modelo em `X-TM-Model` e a janela real em
 * `X-Model-Context-Window`.
 *
 * Esta tabela existe APENAS para preencher o que esses headers NÃO dizem: as
 * capacidades do modelo (visão, thinking, max output, web search nativa) e a
 * janela de fallback pré-handshake. É indexada pelo nome reportado pelo
 * data-plane; quando o nome é desconhecido, cai em getProfileForPlan().
 *
 * Quando o data-plane passar a emitir headers de capacidade
 * (X-Model-Supports-Vision/Thinking/Max-Output-Tokens), esta tabela colapsa
 * para um único default e adicionar/remover modelos deixa de tocar na IDE.
 */

import type { UserPlanName } from '../../stores/billingStore'

// ── Types ──

export interface Counterweight {
  rule: string
  addedFor: string
  addedOn: string
  reviewAfter: string
}

export type ThinkingMode = 'toggleable' | 'mandatory' | 'none'

export interface ModelProfile {
  id: string
  name: string
  modelId: string
  contextWindow: number
  maxOutputTokens: number

  // ── Thinking / Reasoning ──
  thinkingMode: ThinkingMode
  supportsThinking: boolean
  thinkingMandatory: boolean

  // ── Features ──
  supportsAttachments: boolean
  supportsSearch: boolean
  counterweights: Counterweight[]
}

// ── Helpers ──

export function renderCounterweights(profile: ModelProfile): string {
  if (!profile.counterweights || profile.counterweights.length === 0) return ''
  return profile.counterweights.map(c => `- ${c.rule}`).join('\n')
}

// ─────────────────────────────────────────────────
// GLM-5.2 — Zhipu, servido por DOIS provedores OpenAI-compatíveis
//
// O data-plane roteia para z.AI oficial OU para DashScope/Alibaba Cloud (US)
// consoante a config ativa em KV — ambos expõem o mesmo glm-5.2. 1M de
// contexto, até 128K de saída. Thinking ON por defeito; a forma do parâmetro
// (z.AI: `thinking:{type}`; DashScope: `enable_thinking`) é injetada pelo
// worker via extraBody — a IDE nunca a envia. Text-only: visão pelo sidecar.
// ─────────────────────────────────────────────────

const GLM_5_2: ModelProfile = {
  id: 'glm-5.2',
  name: 'GLM-5.2',
  modelId: 'glm-5.2',
  contextWindow: 1_000_000,
  maxOutputTokens: 131_072,

  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingMandatory: false,

  supportsAttachments: false,
  supportsSearch: false,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// DeepSeek V4 Pro — DeepSeek oficial. 1M contexto, até 384K de saída.
// Thinking toggleable via config do data-plane (`thinking:{type}` +
// `reasoning_effort`) e text-only; visão/pesquisa seguem por sidecars.
// ─────────────────────────────────────────────────

const DEEPSEEK_V4_PRO: ModelProfile = {
  id: 'deepseek-v4-pro',
  name: 'DeepSeek V4 Pro',
  modelId: 'deepseek-v4-pro',
  contextWindow: 1_000_000,
  maxOutputTokens: 393_216,

  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingMandatory: false,

  supportsAttachments: false,
  supportsSearch: false,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// Qwen 3.7 Max (snapshot 2026-06-08) — Alibaba China (DashScope)
//
// Flagship Alibaba Cloud. 1M contexto, Visual Understanding + web search
// NATIVOS (supportsAttachments/supportsSearch ligados dispensam os sidecars).
// ─────────────────────────────────────────────────

const QWEN_3_7_MAX: ModelProfile = {
  id: 'qwen3.7-max-2026-06-08',
  name: 'Qwen 3.7 Max',
  modelId: 'qwen3.7-max-2026-06-08',
  contextWindow: 1_000_000,
  maxOutputTokens: 65_536,

  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingMandatory: false,

  supportsAttachments: true,
  supportsSearch: true,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// MiMo V2.5 Pro 1M — Xiaomi. 1M contexto, thinking toggleable.
// ─────────────────────────────────────────────────

const MIMO_V2_5_PRO_1M: ModelProfile = {
  id: 'mimo-v2.5-pro-1m',
  name: 'MiMo V2.5 Pro 1M',
  modelId: 'mimo-v2.5-pro',
  contextWindow: 1_048_576,
  maxOutputTokens: 32_768,

  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingMandatory: false,

  supportsAttachments: false,
  supportsSearch: false,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// MiMo V2.5 1M — Xiaomi. Irmão menor, mesma forma de thinking.
// ─────────────────────────────────────────────────

const MIMO_V2_5_1M: ModelProfile = {
  id: 'mimo-v2.5-1m',
  name: 'MiMo V2.5 · 1M',
  modelId: 'mimo-v2.5',
  contextWindow: 1_048_576,
  maxOutputTokens: 32_768,

  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingMandatory: false,

  supportsAttachments: true,
  supportsSearch: false,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// Grok 4.5 — xAI (api.x.ai/v1, OpenAI-compatible, Bearer)
//
// Modelo agentic/coding de fronteira da xAI (também por trás do "Grok Build").
// Reasoning SEMPRE ativo (mandatory) — não se desliga. O stream expõe o
// raciocínio em `reasoning_content`, que a IDE já parseia genericamente (sem
// código de parsing novo). Input text+image → text; a IDE não envia
// penalties/stop (que os modelos de reasoning do xAI rejeitam). Confirmado nas
// docs oficiais docs.x.ai (2026-07). Search vai por sidecar.
//
// JANELA CAPADA EM 200K (deliberado, não é a janela real de 500K): o preço do
// Grok tem dois patamares por tamanho de prompt — <200k tokens = input $2 /
// cached $0.30 / output $6; ao ATINGIR 200k salta para $4/$0.60/$12 em TODOS os
// tokens. Manter a janela em 200k prende-nos ao patamar barato. Nota de borda:
// o patamar vira quando o prompt "atinge" 200k, por isso 200k exato é o limiar
// — se quiseres garantia dura do tier $2, deixa folga (~190k).
// ─────────────────────────────────────────────────

const GROK_4_5: ModelProfile = {
  id: 'grok-4.5',
  name: 'Grok 4.5',
  modelId: 'grok-4.5',
  contextWindow: 200_000,
  maxOutputTokens: 128_000,

  thinkingMode: 'mandatory',
  supportsThinking: true,
  thinkingMandatory: true,

  supportsAttachments: true,
  supportsSearch: false,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// Kimi K3 — Moonshot/Kimi (api.moonshot.ai/v1, OpenAI-compatible, Bearer)
//
// Flagship multimodal agentic/coding da Moonshot (lançado 2026-07-16). Janela
// 1M; reasoning SEMPRE ativo (mandatory), controlado só por `reasoning_effort`
// (low/high/max, default max) — a forma é injetada pela config gerida via
// extraBody; a IDE não a envia. O stream expõe o raciocínio em
// `reasoning_content` (já parseado genericamente). Regra multi-turno: a
// mensagem completa do assistant (incl. reasoning_content + tool_calls) tem de
// voltar as-is — o round-trip de thinking da IDE já o faz. Confirmado nas docs
// oficiais platform.kimi.ai (2026-07). Search por sidecar.
// ─────────────────────────────────────────────────

const KIMI_K3: ModelProfile = {
  id: 'kimi-k3',
  name: 'Kimi K3',
  modelId: 'kimi-k3',
  contextWindow: 1_048_576,
  maxOutputTokens: 131_072,

  thinkingMode: 'mandatory',
  supportsThinking: true,
  thinkingMandatory: true,

  supportsAttachments: true,
  supportsSearch: false,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  'glm-5.2': GLM_5_2,
  // DashScope/Alibaba Cloud (US) ainda pode reportar o id base 'glm-5' em
  // X-TM-Model — alias para o MESMO perfil, senão o lookup cairia no default.
  'glm-5': GLM_5_2,
  'deepseek-v4-pro': DEEPSEEK_V4_PRO,
  'qwen3.7-max-2026-06-08': QWEN_3_7_MAX,
  // Alias do id antigo → mesmo perfil enquanto a config ativa não republicar
  // o snapshot datado.
  'qwen3.7-max': QWEN_3_7_MAX,
  'mimo-v2.5-pro-1m': MIMO_V2_5_PRO_1M,
  'mimo-v2.5-1m': MIMO_V2_5_1M,
  // Grok 4.5 (xAI). X-TM-Model reporta 'grok-4.5'; os aliases 'grok-4.5-latest'
  // / 'grok-build-latest' mapeiam para o mesmo perfil caso a config os reporte.
  'grok-4.5': GROK_4_5,
  'grok-4.5-latest': GROK_4_5,
  'grok-build-latest': GROK_4_5,
  // Kimi K3 (Moonshot). Id plano, sem snapshots datados nas docs oficiais.
  'kimi-k3': KIMI_K3,
}

export const DEFAULT_MODEL_ID = 'mimo-v2.5-pro-1m'

/**
 * Capacidade EFECTIVA de um modelo: o que o servidor declarou vence o que a
 * tabela local adivinha.
 *
 * PORQUÊ (auditoria 2026-07-29): `MODEL_PROFILES` é uma lista fixa e o resto do
 * sistema é config-driven — "adicionar um modelo é editar a KV, não o código".
 * Quando o nome não estava na tabela, o código caía em `getProfileForPlan()` e
 * o modelo novo HERDAVA as flags de outro: a visão, o pensamento e a pesquisa
 * do MiMo. O efeito prático era enviar imagens a um modelo que não as lê, e
 * anunciar-lhe no prompt uma pesquisa nativa que ele não tem.
 *
 * `declared === null` significa "o servidor não declarou" — e aí o perfil local
 * é a melhor informação que existe. Só um booleano explícito o substitui.
 */
export function effectiveCapability(
  declared: boolean | null | undefined,
  profileValue: boolean | undefined,
): boolean {
  if (typeof declared === 'boolean') return declared
  return profileValue === true
}

export function getModelProfile(modelId: string): ModelProfile {
  return MODEL_PROFILES[modelId] || MODEL_PROFILES[DEFAULT_MODEL_ID]
}

/**
 * Returns the model profile for the user's billing plan.
 *
 * Post-refactor: always returns MiMo V2.5 Pro 1M regardless of plan. The
 * data-plane (KV config) controls actual model routing; this is only the
 * pre-handshake / unknown-model fallback.
 */
export function getProfileForPlan(_plan: UserPlanName): ModelProfile {
  return MIMO_V2_5_PRO_1M
}
