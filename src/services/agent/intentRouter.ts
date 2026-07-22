/**
 * Intent Router — a lightweight, non-streaming model call that classifies
 * the user's request into a `PromptProfile`, a `readOnly` flag, and whether
 * the turn requires file mutation BEFORE the main agent loop starts.
 *
 * Routing: the worker picks the utility model (MiMo V2.5) by the
 * `X-Request-Type: intent-router` header — we send NO `model` in the body
 * (same pattern as memorySelector/visionSidecar). On any failure the router
 * falls back to { bugfix_local, readOnly:false } so the agent still runs,
 * except when the user text contains an explicit no-edit/read-only instruction.
 * That local safety signal is enforced before any network call so HTTP 402,
 * timeouts, or malformed router output cannot turn "do not edit" into a
 * writable bugfix run.
 */

import { resolveAIWorkerUrl } from '../../utils/devUrls'
import FirebaseAuthService, { getAppCheckHeader } from '../auth/firebaseAuth'
import { logger } from '../../utils/logger'
import type { PromptProfile, RouterDiagnostics } from './contextBuilder/auxiliaryRegistry'
import type { ContentBlockAPI, ConversationMessage } from '../../types/chat'

const INTENT_ROUTER_TIMEOUT_MS = 12_000
const INTENT_HISTORY_LIMIT = 8
const INTENT_HISTORY_TEXT_LIMIT = 900

/** Full diagnostics captured on every router call — exported so a failed
 *  run shows exactly what the worker returned (raw body, headers, parse error).
 *  Re-exported from auxiliaryRegistry (canonical home, avoids circular imports). */
export type { RouterDiagnostics }

export interface IntentClassification {
  profile: PromptProfile
  readOnly: boolean
  /** True when this turn should ultimately mutate project files/state. */
  requiresMutation: boolean
  /** 'model' when classified by the router LLM; 'keyword' for local safety overrides; 'fallback' when it fell back. */
  source: 'model' | 'fallback' | 'keyword'
  /** Router self-reported confidence ('high'|'medium'|'low'); 'none' on fallback. */
  confidence: 'high' | 'medium' | 'low' | 'none'
  /** Short reason for logging / export telemetry. */
  reason: string
  /** When source='fallback', the failure reason (token missing, HTTP, timeout, …). */
  error?: string
  /** Full diagnostics — always populated when the HTTP call was made. */
  diagnostics?: RouterDiagnostics
}

const FALLBACK: IntentClassification = {
  profile: 'bugfix_local',
  readOnly: false,
  requiresMutation: false,
  source: 'fallback',
  confidence: 'none',
  reason: 'intent router unavailable',
  error: 'unavailable',
}

function normalizeIntentText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

