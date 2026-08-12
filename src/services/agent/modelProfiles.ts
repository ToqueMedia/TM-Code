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
  // HISTÓRIA dos counterweights (03→05-08): o glm-5.2 derrapou no pipefail
  // (cgk-doc-app 03-08) e ganhou um counterweight; a 05-08 o MiMo derrapou na
  // MESMA regra (sessão recepcionista) — dois modelos ≠ a falhar uma regra
  // que só vivia no MEIO do prompt (queda do U-curve) provou que o problema
  // era a POSIÇÃO, não os modelos. A regra foi promovida ao FINAL CHECKPOINT
  // do Reminder (recência) e os counterweights por-modelo saíram — remendo
  // por-modelo para defeito estrutural do prompt é dívida disfarçada.
  counterweights: [],
}

// ─────────────────────────────────────────────────
// Qwen 3.8 Max — Alibaba US (DashScope, lançado 2026-08-03)
//
// Flagship Qwen (2.4T MoE). 1M contexto, até 131K de saída. Multimodal
// NATIVO (Image/Text/Video) + web search built-in — dispensa os sidecars.
// Thinking HÍBRIDO (enable_thinking) com reasoning_effort low|medium|xhigh
// (default xhigh, docs qwencloud 2026-08); a forma vem da config gerida.
// (Swap 2026-08-04: substitui DeepSeek V4 Pro, MiMo V2.5 base e Qwen 3.7 Max,
// removidos do catálogo — histórico no git. O MiMo V2.5 Pro, que sobreviveu a
// esse swap, saiu por sua vez a 2026-08-07.)
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
// Qwen 3.7 Plus — Alibaba US (DashScope)
//
// Já servia os sidecars `vision` e `web_search`; desde 2026-08-07 é TAMBÉM
// modelo de código elegível para uma persona (o admin atribui-o em
// Settings → Personas). Vision-language NATIVO e web search built-in via
// `enable_search` — dispensa os sidecars quando é o modelo principal.
// Thinking HÍBRIDO da série 3.7: boolean `enable_thinking` (NÃO tem a escala
// graded de reasoning_effort do 3.8-max), por isso o seletor de effort mostra
// off/on. É a família que a DashScope documenta para `preserve_thinking` — o
// data-plane liga-o quando o thinking está ON (ver applyReasoningEffort.ts).
// ─────────────────────────────────────────────────

