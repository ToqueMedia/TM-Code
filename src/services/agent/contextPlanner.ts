/**
 * Context Planner — model-owned selection of on-demand context domains.
 *
 * This deliberately avoids local regex/keyword inference. The utility model
 * decides taskDomain, required capabilities, minimum context, selected
 * contexts, and initial tool groups. On failure we use a conservative profile
 * fallback that does not inspect user text.
 */

import { resolveAIWorkerUrl } from '../../utils/devUrls'
import FirebaseAuthService, { getAppCheckHeader } from '../auth/firebaseAuth'
import { logger } from '../../utils/logger'
import {
  AUXILIARY_METAS,
  fallbackContextPlanForProfile,
  resolveAuxiliaryId,
  type ContextFallbackRisk,
  type ContextGranularity,
  type ContextPlan,
  type PromptProfile,
  type RouterDiagnostics,
} from './contextBuilder/auxiliaryRegistry'

const CONTEXT_PLANNER_TIMEOUT_MS = 12_000
const CONTEXT_PLANNER_MAX_TOKENS = 1_200

type ToolGroup = NonNullable<ContextPlan['toolGroups']>[number]

export interface ContextPlanClassification {
  plan: ContextPlan
  source: 'model' | 'fallback'
  confidence: 'high' | 'medium' | 'low' | 'none'
  reason: string
  error?: string
  diagnostics?: RouterDiagnostics
}

const VALID_CONTEXT_IDS = new Set(AUXILIARY_METAS.filter(m => m.phase === 1).map(m => m.id))
const VALID_GRANULARITY = new Set<ContextGranularity>(['index', 'summary', 'full'])
const VALID_RISK = new Set<ContextFallbackRisk>(['low', 'medium', 'high'])
const VALID_TOOL_GROUPS = new Set<ToolGroup>(['FILE_OPS', 'SHELL', 'WEB', 'SUBAGENT', 'MEMORY', 'PROVISION'])

function registrySummary(): string {
  return AUXILIARY_METAS
    .filter(meta => meta.phase === 1)
    .map(meta => [
      `id=${meta.id}`,
      `domain=${meta.domain}`,
      `capability=${meta.capability}`,
      `granularity=${meta.granularity}`,
      `costTier=${meta.costTier}`,
      `whenToUse=${meta.whenToUse}`,
      `whenNotToUse=${meta.whenNotToUse}`,
      `fallbackTo=${meta.fallbackTo.join(',') || 'none'}`,
    ].join(' | '))
    .join('\n')
}

const CONTEXT_PLANNER_SYSTEM = [
  'You are a context planner for a coding agent.',
  'Choose the smallest sufficient on-demand context domains and initial tool groups for the user request.',
  '',
  'Return ONLY a single JSON object. No prose, no markdown fences, no code blocks, nothing before or after the JSON object.',
  'Shape:',
  '{"taskDomain":"...","requiredCapabilities":["..."],"minimumContextNeeded":"index|summary|full","candidateContexts":["context.id"],"selectedContexts":["context.id"],"rejectedContexts":["context.id"],"toolGroups":["FILE_OPS|SHELL|WEB|SUBAGENT|MEMORY|PROVISION"],"fallbackRisk":"low|medium|high","reason":"short reason","confidence":"high|medium|low"}',
  '',
  'Rules:',
  '- taskDomain must be a non-empty string and selectedContexts must be an array (empty is allowed). Missing or non-array selectedContexts is invalid.',
  '- Choose specific capability contexts before domain/project contexts.',
  '- Do not select project.structure_full unless files are unknown, architecture is broad, multiple modules/packages are involved, specific contexts failed, or dependency mapping spans areas.',
  '- For semantic tokens/theme work, prefer design_system.semantic_tokens and design_system.theme_config before any project structure.',
  '- For refactoring UI components that involve semantic tokens, spacing, or relative time/date formatting, select design_system.semantic_tokens and design_system.component_patterns. relative_time_formatting is a capability handled in code — do not load a context for it.',
  '- Add project.entrypoints (or project.structure_*) to selectedContexts ONLY when the target component file cannot be located from the request. Otherwise keep it out of selectedContexts; it may stay in candidateContexts as a fallback.',
  '- For MCP audits, prefer agent_runtime.mcp_routing; project structure is fallback only if implementation files must be located.',
  '- For dev server/preview/browser runtime issues, prefer delivery.dev_server and optionally delivery.build_scripts/project.package_map.',
  '- For git/commit/diff/branch tasks, prefer delivery.git_status and delivery.changed_files.',
  '- For visual UI polish, prefer design_system.component_patterns, design_system.semantic_tokens, and ui_patterns.',
  '- Keep selectedContexts minimal. Put fallback candidates in candidateContexts instead of selectedContexts.',
  '- rejectedContexts lists candidate contexts you considered but did NOT select. It must never overlap with selectedContexts.',
  '- Use toolGroups only when the first turn needs those tool categories. readOnly runs should avoid mutating groups.',
  '',
  'Available contexts:',
  registrySummary(),
].join('\n')

