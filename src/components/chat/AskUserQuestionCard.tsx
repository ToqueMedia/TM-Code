import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, Text, VStack, Input } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
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

const OTHER_LABEL = '__other__'

const QuestionBlock = memo(function QuestionBlock({
  question,
  selected,
  otherText,
  onSelect,
  onOtherTextChange,
}: {
  question: Question
  selected: string[]
  otherText: string
  onSelect: (label: string) => void
  onOtherTextChange: (text: string) => void
}) {
  const isOtherSelected = selected.includes(OTHER_LABEL)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-focus the text input when "Other" is selected
  useEffect(() => {
    if (isOtherSelected && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOtherSelected])

  return (
    <Box>
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
                w="14px"
                h="14px"
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

        {/* Other option with free-text input — always shown so the user can type freely */}
        <Flex
          align="center"
          gap={2.5}
          px={3}
          py={2}
          borderRadius="6px"
          cursor="pointer"
          bg={isOtherSelected ? 'rgba(254, 16, 99, 0.08)' : 'rgba(255, 255, 255, 0.02)'}
          border={`1px solid ${isOtherSelected ? tokens.colors.accent.primary : tokens.colors.border.panel}`}
          transition="all 0.15s ease"
          _hover={{
            bg: isOtherSelected ? 'rgba(254, 16, 99, 0.12)' : 'rgba(255, 255, 255, 0.05)',
            borderColor: isOtherSelected ? tokens.colors.accent.primary : 'rgba(255, 255, 255, 0.12)',
          }}
          onClick={() => onSelect(OTHER_LABEL)}
        >
          <Box
            w="14px"
            h="14px"
            borderRadius={question.multiSelect ? '3px' : '50%'}
            border={`1.5px solid ${isOtherSelected ? tokens.colors.accent.primary : tokens.colors.text.muted}`}
            bg={isOtherSelected ? tokens.colors.accent.primary : 'transparent'}
            display="flex"
            alignItems="center"
            justifyContent="center"
            flexShrink={0}
            transition="all 0.15s ease"
          >
            {isOtherSelected && (
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
              color={isOtherSelected ? tokens.colors.text.primary : tokens.colors.text.secondary}
              mb={isOtherSelected ? 1.5 : 0}
            >
              {t('chat.otherOption')}
            </Text>
            {isOtherSelected && (
              <Input
                ref={inputRef}
                size="sm"
                fontSize="12px"
                fontFamily={tokens.fontFamily.ui}
                placeholder={t('chat.otherPlaceholder')}
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
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({})
  const [submitting, setSubmitting] = useState(false)
  // Tabs (pedido do user 2026-07-17): uma pergunta por tab + tab final de
  // Resumo — o bloco vertical com N perguntas empilhadas saiu. O índice
  // questions.length É o Resumo.
  const [activeTab, setActiveTab] = useState(0)
  const summaryTab = questions.length

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
      let advanced = false
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
        // Single-select numa opção concreta = resposta dada → avança para a
        // tab seguinte (Resumo no fim). "Other" fica: o user vai escrever.
        advanced = !multiSelect && next.length > 0 && label !== OTHER_LABEL
        return { ...prev, [questionIdx]: next }
      })
      if (advanced) setActiveTab(Math.min(questionIdx + 1, summaryTab))
    },
    [summaryTab],
  )

  const handleOtherTextChange = useCallback((questionIdx: number, text: string) => {
    setOtherTexts((prev) => ({ ...prev, [questionIdx]: text }))
  }, [])

  // Resolve "Other" selections to typed text
  const resolveAnswer = useCallback((_q: Question, sel: string[], idx: number): string | string[] => {
    const mapLabel = (label: string) => {
      if (label === OTHER_LABEL) {
        return (otherTexts[idx] ?? '').trim() || OTHER_LABEL
      }
      return label
    }
    return _q.multiSelect ? sel.map(mapLabel) : mapLabel(sel[0])
  }, [otherTexts])

  const allAnswered = questions.every((_q, i) => {
    const sel = selections[i] ?? []
    if (sel.length === 0) return false
    if (sel.includes(OTHER_LABEL) && !(otherTexts[i] ?? '').trim()) {
      return false
    }
    return true
  })

  const handleSubmit = useCallback(() => {
    if (!allAnswered || submitting) return
    setSubmitting(true)

    // Build answers object keyed by question_N
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

      {/* Tab bar: uma tab por pergunta + Resumo no fim. ✓ = respondida. */}
      <Flex px={4} pt={2.5} pb={2} gap={1.5} flexWrap="wrap" borderBottom="1px solid rgba(255, 255, 255, 0.06)">
        {questions.map((q, idx) => {
          const sel = selections[idx] ?? []
          const answered =
            sel.length > 0 && !(sel.includes(OTHER_LABEL) && !(otherTexts[idx] ?? '').trim())
          const active = activeTab === idx
          return (
            <Flex
              key={idx}
              as="button"
              align="center"
              gap={1.5}
              px={2.5}
              py="4px"
              borderRadius="999px"
              cursor="pointer"
              bg={active ? 'rgba(254, 16, 99, 0.1)' : 'rgba(255, 255, 255, 0.03)'}
              border={`1px solid ${active ? tokens.colors.accent.primary : 'rgba(255, 255, 255, 0.08)'}`}
              transition="all 0.15s ease"
              _hover={{ bg: active ? 'rgba(254, 16, 99, 0.14)' : 'rgba(255, 255, 255, 0.06)' }}
              onClick={() => setActiveTab(idx)}
            >
              {answered ? (
                <Text fontSize="9px" color={tokens.colors.terminal.green} lineHeight={1} fontWeight="bold">✓</Text>
              ) : (
                <Box w="5px" h="5px" borderRadius="full" bg={active ? tokens.colors.accent.primary : tokens.colors.text.muted} />
              )}
              <Text
                fontSize="10px"
                fontFamily={tokens.fontFamily.ui}
                fontWeight="700"
                textTransform="uppercase"
                letterSpacing="0.04em"
                color={active ? tokens.colors.text.primary : tokens.colors.text.secondary}
              >
                {q.header}
              </Text>
            </Flex>
          )
        })}
        <Flex
          as="button"
          align="center"
          gap={1.5}
          px={2.5}
          py="4px"
          borderRadius="999px"
          cursor="pointer"
          bg={activeTab === summaryTab ? 'rgba(254, 16, 99, 0.1)' : 'rgba(255, 255, 255, 0.03)'}
          border={`1px solid ${activeTab === summaryTab ? tokens.colors.accent.primary : 'rgba(255, 255, 255, 0.08)'}`}
          transition="all 0.15s ease"
          _hover={{ bg: activeTab === summaryTab ? 'rgba(254, 16, 99, 0.14)' : 'rgba(255, 255, 255, 0.06)' }}
          onClick={() => setActiveTab(summaryTab)}
        >
          <Text
            fontSize="10px"
            fontFamily={tokens.fontFamily.ui}
            fontWeight="700"
            textTransform="uppercase"
            letterSpacing="0.04em"
            color={activeTab === summaryTab ? tokens.colors.text.primary : tokens.colors.text.secondary}
          >
            {t('chat.questionsSummary')}
          </Text>
        </Flex>
      </Flex>

      {/* Corpo: a pergunta ativa OU o resumo (Q→R, por-responder salta lá). */}
      <Box px={4} pt={3} pb={3}>
        {activeTab < summaryTab ? (
          <QuestionBlock
            key={activeTab}
            question={questions[activeTab]}
            selected={selections[activeTab] ?? []}
            otherText={otherTexts[activeTab] ?? ''}
            onSelect={(label) => handleSelect(activeTab, label, questions[activeTab].multiSelect)}
            onOtherTextChange={(text) => handleOtherTextChange(activeTab, text)}
          />
        ) : (
          <VStack align="stretch" gap={2}>
            {questions.map((q, idx) => {
              const sel = selections[idx] ?? []
              const answered =
                sel.length > 0 && !(sel.includes(OTHER_LABEL) && !(otherTexts[idx] ?? '').trim())
              const resolved = answered ? resolveAnswer(q, sel, idx) : null
              const answerText = resolved === null
                ? t('chat.questionsUnanswered')
                : Array.isArray(resolved) ? resolved.join(', ') : resolved
              return (
                <Flex
                  key={idx}
                  align="flex-start"
                  gap={2.5}
                  px={3}
                  py={2}
                  borderRadius="6px"
                  cursor="pointer"
                  bg="rgba(255, 255, 255, 0.02)"
                  border={`1px solid ${answered ? tokens.colors.border.panel : 'rgba(240, 192, 0, 0.3)'}`}
                  _hover={{ bg: 'rgba(255, 255, 255, 0.05)' }}
                  onClick={() => setActiveTab(idx)}
                  title={q.question}
                >
                  <Text
                    fontSize="10px"
                    fontFamily={tokens.fontFamily.ui}
                    fontWeight="700"
                    color={tokens.colors.accent.primary}
                    textTransform="uppercase"
                    letterSpacing="0.04em"
                    flexShrink={0}
                    mt="2px"
                  >
                    {q.header}
                  </Text>
                  <Box flex={1} minW={0}>
                    <Text fontSize="11px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.ui} lineHeight="1.4" mb="2px">
                      {q.question}
                    </Text>
                    <Text
                      fontSize="12px"
                      fontWeight="600"
                      fontFamily={tokens.fontFamily.ui}
                      color={answered ? tokens.colors.text.primary : tokens.colors.accent.orange}
                    >
                      {answerText}
                    </Text>
                  </Box>
                </Flex>
              )
            })}
          </VStack>
        )}
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
