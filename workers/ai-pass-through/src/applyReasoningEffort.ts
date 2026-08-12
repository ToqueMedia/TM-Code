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

import {
  bareModel,
  isCloudflareAI,
  isDashScope,
  isMoonshot,
  isXAI as isXai,
  isZAI as isZai,
} from './providers'

export interface ApplyReasoningEffortCtx {
  provider: string
  baseUrl: string
  model: string
}

function lower(s: string): string {
  return (s ?? '').toLowerCase()
}

// Detectores de família e bareModel vivem em providers.ts (partilhados com o
// pricing.ts desde o metering 30/70) — uma definição, não duas.
function isKimiK3(model: string): boolean {
  return bareModel(model).startsWith('kimi-k3')
}

function isGlmModel(model: string): boolean {
  return lower(model).includes('glm')
}

// `isCloudflareAI` vive em providers.ts desde que ganhou um segundo consumidor
// (a afinidade de sessão em index.ts). Uma definição, não duas.

/**
 * Família Qwen 3.7 na DashScope (3.7-plus é modelo principal desde 2026-08-07;
 * 3.7-flash serve o sidecar utility). Híbrida por BOOLEAN `enable_thinking` —
 * `reasoning_effort` graded é do 3.8-max, não desta série.
 */
function isQwen37(ctx: ApplyReasoningEffortCtx): boolean {
  return isDashScope(ctx) && bareModel(ctx.model).startsWith('qwen3.7')
}

