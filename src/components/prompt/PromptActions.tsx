import { memo } from 'react'
import { Box, Flex, IconButton, Text } from '@chakra-ui/react'
import { FiSend, FiSquare, FiCode, FiMonitor, FiPaperclip } from 'react-icons/fi'
import { useLayoutStore } from '../../stores/layoutStore'
import { useBillingStore } from '../../stores/billingStore'
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
  // Plan label via i18n — falls back to raw plan name for unknown plans
  const planLabel = t(`prompt.planLabel.${billingPlan}` as any) || billingPlan

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

        {/* Attach files — paid tiers support multimodal via Qwen 3.6 Plus */}
        {billingPlan !== 'explorer' && (
          <IconButton
            aria-label={t("prompt.attach")}
            size="sm"
            variant="ghost"
            color={attachmentCount > 0 ? tokens.colors.accent.primary : tokens.colors.text.secondary}
            _hover={{ bg: tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
            borderRadius="8px"
            onClick={onAttach}
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
