import {
  EFFORT_BY_MODEL,
  effortDisplayLabel,
  getEffortOptionsForModel,
  isPublishedEffortOptions,
  normalizeEffortModelId,
  parseReasoningEffortsHeader,
  currentPublishedEffortOptions,
  resolveEffectiveEffort,
  resolveEffortModelId,
  resolveEffortTurnStamp,
  shouldSendEffort,
} from '../reasoningEffortModels'
import { usePersonaStore } from '../../../stores/personaStore'
import { useActiveModelStore } from '../../../stores/activeModelStore'
import { useAgentStore } from '../../../stores/agentStore'

/**
 * Mapa FRONTEND de effort por modelo + resolução do valor EFETIVO.
 * GLM: só níveis reais (none|high|max) após probe z.AI 2026-07-23.
 */

describe('EFFORT_BY_MODEL — official product levels', () => {
  it('GLM 5.2 → none|high|max (aliases removidos), default max', () => {
    expect(EFFORT_BY_MODEL['glm-5.2'].default).toBe('max')
    expect(EFFORT_BY_MODEL['glm-5.2'].options).toEqual(['none', 'high', 'max'])
  })
  it('Grok 4.5 → default high, low|medium|high (xAI)', () => {
    expect(EFFORT_BY_MODEL['grok-4.5'].default).toBe('high')
    expect(EFFORT_BY_MODEL['grok-4.5'].options).toEqual(['low', 'medium', 'high'])
  })
})

describe('normalizeEffortModelId', () => {
  it('canonicaliza aliases e casing', () => {
    expect(normalizeEffortModelId('GLM-5.2')).toBe('glm-5.2')
    expect(normalizeEffortModelId('glm-5.2-fast-preview')).toBe('glm-5.2')
    expect(normalizeEffortModelId('z-ai/glm-5.2')).toBe('glm-5.2')
    expect(normalizeEffortModelId('grok-4.5-latest')).toBe('grok-4.5')
    expect(normalizeEffortModelId('grok-build-latest')).toBe('grok-4.5')
  })
  it('null / vazio → null', () => {
    expect(normalizeEffortModelId(null)).toBeNull()
    expect(normalizeEffortModelId('  ')).toBeNull()
  })
})

describe('getEffortOptionsForModel', () => {
  it('modelo conhecido / alias → as suas options', () => {
    expect(getEffortOptionsForModel('grok-4.5-latest').default).toBe('high')
    expect(getEffortOptionsForModel('GLM-5.2').default).toBe('max')
    expect(getEffortOptionsForModel('glm-5.2').options).toEqual(['none', 'high', 'max'])
  })
  it('null / desconhecido → default GLM', () => {
    expect(getEffortOptionsForModel(null).default).toBe('max')
    expect(getEffortOptionsForModel('modelo-que-nao-existe').default).toBe('max')
  })
})

