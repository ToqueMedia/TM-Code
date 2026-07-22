/**
 * Descreve imagens através do data-plane para quando o modelo ATIVO não tem
 * visão nativa (profile.supportsAttachments === false).
 *
 * Restaura a "missão Qwen Plus / MiMo V2.5" perdida na migração do proxy
 * antigo (análise 2026-06-12): em vez de degradar imagens para um marcador
 * XML que o modelo parafraseava como "não processo imagens", o agente
 * principal recebe uma descrição detalhada produzida por um modelo
 * multimodal barato.
 *
 * Contrato de segurança: a resposta SÓ é usada se o header X-TM-Config-Key
 * confirmar que foi servida pela configuração de visão. Sem essa configuração,
 * o worker degrada para o modelo ativo — que não vê (é por isso que estamos
 * aqui) e "descreveria" por alucinação. Nesse caso devolvemos null e o caller
 * cai no fallback XML honesto.
 */

import { resolveAIWorkerUrl } from '../../utils/devUrls'
import FirebaseAuthService from '../auth/firebaseAuth'
import { logger } from '../../utils/logger'
import type { OpenAIContentPart } from './types'

const VISION_SIDECAR_TIMEOUT_MS = 60_000

const DEFAULT_VISION_SYSTEM =
  'You are a vision assistant serving a coding agent that cannot see images. ' +
  'Describe each attached image exhaustively and factually: overall layout, ALL visible text transcribed verbatim ' +
  '(code, error messages, stack traces, labels, URLs), UI elements and their states, colors, diagrams and their ' +
  'relationships. Number the descriptions "Image 1", "Image 2", ... in order. Do not speculate beyond what is visible.'

/** Design-copy handoff: the agent will recreate the UI from this alone. */
export const DESIGN_VISION_SYSTEM =
  'You are a design-transcription assistant for a coding agent that will recreate a UI from your description alone. ' +
  'Describe the screenshot as a precise design handoff: overall layout (sections, grid, hero, nav, footer), ' +
  'color palette (approximate hex when readable), typography (size hierarchy, weight, font feel), spacing patterns, ' +
  'component inventory (buttons, cards, forms, icons) with states, and ALL visible text transcribed verbatim. ' +
  'Be exhaustive and concrete. Do not invent content that is not visible. Structure the answer with clear headings.'

export async function describeImagesViaSidecar(
  parts: OpenAIContentPart[],
  options?: {
    /** Override the system prompt (e.g. design-copy handoff). */
    systemPrompt?: string
    /** Override the user text that accompanies the images. */
    userText?: string
  },
): Promise<string | null> {
  const imageParts = parts.filter(p => p.type === 'image_url')
  if (imageParts.length === 0) return null

  // Auxiliary vision is a TM-infra fallback for non-vision models. On free +
  // BYOK it's disabled (self-funded; if the user's model is natively
  // vision-capable, images already flow through the main loop). Paid + BYOK and
  // non-BYOK keep the worker route.
  // capture_url_design also uses this path: without a vision sidecar there is
  // no way to turn a screenshot into text for a text-only tool result.
  const { resolveAuxByokRoute } = await import('./byokRouting')
  if (resolveAuxByokRoute()) return null

  const token = await FirebaseAuthService.getInstance().getIdToken()
  if (!token) return null

  const body = {
    model: 'tm-active-model',
    stream: false,
    // Teto alto (não custo fixo — o billing conta só os tokens gerados): a
    // descrição numerada "Image 1, Image 2, …" pode crescer com lotes grandes
    // de imagens + transcrição verbatim de código/erros. 2048 truncava as
    // últimas imagens; 16384 dá folga para vários screenshots densos.
    max_tokens: 16384,
    messages: [
      {
        role: 'system',
        content: options?.systemPrompt ?? DEFAULT_VISION_SYSTEM,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: options?.userText ?? 'Describe the attached image(s) in full detail.' },
          ...imageParts,
        ],
      },
    ],
  }

  try {
    const res = await fetch(`${resolveAIWorkerUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Request-Type': 'vision',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(VISION_SIDECAR_TIMEOUT_MS),
    })

    if (!res.ok) {
      logger.warn('vision', `image description failed: HTTP ${res.status}`)
      return null
    }
    if (res.headers.get('x-tm-config-key') !== 'sidecar:vision') {
      logger.warn('vision', 'image description unavailable for active model')
      return null
    }
    logger.info(
      'vision',
      `image(s) described by auxiliary model=${res.headers.get('x-tm-model') ?? '?'} (config=vision)`,
    )

    const data = await res.json().catch(() => null) as
      { choices?: Array<{ message?: { content?: string } }> } | null
    const text = data?.choices?.[0]?.message?.content?.trim()
    return text || null
  } catch (err) {
    logger.warn('vision', 'image description threw:', err)
    return null
  }
}