// VERIFICAÇÃO (2026-08-08), depois de estes números terem sido INFERIDOS da
// família na primeira versão:
//  - maxOutputTokens: 131 072, dito pelo PRÓPRIO endpoint. Um pedido com
//    max_tokens acima disso responde "Range of max_tokens should be
//    [1, 131072]". O valor anterior (32 768) estava 4× abaixo e teria capado
//    o modelo — e com ele o tecto da escalada anti-truncagem do loop.
//  - contextWindow: 1M, corroborado pela ficha oficial do modelo e por
//    terceiros, mas NÃO sondado (sondá-lo custaria 1M de tokens). É o valor
//    que mais importa acertar: alimenta o gatilho de auto-compactação, e um
//    valor grande demais faz o run rebentar em vez de compactar.
const QWEN_3_7_PLUS: ModelProfile = {
  id: 'qwen3.7-plus',
  name: 'Qwen 3.7 Plus',
  modelId: 'qwen3.7-plus',
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
// GLM-5.2 — TERCEIRO provedor: Cloudflare Workers AI (2026-08-10)
//
// Mesmo modelo do bloco acima, id e JANELA diferentes. A doc oficial
// (developers.cloudflare.com/workers-ai/models/glm-5.2/) declara:
//   · Model ID  `@cf/zai-org/glm-5.2`
//   · Context Window  262 144  ← NÃO é 1M como no z.AI
//   · Function calling: sim; Reasoning: sim, via `reasoning_effort`
//   · Endpoint OpenAI-compatible `/v1/chat/completions`
//
// PORQUÊ UM PERFIL SEPARADO E NÃO UM ALIAS
// ────────────────────────────────────────
// `MODEL_PROFILES` é indexado pelo ID DO MODELO, e a janela pertence ao par
// (provedor, modelo). Apontar este id para GLM_5_2 herdava 1M e o IDE
// calculava um limiar de compactação de 931 000 onde o correcto é 229 144 —
// o portão de envio do composer deixava passar um prompt que só podia voltar
// em `prompt_too_long`. Como o Workers AI reporta um id PRÓPRIO em X-TM-Model,
// a tabela consegue distinguir os três provedores; onde não conseguir (z.AI e
// DashScope reportam ambos `glm-5.2`) entra a memória por config
// (servedWindowMemory.ts), que guarda o `X-Model-Context-Window` visto.
//
// `maxOutputTokens` herda os 131 072 do modelo: a doc do Cloudflare NÃO
// publica um tecto (descreve `max_completion_tokens` como parâmetro, sem
// valor). Herdar não distorce nada aqui — este campo só alimenta a reserva
// para o sumário, que é `min(maxOutputTokens, MAX_OUTPUT_TOKENS_FOR_SUMMARY)`
// e portanto dá 20 000 para qualquer valor acima disso. Inventar um número
// MENOR é que teria custo: truncava output legítimo.
// ─────────────────────────────────────────────────

const GLM_5_2_CLOUDFLARE: ModelProfile = {
  ...GLM_5_2,
  id: '@cf/zai-org/glm-5.2',
  name: 'GLM-5.2 (Cloudflare)',
  modelId: '@cf/zai-org/glm-5.2',
  contextWindow: 262_144,
}

// ─────────────────────────────────────────────────
// Grok 4.5 — x.AI DIRECTO (api.x.ai/v1, model `grok-4.5`). A via Cloudflare
// AI Gateway foi REMOVIDA a 2026-08-11 (decisão de produto): o metering 30/70
// debita o custo real do provider, e o directo dá controlo do preço e do
// cache automático da x.AI (`x-grok-conv-id` para afinidade, providers.ts).
//
// Modelo agentic/coding de fronteira da xAI (também por trás do "Grok Build").
// Reasoning SEMPRE ativo (mandatory) — não se desliga; effort low|medium|high
// (default high). O stream expõe o raciocínio em `reasoning_content`, que a
// IDE já parseia genericamente. Input text+image → text; frequency_penalty/
// presence_penalty/stop/logit_bias são limpos pelo data-plane (a referência
// REST da x.AI marca-os unsupported nos modelos de reasoning). Search por
// sidecar.
//
// JANELA CAPADA EM 200K (deliberado, não é a janela real de 500K): na x.AI,
// prompts com ≥200k tokens pagam TODOS os preços A DOBRO ($2/$0.30/$6 →
// $4/$0.60/$12). No metering 30/70 isso dobraria o consumo real do utilizador
// num único pedido — o cap mantém todos os pedidos no escalão barato.
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
// (Kimi K3 — Moonshot directo e via Cloudflare AI Gateway — foi REMOVIDO do
// catálogo gerido a 2026-08-11, decisão de produto. Continua disponível como
// provider BYOK: byokRouting/byokStore e o parsing de `reasoning_content`
// mantêm-se para quem ligar a própria chave.)
// ─────────────────────────────────────────────────

// ─────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  'glm-5.2': GLM_5_2,
  // DashScope/Alibaba Cloud (US) ainda pode reportar o id base 'glm-5' em
  // X-TM-Model — alias para o MESMO perfil, senão o lookup cairia no default.
  'glm-5': GLM_5_2,
  // Cloudflare Workers AI expõe o MESMO glm-5.2 com um id próprio e uma janela
  // MENOR. Entrada separada, não alias — ver GLM_5_2_CLOUDFLARE.
  '@cf/zai-org/glm-5.2': GLM_5_2_CLOUDFLARE,
  'zai-org/glm-5.2': GLM_5_2_CLOUDFLARE,
  'qwen3.8-max': QWEN_3_8_MAX,
  'qwen3.7-plus': QWEN_3_7_PLUS,
  // Grok 4.5 — x.AI directo (2026-08-11). Aliases documentados da x.AI; o id
  // 'xai/grok-4.5' do antigo gateway Cloudflare saiu com ele.
  'grok-4.5': GROK_4_5,
  'grok-4.5-latest': GROK_4_5,
  'grok-build-latest': GROK_4_5,
}

// Fallback de modelo desconhecido / pré-handshake. Passou de 'mimo-v2.5-pro-1m'
// para o GLM-5.2 a 2026-08-07 (o MiMo saiu do catálogo gerido): o GLM é a
// config ATIVA em produção e o perfil mais conservador do catálogo — sem visão
// e sem pesquisa nativas, portanto um modelo novo que caia aqui degrada para os
// sidecars em vez de receber imagens que talvez não leia.
export const DEFAULT_MODEL_ID = 'glm-5.2'

/**
 * Capacidade EFECTIVA de um modelo: o que o servidor declarou vence o que a
 * tabela local adivinha.
 *
 * PORQUÊ (auditoria 2026-07-29): `MODEL_PROFILES` é uma lista fixa e o resto do
 * sistema é config-driven — "adicionar um modelo é editar a KV, não o código".
 * Quando o nome não estava na tabela, o código caía em `getProfileForPlan()` e
 * o modelo novo HERDAVA as flags de outro: a visão, o pensamento e a pesquisa
 * do perfil de fallback. O efeito prático era enviar imagens a um modelo que não as lê, e
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
 * e o badge de thinking. Antes devolvia SEMPRE o default: com a
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