describe('resolveEffectiveEffort — preferência-se-válida-senão-default', () => {
  it('sem preferência → default oficial do modelo', () => {
    expect(resolveEffectiveEffort('glm-5.2', null)).toBe('max')
    expect(resolveEffectiveEffort('grok-4.5', null)).toBe('high')
  })
  it('preferência VÁLIDA para o modelo → mantida', () => {
    expect(resolveEffectiveEffort('glm-5.2', 'high')).toBe('high')
    expect(resolveEffectiveEffort('glm-5.2', 'none')).toBe('none')
    expect(resolveEffectiveEffort('glm-5.2', 'max')).toBe('max')
    expect(resolveEffectiveEffort('grok-4.5', 'low')).toBe('low')
  })
  it('preferências LEGADAS do GLM (lista de 7) → nível real', () => {
    // Docs: low/medium → high; xhigh → max; minimal → none.
    expect(resolveEffectiveEffort('glm-5.2', 'low')).toBe('high')
    expect(resolveEffectiveEffort('glm-5.2', 'medium')).toBe('high')
    expect(resolveEffectiveEffort('glm-5.2', 'minimal')).toBe('none')
    expect(resolveEffectiveEffort('glm-5.2', 'xhigh')).toBe('max')
  })
  it('preferência INVÁLIDA para o modelo → cai no default (regra da troca)', () => {
    expect(resolveEffectiveEffort('grok-4.5', 'xhigh')).toBe('high')
    expect(resolveEffectiveEffort('grok-4.5', 'max')).toBe('high')
  })
  it('modelo desconhecido/null → escala UI do GLM; NÃO aplica alias legado low→high', () => {
    // Bug fix Grok: com modelId null, selected=low NÃO deve virar high
    // (o alias legado só vale para glm-5.2 real). low não está nas options
    // do fallback GLM → cai no default max.
    expect(resolveEffectiveEffort(null, null)).toBe('max')
    expect(resolveEffectiveEffort(null, 'high')).toBe('high')
    expect(resolveEffectiveEffort(null, 'low')).toBe('max')
    expect(resolveEffectiveEffort(null, 'medium')).toBe('max')
  })

  it('Grok: low/medium/high nativos, sem alias GLM', () => {
    expect(resolveEffectiveEffort('grok-4.5', 'low')).toBe('low')
    expect(resolveEffectiveEffort('grok-4.5', 'medium')).toBe('medium')
    expect(resolveEffectiveEffort('grok-4.5', 'high')).toBe('high')
    expect(resolveEffectiveEffort('grok-4.5', null)).toBe('high')
    // max inválido no Grok → default high
    expect(resolveEffectiveEffort('grok-4.5', 'max')).toBe('high')
  })

  // Kimi K3 saiu do catálogo gerido a 2026-08-11: o id já não está mapeado,
  // portanto shouldSendEffort('kimi-k3') é false e a escala cai no default
  // GLM (o comportamento de qualquer modelo desconhecido). BYOK Kimi continua
  // a funcionar — o header simplesmente deixa de ir pré-preenchido.
  it('Kimi K3 (fora do catálogo): effort não é enviado', () => {
    expect(shouldSendEffort('kimi-k3')).toBe(false)
  })

  // Qwen 3.7 Plus (modelo principal desde 2026-08-07): híbrido por BOOLEAN.
  // A escala graded (low/medium/xhigh) é do 3.8-max — enviada aqui cairia no
  // default, que é exactamente o que evita o 400 upstream.
  it('Qwen 3.7 Plus: off|on, default on; valores graded inválidos → on', () => {
    expect(resolveEffectiveEffort('qwen3.7-plus', null)).toBe('on')
    expect(resolveEffectiveEffort('qwen3.7-plus', 'off')).toBe('off')
    expect(resolveEffectiveEffort('qwen3.7-plus', 'on')).toBe('on')
    expect(resolveEffectiveEffort('qwen3.7-plus', 'xhigh')).toBe('on')
    expect(resolveEffectiveEffort('qwen3.7-plus', 'max')).toBe('on')
    // Snapshot datado do mesmo modelo canonicaliza para a mesma chave.
    expect(normalizeEffortModelId('qwen3.7-plus-2026-05-26')).toBe('qwen3.7-plus')
    expect(shouldSendEffort('qwen3.7-plus')).toBe(true)
    expect(resolveEffortTurnStamp('qwen3.7-plus', 'off')).toEqual({
      effort: 'off',
      sent: true,
    })
  })

  // O MiMo saiu do catálogo gerido a 2026-08-07: deixou de estar mapeado,
  // portanto o header X-TM-Reasoning-Effort já não sai para ele.
  it('MiMo saiu do mapa — não-mapeado, header não sai', () => {
    expect(shouldSendEffort('mimo-v2.5-pro')).toBe(false)
    expect(normalizeEffortModelId('mimo-v2.5-pro')).toBe('mimo-v2.5-pro')
  })
})

describe('resolveEffortModelId', () => {
  // INVERSÃO 2026-08-05 (Personas): o header X-TM-Model (o que REALMENTE
  // serviu) manda; o Firestore (espelho da Standard) é o fallback. Antes era
  // ao contrário e o selector mostrava a escala do GLM com Standard=MiMo.
  it('servido (X-TM-Model) primeiro, Firestore como fallback', () => {
    expect(resolveEffortModelId('grok-4.5', 'glm-5.2')).toBe('glm-5.2')
    expect(resolveEffortModelId(null, 'grok-4.5')).toBe('grok-4.5')
    expect(resolveEffortModelId('grok-4.5', null)).toBe('grok-4.5')
    expect(resolveEffortModelId(null, null)).toBeNull()
    expect(resolveEffortModelId('kimi-k3', '  ')).toBe('kimi-k3')
  })
})

