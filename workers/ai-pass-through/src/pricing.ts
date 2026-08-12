/**
 * Preços reais por modelo+provider e cálculo de custo — metering 30/70.
 *
 * Decisão de produto (2026-08-11): o consumo deixa de contar-se em "tokens
 * faturáveis" (unidade abstracta com factor de cache 0,43 e multiplicadores
 * de persona/speed) e passa a contar-se em CUSTO REAL do provider, em
 * microdólares (µ$ = 1e-6 USD). A margem de 30% vive no preço do plano; os
 * 70% do preço são o envelope que o utilizador consome exactamente ao custo:
 * cache hit ao preço de cache, miss ao preço cheio, output ao preço de
 * output. Sem multiplicadores: a persona decide o MODELO (e o modelo, por
 * ter preço próprio, decide o ritmo de consumo — é essa a diferenciação).
 *
 * UNIDADE — microdólares, inteiros:
 *   custo_µ$ = tokens × (preço $/M)   (porque $/M ≡ µ$/token)
 * O Firestore só guarda inteiros (increment transforms), o erro de
 * arredondamento é ≤1 µ$ por pedido, e nunca se arredonda para BAIXO
 * (Math.ceil — a margem não paga o arredondamento).
 *
 * Tabela fornecida pelo developer (2026-08-11), preços oficiais por milhão
 * de tokens. O catálogo vivo é o KV do admin; esta tabela é a fonte do
 * CUSTO — mudar um preço aqui é uma decisão de produto, não de deploy.
 */

import { isCloudflareAI, isDashScope, isXAI, isZAI, bareModel, type ProviderIdentity } from './providers'

export interface ModelPricing {
  /** $/M tokens de input NÃO cacheado. */
  inputPerM: number
  /** $/M tokens de prompt servidos do cache do provider. */
  cachedPerM: number
  /** $/M tokens de output. */
  outputPerM: number
}

/**
 * Tabela de preços. Chave = `${família}:${modelo nu}` — modelo SEM prefixo
 * de autor (`@cf/zai-org/glm-5.2` → `glm-5.2`; `xai/grok-4.5` → `grok-4.5`),
 * porque o MESMO modelo tem preços DIFERENTES por provider (glm-5.2:
 * DashScope $1,10 vs z.AI/Cloudflare $1,40) e o id nunca chega para decidir.
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  // GLM 5.2 — três providers, dois preços.
  'dashscope:glm-5.2': { inputPerM: 1.10, cachedPerM: 0.275, outputPerM: 3.851 },
  'zai:glm-5.2': { inputPerM: 1.40, cachedPerM: 0.26, outputPerM: 4.40 },
  'cloudflare:glm-5.2': { inputPerM: 1.40, cachedPerM: 0.26, outputPerM: 4.40 },
  // Qwen (DashScope) — coder + sidecars.
  'dashscope:qwen3.8-max': { inputPerM: 1.65, cachedPerM: 0.206, outputPerM: 4.951 },
  'dashscope:qwen3.7-plus': { inputPerM: 0.276, cachedPerM: 0.056, outputPerM: 1.101 },
  'dashscope:qwen3.7-flash': { inputPerM: 0.028, cachedPerM: 0.006, outputPerM: 0.11 },
  // Grok 4.5 — x.AI directo (Cloudflare gateway removido, decisão 2026-08-11).
  // Cap de contexto: 200k (declarado na config KV, não aqui).
  'xai:grok-4.5': { inputPerM: 2.00, cachedPerM: 0.30, outputPerM: 6.00 },
}

/**
 * Fallback por FAMÍLIA de modelo — um id novo do mesmo modelo (ex. o admin
 * publica `grok-4.5` e a x.AI renomeia para `grok-4-5`) não pode virar
 * metering zero nem preço errado. Só famílias com um único preço plausível.
 */
const FAMILY_PRICING: Array<{ family: string; match: (model: string) => boolean; pricing: ModelPricing }> = [
  { family: 'xai', match: m => m.startsWith('grok'), pricing: MODEL_PRICING['xai:grok-4.5'] },
  { family: 'dashscope', match: m => m.includes('glm'), pricing: MODEL_PRICING['dashscope:glm-5.2'] },
  { family: 'zai', match: m => m.includes('glm'), pricing: MODEL_PRICING['zai:glm-5.2'] },
  { family: 'cloudflare', match: m => m.includes('glm'), pricing: MODEL_PRICING['cloudflare:glm-5.2'] },
]

