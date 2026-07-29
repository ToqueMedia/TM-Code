/**
 * Context Planner — tipos + parser do plano de contexto.
 *
 * Já NÃO planeia nada por modelo: o pré-voo por LLM foi apagado (ver a nota
 * onde vivia planContextWithModel). A seleção é determinista, feita no
 * ContextBuilder, e o agente principal pede o resto por request_context.
 * Ficam os tipos que a telemetria de seleção usa e o parser.
 */

import {
  AUXILIARY_METAS,
  resolveAuxiliaryId,
  type ContextFallbackRisk,
  type ContextGranularity,
  type ContextPlan,
  type RouterDiagnostics,
} from './contextBuilder/auxiliaryRegistry'

type ToolGroup = NonNullable<ContextPlan['toolGroups']>[number]

export interface ContextPlanClassification {
  plan: ContextPlan
  source: 'model' | 'fallback'
  modelTier?: 'utility' | 'code'
  attempts?: number
  confidence: 'high' | 'medium' | 'low' | 'none'
  reason: string
  error?: string
  fallbackReason?: string
  diagnostics?: RouterDiagnostics
}

export class ContextPlannerError extends Error {
  diagnostics?: RouterDiagnostics
  rawOutput?: string
  fallbackReason?: string

  constructor(message: string, options?: { diagnostics?: RouterDiagnostics; rawOutput?: string; fallbackReason?: string }) {
    super(message)
    this.name = 'ContextPlannerError'
    this.diagnostics = options?.diagnostics
    this.rawOutput = options?.rawOutput
    this.fallbackReason = options?.fallbackReason
  }
}

const VALID_CONTEXT_IDS = new Set(AUXILIARY_METAS.filter(m => m.phase === 1).map(m => m.id))
const VALID_GRANULARITY = new Set<ContextGranularity>(['index', 'summary', 'full'])
const VALID_RISK = new Set<ContextFallbackRisk>(['low', 'medium', 'high'])
const VALID_TOOL_GROUPS = new Set<ToolGroup>(['FILE_OPS', 'SHELL', 'WEB', 'SUBAGENT', 'MEMORY', 'PROVISION'])



// planContextWithModel() foi APAGADO na auditoria de 2026-07-28.
//
// Era o pré-voo por modelo: até 3 tentativas no sidecar utility + 1 no modelo
// de código, 60s cada, EM SÉRIE, antes do primeiro token do agente principal —
// ~4 minutos no pior caso, para uma decisão que o modelo principal toma melhor
// e de graça (request_context on demand). Estava desligado por uma flag local
// com um convite a religar, o que é a forma mais cara de código morto: parece
// reversível, mas o que a flag reabria era essa latência.
//
// O que sobra aqui é o PARSER (usado por testes e por qualquer futuro
// consumidor) e os tipos que a telemetria de seleção ainda usa.
export function parseContextPlanJson(
  text: string,
  diagnostics?: RouterDiagnostics,
): ContextPlanClassification | null {
  const raw = text.trim()
  const extracted = extractJsonObject(raw)
  if (!extracted) {
    if (diagnostics) diagnostics.parseError = describeJsonExtractionFailure(raw)
    return null
  }

  // Attempt 1 — strict parse + schema validation.
  const first = tryParseAndValidate(extracted, diagnostics)
  if (first) return first

  // Attempt 2 (single repair) — fix common LLM JSON mistakes, then re-parse.
  // Only runs when the repair actually changed the text, so a schema failure
  // (not a syntax failure) does not waste a second identical parse.
  const repaired = repairJson(extracted)
  if (repaired !== extracted) {
    const second = tryParseAndValidate(repaired, diagnostics)
    if (second) return second
    if (diagnostics) diagnostics.parseError = `repair attempt also failed: ${diagnostics.parseError ?? 'unknown'}`
  }

  return null
}

/** Strip markdown fences (if any) and return the substring from the first
 *  `{` to the last `}`, or null when no JSON object can be located. */
function extractJsonObject(text: string): string | null {
  let cleaned = text.trim()
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n')
    if (firstNewline !== -1) {
      const inner = cleaned.slice(firstNewline + 1)
      const closeIdx = inner.lastIndexOf('```')
      if (closeIdx !== -1) cleaned = inner.slice(0, closeIdx).trim()
    }
  }
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return cleaned.slice(start, end + 1)
}

function describeJsonExtractionFailure(text: string): string {
  if (!text) return 'empty content from context planner'
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && (end === -1 || end <= start)) {
    return `incomplete JSON object in content (len=${text.length}, startsAt=${start})`
  }
  return `no JSON object found in content (len=${text.length})`
}

/** Parse + schema-validate. Returns null (and sets diagnostics.parseError)
 *  on either a JSON syntax error or a schema violation. */
