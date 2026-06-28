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
  'Return ONLY JSON with this shape:',
  '{"taskDomain":"...","requiredCapabilities":["..."],"minimumContextNeeded":"index|summary|full","candidateContexts":["context.id"],"selectedContexts":["context.id"],"toolGroups":["FILE_OPS|SHELL|WEB|SUBAGENT|MEMORY|PROVISION"],"fallbackRisk":"low|medium|high","reason":"short reason","confidence":"high|medium|low"}',
  '',
  'Rules:',
  '- Choose specific capability contexts before domain/project contexts.',
  '- Do not select project.structure_full unless files are unknown, architecture is broad, multiple modules/packages are involved, specific contexts failed, or dependency mapping spans areas.',
  '- For semantic tokens/theme work, prefer design_system.semantic_tokens and design_system.theme_config before any project structure.',
  '- For MCP audits, prefer agent_runtime.mcp_routing; project structure is fallback only if implementation files must be located.',
  '- For dev server/preview/browser runtime issues, prefer delivery.dev_server and optionally delivery.build_scripts/project.package_map.',
  '- For git/commit/diff/branch tasks, prefer delivery.git_status and delivery.changed_files.',
  '- For visual UI polish, prefer design_system.component_patterns, design_system.semantic_tokens, and ui_patterns.',
  '- Keep selectedContexts minimal. Put fallback candidates in candidateContexts instead of selectedContexts.',
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
        max_tokens: 500,
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

function parseContextPlanJson(
  text: string,
  diagnostics?: RouterDiagnostics,
): ContextPlanClassification | null {
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
  if (start === -1 || end === -1 || end <= start) {
    if (diagnostics) diagnostics.parseError = `no JSON object found in content (len=${cleaned.length})`
    return null
  }

  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as {
      taskDomain?: string
      requiredCapabilities?: unknown
      minimumContextNeeded?: string
      candidateContexts?: unknown
      selectedContexts?: unknown
      toolGroups?: unknown
      fallbackRisk?: string
      reason?: string
      confidence?: string
    }

    const selectedContexts = normalizeContextIds(obj.selectedContexts)
    const candidateContexts = normalizeContextIds(obj.candidateContexts)
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

    return {
      plan: {
        taskDomain: typeof obj.taskDomain === 'string' && obj.taskDomain ? obj.taskDomain : 'bugfix_local',
        requiredCapabilities,
        minimumContextNeeded,
        candidateContexts: includeSelectedCandidates(candidateContexts, selectedContexts),
        selectedContexts,
        toolGroups,
        fallbackRisk,
        reason: typeof obj.reason === 'string' && obj.reason ? obj.reason : 'model context planning',
      },
      source: 'model',
      confidence,
      reason: typeof obj.reason === 'string' && obj.reason ? obj.reason : 'model context planning',
      diagnostics,
    }
  } catch (parseErr) {
    if (diagnostics) diagnostics.parseError = `JSON.parse failed: ${String(parseErr)}`
    return null
  }
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
