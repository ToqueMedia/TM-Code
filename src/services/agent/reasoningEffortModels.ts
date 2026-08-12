import type { ReasoningEffortOptions } from '../../stores/reasoningEffortStore'

/**
 * Mapa FRONTEND de reasoning-effort por modelo (decisão 2026-07-23: TUDO no
 * frontend, NÃO no backend). Só estes modelos podem ser o modelo PRINCIPAL.
 *
 * Valores = níveis REAIS de produto (não a lista completa de strings que a API
 * aceita). Aliases documentados mas sem comportamento distinto foram removidos
 * após probe live z.AI + DashScope (2026-07-23) — ver notas por modelo.
 *
 * - **GLM-5.2** (z.AI + DashScope):
 *   Docs listam 7 strings, mas o runtime colapsa:
 *     `none`/`minimal` → sem thinking
 *     `low`/`medium` → `high`
 *     `xhigh` → `max`
 *   Só expomos os 3 níveis distintos: `none` | `high` | `max` (default `max`).
 *   Probe live (5× stream cada): todos os 7 devolvem content; os aliases não
 *   acrescentam UX. DashScope: `enable_thinking` tem prioridade (worker).
 *   Refs: https://docs.z.ai/guides/capabilities/thinking
 *         https://help.aliyun.com/en/model-studio/glm
 *
 * - **Grok 4.5** (xAI): `low` | `medium` | `high` (default `high`).
 *   Reasoning NÃO se desliga. Chat Completions: `reasoning_effort` top-level.
 *   Ref: https://docs.x.ai/developers/model-capabilities/text/reasoning
 *
 * - **Qwen 3.7 Plus** (DashScope): `off` | `on` (default `on`) — híbrido por
 *   BOOLEAN `enable_thinking`, sem escala graded (essa só existe no 3.8-max).
 *
 * O valor viaja no header `X-TM-Reasoning-Effort` (buildExtraHeaders) e o
 * data-plane aplica-o ao body upstream.
 */
export const EFFORT_BY_MODEL: Record<string, ReasoningEffortOptions> = {
  // GLM-5.2 — só níveis com comportamento distinto (aliases removidos 07-23).
  // Vale para as vias z.AI e DashScope, que partilham este vocabulário.
  'glm-5.2': {
    param: 'reasoning_effort',
    options: ['none', 'high', 'max'],
    default: 'max',
  },
  // GLM-5.2 pelo Cloudflare Workers AI (2026-08-10) — MESMO modelo, escala
  // DIFERENTE. A doc do Workers AI descreve `reasoning_effort` com o texto da
  // OpenAI ("Constrains effort on reasoning for reasoning models (o1,
  // o3-mini, …)"), portanto o conjunto válido é low|medium|high. O `max` e o
  // `none` das outras duas vias são vocabulário do z.AI/DashScope.
  //
  // PORQUE PRECISA DE CHAVE PRÓPRIA: `normalizeEffortModelId` corta no último
  // `/` para aceitar prefixos de catálogo (`z-ai/glm-5.2`), e o id do Workers
  // AI é `@cf/zai-org/glm-5.2` — colapsava para `glm-5.2` e a UI mostrava a
  // escala errada, com MAX (reportado pelo developer). É o mesmo detector por
  // NOME que o `isCloudflareAI` do data-plane já evita, e que aqui passou.
  'glm-5.2-cloudflare': {
    param: 'reasoning_effort',
    options: ['low', 'medium', 'high'],
    default: 'high',
  },
  'grok-4.5': {
    param: 'reasoning_effort',
    options: ['low', 'medium', 'high'],
    default: 'high',
  },
  // Qwen 3.8 Max (DashScope US, swap 2026-08-04): híbrido com
  // reasoning_effort low|medium|xhigh (default xhigh, docs qwencloud) —
  // sem 'high'/'max' e sem nível off no /chat/completions.
  'qwen3.8-max': {
    param: 'reasoning_effort',
    options: ['low', 'medium', 'xhigh'],
    default: 'xhigh',
  },
  // Qwen 3.7 Plus (DashScope US, promovido a modelo principal 2026-08-07):
  // a série 3.7 é híbrida por BOOLEAN (`enable_thinking`) — não tem a escala
  // graded low|medium|xhigh que o 3.8-max ganhou. Por isso o seletor mostra
  // off/on, e o data-plane traduz o valor para `enable_thinking` (nunca
  // `reasoning_effort`, que esta família não documenta).
  //
  // Default 'on': ao contrário do MiMo (que saiu do catálogo, e cuja doc
  // desaconselhava thinking com tool calls), a doc do Qwen não tem essa
  // ressalva e o thinking é o modo recomendado para trabalho agentic.
  'qwen3.7-plus': {
    param: 'enable_thinking',
    options: ['off', 'on'],
    default: 'on',
  },
}

