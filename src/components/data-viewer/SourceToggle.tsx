import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'
import type { DataSource } from '../../stores/dataViewerStore'

interface SourceToggleProps {
  source: DataSource
  /** True if a local `dev.db` was detected — when false, the DEV side is dimmed. */
  hasDev: boolean
  /** True if TMDB_URL+TMDB_TOKEN are in `.env` — when false, the PROD side is dimmed. */
  hasProd: boolean
  onChange: (source: DataSource) => void
}

function SourceToggle({ source, hasDev, hasProd, onChange }: SourceToggleProps) {
  const t = useTranslation()
  return (
    <Flex
      align="center"
      gap={0}
      p="2px"
      borderRadius={tokens.radius.md}
      bg="rgba(255, 255, 255, 0.04)"
      border="1px solid"
      borderColor="rgba(255, 255, 255, 0.06)"
    >
      <ToggleButton
        label={t('dataViewer.sourceDev')}
        active={source === 'dev'}
        enabled={hasDev}
        onClick={() => onChange('dev')}
        activeColor={tokens.colors.accent.green}
        title={hasDev ? t('dataViewer.sourceDevTitle') : t('dataViewer.sourceDevDisabled')}
      />
      <ToggleButton
        label={t('dataViewer.sourceProd')}
        active={source === 'prod'}
        enabled={hasProd}
        onClick={() => onChange('prod')}
        activeColor={tokens.colors.accent.primary}
        title={hasProd ? t('dataViewer.sourceProdTitle') : t('dataViewer.sourceProdDisabled')}
      />
    </Flex>
  )
}

interface ToggleButtonProps {
  label: string
  active: boolean
  enabled: boolean
  onClick: () => void
  activeColor: string
  title: string
}

function ToggleButton({ label, active, enabled, onClick, activeColor, title }: ToggleButtonProps) {
  return (
    <button
      type="button"
      onClick={() => enabled && onClick()}
      disabled={!enabled}
      title={title}
      style={{
        padding: '4px 12px',
        borderRadius: tokens.radius.sm,
        background: active ? tokens.colors.bg.activeItem : 'transparent',
        border: 'none',
        cursor: enabled ? 'pointer' : 'not-allowed',
        opacity: enabled ? 1 : 0.4,
        transition: tokens.transition.fast,
      }}
    >
      <Flex align="center" gap={1.5}>
        <Box
          w="6px"
          h="6px"
          borderRadius="full"
          bg={active ? activeColor : tokens.colors.text.disabled}
        />
        <Text
          fontSize="10px"
          fontWeight="700"
          fontFamily={tokens.fontFamily.mono}
          color={active ? tokens.colors.text.primary : tokens.colors.text.muted}
          letterSpacing="0.04em"
        >
          {label}
        </Text>
      </Flex>
    </button>
  )
}

export default SourceToggle
