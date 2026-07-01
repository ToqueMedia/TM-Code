/**
 * Context Planner — model-owned selection of on-demand context domains.
 *
 * This deliberately avoids local regex/keyword inference. The utility model
 * decides taskDomain, required capabilities, minimum context, selected
 * contexts, and initial tool groups. On failure we retry the utility model,
 * then ask the active code model. This module reports hard planner failure;
 * ContextBuilder decides whether to continue without preloaded auxiliaries.
 */

import { resolveAIWorkerUrl } from '../../utils/devUrls'
import FirebaseAuthService, { getAppCheckHeader } from '../auth/firebaseAuth'
import { logger } from '../../utils/logger'
import { extractAssistantTextFromCompletion } from './completionText'
import {
  AUXILIARY_METAS,
  resolveAuxiliaryId,
  type ContextFallbackRisk,
  type ContextGranularity,
  type ContextPlan,
  type PromptProfile,
  type RouterDiagnostics,
} from './contextBuilder/auxiliaryRegistry'

const CONTEXT_PLANNER_TIMEOUT_MS = 60_000
const CONTEXT_PLANNER_MAX_TOKENS = 1_200
const CONTEXT_PLANNER_UTILITY_ATTEMPTS = 3
const CONTEXT_PLANNER_CODE_ATTEMPTS = 1

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
  '- When the task is to find where behavior lives, locate a function/class/component/hook/handler/service, or the target file is unknown but a symbol name is likely, select project.symbol_index first.',
  '- For locating functions/classes/components/hooks/handlers, prefer project.symbol_index before project.structure_overview/project.structure_full; it is only a navigation index, so the agent must still Read the exact range before editing.',
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
  const trimmed = userMessage.trim()
  if (!trimmed) {
    throw new ContextPlannerError('empty user message')
  }

  const token = await FirebaseAuthService.getInstance().getIdToken()
  if (!token) {
    throw new ContextPlannerError('auth token unavailable')
  }

  const url = `${resolveAIWorkerUrl()}/v1/chat/completions`
  const failures: Array<{ reason: string; diagnostics?: RouterDiagnostics; rawOutput?: string }> = []

  for (let attempt = 1; attempt <= CONTEXT_PLANNER_UTILITY_ATTEMPTS; attempt++) {
    const result = await runPlannerAttempt({
      url,
      token,
      profile,
      readOnly,
      userMessage: trimmed,
      modelTier: 'utility',
      attempt,
      jsonMode: attempt === 1,
    })
    if (result.ok) {
      const parsed = {
        ...result.parsed,
        modelTier: 'utility' as const,
        attempts: attempt,
      }
      logger.info('context-planner', `planned: tier=utility attempt=${attempt} domain=${parsed.plan.taskDomain} contexts=${parsed.plan.selectedContexts.join(',') || 'none'}`)
      return parsed
    }
    failures.push(result.failure)
    logger.warn('context-planner', `utility attempt ${attempt}/${CONTEXT_PLANNER_UTILITY_ATTEMPTS} failed: ${result.failure.reason}`, result.failure.diagnostics)
  }

  const utilityFailure = failures[failures.length - 1]?.reason ?? 'utility planner failed'
  for (let attempt = 1; attempt <= CONTEXT_PLANNER_CODE_ATTEMPTS; attempt++) {
    const result = await runPlannerAttempt({
      url,
      token,
      profile,
      readOnly,
      userMessage: trimmed,
      modelTier: 'code',
      attempt,
      fallbackReason: `utility planner failed after ${CONTEXT_PLANNER_UTILITY_ATTEMPTS} attempts: ${utilityFailure}`,
      jsonMode: false,
    })
    if (result.ok) {
      const parsed = {
        ...result.parsed,
        modelTier: 'code' as const,
        attempts: CONTEXT_PLANNER_UTILITY_ATTEMPTS + attempt,
        fallbackReason: `utility planner failed after ${CONTEXT_PLANNER_UTILITY_ATTEMPTS} attempts: ${utilityFailure}`,
      }
      logger.info('context-planner', `planned: tier=code attempt=${attempt} domain=${parsed.plan.taskDomain} contexts=${parsed.plan.selectedContexts.join(',') || 'none'}`)
      return parsed
    }
    failures.push(result.failure)
    logger.warn('context-planner', `code fallback attempt ${attempt}/${CONTEXT_PLANNER_CODE_ATTEMPTS} failed: ${result.failure.reason}`, result.failure.diagnostics)
  }

  const last = failures[failures.length - 1]
  throw new ContextPlannerError(
    `context planner failed after ${CONTEXT_PLANNER_UTILITY_ATTEMPTS} utility attempts and ${CONTEXT_PLANNER_CODE_ATTEMPTS} code-model fallback attempt`,
    {
      diagnostics: last?.diagnostics,
      rawOutput: last?.rawOutput,
      fallbackReason: `utility planner failed after ${CONTEXT_PLANNER_UTILITY_ATTEMPTS} attempts`,
    },
  )
}

