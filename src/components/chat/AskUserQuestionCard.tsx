import { memo, useCallback, useEffect, useState } from 'react'
import { Box, Flex, Text, VStack } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { useAskUserQuestionStore } from '../../stores/askUserQuestionStore'
import type { Question } from '../../stores/askUserQuestionStore'
import { useChatStore } from '../../stores/chatStore'

interface AskUserQuestionCardProps {
  messageId: string
  requestId: string
  projectPath: string
  status: string
  questions: Question[]
}

const QuestionBlock = memo(function QuestionBlock({
  question,
  idx,
  selected,
  onSelect,
}: {
  question: Question
  idx: number
  selected: string[]
  onSelect: (label: string) => void
}) {
  return (
    <Box mb={idx < 3 ? 4 : 0}>
      {/* Header chip */}
      <Flex align="center" gap={2} mb={2}>
        <Text
          fontSize="10px"
          fontFamily={tokens.fontFamily.ui}
          fontWeight="700"
          color={tokens.colors.accent.primary}
          bg="rgba(254, 16, 99, 0.08)"
          border="1px solid rgba(254, 16, 99, 0.2)"
          borderRadius="4px"
          px={2}
          py="2px"
          textTransform="uppercase"
          letterSpacing="0.05em"
        >
          {question.header}
        </Text>
      </Flex>

      {/* Question text */}
      <Text
        fontSize="13px"
        color={tokens.colors.text.primary}
        fontFamily={tokens.fontFamily.ui}
        lineHeight="1.6"
        mb={2.5}
      >
        {question.question}
      </Text>

      {/* Options */}
      <VStack align="stretch" gap={1.5}>
        {question.options.map((opt) => {
          const isSelected = selected.includes(opt.label)
          return (
            <Flex
              key={opt.label}
              align="center"
              gap={2.5}
              px={3}
              py={2}
              borderRadius="6px"
              cursor="pointer"
              bg={isSelected ? 'rgba(254, 16, 99, 0.08)' : 'rgba(255, 255, 255, 0.02)'}
              border={`1px solid ${isSelected ? tokens.colors.accent.primary : tokens.colors.border.panel}`}
              transition="all 0.15s ease"
              _hover={{
                bg: isSelected ? 'rgba(254, 16, 99, 0.12)' : 'rgba(255, 255, 255, 0.05)',
                borderColor: isSelected ? tokens.colors.accent.primary : 'rgba(255, 255, 255, 0.12)',
              }}
              onClick={() => onSelect(opt.label)}
            >
              {/* Radio / Checkbox indicator */}
              <Box
                w={question.multiSelect ? '14px' : '14px'}
                h={question.multiSelect ? '14px' : '14px'}
                borderRadius={question.multiSelect ? '3px' : '50%'}
                border={`1.5px solid ${isSelected ? tokens.colors.accent.primary : tokens.colors.text.muted}`}
                bg={isSelected ? tokens.colors.accent.primary : 'transparent'}
                display="flex"
                alignItems="center"
                justifyContent="center"
                flexShrink={0}
                transition="all 0.15s ease"
              >
                {isSelected && (
                  <Text fontSize="9px" color="white" lineHeight={1} fontWeight="bold">
                    {question.multiSelect ? '✓' : ''}
                  </Text>
                )}
              </Box>

              <Box flex={1}>
                <Text
                  fontSize="12px"
                  fontFamily={tokens.fontFamily.ui}
                  fontWeight="600"
                  color={isSelected ? tokens.colors.text.primary : tokens.colors.text.secondary}
                >
                  {opt.label}
                </Text>
                {opt.description && (
                  <Text
                    fontSize="11px"
                    fontFamily={tokens.fontFamily.ui}
                    color={tokens.colors.text.muted}
                    mt="2px"
                    lineHeight="1.4"
                  >
                    {opt.description}
                  </Text>
                )}
              </Box>
            </Flex>
          )
        })}
      </VStack>
    </Box>
  )
})

