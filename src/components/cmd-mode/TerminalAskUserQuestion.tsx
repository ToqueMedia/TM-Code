import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, Text, Input } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { useAskUserQuestionStore } from '../../stores/askUserQuestionStore'
import type { Question } from '../../stores/askUserQuestionStore'

const OTHER_LABEL = 'Other'

interface TerminalAskUserQuestionProps {
  requestId: string
  questions: Question[]
}

const TerminalQuestionBlock = memo(function TerminalQuestionBlock({
  question,
  idx,
  total,
  selected,
  otherText,
  onSelect,
  onOtherTextChange,
}: {
  question: Question
  idx: number
  total: number
  selected: string[]
  otherText: string
  onSelect: (label: string) => void
  onOtherTextChange: (text: string) => void
}) {
  const isOtherSelected = selected.includes(OTHER_LABEL)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOtherSelected && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOtherSelected])

  return (
    <Box mb={idx < total - 1 ? 3 : 0}>
      {/* Header */}
      <Flex align="center" gap={2} mb={1}>
        <Text
          fontSize="11px"
          color={tokens.colors.accent.primary}
          fontFamily={tokens.fontFamily.mono}
          fontWeight="700"
          textTransform="uppercase"
          letterSpacing="0.06em"
        >
          {question.header}
        </Text>
        {question.multiSelect && (
          <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
            (multi-select)
          </Text>
        )}
      </Flex>

      {/* Question */}
      <Text
        fontSize="12px"
        color={tokens.colors.text.primary}
        fontFamily={tokens.fontFamily.mono}
        lineHeight="1.5"
        mb={2}
      >
        {question.question}
      </Text>

      {/* Options */}
      {question.options.map((opt, optIdx) => {
        const isSelected = selected.includes(opt.label)
        const key = `${idx}-${optIdx}`
        return (
          <Flex
            key={key}
            align="center"
            gap={2}
            py="3px"
            cursor="pointer"
            onClick={() => onSelect(opt.label)}
            _hover={{ bg: 'rgba(255, 255, 255, 0.03)' }}
          >
            <Text
              fontSize="12px"
              fontFamily={tokens.fontFamily.mono}
              color={isSelected ? tokens.colors.accent.primary : tokens.colors.text.muted}
              fontWeight="600"
              w="14px"
              textAlign="center"
            >
              {isSelected ? (question.multiSelect ? '☑' : '●') : (question.multiSelect ? '☐' : '○')}
            </Text>
            <Text
              fontSize="12px"
              fontFamily={tokens.fontFamily.mono}
              fontWeight={isSelected ? '600' : '400'}
              color={isSelected ? tokens.colors.text.primary : tokens.colors.text.secondary}
            >
              {opt.label}
            </Text>
            {opt.description && (
              <Text fontSize="11px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.text.muted}>
                — {opt.description}
              </Text>
            )}
          </Flex>
        )
      })}

      {/* Other option with free-text input */}
      {question.allowOther && (
        <Flex
          align="flex-start"
          gap={2}
          py="3px"
          cursor="pointer"
          onClick={() => onSelect(OTHER_LABEL)}
          _hover={{ bg: 'rgba(255, 255, 255, 0.03)' }}
        >
          <Text
            fontSize="12px"
            fontFamily={tokens.fontFamily.mono}
            color={isOtherSelected ? tokens.colors.accent.primary : tokens.colors.text.muted}
            fontWeight="600"
            w="14px"
            textAlign="center"
            mt="3px"
          >
            {isOtherSelected ? (question.multiSelect ? '☑' : '●') : (question.multiSelect ? '☐' : '○')}
          </Text>
          <Box flex={1} onClick={(e) => e.stopPropagation()}>
            <Text
              fontSize="12px"
              fontFamily={tokens.fontFamily.mono}
              fontWeight={isOtherSelected ? '600' : '400'}
              color={isOtherSelected ? tokens.colors.text.primary : tokens.colors.text.secondary}
              mb={isOtherSelected ? 1 : 0}
            >
              Other
            </Text>
            {isOtherSelected && (
              <Input
                ref={inputRef}
                size="sm"
                fontSize="12px"
                fontFamily={tokens.fontFamily.mono}
                placeholder="Type your answer..."
                value={otherText}
                onChange={(e) => onOtherTextChange(e.target.value)}
                bg="rgba(0, 0, 0, 0.2)"
                border="1px solid rgba(255, 255, 255, 0.12)"
                borderRadius="4px"
                color={tokens.colors.text.primary}
                _placeholder={{ color: tokens.colors.text.muted }}
                _focus={{ borderColor: tokens.colors.accent.primary, outline: 'none' }}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect(OTHER_LABEL)
                }}
              />
            )}
          </Box>
        </Flex>
      )}
    </Box>
  )
})

