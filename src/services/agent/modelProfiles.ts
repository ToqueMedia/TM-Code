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
import { getPersonaFallbackModelId } from '../../stores/activeModelStore'

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
  // Desvio observado em sessão real (cgk-doc-app, 2026-08-03 20:15, export
  // analisado em post-mortem): com a regra JÁ no prompt, o glm-5.2 validou
  // com `tsc --noEmit 2>&1 | head -40` — pipe sem pipefail numa validação.
  // Counterweight = eco em PRIMAZIA. Rever após mais sessões; se deixar de
  // derrapar, remover. (Um 2º counterweight — Verify obrigatório — existiu
  // por umas horas e saiu a 04-08: o user removeu o próprio contrato do
  // prompt; ver a nota histórica em chatSections, secção Doing tasks.)
  counterweights: [
    {
      rule: 'Never pipe a validation command (tsc, build, tests). Run it bare so the exit code is real; if output must be trimmed, prefix `set -o pipefail;`.',
      addedFor: 'tsc --noEmit 2>&1 | head -40 sem pipefail (sessão cgk-doc-app 2026-08-03 20:15)',
      addedOn: '2026-08-03',
      reviewAfter: '2026-09-01',
    },
  ],
}

// ─────────────────────────────────────────────────
// Qwen 3.8 Max — Alibaba US (DashScope, lançado 2026-08-03)
//
// Flagship Qwen (2.4T MoE). 1M contexto, até 131K de saída. Multimodal
// NATIVO (Image/Text/Video) + web search built-in — dispensa os sidecars.
// Thinking HÍBRIDO (enable_thinking) com reasoning_effort low|medium|xhigh
// (default xhigh, docs qwencloud 2026-08); a forma vem da config gerida.
// (Swap 2026-08-04: substitui DeepSeek V4 Pro, MiMo V2.5 base e Qwen 3.7 Max,
// removidos do catálogo — histórico no git. O MiMo V2.5 Pro mantém-se.)
// ─────────────────────────────────────────────────

const QWEN_3_8_MAX: ModelProfile = {
  id: 'qwen3.8-max',
  name: 'Qwen 3.8 Max',
  modelId: 'qwen3.8-max',
  contextWindow: 1_000_000,
  maxOutputTokens: 131_072,

  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingMandatory: false,

  supportsAttachments: true,
  supportsSearch: true,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// MiMo V2.5 Pro 1M — Xiaomi. 1M contexto, thinking toggleable.
// MANTIDO no swap 2026-08-04 (só o V2.5 base saiu; o Pro continua gerido).
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
// Grok 4.5 — desde 2026-08-04 servido via Cloudflare AI Gateway
// (api.cloudflare.com/client/v4/accounts/{id}/ai/v1, model `xai/grok-4.5`,
// billing unificado Cloudflare) — antes era xAI directo (api.x.ai/v1).
//
// Modelo agentic/coding de fronteira da xAI (também por trás do "Grok Build").
// Reasoning SEMPRE ativo (mandatory) — não se desliga. O stream expõe o
// raciocínio em `reasoning_content`, que a IDE já parseia genericamente (sem
// código de parsing novo). Input text+image → text; a IDE não envia
// penalties/stop (que os modelos de reasoning do xAI rejeitam). Search por
// sidecar.
//
// JANELA CAPADA EM 200K (deliberado, não é a janela real de 500K): o preço do
// Grok directo na xAI tinha dois patamares por tamanho de prompt (<200k =
// $2/$0.30/$6; ≥200k = $4/$0.60/$12) e o cap prendia-nos ao barato. Via
// gateway o preço de tabela do provider presume-se repassado — manter o cap
// até o billing unificado provar o contrário.
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
  'qwen3.8-max': QWEN_3_8_MAX,
  'mimo-v2.5-pro-1m': MIMO_V2_5_PRO_1M,
  // O id que a config KV/X-TM-Model reporta é 'mimo-v2.5-pro' (sem o sufixo
  // -1m do id de catálogo) — sem este alias o lookup por persona/servido caía
  // no default (que por acaso É o MiMo, mas por acidente, não por contrato).
  'mimo-v2.5-pro': MIMO_V2_5_PRO_1M,
  // Grok 4.5. Via Cloudflare AI Gateway o X-TM-Model reporta 'xai/grok-4.5'
  // (sintaxe author/model do gateway); os restantes aliases cobrem ids xAI
  // directos caso a config volte a apontar lá.
  'grok-4.5': GROK_4_5,
  'xai/grok-4.5': GROK_4_5,
  'grok-4.5-latest': GROK_4_5,
  'grok-build-latest': GROK_4_5,
  // Kimi K3 — Moonshot directo reporta 'kimi-k3'; via Cloudflare AI Gateway
  // reporta 'moonshotai/kimi-k3'. Mesmo perfil.
  'kimi-k3': KIMI_K3,
  'moonshotai/kimi-k3': KIMI_K3,
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
 * Returns the pre-handshake / unknown-model fallback profile.
 *
 * PERSONA-AWARE desde 2026-08-05 (auditoria pós-personas): este é o fallback
 * de TODOS os gates de capacidade pré-primeira-resposta — visão inline vs
 * sidecar (usePromptBar/agentRunner/steerContent), pesquisa nativa no prompt
 * (contextBuilder), janela do auto-compact (agentService/parallelTaskRunner)
 * e o badge de thinking. Antes devolvia SEMPRE o default (MiMo): com a
 * persona Master (modelo com visão nativa) selecionada, a app tratava o
 * modelo como cego até à 1ª resposta — imagem desviada ao sidecar (custo +
 * fidelidade) ou 503 se o sidecar não estivesse publicado. O modelo da
 * persona SELECIONADA (mapa system/aiPersonas) é a melhor informação
 * disponível antes do X-TM-Model chegar; o plano continua irrelevante.
 */
export function getProfileForPlan(_plan: UserPlanName): ModelProfile {
  const personaModel = getPersonaFallbackModelId()
  if (personaModel && MODEL_PROFILES[personaModel]) return MODEL_PROFILES[personaModel]
  return MODEL_PROFILES[DEFAULT_MODEL_ID]
}