type PlannerAttemptResult =
  | { ok: true; parsed: ContextPlanClassification }
  | { ok: false; failure: { reason: string; diagnostics?: RouterDiagnostics; rawOutput?: string } }

async function runPlannerAttempt(options: {
  url: string
  token: string
  profile: PromptProfile
  readOnly: boolean
  userMessage: string
  modelTier: 'utility' | 'code'
  attempt: number
  fallbackReason?: string
  jsonMode?: boolean
}): Promise<PlannerAttemptResult> {
  const { url, token, profile, readOnly, userMessage, modelTier, attempt, fallbackReason, jsonMode } = options
  if (modelTier === 'code') {
    const byokResult = await runActiveByokCodePlannerAttempt(options)
    if (byokResult) return byokResult
  }
  try {
    const appCheck = await getAppCheckHeader()
    const appCheckPresent = !!appCheck['X-Firebase-AppCheck']
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...appCheck,
    }
    if (modelTier === 'utility') {
      headers['X-Request-Type'] = 'context-planner'
    }

    const body: Record<string, unknown> = {
      stream: false,
      temperature: 0,
      max_tokens: CONTEXT_PLANNER_MAX_TOKENS,
      messages: [
        { role: 'system', content: CONTEXT_PLANNER_SYSTEM },
        { role: 'user', content: JSON.stringify({ profile, readOnly, userMessage, modelTier, attempt, fallbackReason }) },
      ],
    }
    if (jsonMode) {
      body.response_format = { type: 'json_object' }
    }
    if (modelTier === 'code') {
      body.model = 'tm-active-model'
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
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
      return { ok: false, failure: { reason: `HTTP ${res.status}`, diagnostics, rawOutput: rawBody } }
    }

    let data: unknown = null
    try {
      data = JSON.parse(rawBody) as unknown
    } catch (parseErr) {
      diagnostics.parseError = `body JSON parse failed: ${String(parseErr)}`
      return { ok: false, failure: { reason: 'response body not JSON', diagnostics, rawOutput: rawBody } }
    }

    const content = extractAssistantTextFromCompletion(data)
    diagnostics.contentPreview = content.slice(0, 500)
    const parsed = parseContextPlanJson(content, diagnostics)
    if (!parsed) {
      return { ok: false, failure: { reason: diagnostics.parseError ?? 'invalid context plan JSON', diagnostics, rawOutput: content || rawBody } }
    }

    return { ok: true, parsed }
  } catch (err) {
    const diagnostics: RouterDiagnostics = { url, appCheckPresent: false, httpStatus: 0, parseError: String(err) }
    return { ok: false, failure: { reason: String(err), diagnostics } }
  }
}

async function runActiveByokCodePlannerAttempt(options: {
  profile: PromptProfile
  readOnly: boolean
  userMessage: string
  modelTier: 'utility' | 'code'
  attempt: number
  fallbackReason?: string
}): Promise<PlannerAttemptResult | null> {
  const { profile, readOnly, userMessage, modelTier, attempt, fallbackReason } = options
  if (modelTier !== 'code') return null
  const [{ useChatStore }, { useByokStore }] = await Promise.all([
    import('../../stores/chatStore'),
    import('../../stores/byokStore'),
  ])
  const snapshot = useChatStore.getState().getActiveSession()?.byokSnapshot ?? null
  const byokActive = !!snapshot && useByokStore.getState().enabled
  if (!byokActive || !snapshot) return null
  const { byokAuxCompletion } = await import('./byokRouting')

  const diagnostics: RouterDiagnostics = {
    url: snapshot.baseURL,
    appCheckPresent: false,
    httpStatus: 0,
    servedModel: snapshot.modelId,
    configKey: `byok:${snapshot.providerId}`,
    contentType: undefined,
  }

  try {
    const content = (await byokAuxCompletion(snapshot, {
      maxTokens: CONTEXT_PLANNER_MAX_TOKENS,
      temperature: 0,
      jsonObject: false,
      signal: AbortSignal.timeout(CONTEXT_PLANNER_TIMEOUT_MS),
      messages: [
        { role: 'system', content: CONTEXT_PLANNER_SYSTEM },
        { role: 'user', content: JSON.stringify({ profile, readOnly, userMessage, modelTier, attempt, fallbackReason }) },
      ],
    }))?.trim() ?? ''
    diagnostics.httpStatus = content ? 200 : 0
    diagnostics.contentPreview = content.slice(0, 500)

    const parsed = parseContextPlanJson(content, diagnostics)
    if (!parsed) {
      return {
        ok: false,
        failure: {
          reason: diagnostics.parseError ?? 'invalid context plan JSON from BYOK code model',
          diagnostics,
          rawOutput: content,
        },
      }
    }

    return { ok: true, parsed }
  } catch (err) {
    diagnostics.parseError = String(err)
    return {
      ok: false,
      failure: {
        reason: String(err),
        diagnostics,
      },
    }
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