export const TerminalAskUserQuestion = memo(function TerminalAskUserQuestion({
  requestId,
  questions,
}: TerminalAskUserQuestionProps) {
  const [selections, setSelections] = useState<Record<number, string[]>>({})
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({})
  const [submitting, setSubmitting] = useState(false)

  const handleSelect = useCallback(
    (questionIdx: number, label: string, multiSelect: boolean) => {
      setSelections((prev) => {
        const current = prev[questionIdx] ?? []
        let next: string[]
        if (multiSelect) {
          next = current.includes(label)
            ? current.filter((l) => l !== label)
            : [...current, label]
        } else {
          next = current.includes(label) ? [] : [label]
        }
        return { ...prev, [questionIdx]: next }
      })
    },
    [],
  )

  const handleOtherTextChange = useCallback((questionIdx: number, text: string) => {
    setOtherTexts((prev) => ({ ...prev, [questionIdx]: text }))
  }, [])

  const resolveAnswer = useCallback((q: Question, sel: string[], idx: number): string | string[] => {
    const mapLabel = (label: string) => {
      if (label === OTHER_LABEL && q.allowOther) {
        return (otherTexts[idx] ?? '').trim() || OTHER_LABEL
      }
      return label
    }
    return q.multiSelect ? sel.map(mapLabel) : mapLabel(sel[0])
  }, [otherTexts])

  const allAnswered = questions.every((q, i) => {
    const sel = selections[i] ?? []
    if (sel.length === 0) return false
    if (q.allowOther && sel.includes(OTHER_LABEL) && !(otherTexts[i] ?? '').trim()) {
      return false
    }
    return true
  })

  const handleSubmit = useCallback(() => {
    if (!allAnswered || submitting) return
    setSubmitting(true)
    const answers: Record<string, string | string[]> = {}
    questions.forEach((q, i) => {
      const sel = selections[i] ?? []
      answers[`question_${i}`] = resolveAnswer(q, sel, i)
    })
    useAskUserQuestionStore.getState().submit(requestId, answers)
  }, [allAnswered, submitting, selections, requestId, questions, resolveAnswer])

  const handleCancel = useCallback(() => {
    useAskUserQuestionStore.getState().cancel(requestId)
  }, [requestId])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (submitting) return

      // Cmd/Ctrl+Enter = submit
      if ((e.key === 'Enter' && (e.metaKey || e.ctrlKey)) || (e.key === 's' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault()
        handleSubmit()
        return
      }

      // Escape = cancel
      if (e.key === 'Escape') {
        e.preventDefault()
        handleCancel()
        return
      }

      // Enter without modifier = submit if all answered (but not if typing in Other input)
      if (e.key === 'Enter' && allAnswered && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault()
        handleSubmit()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [submitting, handleSubmit, handleCancel, allAnswered])

  return (
    <Box
      mb={3}
      borderLeft={`2px solid ${tokens.colors.accent.primary}`}
      pl={3}
      py={2}
    >
      {/* Questions */}
      {questions.map((q, idx) => (
        <TerminalQuestionBlock
          key={idx}
          question={q}
          idx={idx}
          total={questions.length}
          selected={selections[idx] ?? []}
          otherText={otherTexts[idx] ?? ''}
          onSelect={(label) => handleSelect(idx, label, q.multiSelect)}
          onOtherTextChange={(text) => handleOtherTextChange(idx, text)}
        />
      ))}

      {/* Key hints */}
      <Flex align="center" gap={3} mt={3} pt={2} borderTop={`1px solid rgba(255, 255, 255, 0.06)`}>
        <Flex align="center" gap={1}>
          <Box
            as="span"
            px="5px"
            py="1px"
            borderRadius="3px"
            bg="rgba(255, 255, 255, 0.06)"
            border="1px solid rgba(255, 255, 255, 0.1)"
            fontSize="10px"
            fontFamily={tokens.fontFamily.mono}
            color={tokens.colors.terminal.foreground}
            fontWeight="600"
          >
            {navigator.platform.includes('Mac') ? '⌘↵' : 'Ctrl+Enter'}
          </Box>
          <Text fontSize="10px" color={allAnswered ? tokens.colors.terminal.green : tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} opacity={0.8}>
            {submitting ? 'submitting...' : 'submit'}
          </Text>
        </Flex>
        <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
          ·
        </Text>
        <Flex align="center" gap={1}>
          <Box
            as="span"
            px="5px"
            py="1px"
            borderRadius="3px"
            bg="rgba(255, 255, 255, 0.06)"
            border="1px solid rgba(255, 255, 255, 0.1)"
            fontSize="10px"
            fontFamily={tokens.fontFamily.mono}
            color={tokens.colors.terminal.foreground}
            fontWeight="600"
          >
            esc
          </Box>
          <Text fontSize="10px" color={tokens.colors.accent.red} fontFamily={tokens.fontFamily.mono} opacity={0.8}>
            cancel
          </Text>
        </Flex>
      </Flex>
    </Box>
  )
})
