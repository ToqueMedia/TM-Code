/**
 * Aplica o reasoning-effort do utilizador (header X-TM-Reasoning-Effort) ao
 * body OpenAI-compatible antes do upstream.
 *
 * O frontend manda o valor NATIVO (mapa reasoningEffortModels.ts). Aqui:
 *   1. escreve sempre `reasoning_effort` (override do extraBody da KV)
 *   2. ajusta campos companion POR PROVIDER para o effort realmente contar
 *      (sem isto, DashScope com enable_thinking:false no extraBody ignora o
 *      effort — a prioridade de enable_thinking está documentada).
 *
 * Docs (2026-07):
 * - GLM 5.2 z.AI: thinking.type + reasoning_effort
 *   https://docs.z.ai/guides/capabilities/thinking
 * - GLM 5.2 DashScope: enable_thinking tem prioridade sobre reasoning_effort
 *   https://help.aliyun.com/en/model-studio/glm
 * - Grok 4.5: só reasoning_effort (low|medium|high); nunca thinking
 *   https://docs.x.ai/developers/model-capabilities/text/reasoning
 * - Kimi K3: só reasoning_effort (low|high|max); NÃO enviar thinking
 *   https://platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model
 */

export interface ApplyReasoningEffortCtx {
  provider: string
  baseUrl: string
  model: string
}

function lower(s: string): string {
  return (s ?? '').toLowerCase()
}

function isDashScope(ctx: ApplyReasoningEffortCtx): boolean {
  const p = lower(ctx.provider)
  const b = lower(ctx.baseUrl)
  return (
    p === 'dashscope' ||
    p === 'aliyun' ||
    b.includes('dashscope') ||
    b.includes('aliyuncs.com') ||
    b.includes('maas.aliyuncs.com')
  )
}

function isZai(ctx: ApplyReasoningEffortCtx): boolean {
  const p = lower(ctx.provider)
  const b = lower(ctx.baseUrl)
  return (
    p === 'zai' ||
    p === 'z.ai' ||
    p === 'zhipu' ||
    p === 'bigmodel' ||
    b.includes('z.ai') ||
    b.includes('bigmodel.cn') ||
    b.includes('open.bigmodel')
  )
}

function isMoonshot(ctx: ApplyReasoningEffortCtx): boolean {
  const p = lower(ctx.provider)
  const b = lower(ctx.baseUrl)
  const m = lower(ctx.model)
  // provider pode ser `moonshot`, `moonshotai`, `kimi`, …
  return (
    p.includes('moonshot') ||
    p.includes('kimi') ||
    b.includes('moonshot') ||
    b.includes('kimi.ai') ||
    m.startsWith('kimi-k3') ||
    m.startsWith('kimi-k2')
  )
}

function isKimiK3(model: string): boolean {
  return lower(model).startsWith('kimi-k3')
}

function isXai(ctx: ApplyReasoningEffortCtx): boolean {
  const p = lower(ctx.provider)
  const b = lower(ctx.baseUrl)
  const m = lower(ctx.model)
  return (
    p === 'xai' ||
    p === 'x.ai' ||
    b.includes('api.x.ai') ||
    m.startsWith('grok-')
  )
}

function isGlmModel(model: string): boolean {
  return lower(model).includes('glm')
}

/**
 * Effort que desliga o thinking no GLM.
 * Frontend só expõe `none|high|max`, mas aceitamos `minimal` (legado) como off.
 */
function isOffEffort(effort: string): boolean {
  return effort === 'none' || effort === 'minimal'
}

/**
 * Mutates `body` in place. No-op when effort is empty.
 * Always runs AFTER extraBody merge so the user choice wins.
 */
export function applyReasoningEffort(
  body: Record<string, unknown>,
  effortRaw: string,
  ctx: ApplyReasoningEffortCtx,
): void {
  const effort = effortRaw.trim()
  if (!effort) return

  // Valor nativo — o frontend já validou contra as options do modelo.
  body.reasoning_effort = effort

  // Moonshot / Kimi:
  // - K3: NÃO enviar `thinking` (docs); só `reasoning_effort` (low|high|max).
  // - K2.x: thinking toggle existe, mas o managed path controla effort via
  //   reasoning_effort quando o admin o publica — limpar companions errados.
  // - K3 rejeita temperature ≠ 1 com 400 ("only 1 is allowed"). Se a KV
  //   extraBody ou um merge meteu temperature, removemos (omit = default OK).
  if (isMoonshot(ctx)) {
    delete body.thinking
    delete body.enable_thinking
    if (isKimiK3(ctx.model)) {
      const temp = body.temperature
      if (temp !== undefined && temp !== 1 && temp !== 1.0) {
        delete body.temperature
      }
      // sampling knobs que a API K3 fixa / rejeita em alguns SKUs
      delete body.top_p
      delete body.frequency_penalty
      delete body.presence_penalty
      delete body.n
    }
    return
  }

  // Grok 4.5: só reasoning_effort; reasoning não se desliga.
  if (isXai(ctx)) {
    delete body.thinking
    delete body.enable_thinking
    return
  }

  // DashScope GLM: enable_thinking tem PRIORIDADE sobre reasoning_effort.
  // Sem alinhar o flag, effort=high com enable_thinking:false (extraBody) =
  // zero reasoning e UX "mensagem vazia de thinking".
  if (isDashScope(ctx) && isGlmModel(ctx.model)) {
    body.enable_thinking = !isOffEffort(effort)
    return
  }

  // z.AI GLM: thinking.type + reasoning_effort (docs Deep Thinking).
  if (isZai(ctx) && isGlmModel(ctx.model)) {
    body.thinking = { type: isOffEffort(effort) ? 'disabled' : 'enabled' }
    return
  }

  // Outros providers (ou GLM noutro host): só reasoning_effort basta.
}
