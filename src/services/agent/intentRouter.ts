/**
 * Intent Router — a lightweight, non-streaming model call that classifies
 * the user's request into a `PromptProfile` + a `readOnly` flag BEFORE the
 * main agent loop starts.
 *
 * Routing: the worker picks the utility model (MiMo V2.5) by the
 * `X-Request-Type: intent-router` header — we send NO `model` in the body
 * (same pattern as memorySelector/visionSidecar). On any failure the router
 * falls back to { bugfix_local, readOnly:false } so the agent still runs;
 * the failure reason + raw response diagnostics are exported so the cause
 * (HTML error page, wrong model, non-strict JSON, empty content) is visible
 * without guessing.
 */

import { resolveAIWorkerUrl } from '../../utils/devUrls'
import FirebaseAuthService, { getAppCheckHeader } from '../auth/firebaseAuth'
import { logger } from '../../utils/logger'
import type { PromptProfile, RouterDiagnostics } from './contextBuilder/auxiliaryRegistry'

const INTENT_ROUTER_TIMEOUT_MS = 12_000

/** Full diagnostics captured on every router call — exported so a failed
 *  run shows exactly what the worker returned (raw body, headers, parse error).
 *  Re-exported from auxiliaryRegistry (canonical home, avoids circular imports). */
export type { RouterDiagnostics }

export interface IntentClassification {
  profile: PromptProfile
  readOnly: boolean
  /** 'model' when classified by the router LLM; 'fallback' when it fell back. */
  source: 'model' | 'fallback'
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
  source: 'fallback',
  confidence: 'none',
  reason: 'intent router unavailable',
  error: 'unavailable',
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
  'Return ONLY a JSON object (no markdown fences, no prose):\n' +
  '{"profile": "<one of the profiles>", "readOnly": <true|false>, "confidence": "<high|medium|low>", "reason": "<short reason>"}\n\n' +
  'Profiles:\n' +
  '- "analysis_readonly": the user wants a verification/audit/inspection WITHOUT editing files (e.g. "check if X is configured", "don\'t edit, just confirm", "sem editar, apenas confirme", "where is this defined").\n' +
  '- "bugfix_local": a localised fix/edit in existing files (default for code work).\n' +
  '- "frontend_ui": UI/design/visual work (components, layout, styles, dialogs, buttons, screens).\n' +
  '- "scaffold_project": create a NEW project/app from scratch (install deps, setup).\n' +
  '- "deploy_publish": deploy, publish, release, domain, cloud hosting.\n' +
  '- "auth_database": login, auth, database, storage, uploads.\n' +
  '- "vision": an image/screenshot/mockup is attached.\n\n' +
  'readOnly rules:\n' +
  '- Set "readOnly": true when the user EXPLICITLY says they don\'t want edits — "don\'t edit", "just confirm", "sem editar", "nao edite", "read-only", "apenas confirme", "não edite ficheiros".\n' +
  '- A profile of "analysis_readonly" ALWAYS implies readOnly true.\n' +
  '- When the user asks to VERIFY/CHECK/CONFIRM something WITHOUT editing, prefer "analysis_readonly" with readOnly true — even if the subject is UI/dialogs/components.\n' +
  '- For task profiles (deploy/auth/scaffold/frontend), readOnly true means "do the task but don\'t write files" (e.g. "deploy without editing").\n' +
  '- When in doubt, readOnly false.\n\n' +
  'confidence: how sure you are of the profile choice (high/medium/low).\n\n' +
  'Decide the single best profile. Prefer the most specific. If an image is attached, always "vision".'

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
  signals?: { hasImage?: boolean },
): Promise<IntentClassification> {
  // Image present is a structural signal — skip the model call entirely.
  if (signals?.hasImage) {
    return {
      profile: 'vision',
      readOnly: false,
      source: 'model',
      confidence: 'high',
      reason: 'image attachment present',
    }
  }

  const trimmed = userMessage.trim()
  if (!trimmed) {
    return { ...FALLBACK, reason: 'empty user message' }
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
        max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: INTENT_ROUTER_SYSTEM },
          { role: 'user', content: trimmed },
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
        `classified: profile=${parsed.profile} readOnly=${parsed.readOnly} confidence=${parsed.confidence} (model)`,
      )
      return {
        profile: parsed.profile,
        readOnly: parsed.readOnly,
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
): { profile: PromptProfile; readOnly: boolean; confidence: 'high' | 'medium' | 'low'; reason?: string } | null {
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
      confidence,
      reason: typeof obj.reason === 'string' ? obj.reason : undefined,
    }
  } catch (parseErr) {
    if (diag) diag.parseError = `JSON.parse failed: ${String(parseErr)}`
    return null
  }
}