describe('resolveEffortTurnStamp — carimbo por turno', () => {
  it('modelo mapeado → effort + sent:true', () => {
    expect(resolveEffortTurnStamp('glm-5.2', 'high')).toEqual({
      effort: 'high',
      sent: true,
    })
    expect(resolveEffortTurnStamp('glm-5.2', null)).toEqual({
      effort: 'max',
      sent: true,
    })
  })
  it('modelo desconhecido → effort da UI mas sent:false (header não sai)', () => {
    expect(resolveEffortTurnStamp(null, 'high')).toEqual({
      effort: 'high',
      sent: false,
    })
    // Unmapped: options caem no mapa GLM (high é válido na lista de display)
    // mas shouldSendEffort=false → o provider NÃO recebe o header.
    expect(resolveEffortTurnStamp('mimo-v2.5', 'high')).toEqual({
      effort: 'high',
      sent: false,
    })
    expect(resolveEffortTurnStamp('mimo-v2.5', null)).toEqual({
      effort: 'max',
      sent: false,
    })
  })
  it('effortDisplayLabel capitaliza', () => {
    expect(effortDisplayLabel('high')).toBe('High')
    expect(effortDisplayLabel('max')).toBe('Max')
    expect(effortDisplayLabel('xhigh')).toBe('xHigh')
  })
})

describe('shouldSendEffort — guarda contra params inválidos', () => {
  it('null/undefined (pré-deteção) → NÃO envia (max GLM invalidaria Grok)', () => {
    expect(shouldSendEffort(null)).toBe(false)
    expect(shouldSendEffort(undefined)).toBe(false)
    expect(shouldSendEffort('')).toBe(false)
  })
  it('modelo mapeado / alias → envia', () => {
    expect(shouldSendEffort('glm-5.2')).toBe(true)
    expect(shouldSendEffort('GLM-5.2')).toBe(true)
    expect(shouldSendEffort('glm-5.2-fast-preview')).toBe(true)
    expect(shouldSendEffort('grok-4.5')).toBe(true)
    expect(shouldSendEffort('grok-4.5-latest')).toBe(true)
  })
  it('modelo NÃO-mapeado (não-null) → NÃO envia', () => {
    expect(shouldSendEffort('gpt-qualquer')).toBe(false)
    expect(shouldSendEffort('mimo-v2.5')).toBe(false)
  })
})

/**
 * GLM-5.2 pelo Cloudflare Workers AI (2026-08-10) — o MESMO modelo servido por
 * três provedores, com escalas de effort diferentes.
 *
 * O bug reportado: a UI mostrava `MAX` para a via Cloudflare.
 * `normalizeEffortModelId` corta no último `/` (para aceitar prefixos de
 * catálogo como `z-ai/glm-5.2`), e nesse corte `@cf/zai-org/glm-5.2` vira
 * `glm-5.2` — herdando `none|high|max` do z.AI/DashScope. O `max` não existe
 * no conjunto que o Workers AI declara (texto da OpenAI → low|medium|high).
 *
 * É o mesmo detector-por-nome que o `isCloudflareAI` do data-plane evita.
 */
describe('GLM-5.2 multi-provider — escala de effort por VIA', () => {
  const CF = '@cf/zai-org/glm-5.2'

  it('o id do Workers AI NÃO colapsa na chave do z.AI/DashScope', () => {
    expect(normalizeEffortModelId(CF)).toBe('glm-5.2-cloudflare')
    expect(normalizeEffortModelId('glm-5.2')).toBe('glm-5.2')
  })

  it('não oferece max — o valor que causou o report', () => {
    const opts = getEffortOptionsForModel(CF)
    expect(opts.options).toEqual(['low', 'medium', 'high'])
    expect(opts.options).not.toContain('max')
    expect(opts.default).toBe('high')
  })

  it('as outras duas vias mantêm a escala delas', () => {
    const opts = getEffortOptionsForModel('glm-5.2')
    expect(opts.options).toEqual(['none', 'high', 'max'])
    expect(opts.default).toBe('max')
  })

  it('o prefixo de catálogo z-ai/ continua a ser z.AI, não Cloudflare', () => {
    // `z-ai` (OpenRouter) e `zai-org` (autor no catálogo Cloudflare) são
    // strings diferentes de propósito — não podem colidir.
    expect(normalizeEffortModelId('z-ai/glm-5.2')).toBe('glm-5.2')
  })

  it('uma preferência max herdada do z.AI cai no default do Cloudflare', () => {
    // Sem isto o header levava um valor fora do conjunto do endpoint.
    expect(resolveEffectiveEffort(CF, 'max')).toBe('high')
    expect(resolveEffectiveEffort(CF, 'none')).toBe('high')
    expect(resolveEffectiveEffort(CF, 'low')).toBe('low')
    expect(resolveEffectiveEffort(CF, 'medium')).toBe('medium')
  })

  it('o alias legado do GLM NÃO se aplica ao Cloudflare — low ali é low', () => {
    // No z.AI `low` é alias de `high`; no Cloudflare `low` existe mesmo.
    expect(resolveEffectiveEffort('glm-5.2', 'low')).toBe('high')
    expect(resolveEffectiveEffort(CF, 'low')).toBe('low')
  })

  it('continua a enviar o header — a chave está mapeada', () => {
    expect(shouldSendEffort(CF)).toBe(true)
  })
})

