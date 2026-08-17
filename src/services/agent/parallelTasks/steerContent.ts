/**
 * Resolve parallel-task steer items into QueryEngine QueuedSteeringContent
 * with the same image pipeline as mainDispatch (native vision vs sidecar).
 */

import type { ContentBlockAPI, PromptBlock } from '../../../types/chat'
import type { ParallelSteerItem } from '../../../stores/parallelTaskStore'
import {
  buildAugmentedPrompt,
  buildContentParts,
  extractDisplayFromValue,
} from '../promptValueHelpers'
import type { PromptValue } from '../../../types/messageQueueTypes'
import { resolveAttachments, resolveDescribedAttachments, resolveImageToDataUri } from '../../attachmentService'
import { describeImagesViaSidecar } from '../visionSidecar'
import { useBillingStore } from '../../../stores/billingStore'
import { useAgentStore } from '../../../stores/agentStore'
import { useChatStore } from '../../../stores/chatStore'
import { getProfileForPlan, MODEL_PROFILES, effectiveCapability } from '../modelProfiles'
import { resolveByokNativeVision } from '../byokVision'

const resolvers = {
  resolveAttachmentXml: resolveAttachments,
  resolveImageDataUri: resolveImageToDataUri,
}

function itemToPromptValue(item: ParallelSteerItem): PromptValue {
  if (item.blocks && item.blocks.length > 0) return item.blocks
  return item.text
}

/**
 * Merge one or more steer items into a single payload for the next model turn.
 * Mirrors mainDispatch collectSteeringMessages image handling.
 */
export async function resolveSteerItemsToContent(
  items: ParallelSteerItem[],
  opts?: { sessionId?: string | null },
): Promise<string | ContentBlockAPI[] | null> {
  if (items.length === 0) return null

  const values = items.map(itemToPromptValue)
  // Coalesce: flatten sequential text+attachment blocks across the burst.
  let merged: PromptValue
  if (values.length === 1) {
    merged = values[0]!
  } else {
    const blocks: PromptBlock[] = []
    for (const v of values) {
      if (typeof v === 'string') {
        if (v.trim()) blocks.push({ type: 'text', text: v })
      } else {
        blocks.push(...v)
      }
    }
    merged = blocks.length > 0 ? blocks : items.map((i) => i.text).filter(Boolean).join('\n\n')
  }

  const display = extractDisplayFromValue(merged)
  const billingPlan = useBillingStore.getState().plan
  const planAllowsImagePipeline = billingPlan !== 'explorer'
  // Prefer the run's session BYOK snapshot (not merely the focused session)
  // so vision gating matches the agent that will consume the steer.
  const chat = useChatStore.getState()
  const session = opts?.sessionId
    ? chat.sessions.get(opts.sessionId)
    : chat.getActiveSession()
  const byokNativeVision = resolveByokNativeVision(session?.byokSnapshot ?? null)
  const modelName = useAgentStore.getState().modelName
  const activeProfile =
    modelName && MODEL_PROFILES[modelName]
      ? MODEL_PROFILES[modelName]
      : getProfileForPlan(billingPlan)
  // Same gate as usePromptBar / mainDispatch: BYOK snapshot wins when set.
  const activeModelSupportsImageParts =
    byokNativeVision !== null
      ? byokNativeVision
      : effectiveCapability(
        useAgentStore.getState().modelSupportsVision,
        activeProfile.supportsAttachments,
      )

  if (planAllowsImagePipeline && display.attachments.some((a) => a.type === 'image')) {
    const parts = await buildContentParts(merged, resolvers)
    if (parts && activeModelSupportsImageParts) {
      return parts as unknown as ContentBlockAPI[]
    }
    if (parts) {
      const description = await describeImagesViaSidecar(parts)
      if (description) {
        const textOnly = await buildAugmentedPrompt(merged, {
          ...resolvers,
          resolveAttachmentXml: resolveDescribedAttachments,
        })
        return `${textOnly}\n\n<image_description source="image-analysis">\n${description}\n</image_description>`
      }
    }
  }

  const text = await buildAugmentedPrompt(merged, resolvers)
  return text && text.trim().length > 0 ? text : display.text || null
}
