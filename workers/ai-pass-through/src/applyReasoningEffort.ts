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
 * Default quando o cliente NÃO manda `X-TM-Reasoning-Effort`.
 *
 * Existe para as builds da IDE já distribuídas: até este worker ser deployado
 * (2026-08) o header era ignorado, portanto há clientes lá fora que não o
 * enviam. Sem default, esses ficavam sem `reasoning_effort` E sem os campos
 * companion (`thinking.type`, `enable_thinking`) — ou seja, à mercê do que o
 * extraBody da KV tivesse.
 *
 * NÃO é `max` para todos: o Grok aceita só `low|medium|high` e `max` cairia
 * fora do conjunto — o 400 que este ficheiro existe para evitar. Os valores
 * espelham EFFORT_BY_MODEL em src/services/agent/reasoningEffortModels.ts (a
 * fonte de verdade, probada ao vivo em 2026-07-23); o teste
 * `reasoningEffortDefaults.test.ts` lê esse ficheiro e acusa se divergirem.
 *
 * Provider desconhecido devolve '' de propósito: não inventamos um valor para
 * uma API cujo conjunto válido não conhecemos.
 */
export function defaultEffortFor(ctx: ApplyReasoningEffortCtx): string {
  if (isMoonshot(ctx)) return isKimiK3(ctx.model) ? 'max' : ''
  if (isXai(ctx)) return 'high'
  if (isGlmModel(ctx.model) && (isZai(ctx) || isDashScope(ctx))) return 'max'
  return ''
}

/**
 * Mutates `body` in place. No-op when effort is empty AND the model has no
 * known default.
 * Always runs AFTER extraBody merge so the user choice wins.
 */
export function applyReasoningEffort(
  body: Record<string, unknown>,
  effortRaw: string,
  ctx: ApplyReasoningEffortCtx,
): void {
  const effort = effortRaw.trim() || defaultEffortFor(ctx)
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
  //
  // NÃO enviamos `preserve_thinking` aqui. Existe no DashScope e faz o que
  // queríamos ("pass prior reasoning to subsequent turns"), mas a doc limita-o
  // a qwen3.7-*/qwen3.6-*/kimi-k2.6/kimi-k2.7-* — **GLM não está na lista**.
  // Mandá-lo ao GLM era o parâmetro não suportado que este ficheiro existe para
  // evitar. Se um dia um qwen3.7 for o modelo principal, é aqui que entra, com
  // guarda de modelo — não por provider.
  if (isDashScope(ctx) && isGlmModel(ctx.model)) {
    body.enable_thinking = !isOffEffort(effort)
    return
  }

  // z.AI GLM: thinking.type + reasoning_effort (docs Deep Thinking).
  //
  // `clear_thinking: false` = Preserved Thinking. O default da API é `true`, e
  // a descrição é literal: "Controls whether to clear reasoning_content from
  // previous conversation turns". Ou seja, por omissão o servidor DEITA FORA o
  // raciocínio dos turnos anteriores que nós enviamos.
  //
  // Isto fecha meio contrato que estava aberto: a doc pede as duas metades —
  // `clear_thinking: false` E devolver o `reasoning_content` intacto. A segunda
  // já a cumpríamos com rigor (round-trip `_native` em query.ts, e uma
  // auditoria que recusou podá-lo); a primeira nunca foi enviada. Resultado:
  // pagávamos esses tokens em input, todos os turnos, e o servidor descartava-os.
  //
  // Só no ramo `enabled`: com `type: 'disabled'` não há raciocínio a preservar,
  // e o comportamento do campo nesse estado não está documentado.
  if (isZai(ctx) && isGlmModel(ctx.model)) {
    body.thinking = isOffEffort(effort)
      ? { type: 'disabled' }
      : { type: 'enabled', clear_thinking: false }
    return
  }

  // Outros providers (ou GLM noutro host): só reasoning_effort basta.
}