export const AskUserQuestionCard = memo(function AskUserQuestionCard({
  messageId,
  requestId,
  status,
  questions,
}: AskUserQuestionCardProps) {
  // Track selected labels per question index
  const [selections, setSelections] = useState<Record<number, string[]>>({})
  const [submitting, setSubmitting] = useState(false)

  // Auto-remove after submit/cancel
  useEffect(() => {
    if (status !== 'submitted' && status !== 'cancelled') return
    const timer = setTimeout(() => {
      useChatStore.getState().removeMessage(messageId)
    }, 3000)
    return () => clearTimeout(timer)
  }, [status, messageId])

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

  const allAnswered = questions.every((_, i) => (selections[i] ?? []).length > 0)

  const handleSubmit = useCallback(() => {
    if (!allAnswered || submitting) return
    setSubmitting(true)

    // Build answers object keyed by question_N
    const answers: Record<string, string | string[]> = {}
    questions.forEach((q, i) => {
      const sel = selections[i] ?? []
      answers[`question_${i}`] = q.multiSelect ? sel : sel[0]
    })

    useAskUserQuestionStore.getState().submit(requestId, answers)
  }, [allAnswered, submitting, selections, requestId, questions])

  const handleCancel = useCallback(() => {
    useAskUserQuestionStore.getState().cancel(requestId)
  }, [requestId])

  // ── Submitted state ──
  if (status === 'submitted') {
    return (
      <Box mb={3} px={4} py={3} borderRadius="8px" bg="rgba(46, 160, 67, 0.05)" border="1px solid rgba(46, 160, 67, 0.15)">
        <Flex align="center" gap={2}>
          <Text fontSize="13px" color={tokens.colors.terminal.green} fontFamily={tokens.fontFamily.ui}>
            ✓
          </Text>
          <Text fontSize="12px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.ui}>
            Questions answered — continuing...
          </Text>
        </Flex>
      </Box>
    )
  }

  // ── Cancelled state ──
  if (status === 'cancelled') {
    return (
      <Box mb={3} px={4} py={3} borderRadius="8px" bg="rgba(255, 255, 255, 0.02)" border="1px solid rgba(255, 255, 255, 0.06)">
        <Flex align="center" gap={2}>
          <Text fontSize="13px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.ui}>
            ✗
          </Text>
          <Text fontSize="12px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.ui}>
            Questions cancelled.
          </Text>
        </Flex>
      </Box>
    )
  }

  // ── Active form ──
  return (
    <Box
      mb={3}
      borderRadius="8px"
      bg="rgba(255, 255, 255, 0.02)"
      border="1px solid rgba(255, 255, 255, 0.08)"
      overflow="hidden"
    >
      {/* Header */}
      <Flex
        align="center"
        gap={2}
        px={4}
        py={2.5}
        borderBottom="1px solid rgba(255, 255, 255, 0.06)"
        bg="rgba(254, 16, 99, 0.03)"
      >
        <Text
          fontSize="10px"
          fontFamily={tokens.fontFamily.ui}
          fontWeight="700"
          color={tokens.colors.accent.primary}
          textTransform="uppercase"
          letterSpacing="0.08em"
        >
          Questions
        </Text>
        <Text
          fontSize="10px"
          fontFamily={tokens.fontFamily.ui}
          color={tokens.colors.text.muted}
        >
          {questions.length} {questions.length === 1 ? 'question' : 'questions'}
        </Text>
      </Flex>

      {/* Questions */}
      <Box px={4} pt={3} pb={3}>
        {questions.map((q, idx) => (
          <QuestionBlock
            key={idx}
            question={q}
            idx={idx}
            selected={selections[idx] ?? []}
            onSelect={(label) => handleSelect(idx, label, q.multiSelect)}
          />
        ))}
      </Box>

      {/* Actions */}
      <Flex
        align="center"
        justify="flex-end"
        gap={2}
        px={4}
        py={2.5}
        borderTop="1px solid rgba(255, 255, 255, 0.06)"
        bg="rgba(0, 0, 0, 0.1)"
      >
        <Box
          as="button"
          px={3}
          py="6px"
          borderRadius="6px"
          bg="transparent"
          border={`1px solid ${tokens.colors.border.panel}`}
          fontSize="11px"
          fontFamily={tokens.fontFamily.ui}
          fontWeight="600"
          color={tokens.colors.text.secondary}
          cursor="pointer"
          transition="all 0.15s ease"
          _hover={{
            bg: 'rgba(255, 255, 255, 0.05)',
            borderColor: 'rgba(255, 255, 255, 0.15)',
          }}
          onClick={handleCancel}
        >
          Cancel
        </Box>
        <Box
          as="button"
          px={3}
          py="6px"
          borderRadius="6px"
          bg={allAnswered ? tokens.colors.accent.primary : 'rgba(255, 255, 255, 0.05)'}
          border="none"
          fontSize="11px"
          fontFamily={tokens.fontFamily.ui}
          fontWeight="600"
          color={allAnswered ? 'white' : tokens.colors.text.muted}
          cursor={allAnswered ? 'pointer' : 'default'}
          opacity={allAnswered ? 1 : 0.5}
          transition="all 0.15s ease"
          _hover={allAnswered ? { filter: 'brightness(1.1)' } : undefined}
          onClick={handleSubmit}
        >
          Submit{submitting ? 'ting...' : ''}
        </Box>
      </Flex>
    </Box>
  )
})