const DEEPSEEK_PUBLISHED = {
  param: 'reasoning_effort' as const,
  options: ['low', 'medium', 'high'],
  default: 'high',
}

describe('shape publicada (catálogo / header) — modelo fora do mapa local', () => {
  it('isPublishedEffortOptions rejeita blocos incompletos', () => {
    expect(isPublishedEffortOptions(DEEPSEEK_PUBLISHED)).toBe(true)
    expect(isPublishedEffortOptions({ param: 'reasoning_effort', options: [], default: 'high' })).toBe(false)
    expect(isPublishedEffortOptions({ param: 'nope', options: ['low'], default: 'low' })).toBe(false)
  })

  it('um modelo desconhecido COM thinking publicado mostra essa escala e envia o header', () => {
    expect(getEffortOptionsForModel('deepseek-v4-flash', DEEPSEEK_PUBLISHED)).toEqual(DEEPSEEK_PUBLISHED)
    expect(shouldSendEffort('deepseek-v4-flash', DEEPSEEK_PUBLISHED)).toBe(true)
    expect(resolveEffectiveEffort('deepseek-v4-flash', null, DEEPSEEK_PUBLISHED)).toBe('high')
    expect(resolveEffectiveEffort('deepseek-v4-flash', 'low', DEEPSEEK_PUBLISHED)).toBe('low')
    expect(resolveEffectiveEffort('deepseek-v4-flash', 'max', DEEPSEEK_PUBLISHED)).toBe('high')
    expect(resolveEffortTurnStamp('deepseek-v4-flash', 'medium', DEEPSEEK_PUBLISHED)).toEqual({
      effort: 'medium',
      sent: true,
    })
  })

  it('sem shape publicada, um modelo desconhecido continua a NÃO enviar o header', () => {
    expect(shouldSendEffort('deepseek-v4-flash')).toBe(false)
    expect(resolveEffortTurnStamp('deepseek-v4-flash', 'high').sent).toBe(false)
  })

  it('a shape publicada vence o mapa local (admin pode encolher a escala do GLM)', () => {
    const published = { param: 'reasoning_effort' as const, options: ['high', 'max'], default: 'max' }
    expect(getEffortOptionsForModel('glm-5.2', published).options).toEqual(['high', 'max'])
    expect(resolveEffectiveEffort('glm-5.2', 'none', published)).toBe('max')
  })
})

describe('parseReasoningEffortsHeader', () => {
  it('lê o formato k=v do data-plane', () => {
    expect(parseReasoningEffortsHeader('param=reasoning_effort;default=high;options=low,medium,high'))
      .toEqual(DEEPSEEK_PUBLISHED)
  })

  it('lê JSON', () => {
    expect(parseReasoningEffortsHeader(JSON.stringify(DEEPSEEK_PUBLISHED))).toEqual(DEEPSEEK_PUBLISHED)
  })

  it('ausente / inválido → null', () => {
    expect(parseReasoningEffortsHeader(null)).toBeNull()
    expect(parseReasoningEffortsHeader('')).toBeNull()
    expect(parseReasoningEffortsHeader('param=nope;default=x;options=x')).toBeNull()
    expect(parseReasoningEffortsHeader('param=reasoning_effort;default=max;options=low,high')).toBeNull()
  })
})

describe('currentPublishedEffortOptions', () => {
  it('prefere o thinking da persona selecionada ao header servido', () => {
    usePersonaStore.setState({ selected: 'expert' })
    useActiveModelStore.setState({
      personaModels: {
        expert: { modelId: 'deepseek-v4-flash', thinking: DEEPSEEK_PUBLISHED },
      },
    })
    useAgentStore.setState({
      reasoningEffortOptions: { param: 'enable_thinking', options: ['off', 'on'], default: 'on' },
    })
    expect(currentPublishedEffortOptions()).toEqual(DEEPSEEK_PUBLISHED)

    useActiveModelStore.setState({ personaModels: {} })
    expect(currentPublishedEffortOptions()).toEqual({
      param: 'enable_thinking',
      options: ['off', 'on'],
      default: 'on',
    })

    useAgentStore.setState({ reasoningEffortOptions: null })
    expect(currentPublishedEffortOptions()).toBeNull()
  })
})
