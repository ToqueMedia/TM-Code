/**
 * Resolve whether a BYOK session snapshot implies native vision on the
 * selected model. Shared by usePromptBar and parallel-task steer so the
 * two paths cannot diverge (review residual 2026-07-24).
 *
 * Returns:
 *  - true/false when BYOK snapshot is present and capabilities known
 *  - null when not on BYOK (caller falls back to managed model profile)
 */

import type { ByokSessionSnapshot } from '../../types/chat'
import { useByokStore } from '../../stores/byokStore'

export function resolveByokNativeVision(snapshot: ByokSessionSnapshot | null): boolean | null {
  if (!snapshot) return null
  if (snapshot.capabilities?.images !== undefined) return snapshot.capabilities.images

  const byokState = useByokStore.getState()
  const provider = byokState.providers.find(p => p.id === snapshot.providerId)
  const config = byokState.perProviderConfig[snapshot.providerId]
  const registryModel = provider?.models.find(m => m.id === snapshot.modelId)
  if (registryModel) return registryModel.capabilities.images

  const dynamicModel = config?.dynamicCatalog?.models.find(m => m.id === snapshot.modelId)
  if (dynamicModel) return dynamicModel.capabilities.images

  const userDefined = config?.userDefinedModel
  if (userDefined?.id === snapshot.modelId) return userDefined.capabilities.images

  return false
}