/**
 * Preferências antigas (lista de 7 do GLM) → nível real.
 * Usado em resolveEffectiveEffort para não “cair no default” quando o user
 * tinha `low`/`medium`/`xhigh`/`minimal` guardados no localStorage.
 */
const GLM_LEGACY_EFFORT_ALIAS: Record<string, string> = {
  none: 'none',
  minimal: 'none',
  low: 'high',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

/** Fallback UI quando o modelo ainda não é conhecido — escala GLM. */
const DEFAULT_EFFORT: ReasoningEffortOptions = EFFORT_BY_MODEL['glm-5.2']

/**
 * Canonicaliza o model id do admin/header para a chave do mapa.
 * Aceita casing, prefixos de catálogo (`z-ai/glm-5.2`) e aliases documentados
 * (grok-4.5-latest, grok-build-latest, glm-5.2-fast-preview).
 */
export function normalizeEffortModelId(
  modelId: string | null | undefined,
): string | null {
  if (modelId == null) return null
  const raw = modelId.trim().toLowerCase()
  if (!raw) return null
  // OpenRouter / catalog prefixes: "z-ai/glm-5.2" → "glm-5.2"
  const bare = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw

  // O corte acima existe para aceitar prefixos de catálogo, mas DEITA FORA a
  // única pista do provedor — e o mesmo glm-5.2 é servido por três, com
  // escalas de effort diferentes. O id nativo do Cloudflare Workers AI
  // (`@cf/zai-org/glm-5.2`) tem de ser reconhecido ANTES do corte, senão
  // colapsa em `glm-5.2` e a UI oferece `max`, que aquele endpoint não aceita.
  //
  // `zai-org` (autor do modelo no catálogo Cloudflare) não colide com o
  // `z-ai/` dos prefixos de OpenRouter — strings diferentes, de propósito.
  const isCloudflareNative = raw.startsWith('@cf/') || raw.includes('zai-org/')
  if (isCloudflareNative && bare.startsWith('glm-5.2')) return 'glm-5.2-cloudflare'

  if (bare.startsWith('glm-5.2')) return 'glm-5.2'
  if (bare.startsWith('grok-4.5') || bare === 'grok-build-latest') return 'grok-4.5'
  if (bare.startsWith('qwen3.8-max')) return 'qwen3.8-max'
  // Cobre 'qwen3.7-plus' e os snapshots datados ('qwen3.7-plus-2026-05-26').
  if (bare.startsWith('qwen3.7-plus')) return 'qwen3.7-plus'
  return bare
}

/**
 * Resolve as opções de effort para o modelo ativo. Desconhecido/não-mapeado →
 * default (GLM). Nunca devolve null — o controlo está sempre disponível.
 */
export function getEffortOptionsForModel(
  modelId: string | null | undefined,
): ReasoningEffortOptions {
  const key = normalizeEffortModelId(modelId)
  if (key && EFFORT_BY_MODEL[key]) return EFFORT_BY_MODEL[key]
  return DEFAULT_EFFORT
}

/**
 * Valor EFETIVO (UI + header): preferência do user se válida p/ o modelo, senão
 * o DEFAULT do modelo. Sem side-effects — a troca de modelo re-resolve sozinha.
 *
 * GLM (só quando o modelo É glm-5.2): preferências legadas
 * (`minimal`/`low`/`medium`/`xhigh`) mapeiam para o nível real. NÃO aplicar
 * quando modelId é null — senão um user com Grok e selected=`low` via o alias
 * GLM e o valor vira `high` (bug: Effort Low no Grok comportava-se como High).
 */
export function resolveEffectiveEffort(
  modelId: string | null | undefined,
  selected: string | null,
): string {
  const opts = getEffortOptionsForModel(modelId)
  if (!selected) return opts.default

  const key = normalizeEffortModelId(modelId)
  const normalized =
    key === 'glm-5.2'
      ? (GLM_LEGACY_EFFORT_ALIAS[selected] ?? selected)
      : selected

  return opts.options.includes(normalized) ? normalized : opts.default
}

/**
 * Modelo id usado para effort: último X-TM-Model (o que REALMENTE serviu),
 * senão Firestore real-time. O seletor e o header DEVEM usar a mesma fonte.
 *
 * INVERSÃO DE PRIORIDADE (2026-08-05, feature Personas): o fallback vem do
 * mapa por-persona (system/aiPersonas → activeModelStore.personaModels) — mas
 * o modelo que REALMENTE serviu pode divergir (config KV vs mapa) e o
 * X-TM-Model da resposta é a verdade final. Firestore-primeiro mostrava a escala do GLM com
 * o Standard publicado como MiMo (bug reportado pelo developer: "vejo High,
 * Max" num modelo sem esses níveis). O custo da inversão é o cenário antigo
 * (swap de modelo pelo admin com header ainda do modelo anterior) mostrar a
 * escala velha durante UM turno — auto-corrige na resposta seguinte, e o
 * worker ignora valores fora das options do modelo real (nunca há 400).
 */
export function resolveEffortModelId(
  activeModelId: string | null | undefined,
  headerModelId?: string | null | undefined,
): string | null {
  const served = headerModelId?.trim() || null
  if (served) return served
  return activeModelId?.trim() || null
}

/**
 * Deve o data-plane receber X-TM-Reasoning-Effort?
 * - null/undefined (pré-deteção) → NÃO. O default GLM (`max`) é inválido no
 *   Grok (só low|medium|high) e um 400 no 1.º turno deixa a bolha do assistente
 *   vazia. Enquanto o modelId não chega (Firestore / X-TM-Model), o provider
 *   usa o SEU default nativo (GLM max, Grok high, Kimi max).
 * - mapeado (incl. aliases) → sim
 * - não-mapeado → não (evita 400 em providers sem reasoning_effort)
 */
export function shouldSendEffort(modelId: string | null | undefined): boolean {
  if (modelId == null || modelId.trim() === '') return false
  const key = normalizeEffortModelId(modelId)
  return key != null && key in EFFORT_BY_MODEL
}

/**
 * Chave i18n da descrição do effort. Escolhe o texto da escala correcta
 * (docs oficiais) sem revelar o modelo na UI — as strings nunca nomeiam
 * o provider. Fallback genérico: `prompt.effort.desc.{value}`.
 */
export function effortDescriptionKey(
  value: string,
  modelId?: string | null,
): string {
  const key = normalizeEffortModelId(modelId)
  if (key === 'glm-5.2') return `prompt.effort.desc.glm.${value}`
  if (key === 'grok-4.5') return `prompt.effort.desc.grok.${value}`
  return `prompt.effort.desc.${value}`
}

/**
 * Carimbo de effort para UM turno do assistente (sessão + UI).
 * `effort` = valor efetivo (preferência válida ou default do modelo).
 * `sent` = se o header X-TM-Reasoning-Effort será/foi anexado (só modelos
 * mapeados com modelId conhecido).
 */
export interface EffortTurnStamp {
  effort: string
  sent: boolean
}

export function resolveEffortTurnStamp(
  modelId: string | null | undefined,
  selected: string | null,
): EffortTurnStamp {
  return {
    effort: resolveEffectiveEffort(modelId, selected),
    sent: shouldSendEffort(modelId),
  }
}

/** Label curta para UI (High, Max, xHigh, None…). */
export function effortDisplayLabel(value: string): string {
  if (value === 'xhigh') return 'xHigh'
  if (!value) return value
  return value.charAt(0).toUpperCase() + value.slice(1)
}
