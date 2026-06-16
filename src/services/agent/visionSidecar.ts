/**
 * Sidecar de visão — descreve imagens através da config `sidecar:vision`
 * publicada no KV do data-plane, para quando o modelo ATIVO não tem visão
 * nativa (profile.supportsAttachments === false).
 *
 * Restaura a "missão Qwen Plus / MiMo V2.5" perdida na migração do proxy
 * antigo (análise 2026-06-12): em vez de degradar imagens para um marcador
 * XML que o modelo parafraseava como "não processo imagens", o agente
 * principal recebe uma descrição detalhada produzida por um modelo
 * multimodal barato.
 *
 * Contrato de segurança: a resposta SÓ é usada se o header X-TM-Config-Key
 * confirmar que foi o sidecar a servir. Sem sidecar publicado, o worker
 * degrada para o modelo ativo — que não vê (é por isso que estamos aqui) e
 * "descreveria" por alucinação. Nesse caso devolvemos null e o caller cai
 * no fallback XML honesto.
 */

import { resolveAIWorkerUrl } from '../../utils/devUrls'
import FirebaseAuthService from '../auth/firebaseAuth'
import { logger } from '../../utils/logger'
import type { OpenAIContentPart } from './types'

const VISION_SIDECAR_TIMEOUT_MS = 60_000

export async function describeImagesViaSidecar(
  parts: OpenAIContentPart[],
): Promise<string | null> {
  const imageParts = parts.filter(p => p.type === 'image_url')
  if (imageParts.length === 0) return null

  const token = await FirebaseAuthService.getInstance().getIdToken()
  if (!token) return null

  const body = {
    model: 'tm-active-model', // substituído pelo worker (sidecar:vision)
    stream: false,
    // Teto alto (não custo fixo — o billing conta só os tokens gerados): a
    // descrição numerada "Image 1, Image 2, …" pode crescer com lotes grandes
    // de imagens + transcrição verbatim de código/erros. 2048 truncava as
    // últimas imagens; 16384 dá folga para vários screenshots densos.
    max_tokens: 16384,
    messages: [
      {
        role: 'system',
        content:
          'You are a vision assistant serving a coding agent that cannot see images. ' +
          'Describe each attached image exhaustively and factually: overall layout, ALL visible text transcribed verbatim ' +
          '(code, error messages, stack traces, labels, URLs), UI elements and their states, colors, diagrams and their ' +
          'relationships. Number the descriptions "Image 1", "Image 2", ... in order. Do not speculate beyond what is visible.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe the attached image(s) in full detail.' },
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
      logger.warn('vision-sidecar', `describe failed: HTTP ${res.status}`)
      return null
    }
    if (res.headers.get('x-tm-config-key') !== 'sidecar:vision') {
      logger.warn('vision-sidecar', 'no vision sidecar published — skipping (would hallucinate on the blind active model)')
      return null
    }
    logger.info(
      'vision-sidecar',
      `image(s) described by sidecar model=${res.headers.get('x-tm-model') ?? '?'} (config=sidecar:vision)`,
    )

    const data = await res.json().catch(() => null) as
      { choices?: Array<{ message?: { content?: string } }> } | null
    const text = data?.choices?.[0]?.message?.content?.trim()
    return text || null
  } catch (err) {
    logger.warn('vision-sidecar', 'describe threw:', err)
    return null
  }
}
