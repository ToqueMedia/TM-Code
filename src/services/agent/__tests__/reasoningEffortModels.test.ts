import {
  EFFORT_BY_MODEL,
  effortDisplayLabel,
  getEffortOptionsForModel,
  normalizeEffortModelId,
  resolveEffectiveEffort,
  resolveEffortModelId,
  resolveEffortTurnStamp,
  shouldSendEffort,
} from '../reasoningEffortModels'

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
  it('Kimi K3 → default max, low|high|max (Moonshot)', () => {
    expect(EFFORT_BY_MODEL['kimi-k3'].default).toBe('max')
    expect(EFFORT_BY_MODEL['kimi-k3'].options).toEqual(['low', 'high', 'max'])
  })
})

describe('normalizeEffortModelId', () => {
  it('canonicaliza aliases e casing', () => {
    expect(normalizeEffortModelId('GLM-5.2')).toBe('glm-5.2')
    expect(normalizeEffortModelId('glm-5.2-fast-preview')).toBe('glm-5.2')
    expect(normalizeEffortModelId('z-ai/glm-5.2')).toBe('glm-5.2')
    expect(normalizeEffortModelId('grok-4.5-latest')).toBe('grok-4.5')
    expect(normalizeEffortModelId('grok-build-latest')).toBe('grok-4.5')
    expect(normalizeEffortModelId('kimi-k3')).toBe('kimi-k3')
    expect(normalizeEffortModelId('moonshotai/kimi-k3')).toBe('kimi-k3')
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
    expect(resolveEffectiveEffort('kimi-k3', null)).toBe('max')
  })
  it('preferência VÁLIDA para o modelo → mantida', () => {
    expect(resolveEffectiveEffort('glm-5.2', 'high')).toBe('high')
    expect(resolveEffectiveEffort('glm-5.2', 'none')).toBe('none')
    expect(resolveEffectiveEffort('glm-5.2', 'max')).toBe('max')
    expect(resolveEffectiveEffort('grok-4.5', 'low')).toBe('low')
    expect(resolveEffectiveEffort('kimi-k3', 'high')).toBe('high')
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
    expect(resolveEffectiveEffort('kimi-k3', 'medium')).toBe('max')
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

  it('Kimi K3: low|high|max nativos, default max; medium inválido → max', () => {
    expect(resolveEffectiveEffort('kimi-k3', null)).toBe('max')
    expect(resolveEffectiveEffort('kimi-k3', 'low')).toBe('low')
    expect(resolveEffectiveEffort('kimi-k3', 'high')).toBe('high')
    expect(resolveEffectiveEffort('kimi-k3', 'max')).toBe('max')
    // medium é do Grok — não existe no Kimi → default max (não 400)
    expect(resolveEffectiveEffort('kimi-k3', 'medium')).toBe('max')
    expect(resolveEffectiveEffort('kimi-k3', 'none')).toBe('max')
    expect(resolveEffortTurnStamp('kimi-k3', 'low')).toEqual({
      effort: 'low',
      sent: true,
    })
    expect(normalizeEffortModelId('moonshotai/kimi-k3')).toBe('kimi-k3')
    expect(shouldSendEffort('kimi-k3')).toBe(true)
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
    expect(shouldSendEffort('kimi-k3')).toBe(true)
  })
  it('modelo NÃO-mapeado (não-null) → NÃO envia', () => {
    expect(shouldSendEffort('gpt-qualquer')).toBe(false)
    expect(shouldSendEffort('mimo-v2.5')).toBe(false)
  })
})