/**
 * Preço conservador para modelo SEM entrada nem família reconhecida.
 * "Todos os modelos terão preço" (decisão 2026-08-11) — portanto chegar aqui
 * é config por publicar: cobra-se caro e faz-se barulho em vez de cobrar 0
 * (o silêncio que transformaria um modelo novo em buraco de margem).
 */
export const FALLBACK_PRICING: ModelPricing = { inputPerM: 2.00, cachedPerM: 0.30, outputPerM: 6.00 }

export interface ResolvedPricing {
  pricing: ModelPricing
  /** Chave resolvida (`dashscope:glm-5.2`) ou a razão do fallback. */
  key: string
  /** true quando nenhuma entrada casou — o caller deve logar. */
  fallback: boolean
}

function pricingFamily(ctx: ProviderIdentity): string {
  if (isCloudflareAI(ctx)) return 'cloudflare'
  if (isDashScope(ctx)) return 'dashscope'
  if (isXAI(ctx)) return 'xai'
  if (isZAI(ctx)) return 'zai'
  return 'unknown'
}

const warnedFallbackKeys = new Set<string>()

/** Reset do aviso único por chave — para os testes. */
export function resetFallbackPricingWarnings(): void {
  warnedFallbackKeys.clear()
}

export function resolveModelPricing(ctx: ProviderIdentity): ResolvedPricing {
  const family = pricingFamily(ctx)
  const model = bareModel(ctx.model ?? '')
  const exact = MODEL_PRICING[`${family}:${model}`]
  if (exact) return { pricing: exact, key: `${family}:${model}`, fallback: false }
  for (const entry of FAMILY_PRICING) {
    if (entry.family === family && entry.match(model)) {
      return { pricing: entry.pricing, key: `${family}:${model} (família)`, fallback: false }
    }
  }
  // Uma vez por chave: um modelo sem preço é config por publicar, não um erro
  // por pedido. O custo segue (conservador) — o silêncio é que era inaceitável.
  const key = `${family}:${model}`
  if (!warnedFallbackKeys.has(key)) {
    warnedFallbackKeys.add(key)
    console.warn(
      `[billing] modelo SEM preço na tabela: ${key} — a cobrar pelo fallback conservador ` +
      `($${FALLBACK_PRICING.inputPerM}/$${FALLBACK_PRICING.cachedPerM}/$${FALLBACK_PRICING.outputPerM} por M). ` +
      'Publicar o preço em pricing.ts antes de servir este modelo em produção.',
    )
  }
  return { pricing: FALLBACK_PRICING, key: `${key} (FALLBACK)`, fallback: true }
}

/**
 * Custo REAL do pedido em microdólares. cached é subconjunto de prompt
 * (o provider já o inclui no total) — clamp por defesa.
 *
 *   miss×input + hit×cache + output×output   (preços $/M ≡ µ$/token)
 */
export function computeRequestCostMicros(
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number },
  pricing: ModelPricing,
): number {
  const prompt = Math.max(0, usage.promptTokens)
  const cached = Math.max(0, Math.min(prompt, usage.cachedTokens))
  const completion = Math.max(0, usage.completionTokens)
  const micros =
    (prompt - cached) * pricing.inputPerM +
    cached * pricing.cachedPerM +
    completion * pricing.outputPerM
  return Math.max(0, Math.ceil(micros))
}

/**
 * Ratio de cache REAL do provider (preço hit / preço input) — para o ledger
 * Team BYOK contar a despesa do admin como o provider a conta. Sem pricing
 * conhecido não há desconto: o ledger fica raw 1× (conservador para a pool).
 */
export function byokCacheRatio(pricing: ModelPricing | null): number {
  if (!pricing || pricing.inputPerM <= 0) return 1
  const ratio = pricing.cachedPerM / pricing.inputPerM
  return ratio > 0 && ratio < 1 ? ratio : 1
}

/** Geração de imagens: preços POR IMAGEM em USD (rate card em usage.ts). */
export function imageCostMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0
  return Math.ceil(usd * 1_000_000)
}