function isMimo(ctx: ApplyReasoningEffortCtx): boolean {
  const p = lower(ctx.provider)
  const b = lower(ctx.baseUrl)
  return p === 'mimo' || b.includes('xiaomimimo.com') || bareModel(ctx.model).startsWith('mimo-')
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
  // GLM no Cloudflare Workers AI: a doc do modelo declara `reasoning_effort`
  // com a descrição da OpenAI ("Constrains effort on reasoning for reasoning
  // models (o1, o3-mini, …)"), portanto o conjunto válido é o da OpenAI —
  // low|medium|high. NÃO se manda 'max' como no z.AI/DashScope: é um valor
  // fora desse conjunto e este ficheiro existe para não enviar parâmetros que
  // o provedor não aceita.
  if (isGlmModel(ctx.model) && isCloudflareAI(ctx)) return 'high'
  // MiMo hospedado: default 'off' por recomendação OFICIAL da Xiaomi para
  // tool calling — todo o tráfego TM é agentic. VERIFICADO na fonte a
  // 2026-08-06 (mimo.mi.com/docs/en-US/quick-start/faq/api-integration),
  // citação exacta: "The appearance of `tool_calls` in the reasoning content
  // indicates instability and incomplete output caused by the model having
  // `thinking` enabled when calling `tool`. It is recommended to disable
  // `thinking` when calling `tool` calls".
  //
  // O DEFAULT da API quando o campo é omitido NÃO está verificado: nenhuma
  // página do mimo.mi.com o declara, e a receita vLLM do mesmo modelo diz o
  // contrário do que aqui se afirmava antes ("Set enable_thinking: false (or
  // omit the kwargs) to disable thinking mode"). É indiferente na prática —
  // este ramo escreve o campo SEMPRE — e por isso a afirmação saiu daqui em
  // vez de continuar a ser repetida sem fonte.
  if (isMimo(ctx)) return 'off'
  // Qwen 3.8 Max (swap 2026-08-04): low|medium|xhigh, default xhigh — o
  // extraBody da KV já traz reasoning_effort:'xhigh', isto cobre o caso de
  // uma KV publicada sem ele + mantém o guarda-espelho do frontend honesto.
  if (isDashScope(ctx) && bareModel(ctx.model).startsWith('qwen3.8-max')) return 'xhigh'
  // Qwen 3.7 PLUS como modelo principal (2026-08-07): híbrido por boolean,
  // default ON (o ramo de aplicação traduz para enable_thinking). Restrito ao
  // `-plus`: o `-flash` da mesma família serve o sidecar:utility e o default
  // dele é enable_thinking:FALSE, publicado na config — um default 'on' aqui
  // ligava-lhe o thinking sempre que o effort chegasse vazio.
  if (isDashScope(ctx) && bareModel(ctx.model).startsWith('qwen3.7-plus')) return 'on'
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

  // MiMo hospedado (thinking_object on/off, SEM reasoning_effort): traduz o
  // toggle para thinking:{type} e NÃO envia reasoning_effort (param não
  // documentado na API da Xiaomi). Ramo ANTES da escrita genérica abaixo.
  //
  // A FORMA está VERIFICADA (2026-08-06) na página de compatibilidade OpenAI
  // do próprio endpoint que este ramo serve — mimo.mi.com/docs/en-US/api/chat/
  // openai-api, cujo exemplo de request traz `"thinking": {"type":"disabled"}`.
  // `api.xiaomimimo.com` é o host que `isMimo` casa.
  //
  // NÃO confundir com `chat_template_kwargs: {enable_thinking: bool}`: essa é
  // a forma do MiMo servido por vLLM self-host / Aliyun Model Studio, e é
  // exactamente por isso que o BYOK tem `mimo_chat_template_kwargs` como
  // thinking-shape SEPARADA. Dois deployments, duas formas — não é
  // inconsistência do repo.
  //
  // AVISO da doc, ainda não coberto por código: em thinking mode o
  // mimo-v2.5-pro IGNORA `temperature` e `top_p` e força 1.0 / 0.95
  // (mimo.mi.com/docs/en-US/api/guidance/model-hyperparameters). Com o default
  // 'off' isto não morde; se alguém ligar o thinking, qualquer temperature
  // configurada para MiMo passa a ser decorativa.
  if (isMimo(ctx)) {
    body.thinking = { type: effort === 'off' ? 'disabled' : 'enabled' }
    delete body.enable_thinking
    delete body.reasoning_effort
    return
  }

  // Qwen 3.7 (DashScope): híbrido por BOOLEAN. O seletor manda 'off'/'on' e
  // aqui vira `enable_thinking` — `reasoning_effort` é APAGADO de propósito:
  // a escala graded é do 3.8-max e esta família não a documenta (mandá-la era
  // o parâmetro não suportado que este ficheiro existe para evitar).
  //
  // `preserve_thinking` entra aqui e SÓ aqui: a doc DashScope limita-o às
  // famílias qwen3.7-*/qwen3.6-*/kimi-k2.x (é a razão pela qual o ramo do GLM
  // mais abaixo não o envia). Faz o par com o round-trip de `reasoning_content`
  // que a IDE já faz — sem ele o servidor descarta o raciocínio dos turnos
  // anteriores que nós pagámos para enviar. Só com thinking ON: desligado não
  // há raciocínio a preservar.
  if (isQwen37(ctx)) {
    // GUARDA (não é zelo — é o sidecar:utility): só valores DESTA família
    // ('on'/'off') são aplicados. Um valor de outra escala ('max', 'xhigh')
    // quer dizer que o header foi calculado para o modelo PRINCIPAL e o pedido
    // acabou noutra config — tipicamente o `sidecar:utility`, que é um
    // qwen3.7-flash publicado com `enable_thinking:false` DE PROPÓSITO (bench
    // 04-08: thinking ligado = 5× latência e 5× tokens, sem ganho). Traduzir
    // um 'max' do GLM para enable_thinking:true aqui destruía essa config em
    // todos os turnos. Valor fora das options não conta — é o contrato.
    const isOn = effort === 'on'
    const isOff = effort === 'off' || isOffEffort(effort)
    if (!isOn && !isOff) return

    body.enable_thinking = isOn
    delete body.reasoning_effort
    if (isOn) body.preserve_thinking = true
    else delete body.preserve_thinking
    return
  }

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

  // Grok 4.5 (x.AI): só reasoning_effort; reasoning não se desliga.
  // A referência REST da x.AI é explícita: frequency_penalty, presence_penalty
  // e stop NÃO são suportados nos modelos de reasoning — "requests that
  // include them return an error" (docs.x.ai, chat completions). logit_bias
  // está marcado unsupported. max_tokens é deprecated → max_completion_tokens
  // (default 128k quando ausente — só conta output visível).
  if (isXai(ctx)) {
    delete body.thinking
    delete body.enable_thinking
    delete body.frequency_penalty
    delete body.presence_penalty
    delete body.stop
    delete body.logit_bias
    if (body.max_tokens !== undefined && body.max_completion_tokens === undefined) {
      body.max_completion_tokens = body.max_tokens
    }
    delete body.max_tokens
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
  // evitar. (Desde 2026-08-07 o qwen3.7-plus É modelo principal e recebe
  // `preserve_thinking` — no ramo `isQwen37` acima, com guarda de MODELO, não
  // de provider. Este ramo, que é do GLM, continua sem ele.)
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

  // GLM no Cloudflare Workers AI: `reasoning_effort` e MAIS NADA. Não leva o
  // `enable_thinking` do DashScope nem o `thinking:{type, clear_thinking}` do
  // z.AI — a doc do Workers AI não declara nenhum dos dois, e mandá-los era o
  // parâmetro não suportado que este ficheiro existe para evitar. Ramo
  // explícito (em vez de cair no fall-through) para que a intenção fique
  // escrita e um teste a possa fixar.
  if (isCloudflareAI(ctx) && isGlmModel(ctx.model)) {
    return
  }

  // Outros providers (ou GLM noutro host): só reasoning_effort basta.
}