function tryParseAndValidate(
  jsonStr: string,
  diagnostics?: RouterDiagnostics,
): ContextPlanClassification | null {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(jsonStr) as Record<string, unknown>
  } catch (parseErr) {
    if (diagnostics) diagnostics.parseError = `JSON.parse failed: ${String(parseErr)}`
    return null
  }
  const shape = validateContextPlanShape(obj)
  if (!shape.ok) {
    if (diagnostics) diagnostics.parseError = `schema validation failed: ${shape.error}`
    return null
  }
  // Success — clear any stale parseError left by an earlier failed attempt
  // (e.g. the strict parse failed, then the repair attempt succeeded).
  if (diagnostics) diagnostics.parseError = undefined
  return buildClassificationFromObject(obj, diagnostics)
}

/** Schema gate applied BEFORE the plan is trusted. A plan missing
 *  taskDomain or carrying a non-array selectedContexts is rejected — the
 *  previous behaviour silently defaulted taskDomain to 'bugfix_local',
 *  which masked planner failures as success. */
function validateContextPlanShape(
  obj: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  if (typeof obj.taskDomain !== 'string' || obj.taskDomain.trim() === '') {
    return { ok: false, error: 'taskDomain must be a non-empty string' }
  }
  if (!Array.isArray(obj.selectedContexts)) {
    return { ok: false, error: 'selectedContexts must be an array' }
  }
  if (obj.requiredCapabilities !== undefined && !Array.isArray(obj.requiredCapabilities)) {
    return { ok: false, error: 'requiredCapabilities must be an array when present' }
  }
  return { ok: true }
}

/** Single, conservative repair pass: strip non-printable control chars and
 *  remove trailing commas before } or ]. Intentionally narrow — we do not
 *  touch quotes or keys, which would risk corrupting string values. */
function repairJson(text: string): string {
  let out = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
  out = out.replace(/,(\s*[}\]])/g, '$1')
  return out
}

function buildClassificationFromObject(
  obj: Record<string, unknown>,
  diagnostics?: RouterDiagnostics,
): ContextPlanClassification {
  const selectedContexts = normalizeContextIds(obj.selectedContexts)
  const candidateContexts = includeSelectedCandidates(
    normalizeContextIds(obj.candidateContexts),
    selectedContexts,
  )
  const minimumContextNeeded = VALID_GRANULARITY.has(obj.minimumContextNeeded as ContextGranularity)
    ? obj.minimumContextNeeded as ContextGranularity
    : 'summary'
  const fallbackRisk = VALID_RISK.has(obj.fallbackRisk as ContextFallbackRisk)
    ? obj.fallbackRisk as ContextFallbackRisk
    : 'medium'
  const toolGroups = normalizeToolGroups(obj.toolGroups)
  const requiredCapabilities = Array.isArray(obj.requiredCapabilities)
    ? obj.requiredCapabilities.filter((v): v is string => typeof v === 'string').slice(0, 8)
    : []
  const rawConfidence = typeof obj.confidence === 'string' ? obj.confidence.toLowerCase() : ''
  const confidence: 'high' | 'medium' | 'low' =
    rawConfidence === 'high' ? 'high' : rawConfidence === 'low' ? 'low' : 'medium'
  const reason = typeof obj.reason === 'string' && obj.reason ? obj.reason : 'model context planning'
  const rejectedContexts = deriveRejectedContexts(
    normalizeContextIds(obj.rejectedContexts),
    candidateContexts,
    selectedContexts,
  )

  return {
    plan: {
      taskDomain: obj.taskDomain as string,
      requiredCapabilities,
      minimumContextNeeded,
      candidateContexts,
      selectedContexts,
      rejectedContexts,
      toolGroups,
      fallbackRisk,
      reason,
    },
    source: 'model',
    confidence,
    reason,
    diagnostics,
  }
}

/** Contexts considered but not selected. Merges any explicit
 *  rejectedContexts the model supplied with the derived set
 *  (candidateContexts minus selectedContexts); selected ids are never
 *  reported as rejected. */
function deriveRejectedContexts(
  explicit: string[],
  candidateContexts: string[],
  selectedContexts: string[],
): string[] {
  const selectedSet = new Set(selectedContexts)
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of [...explicit, ...candidateContexts]) {
    if (selectedSet.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function normalizeContextIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = resolveAuxiliaryId(item)
    if (!VALID_CONTEXT_IDS.has(id) || out.includes(id)) continue
    out.push(id)
  }
  return out
}

function normalizeToolGroups(value: unknown): ToolGroup[] {
  if (!Array.isArray(value)) return []
  const out: ToolGroup[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const group = item as ToolGroup
    if (!VALID_TOOL_GROUPS.has(group) || out.includes(group)) continue
    out.push(group)
  }
  return out
}

function includeSelectedCandidates(candidateContexts: string[], selectedContexts: string[]): string[] {
  const out = [...candidateContexts]
  for (const id of selectedContexts) {
    if (!out.includes(id)) out.push(id)
  }
  return out
}