export async function planContextWithModel(
  userMessage: string,
  profile: PromptProfile,
  readOnly: boolean,
): Promise<ContextPlanClassification> {
  const fallback = fallbackContextPlanForProfile(profile)
  const trimmed = userMessage.trim()
  if (!trimmed) {
    return { plan: fallback, source: 'fallback', confidence: 'none', reason: 'empty user message', error: 'empty user message' }
  }

  const token = await FirebaseAuthService.getInstance().getIdToken()
  if (!token) {
    return { plan: fallback, source: 'fallback', confidence: 'none', reason: 'auth token unavailable', error: 'no auth token' }
  }

  const url = `${resolveAIWorkerUrl()}/v1/chat/completions`
  try {
    const appCheck = await getAppCheckHeader()
    const appCheckPresent = !!appCheck['X-Firebase-AppCheck']
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Request-Type': 'context-planner',
        ...appCheck,
      },
      body: JSON.stringify({
        stream: false,
        temperature: 0,
        max_tokens: CONTEXT_PLANNER_MAX_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: CONTEXT_PLANNER_SYSTEM },
          { role: 'user', content: JSON.stringify({ profile, readOnly, userMessage: trimmed }) },
        ],
      }),
      signal: AbortSignal.timeout(CONTEXT_PLANNER_TIMEOUT_MS),
    })

    const rawBody = await res.text()
    const diagnostics: RouterDiagnostics = {
      url,
      appCheckPresent,
      httpStatus: res.status,
      servedModel: res.headers.get('x-tm-model') ?? undefined,
      configKey: res.headers.get('x-tm-config-key') ?? undefined,
      contentType: res.headers.get('content-type') ?? undefined,
      rawBodyPreview: rawBody.slice(0, 500),
    }

    if (!res.ok) {
      logger.warn('context-planner', `planning failed: HTTP ${res.status}`, diagnostics)
      return { plan: fallback, source: 'fallback', confidence: 'none', reason: `HTTP ${res.status}`, error: `HTTP ${res.status}`, diagnostics }
    }

    let data: { choices?: Array<{ message?: { content?: string } }> } | null = null
    try {
      data = JSON.parse(rawBody) as { choices?: Array<{ message?: { content?: string } }> } | null
    } catch (parseErr) {
      diagnostics.parseError = `body JSON parse failed: ${String(parseErr)}`
      return { plan: fallback, source: 'fallback', confidence: 'none', reason: 'response body not JSON', error: 'body not JSON', diagnostics }
    }

    const content = data?.choices?.[0]?.message?.content?.trim() ?? ''
    diagnostics.contentPreview = content.slice(0, 500)
    const parsed = parseContextPlanJson(content, diagnostics)
    if (!parsed) {
      return { plan: fallback, source: 'fallback', confidence: 'none', reason: 'invalid context plan JSON', error: 'invalid JSON', diagnostics }
    }

    logger.info('context-planner', `planned: domain=${parsed.plan.taskDomain} contexts=${parsed.plan.selectedContexts.join(',') || 'none'}`)
    return parsed
  } catch (err) {
    const diagnostics: RouterDiagnostics = { url, appCheckPresent: false, httpStatus: 0, parseError: String(err) }
    logger.warn('context-planner', 'planning threw:', err, diagnostics)
    return { plan: fallback, source: 'fallback', confidence: 'none', reason: 'request error', error: String(err), diagnostics }
  }
}

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
