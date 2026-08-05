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
 * - **Kimi K3** (Moonshot): `low` | `high` | `max` (default `max`).
 *   Sempre raciocina; NÃO enviar `thinking`. Só `reasoning_effort` top-level.
 *   Ref: https://platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model
 *
 * O valor viaja no header `X-TM-Reasoning-Effort` (buildExtraHeaders) e o
 * data-plane aplica-o ao body upstream.
 */
export const EFFORT_BY_MODEL: Record<string, ReasoningEffortOptions> = {
  // GLM-5.2 — só níveis com comportamento distinto (aliases removidos 07-23).
  'glm-5.2': {
    param: 'reasoning_effort',
    options: ['none', 'high', 'max'],
    default: 'max',
  },
  'grok-4.5': {
    param: 'reasoning_effort',
    options: ['low', 'medium', 'high'],
    default: 'high',
  },
  'kimi-k3': {
    param: 'reasoning_effort',
    options: ['low', 'high', 'max'],
    default: 'max',
  },
  // Qwen 3.8 Max (DashScope US, swap 2026-08-04): híbrido com
  // reasoning_effort low|medium|xhigh (default xhigh, docs qwencloud) —
  // sem 'high'/'max' e sem nível off no /chat/completions.
  'qwen3.8-max': {
    param: 'reasoning_effort',
    options: ['low', 'medium', 'xhigh'],
    default: 'xhigh',
  },
  // MiMo V2.5 Pro (Xiaomi hospedado): SEM reasoning_effort graded — só o
  // toggle thinking:{type} (thinking_object). Default OFF por recomendação
  // OFICIAL da Xiaomi para tool calling (FAQ mimo.mi.com, lida 2026-08-05:
  // "tool_calls in reasoning content indicates instability... recommended
  // to disable thinking when calling tool") — e o TM Code é 100% agentic.
  // Antes o MiMo nem estava neste mapa: header nunca saía e a API ficava no
  // default dela (thinking ON), contra a própria doc.
  'mimo-v2.5-pro': {
    param: 'thinking_object',
    options: ['off', 'on'],
    default: 'off',
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

  if (bare.startsWith('glm-5.2')) return 'glm-5.2'
  if (bare.startsWith('grok-4.5') || bare === 'grok-build-latest') return 'grok-4.5'
  if (bare.startsWith('kimi-k3')) return 'kimi-k3'
  if (bare.startsWith('qwen3.8-max')) return 'qwen3.8-max'
  // Cobre 'mimo-v2.5-pro' e variantes (ex.: -ultraspeed do TM Speed).
  if (bare.startsWith('mimo-v2.5-pro')) return 'mimo-v2.5-pro'
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
  if (key === 'kimi-k3') return `prompt.effort.desc.kimi.${value}`
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
