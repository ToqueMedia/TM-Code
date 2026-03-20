import React, { useEffect, useRef, useState } from 'react'
import { Box, Flex, Input } from '@chakra-ui/react'
import MonacoBridge from '../../utils/monacoBridge'
import { tokens } from '../../theme/tokens'

function GoToLineDialog(): React.ReactElement | null {
  const [isOpen, setIsOpen] = useState(false)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handler = () => {
      setIsOpen(true)
      setValue('')
      setTimeout(() => inputRef.current?.focus(), 0)
    }
    window.addEventListener('editor:go-to-line', handler)
    return () => window.removeEventListener('editor:go-to-line', handler)
  }, [])

  const close = () => setIsOpen(false)

  const submit = () => {
    const line = parseInt(value, 10)
    if (isNaN(line) || line < 1) return
    const ed = MonacoBridge.getInstance().getCurrentEditor()
    if (ed) {
      const model = ed.getModel()
      const maxLine = model ? model.getLineCount() : line
      const safeLine = Math.min(line, maxLine)
      ed.setPosition({ lineNumber: safeLine, column: 1 })
      ed.revealLineInCenter(safeLine)
      ed.focus()
    }
    close()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); submit() }
    if (e.key === 'Escape') close()
  }

  const onBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) close()
  }

  if (!isOpen) return null

  const ed = MonacoBridge.getInstance().getCurrentEditor()
  const maxLine = ed?.getModel()?.getLineCount() ?? 0
  const currentLine = ed?.getPosition()?.lineNumber ?? 1

  return (
    <Box position="fixed" inset={0} bg={tokens.colors.bg.blackOverlay} zIndex={2000} onMouseDown={onBackdrop}>
      <Flex justify="center" mt="10vh">
        <Box
          bg={tokens.colors.bg.app}
          border={`1px solid ${tokens.colors.border.default}`}
          borderRadius="12px"
          width="min(400px, 80vw)"
          boxShadow={tokens.shadow.overlay}
          p={3}
        >
          <Input
            ref={inputRef}
            type="number"
            min={1}
            max={maxLine}
            autoComplete="off"
            placeholder={`Go to Line (1–${maxLine}, current: ${currentLine})`}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            bg={tokens.colors.bg.statusbar}
            borderColor={tokens.colors.border.inputAlt}
            color={tokens.colors.text.statusbar}
            _focus={{ borderColor: tokens.colors.accent.primaryBorder, boxShadow: `0 0 0 2px ${tokens.colors.accent.primarySubtle}` }}
          />
        </Box>
      </Flex>
    </Box>
  )
}

export default GoToLineDialog
