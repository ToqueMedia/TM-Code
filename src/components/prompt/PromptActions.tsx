import { memo, useMemo } from 'react'
import { Box, Flex, IconButton, Text } from '@chakra-ui/react'
import { FiSend, FiSquare, FiCode, FiMonitor, FiPaperclip } from 'react-icons/fi'
import { useLayoutStore } from '../../stores/layoutStore'
import { useBillingStore } from '../../stores/billingStore'
import { useChatStore } from '../../stores/chatStore'
import { useByokStore } from '../../stores/byokStore'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

interface PromptActionsProps {
  viewMode: string
  isStreaming: boolean
  hasInput: boolean
  hasPreview: boolean
  onToggleEditor: () => void
  onTogglePreview: () => void
  onSend: () => void
  onStop: () => void
  onAttach: () => void
  attachmentCount: number
}

function PromptActions({
  viewMode,
  isStreaming,
  hasInput,
  hasPreview,
  onToggleEditor,
  onTogglePreview,
  onSend,
  onStop,
  onAttach,
  attachmentCount,
}: PromptActionsProps) {
  const isPreviewActive = viewMode === 'preview'
  const isPreviewLoading = useLayoutStore(s => s.isPreviewServerLoading)
  const billingPlan = useBillingStore(s => s.plan)
  // Plan label via i18n — falls back to raw plan name for unknown plans.
  // Welcome plan shows the model name instead of the plan label.
  const planLabel = billingPlan === 'welcome'
    ? 'MiMo V2.5 Pro'
    : t(`prompt.planLabel.${billingPlan}` as any) || billingPlan

  // ── Paperclip gate ──
  //
  // Decision matrix (whether attach button is shown, and the hint):
  //   BYOK active + provider supports images natively  → show, native
  //   BYOK active + no native vision + paid plan       → show, "via TM Vision"
  //   BYOK active + no native vision + Explorer        → hidden (plan limit)
  //   BYOK inactive + paid plan                        → show, native via Qwen
  //   BYOK inactive + Explorer                         → hidden (plan limit)
  //
  // Source of truth is the active session's BYOK snapshot (if any), with a
  // fallback to the current global byokStore selection for not-yet-snapshotted
  // sessions (e.g. before the first send). This mirrors the agentService logic.
  const activeSession = useChatStore(s => s.activeSessionId ? s.sessions.get(s.activeSessionId) ?? null : null)
  const byokSnapshot = activeSession?.byokSnapshot ?? null

  // Subscribe to PRIMITIVES only — selecting `resolveActive()` directly was
  // returning a fresh object reference each render, which made Zustand's
  // useSyncExternalStore think the snapshot kept changing and re-rendered
  // forever ("getSnapshot should be cached" warning + Maximum update depth).
  // Compute the resolved tuple in a memo so the reference stays stable until
  // any of the contributing fields actually changes.
  const byokEnabled = useByokStore(s => s.enabled)
  const byokActiveProvider = useByokStore(s => s.activeProvider)
  const byokActiveModel = useByokStore(s => s.activeModel)
  const byokProviders = useByokStore(s => s.providers)
  const byokPerProviderConfig = useByokStore(s => s.perProviderConfig)
  const byokResolvedActive = useMemo(() => {
    if (!byokEnabled || !byokActiveProvider || !byokActiveModel) return null
    const provider = byokProviders.find(p => p.id === byokActiveProvider)
    if (!provider) return null
    const userDefined = byokPerProviderConfig[byokActiveProvider]?.userDefinedModel
    const registryModel = provider.models.find(m => m.id === byokActiveModel)
    if (registryModel) return { providerCustom: provider.custom === true, imagesSupported: registryModel.capabilities.images }
    if (userDefined && userDefined.id === byokActiveModel) return { providerCustom: provider.custom === true, imagesSupported: userDefined.capabilities.images }
    if (provider.custom) return { providerCustom: true, imagesSupported: false }
    return null
  }, [byokEnabled, byokActiveProvider, byokActiveModel, byokProviders, byokPerProviderConfig])

  const byokModelImages = byokSnapshot
    ? (byokSnapshot.capabilities?.images ?? false)
    : (byokResolvedActive?.imagesSupported ?? null)
  const byokInUse = byokSnapshot !== null || byokResolvedActive !== null
  const isExplorer = billingPlan === 'explorer'

  let showAttach = false
  let attachHint: string | null = null
  if (byokInUse) {
    if (byokModelImages === true) {
      showAttach = true
    } else if (!isExplorer) {
      showAttach = true
      attachHint = 'via TM Vision'
    }
  } else {
    showAttach = !isExplorer
  }

  return (
    <Flex align="center" justify="space-between" px={3} py={2}>
      <Flex align="center" gap={1}>
        {/* Plan badge — model is decided by the backend based on the user's plan */}
        <Flex
          align="center"
          px={2}
          py="5px"
          borderRadius="6px"
          color={tokens.colors.text.secondary}
        >
          <Text fontSize="11px" fontWeight={600} letterSpacing="0.02em">
            {planLabel}
          </Text>
        </Flex>

        {showAttach && (
          <IconButton
            aria-label={attachHint ? `${t("prompt.attach")} (${attachHint})` : t("prompt.attach")}
            size="sm"
            variant="ghost"
            color={attachmentCount > 0 ? tokens.colors.accent.primary : tokens.colors.text.secondary}
            _hover={{ bg: tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
            borderRadius="8px"
            onClick={onAttach}
            title={attachHint || undefined}
          >
            <FiPaperclip size={15} />
          </IconButton>
        )}

        {/* Editor toggle */}
        <IconButton
          aria-label={t("prompt.toggleEditor")}
          size="sm"
          variant="ghost"
          color={viewMode === 'editor' ? tokens.colors.accent.primary : tokens.colors.text.secondary}
          _hover={{ bg: tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
          borderRadius="8px"
          onClick={onToggleEditor}
        >
          <FiCode size={15} />
        </IconButton>

        {/* Preview toggle — only visible when a preview is available */}
        {hasPreview && (
          <Flex align="center" gap={0}>
            <IconButton
              aria-label={isPreviewLoading ? t('prompt.startingServer') : isPreviewActive ? t('prompt.hidePreview') : t('prompt.showPreview')}
              size="sm"
              variant="ghost"
              color={isPreviewActive ? tokens.colors.accent.primary : tokens.colors.text.secondary}
              _hover={{ bg: tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
              borderRadius="8px"
              onClick={onTogglePreview}
            >
              {isPreviewLoading ? (
                <Box
                  w="15px"
                  h="15px"
                  borderRadius="full"
                  border="2px solid transparent"
                  borderTopColor={tokens.colors.accent.primary}
                  borderRightColor={tokens.colors.accent.primary}
                  css={{
                    animation: 'previewSpin 0.7s linear infinite',
                    '@keyframes previewSpin': {
                      to: { transform: 'rotate(360deg)' },
                    },
                  }}
                />
              ) : (
                <FiMonitor size={15} />
              )}
            </IconButton>
          </Flex>
        )}
      </Flex>

      {/* Send / Stop / Queue button */}
      {isStreaming && hasInput ? (
        // Agent working + user typed → send to queue
        <IconButton
          aria-label={t("prompt.sendToQueue")}
          size="sm"
          bg={tokens.colors.accent.primary}
          color={tokens.colors.text.inverse}
          borderRadius="8px"
          _hover={{ bg: tokens.colors.accent.primaryDark }}
          onClick={onSend}
        >
          <FiSend size={14} />
        </IconButton>
      ) : isStreaming ? (
        // Agent working + no input → stop
        <IconButton
          aria-label={t("prompt.stopGeneration")}
          size="sm"
          bg={tokens.colors.accent.redSubtle}
          color={tokens.colors.accent.red}
          borderRadius="8px"
          _hover={{ bg: tokens.colors.accent.redMuted }}
          onClick={onStop}
        >
          <FiSquare size={14} />
        </IconButton>
      ) : (
        // Agent idle → normal send
        <IconButton
          aria-label={t("prompt.send")}
          size="sm"
          bg={hasInput ? tokens.colors.accent.primary : 'transparent'}
          color={hasInput ? tokens.colors.text.inverse : tokens.colors.text.disabled}
          borderRadius="8px"
          _hover={hasInput ? { bg: tokens.colors.accent.primaryDark } : {}}
          onClick={onSend}
          disabled={!hasInput}
        >
          <FiSend size={14} />
        </IconButton>
      )}
    </Flex>
  )
}

export default memo(PromptActions)
