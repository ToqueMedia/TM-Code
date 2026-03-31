import React, { memo } from 'react'
import { Box } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

interface PromptTextareaProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  value: string
  onChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onBlur?: () => void
  onPaste?: (e: React.ClipboardEvent) => void
  disabled: boolean
}

function PromptTextarea({ textareaRef, value, onChange, onKeyDown, onBlur, onPaste, disabled }: PromptTextareaProps) {
  return (
    <Box px={4} pt={3} pb={1}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onPaste={onPaste}
        placeholder={t('prompt.placeholder')}
        aria-label={t('prompt.ariaLabel')}
        disabled={disabled}
        rows={1}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: tokens.colors.text.primary,
          fontSize: tokens.fontSize.lg,
          fontFamily: tokens.fontFamily.ui,
          resize: 'none',
          lineHeight: '24px',
          maxHeight: `${6 * 24}px`,
          overflowY: 'auto',
          opacity: disabled ? 0.5 : 1,
        }}
      />
    </Box>
  )
}

export default memo(PromptTextarea)
