import { memo, useState, useRef, useEffect } from 'react'
import { Box, Flex, IconButton, Text } from '@chakra-ui/react'
import { FiSend, FiSquare, FiCode, FiMonitor, FiPaperclip, FiChevronUp } from 'react-icons/fi'
import { useLayoutStore } from '../../stores/layoutStore'
import { useSettingsStore, type AgentModelId } from '../../stores/settingsStore'
import { useBillingStore } from '../../stores/billingStore'
import { getModelsForPlan, getDefaultModelForPlan, getModelProfile, type ModelProfile } from '../../services/agent/modelProfiles'
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
  const agentModel = useSettingsStore(s => s.agentModel)
  const setAgentModel = useSettingsStore(s => s.setAgentModel)
  const billingPlan = useBillingStore(s => s.plan)
  const billingLoaded = useBillingStore(s => s.isLoaded)
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const profiles = getModelsForPlan(billingPlan)
  const isAvailable = profiles.some(p => p.id === agentModel)

  // While billing is loading, show the user's persisted model (don't filter by plan yet).
  // After billing loads, enforce plan restrictions.
  const activeProfile = !billingLoaded
    ? getModelProfile(agentModel)
    : (profiles.find(p => p.id === agentModel) || profiles.find(p => p.id === getDefaultModelForPlan(billingPlan)) || profiles[0])

  // Persist the corrected model to settings — only AFTER billing data is loaded
  // to avoid resetting a paid user's model to free before /v1/me returns.
  useEffect(() => {
    if (!billingLoaded) return
    if (!isAvailable) {
      setAgentModel(getDefaultModelForPlan(billingPlan) as AgentModelId)
    }
  }, [billingPlan, billingLoaded, isAvailable, setAgentModel])

  useEffect(() => {
    if (!isModelMenuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setIsModelMenuOpen(false)
      }
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsModelMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [isModelMenuOpen])

  return (
    <Flex align="center" justify="space-between" px={3} py={2}>
      <Flex align="center" gap={1}>
        {/* Model persona selector */}
        <Box ref={modelMenuRef} position="relative">
          <Flex
            as="button"
            align="center"
            gap="4px"
            px={2}
            py="5px"
            borderRadius="6px"
            cursor={isStreaming ? 'default' : 'pointer'}
            opacity={isStreaming ? 0.5 : 1}
            color={tokens.colors.text.secondary}
            _hover={isStreaming ? {} : { bg: tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
            transition={`all ${tokens.transition.fast}`}
            onClick={() => { if (!isStreaming) setIsModelMenuOpen(!isModelMenuOpen) }}
          >
            <Text fontSize="11px" fontWeight={600} letterSpacing="0.02em">
              {(() => {
                const parts = activeProfile.persona.name.split(' ')
                const last = parts[parts.length - 1]
                // Roman numeral suffixes (II, III, IV) — include preceding word
                if (parts.length > 1 && /^[IVX]+$/.test(last)) return parts.slice(-2).join(' ')
                return last || activeProfile.persona.name
              })()}
            </Text>
            <FiChevronUp size={10} style={{
              transform: isModelMenuOpen ? 'rotate(180deg)' : 'none',
              transition: 'transform 0.15s ease',
            }} />
          </Flex>

          {isModelMenuOpen && (
            <Box
              position="absolute"
              bottom="calc(100% + 6px)"
              left={0}
              bg={tokens.colors.bg.overlay}
              border={`1px solid ${tokens.colors.border.panel}`}
              borderRadius="10px"
              py={1}
              zIndex={tokens.zIndex.dropdown}
              minW="260px"
              boxShadow={tokens.shadow.overlay}
              overflow="hidden"
            >
              {profiles.map((profile: ModelProfile) => {
                const isActive = profile.id === agentModel
                return (
                  <Flex
                    key={profile.id}
                    as="button"
                    w="100%"
                    px={3}
                    py="8px"
                    align="center"
                    gap="10px"
                    cursor="pointer"
                    bg={isActive ? tokens.colors.bg.hoverSubtle : 'transparent'}
                    _hover={{ bg: tokens.colors.bg.hoverSubtle }}
                    transition={`background ${tokens.transition.fast}`}
                    onClick={() => {
                      setAgentModel(profile.id as AgentModelId)
                      setIsModelMenuOpen(false)
                    }}
                  >
                    {/* Active indicator dot */}
                    <Box
                      w="6px"
                      h="6px"
                      borderRadius="full"
                      bg={isActive ? tokens.colors.accent.primary : 'transparent'}
                      flexShrink={0}
                    />
                    <Flex direction="column" align="flex-start" gap="2px" flex={1} textAlign="left">
                      <Text
                        fontSize="12px"
                        fontWeight={600}
                        color={isActive ? tokens.colors.accent.primary : tokens.colors.text.primary}
                      >
                        {profile.persona.name}
                      </Text>
                      <Text fontSize="10px" color={tokens.colors.text.disabled} lineHeight="1.3" textAlign="left">
                        {profile.persona.tagline}
                      </Text>
                    </Flex>
                  </Flex>
                )
              })}
            </Box>
          )}
        </Box>

        {/* Attach files — only for multimodal models */}
        {activeProfile.supportsAttachments && (
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

      {/* Send / Stop button */}
      {isStreaming ? (
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