export function hasExplicitNoEditIntent(userMessage: string): boolean {
  const text = normalizeIntentText(userMessage)
  return [
    /\bdo\s+not\s+edit\b/,
    /\bdon['’]?t\s+edit\b/,
    /\bno\s+(?:file\s+)?edits?\b/,
    /\bno\s+code\s+changes?\b/,
    /\bwithout\s+editing\b/,
    // NB: "read-only" SOLTO foi removido (2026-07-17): quase sempre descreve
    // um ARTEFACTO ("modal read-only", "perfil read-only", "campo readonly"),
    // não uma instrução ao agente — classificou um pedido de ESCRITA como
    // analysis_readonly e o run inteiro falhou com DENIED em create/edit
    // (sessão profile-me 15:26). Instruções genuínas continuam cobertas pelos
    // imperativos acima/abaixo e pelo router por modelo.
    /\bnao\s+(?:edite|editar|altere|alterar|modifique|modificar|mexa|mexer)\b/,
    /\bsem\s+(?:editar|alterar|modificar|mexer|alteracoes?|mudancas?)\b/,
    /\bapenas\s+(?:confirme|verifique|analise|inspecione)\b/,
    /\bso\s+(?:confirme|verifique|analise|inspecione)\b/,
  ].some((pattern) => pattern.test(text))
}

const VALID_PROFILES: ReadonlySet<PromptProfile> = new Set<PromptProfile>([
  'analysis_readonly',
  'bugfix_local',
  'frontend_ui',
  'scaffold_project',
  'deploy_publish',
  'auth_database',
  'vision',
])

const INTENT_ROUTER_SYSTEM =
  'You are an intent router for a coding agent. Classify the user\'s request.\n\n' +
  'The user message is JSON with currentUserMessage, hasImage, and recentConversation. Use recentConversation to resolve short follow-ups like "continue", "continua", "retoma", "go on", or "where you left off".\n\n' +
  'Return ONLY a JSON object (no markdown fences, no prose):\n' +
  '{"profile": "<one of the profiles>", "readOnly": <true|false>, "requiresMutation": <true|false>, "confidence": "<high|medium|low>", "reason": "<short reason>"}\n\n' +
  'Profiles:\n' +
  '- "analysis_readonly": the user wants a verification/audit/inspection WITHOUT editing files (e.g. "check if X is configured", "don\'t edit, just confirm", "sem editar, apenas confirme", "where is this defined").\n' +
  '- "bugfix_local": a localised fix/edit in existing files (default for code work).\n' +
  '- "frontend_ui": UI/design/visual work (components, layout, styles, dialogs, buttons, screens).\n' +
  '- "scaffold_project": create a NEW project/app from scratch (install deps, setup).\n' +
  '- "deploy_publish": deploy, publish, release, domain, cloud hosting.\n' +
  '- "auth_database": login, auth, database, storage, uploads.\n' +
  '- "vision": an image/screenshot/mockup is attached.\n\n' +
  'Disambiguation:\n' +
  '- Billing/payment/account tasks that require screens, routes, dialogs, modals, forms, buttons, or UI edits are "frontend_ui", even when they read or save user profile data.\n' +
  '- Use "auth_database" only when the main work is auth, database schema/storage, provisioning, credentials, rules, uploads, or backend data plumbing without a primary UI surface.\n' +
  '- If the request mentions /billing, /payments, AccountOverview, a modal, NIF/tax id, invoices/facturas, Multicaixa, or Reference and asks to implement UI behavior, choose "frontend_ui"; auth/database may be auxiliary context, not the main profile.\n\n' +
  'readOnly rules:\n' +
  '- Set "readOnly": true when the user EXPLICITLY says they don\'t want edits — "don\'t edit", "just confirm", "sem editar", "nao edite", "read-only", "apenas confirme", "não edite ficheiros".\n' +
  '- A profile of "analysis_readonly" ALWAYS implies readOnly true.\n' +
  '- When the user asks to VERIFY/CHECK/CONFIRM something WITHOUT editing, prefer "analysis_readonly" with readOnly true — even if the subject is UI/dialogs/components.\n' +
  '- For task profiles (deploy/auth/scaffold/frontend), readOnly true means "do the task but don\'t write files" (e.g. "deploy without editing").\n' +
  '- When in doubt, readOnly false.\n\n' +
  'requiresMutation rules:\n' +
  '- Set "requiresMutation": true when the current request asks the coding agent to create, edit, fix, refactor, remove, configure, scaffold, deploy/publish, update docs, run an implementation plan, or otherwise change project files/state.\n' +
  '- Set "requiresMutation": false for pure explanation, diagnosis, root-cause analysis, review, audit, search, comparison, or questions where a text answer can satisfy the request.\n' +
  '- If readOnly is true, requiresMutation MUST be false.\n' +
  '- For short continuation requests, inherit requiresMutation/profile from the most recent substantive user task in recentConversation unless the current message explicitly changes scope.\n' +
  '- "Continue", "Continue onde paraste", "continua", "retoma", "avança", and similar messages are contextual, not standalone analysis requests.\n\n' +
  'confidence: how sure you are of the profile choice (high/medium/low).\n\n' +
  'Decide the single best profile. Prefer the most specific. If hasImage is true, always use profile "vision" while still classifying requiresMutation from the text/context.'

export interface IntentRouterSignals {
  hasImage?: boolean
  conversationHistory?: readonly ConversationMessage[]
}

interface IntentRouterHistoryItem {
  role: 'user' | 'assistant'
  text: string
}

function truncateIntentText(text: string, limit = INTENT_HISTORY_TEXT_LIMIT): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit - 1)}…`
}

function contentToIntentText(content: string | ContentBlockAPI[] | null): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content)

  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text ?? ''
        case 'tool_call':
          return `[tool_call ${block.name}]`
        case 'image_url':
          return '[image]'
        case 'thinking':
        case 'tool_result':
          return ''
        default:
          return ''
      }
    })
    .filter(Boolean)
    .join('\n')
}

export function summarizeIntentHistory(
  history: readonly ConversationMessage[] | undefined,
): IntentRouterHistoryItem[] {
  if (!history?.length) return []

  const recent: IntentRouterHistoryItem[] = []
  for (let i = history.length - 1; i >= 0 && recent.length < INTENT_HISTORY_LIMIT; i--) {
    const msg = history[i]
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue
    const text = truncateIntentText(contentToIntentText(msg.content))
    if (!text) continue
    recent.push({ role: msg.role, text })
  }
  return recent.reverse()
}

function buildRouterUserPayload(
  currentUserMessage: string,
  signals?: IntentRouterSignals,
): string {
  return JSON.stringify({
    currentUserMessage,
    hasImage: signals?.hasImage === true,
    recentConversation: summarizeIntentHistory(signals?.conversationHistory),
  })
}

/** Build a diagnostics object from a Response (headers + status). The raw
 *  body is read separately by the caller (it can only be consumed once). */
function diagnosticsFromResponse(
  url: string,
  appCheckPresent: boolean,
  res: Response,
): RouterDiagnostics {
  return {
    url,
    appCheckPresent,
    httpStatus: res.status,
    servedModel: res.headers.get('x-tm-model') ?? undefined,
    configKey: res.headers.get('x-tm-config-key') ?? undefined,
    contentType: res.headers.get('content-type') ?? undefined,
  }
}

/**
 * Classify the user's intent via a lightweight model call.
 *
 * @param userMessage  the raw user-authored text (no @mention file contents)
 * @param signals      structural signals (e.g. hasImage) that can short-circuit
 */
export async function classifyIntent(
  userMessage: string,
  signals?: IntentRouterSignals,
): Promise<IntentClassification> {
  // Image-only turns are structurally vision requests; text/image turns still
  // go through the router so it can decide whether the screenshot implies edits.
  if (!userMessage.trim() && signals?.hasImage) {
    return {
      profile: 'vision',
      readOnly: false,
      requiresMutation: false,
      source: 'model',
      confidence: 'high',
      reason: 'image attachment present',
    }
  }

  const trimmed = userMessage.trim()
  if (!trimmed) {
    return { ...FALLBACK, reason: 'empty user message' }
  }

  if (hasExplicitNoEditIntent(trimmed)) {
    return {
      profile: 'analysis_readonly',
      readOnly: true,
      requiresMutation: false,
      source: 'keyword',
      confidence: 'high',
      reason: 'explicit no-edit/read-only instruction',
    }
  }

  const token = await FirebaseAuthService.getInstance().getIdToken()
  if (!token) {
    return { ...FALLBACK, reason: 'auth token unavailable', error: 'no auth token' }
  }

  const url = `${resolveAIWorkerUrl()}/v1/chat/completions`
  try {
    // The worker routes by X-Request-Type ('intent-router' → the utility
    // model, e.g. MiMo V2.5). We deliberately do NOT send a `model` in the
    // body — same pattern as memorySelector/memoryDistiller/summarize: the
    // worker injects the configured utility model.
    const appCheck = await getAppCheckHeader()
    const appCheckPresent = !!appCheck['X-Firebase-AppCheck']
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Request-Type': 'intent-router',
        ...appCheck,
      },
      body: JSON.stringify({
        // No `model` — the worker picks the utility model by X-Request-Type.
        stream: false,
        temperature: 0,
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: INTENT_ROUTER_SYSTEM },
          { role: 'user', content: buildRouterUserPayload(trimmed, signals) },
        ],
      }),
      signal: AbortSignal.timeout(INTENT_ROUTER_TIMEOUT_MS),
    })

    // Capture the RAW body as text FIRST — res.json() would swallow HTML /
    // error pages into a throw we can't inspect. Reading text() once lets us
    // both log it AND attempt a manual JSON.parse.
    const rawBody = await res.text()
    const diag: RouterDiagnostics = {
      ...diagnosticsFromResponse(url, appCheckPresent, res),
      rawBodyPreview: rawBody.slice(0, 500),
    }

    if (!res.ok) {
      logger.warn('intent-router', `classification failed: HTTP ${res.status}`, diag)
      return { ...FALLBACK, reason: `HTTP ${res.status}`, error: `HTTP ${res.status}`, diagnostics: diag }
    }

    logger.info('intent-router', `served by model=${diag.servedModel ?? '?'} config=${diag.configKey ?? '?'}`)

    // Parse the raw body as the OpenAI completion envelope.
    let data: { choices?: Array<{ message?: { content?: string } }> } | null = null
    try {
      data = JSON.parse(rawBody) as { choices?: Array<{ message?: { content?: string } }> } | null
    } catch (parseErr) {
      diag.parseError = `body JSON parse failed: ${String(parseErr)}`
      logger.warn('intent-router', 'response body is not valid JSON', diag)
      return { ...FALLBACK, reason: 'response body not JSON', error: 'body not JSON', diagnostics: diag }
    }

    const content = data?.choices?.[0]?.message?.content?.trim() ?? ''
    diag.contentPreview = content.slice(0, 500)
    if (!content) {
      diag.parseError = 'empty content in choices[0].message.content'
      logger.warn('intent-router', 'empty model content', diag)
      return { ...FALLBACK, reason: 'empty model content', error: 'empty content', diagnostics: diag }
    }

    const parsed = parseIntentJson(content, diag)
    if (parsed) {
      logger.info(
        'intent-router',
        `classified: profile=${parsed.profile} readOnly=${parsed.readOnly} requiresMutation=${parsed.requiresMutation} confidence=${parsed.confidence} (model)`,
      )
      return {
        profile: parsed.profile,
        readOnly: parsed.readOnly,
        requiresMutation: parsed.requiresMutation,
        source: 'model',
        confidence: parsed.confidence,
        reason: parsed.reason ?? 'model classification',
        diagnostics: diag,
      }
    }
    logger.warn('intent-router', 'unparseable router output', diag)
    return { ...FALLBACK, reason: 'invalid JSON from router', error: 'invalid JSON', diagnostics: diag }
  } catch (err) {
    const diag: RouterDiagnostics = { url, appCheckPresent: false, httpStatus: 0, parseError: String(err) }
    logger.warn('intent-router', 'classification threw:', err, diag)
    return { ...FALLBACK, reason: 'request error', error: String(err), diagnostics: diag }
  }
}

/**
 * Parse the router's JSON without regex. Tolerates markdown code fences
 * (some providers wrap JSON in ```json … ```) by plain string slicing.
 * Records the parse error into `diag` when it fails, for export.
 */
function parseIntentJson(
  text: string,
  diag?: RouterDiagnostics,
): { profile: PromptProfile; readOnly: boolean; requiresMutation: boolean; confidence: 'high' | 'medium' | 'low'; reason?: string } | null {
  let cleaned = text.trim()

  // Strip a leading markdown code fence (```json or ```) without regex.
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n')
    if (firstNewline !== -1) {
      const inner = cleaned.slice(firstNewline + 1)
      const closeIdx = inner.lastIndexOf('```')
      if (closeIdx !== -1) {
        cleaned = inner.slice(0, closeIdx).trim()
      }
    }
  }

  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    if (diag) diag.parseError = `no JSON object found in content (len=${cleaned.length})`
    return null
  }

  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as {
      profile?: string
      readOnly?: boolean
      requiresMutation?: boolean
      confidence?: string
      reason?: string
    }
    const profile = (obj.profile ?? '').toLowerCase() as PromptProfile
    if (!VALID_PROFILES.has(profile)) {
      if (diag) diag.parseError = `unknown profile "${obj.profile ?? ''}" (not in valid set)`
      return null
    }
    const rawConf = (obj.confidence ?? '').toLowerCase()
    const confidence: 'high' | 'medium' | 'low' =
      rawConf === 'high' ? 'high' : rawConf === 'low' ? 'low' : 'medium'
    return {
      profile,
      readOnly: obj.readOnly === true,
      requiresMutation: obj.readOnly === true ? false : obj.requiresMutation === true,
      confidence,
      reason: typeof obj.reason === 'string' ? obj.reason : undefined,
    }
  } catch (parseErr) {
    if (diag) diag.parseError = `JSON.parse failed: ${String(parseErr)}`
    return null
  }
}
