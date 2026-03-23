import React, { memo } from 'react'
import { Box } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

interface PromptTextareaProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  value: string
  onChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onBlur?: () => void
  disabled: boolean
}

function PromptTextarea({ textareaRef, value, onChange, onKeyDown, onBlur, disabled }: PromptTextareaProps) {
  return (
    <Box px={4} pt={3} pb={1}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        placeholder="Ask anything... (type / for commands)"
        aria-label="Message prompt"
        disabled={disabled}
        rows={1}
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
