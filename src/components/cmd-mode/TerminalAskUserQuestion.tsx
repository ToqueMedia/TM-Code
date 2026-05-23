import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, Text, Input } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { useAskUserQuestionStore } from '../../stores/askUserQuestionStore'
import { useChatStore } from '../../stores/chatStore'
import type { Question } from '../../stores/askUserQuestionStore'
import type { ChatMessageCard } from '../../types/chat'

const OTHER_LABEL = 'Other'

interface TerminalAskUserQuestionProps {
  messageId: string
  requestId: string
  questions: Question[]
  status?: ChatMessageCard['status']
}

// ─── Tab bar ────────────────────────────────────────────────────────────────

function TabBar({
  questions,
  activeTab,
  allAnswered,
}: {
  questions: Question[]
  activeTab: number
  allAnswered: boolean
}) {
  const tabCount = questions.length + 1 // +1 for summary tab
  return (
    <Flex
      gap={0}
      borderBottom={`1px solid ${tokens.colors.border.panel}`}
      mb={2}
      userSelect="none"
    >
      {questions.map((q, i) => {
        const isActive = i === activeTab
        return (
          <Flex
            key={i}
            align="center"
            gap={1}
            px={2}
            py="4px"
            cursor="pointer"
            borderBottom={isActive ? `2px solid ${tokens.colors.accent.primary}` : '2px solid transparent'}
            bg={isActive ? 'rgba(254, 16, 99, 0.06)' : 'transparent'}
            transition="all 0.12s"
            _hover={{ bg: isActive ? 'rgba(254, 16, 99, 0.06)' : 'rgba(255, 255, 255, 0.03)' }}
          >
            <Text
              fontSize="11px"
              fontFamily={tokens.fontFamily.mono}
              fontWeight="600"
              color={isActive ? tokens.colors.accent.primary : tokens.colors.text.muted}
            >
              {isActive ? '●' : '○'}
            </Text>
            <Text
              fontSize="11px"
              fontFamily={tokens.fontFamily.mono}
              fontWeight={isActive ? '700' : '400'}
              color={isActive ? tokens.colors.text.primary : tokens.colors.text.muted}
              textTransform="uppercase"
              letterSpacing="0.04em"
            >
              {q.header}
            </Text>
          </Flex>
        )
      })}
      {/* Summary / Review tab */}
      <Flex
        align="center"
        gap={1}
        px={2}
        py="4px"
        cursor="pointer"
        borderBottom={activeTab === tabCount - 1 ? `2px solid ${tokens.colors.accent.primary}` : '2px solid transparent'}
        bg={activeTab === tabCount - 1 ? 'rgba(254, 16, 99, 0.06)' : 'transparent'}
        transition="all 0.12s"
        _hover={{ bg: activeTab === tabCount - 1 ? 'rgba(254, 16, 99, 0.06)' : 'rgba(255, 255, 255, 0.03)' }}
      >
        <Text
          fontSize="11px"
          fontFamily={tokens.fontFamily.mono}
          fontWeight="600"
          color={activeTab === tabCount - 1 ? tokens.colors.accent.primary : tokens.colors.text.muted}
        >
          {activeTab === tabCount - 1 ? '●' : allAnswered ? '✓' : '○'}
        </Text>
        <Text
          fontSize="11px"
          fontFamily={tokens.fontFamily.mono}
          fontWeight={activeTab === tabCount - 1 ? '700' : '400'}
          color={activeTab === tabCount - 1 ? tokens.colors.text.primary : allAnswered ? tokens.colors.terminal.green : tokens.colors.text.muted}
          textTransform="uppercase"
          letterSpacing="0.04em"
        >
          Review
        </Text>
      </Flex>
    </Flex>
  )
}

// ─── Question panel (single question view) ──────────────────────────────────

function QuestionPanel({
  question,
  selections,
  otherText,
  focusedOption,
  onOtherTextChange,
  onOtherKeyDown,
  otherInputRef,
}: {
  question: Question
  selections: string[]
  otherText: string
  focusedOption: number
  onOtherTextChange: (text: string) => void
  onOtherKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  otherInputRef: React.RefObject<HTMLInputElement | null>
}) {
  const isOtherSelected = selections.includes(OTHER_LABEL)
  const totalOptions = question.options.length + 1 // +1 for Other
  const isOtherFocusedOption = focusedOption === totalOptions - 1

  return (
    <Box>
      {/* Question header */}
      <Text
        fontSize="10px"
        fontFamily={tokens.fontFamily.mono}
        color={tokens.colors.accent.primary}
        fontWeight="700"
        textTransform="uppercase"
        letterSpacing="0.08em"
        mb={1}
      >
        {question.header}
      </Text>
      <Text
        fontSize="12px"
        fontFamily={tokens.fontFamily.mono}
        color={tokens.colors.text.primary}
        lineHeight="1.5"
        mb={3}
      >
        {question.question}
      </Text>

      {/* Options */}
      {question.options.map((opt, optIdx) => {
        const isSelected = selections.includes(opt.label)
        const isFocused = focusedOption === optIdx
        return (
          <Flex
            key={optIdx}
            align="center"
            gap={2}
            py="3px"
            px={1}
            borderRadius="3px"
            bg={isFocused ? 'rgba(255, 255, 255, 0.04)' : 'transparent'}
            transition="background 0.1s"
          >
            <Text
              fontSize="12px"
              fontFamily={tokens.fontFamily.mono}
              color={tokens.colors.text.muted}
              w="14px"
              textAlign="center"
            >
              {isFocused ? '→' : ' '}
            </Text>
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
              fontWeight={isSelected || isFocused ? '600' : '400'}
              color={isSelected ? tokens.colors.text.primary : isFocused ? tokens.colors.text.primary : tokens.colors.text.secondary}
            >
              {opt.label}
            </Text>
            {opt.description && (
              <Text
                fontSize="11px"
                fontFamily={tokens.fontFamily.mono}
                color={tokens.colors.text.muted}
              >
                — {opt.description}
              </Text>
            )}
          </Flex>
        )
      })}

      {/* Other option */}
      <Flex
        align="center"
        gap={2}
        py="3px"
        px={1}
        borderRadius="3px"
        bg={isOtherFocusedOption ? 'rgba(255, 255, 255, 0.04)' : 'transparent'}
        transition="background 0.1s"
      >
        <Text
          fontSize="12px"
          fontFamily={tokens.fontFamily.mono}
          color={tokens.colors.text.muted}
          w="14px"
          textAlign="center"
        >
          {isOtherFocusedOption ? '→' : ' '}
        </Text>
        <Text
          fontSize="12px"
          fontFamily={tokens.fontFamily.mono}
          color={isOtherSelected ? tokens.colors.accent.primary : tokens.colors.text.muted}
          fontWeight="600"
          w="14px"
          textAlign="center"
        >
          {isOtherSelected ? (question.multiSelect ? '☑' : '●') : (question.multiSelect ? '☐' : '○')}
        </Text>
        <Box flex={1}>
          <Text
            fontSize="12px"
            fontFamily={tokens.fontFamily.mono}
            fontWeight={isOtherSelected || isOtherFocusedOption ? '600' : '400'}
            color={isOtherSelected ? tokens.colors.text.primary : isOtherFocusedOption ? tokens.colors.text.primary : tokens.colors.text.secondary}
            mb={isOtherSelected ? 1 : 0}
          >
            {otherText.trim() && isOtherSelected ? otherText.trim() : OTHER_LABEL}
          </Text>
          {isOtherSelected && (
            <Input
              ref={otherInputRef}
              size="sm"
              fontSize="12px"
              fontFamily={tokens.fontFamily.mono}
              placeholder="Type your answer..."
              value={otherText}
              onChange={(e) => onOtherTextChange(e.target.value)}
              onKeyDown={onOtherKeyDown}
              bg="rgba(0, 0, 0, 0.2)"
              border="1px solid rgba(255, 255, 255, 0.12)"
              borderRadius="4px"
              color={tokens.colors.text.primary}
              _placeholder={{ color: tokens.colors.text.muted }}
              _focus={{ borderColor: tokens.colors.accent.primary, outline: 'none' }}
            />
          )}
        </Box>
      </Flex>
    </Box>
  )
}

// ─── Summary panel ──────────────────────────────────────────────────────────

function SummaryPanel({
  questions,
  selections,
  otherTexts,
}: {
  questions: Question[]
  selections: Record<number, string[]>
  otherTexts: Record<number, string>
}) {
  return (
    <Box>
      <Text
        fontSize="10px"
        fontFamily={tokens.fontFamily.mono}
        color={tokens.colors.accent.primary}
        fontWeight="700"
        textTransform="uppercase"
        letterSpacing="0.08em"
        mb={3}
      >
        Summary
      </Text>
      {questions.map((q, i) => {
        const sel = selections[i] ?? []
        const resolved = sel.map((label) => {
          if (label === OTHER_LABEL) {
            return (otherTexts[i] ?? '').trim() || OTHER_LABEL
          }
          return label
        })
        const display = resolved.length > 0 ? resolved.join(', ') : '—'
        return (
          <Flex key={i} gap={3} mb={1}>
            <Text
              fontSize="12px"
              fontFamily={tokens.fontFamily.mono}
              color={tokens.colors.text.muted}
              fontWeight="600"
              minW="120px"
              textTransform="uppercase"
              letterSpacing="0.04em"
            >
              {q.header}:
            </Text>
            <Text
              fontSize="12px"
              fontFamily={tokens.fontFamily.mono}
              color={resolved.length > 0 ? tokens.colors.text.primary : tokens.colors.text.muted}
            >
              {display}
            </Text>
          </Flex>
        )
      })}
    </Box>
  )
}

// ─── Main component ─────────────────────────────────────────────────────────

export const TerminalAskUserQuestion = memo(function TerminalAskUserQuestion({
  messageId,
  requestId,
  questions,
  status,
}: TerminalAskUserQuestionProps) {
  const [activeTab, setActiveTab] = useState(0)
  const [selections, setSelections] = useState<Record<number, string[]>>({})
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({})
  const [focusedOption, setFocusedOption] = useState(0)
  const [submitting, setSubmitting] = useState(false)

  const tabCount = questions.length + 1 // +1 for summary
  const isSummaryTab = activeTab === tabCount - 1
  const rootRef = useRef<HTMLDivElement>(null)
  const otherInputRef = useRef<HTMLInputElement>(null)

  // Resolve whether all questions are answered
  const allAnswered = questions.every((_q, i) => {
    const sel = selections[i] ?? []
    if (sel.length === 0) return false
    if (sel.includes(OTHER_LABEL) && !(otherTexts[i] ?? '').trim()) return false
    return true
  })

  // Auto-focus root on mount so keyboard navigation works immediately.
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  // Reset focused option when switching tabs
  useEffect(() => {
    setFocusedOption(0)
  }, [activeTab])

  // Auto-remove after submit/cancel
  useEffect(() => {
    if (status !== 'submitted' && status !== 'cancelled') return
    const timer = setTimeout(() => {
      useChatStore.getState().removeMessage(messageId)
    }, 2000)
    return () => clearTimeout(timer)
  }, [status, messageId])

  const handleSelect = useCallback((questionIdx: number, label: string) => {
    const q = questions[questionIdx]
    setSelections((prev) => {
      const current = prev[questionIdx] ?? []
      let next: string[]
      if (q.multiSelect) {
        next = current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label]
      } else {
        next = current.includes(label) ? [] : [label]
      }
      return { ...prev, [questionIdx]: next }
    })
  }, [questions])

  const handleOtherTextChange = useCallback((text: string) => {
    setOtherTexts((prev) => ({ ...prev, [activeTab]: text }))
  }, [activeTab])

  const handleSubmit = useCallback(() => {
    if (!allAnswered || submitting) return
    setSubmitting(true)
    const answers: Record<string, string | string[]> = {}
    questions.forEach((q, i) => {
      const sel = selections[i] ?? []
      const mapLabel = (label: string) => {
        if (label === OTHER_LABEL) {
          return (otherTexts[i] ?? '').trim() || OTHER_LABEL
        }
        return label
      }
      answers[`question_${i}`] = q.multiSelect ? sel.map(mapLabel) : mapLabel(sel[0])
    })
    useAskUserQuestionStore.getState().submit(requestId, answers)
  }, [allAnswered, submitting, selections, requestId, questions, otherTexts])

  const handleCancel = useCallback(() => {
    useAskUserQuestionStore.getState().cancel(requestId)
  }, [requestId])

  // Handle Enter/Escape/Tab in the "Other" text input.
  // Uses stopPropagation to prevent the root onKeyDown from seeing these events.
  const handleOtherKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      rootRef.current?.focus()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      rootRef.current?.focus()
      return
    }
    // Tab/Shift+Tab: advance/go back in tabs. Without this, the browser's
    // default Tab behavior steals focus to the next tabbable element (prompt
    // input, buttons, etc.), breaking keyboard navigation.
    if (e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      setActiveTab((prev) => e.shiftKey ? (prev - 1 + tabCount) % tabCount : (prev + 1) % tabCount)
      rootRef.current?.focus()
    }
  }, [tabCount])

  // Keyboard navigation — scoped to the root div's DOM subtree via onKeyDown.
  // This avoids window.addEventListener which would capture keys globally
  // and interfere with the prompt input, code blocks, session picker, etc.
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (submitting) return
    if (status === 'submitted' || status === 'cancelled') return

    // Don't intercept when typing in the Other input — let the input handle
    // its own cursor movement, selection, etc. Enter/Escape in the input are
    // handled by handleOtherKeyDown which calls stopPropagation to prevent
    // this handler from seeing them.
    if (e.target instanceof HTMLInputElement) return

    const totalOptions = isSummaryTab ? 0 : questions[activeTab].options.length + 1 // +1 for Other

    switch (e.key) {
      case 'ArrowLeft': {
        e.preventDefault()
        e.stopPropagation()
        setActiveTab((prev) => (prev - 1 + tabCount) % tabCount)
        return
      }
      case 'ArrowRight': {
        e.preventDefault()
        e.stopPropagation()
        setActiveTab((prev) => (prev + 1) % tabCount)
        return
      }
      case 'ArrowUp': {
        if (isSummaryTab) return
        e.preventDefault()
        e.stopPropagation()
        setFocusedOption((prev) => (prev - 1 + totalOptions) % totalOptions)
        return
      }
      case 'ArrowDown': {
        if (isSummaryTab) return
        e.preventDefault()
        e.stopPropagation()
        setFocusedOption((prev) => (prev + 1) % totalOptions)
        return
      }
      case 'Enter': {
        e.preventDefault()
        e.stopPropagation()
        if (isSummaryTab) {
          handleSubmit()
          return
        }
        const isOther = focusedOption === questions[activeTab].options.length
        if (isOther) {
          // Ensure "Other" is selected (don't toggle off if already selected).
          const currentSel = selections[activeTab] ?? []
          if (!currentSel.includes(OTHER_LABEL)) {
            handleSelect(activeTab, OTHER_LABEL)
          }
          // Focus input on next tick (after React renders it if newly selected).
          setTimeout(() => {
            otherInputRef.current?.focus()
          }, 0)
          return
        }
        handleSelect(activeTab, questions[activeTab].options[focusedOption].label)
        return
      }
      case 'Escape': {
        e.preventDefault()
        e.stopPropagation()
        handleCancel()
        return
      }
    }

    // Tab / Shift+Tab for tab navigation
    if (e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      setActiveTab((prev) => e.shiftKey ? (prev - 1 + tabCount) % tabCount : (prev + 1) % tabCount)
    }
  }, [submitting, status, activeTab, tabCount, isSummaryTab, questions, focusedOption, selections, handleSelect, handleSubmit, handleCancel])

  // Submitted / cancelled status
  if (status === 'submitted') {
    return (
      <Box mb={3} pl={3} py={1}>
        <Text fontSize="12px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.terminal.green}>
          ✓ answers submitted
        </Text>
      </Box>
    )
  }

  if (status === 'cancelled') {
    return (
      <Box mb={3} pl={3} py={1}>
        <Text fontSize="12px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.accent.red}>
          ✗ cancelled
        </Text>
      </Box>
    )
  }

  return (
    <Box
      ref={rootRef}
      data-question-root
      tabIndex={-1}
      mb={3}
      borderLeft={`2px solid ${tokens.colors.accent.primary}`}
      pl={3}
      py={2}
      outline="none"
      _focus={{ outline: 'none' }}
      onKeyDown={handleKeyDown}
    >
      {/* Tab bar */}
      <TabBar questions={questions} activeTab={activeTab} allAnswered={allAnswered} />

      {/* Panel content */}
      <Box minH="80px" mb={2}>
        {isSummaryTab ? (
          <SummaryPanel questions={questions} selections={selections} otherTexts={otherTexts} />
        ) : (
          <QuestionPanel
            question={questions[activeTab]}
            selections={selections[activeTab] ?? []}
            otherText={otherTexts[activeTab] ?? ''}
            focusedOption={focusedOption}
            onOtherTextChange={handleOtherTextChange}
            onOtherKeyDown={handleOtherKeyDown}
            otherInputRef={otherInputRef}
          />
        )}
      </Box>

      {/* Key hints */}
      <Flex
        align="center"
        gap={3}
        pt={2}
        borderTop={`1px solid rgba(255, 255, 255, 0.06)`}
        userSelect="none"
      >
        <Flex align="center" gap={1}>
          <Box as="span" px="4px" py="1px" borderRadius="3px" bg="rgba(255, 255, 255, 0.06)" border="1px solid rgba(255, 255, 255, 0.1)" fontSize="10px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.terminal.foreground} fontWeight="600">←→</Box>
          <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} opacity={0.7}>tabs</Text>
        </Flex>
        {!isSummaryTab && (
          <Flex align="center" gap={1}>
            <Box as="span" px="4px" py="1px" borderRadius="3px" bg="rgba(255, 255, 255, 0.06)" border="1px solid rgba(255, 255, 255, 0.1)" fontSize="10px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.terminal.foreground} fontWeight="600">↑↓</Box>
            <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} opacity={0.7}>navigate</Text>
          </Flex>
        )}
        <Flex align="center" gap={1}>
          <Box as="span" px="4px" py="1px" borderRadius="3px" bg="rgba(255, 255, 255, 0.06)" border="1px solid rgba(255, 255, 255, 0.1)" fontSize="10px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.terminal.foreground} fontWeight="600">↵</Box>
          <Text fontSize="10px" color={isSummaryTab && allAnswered ? tokens.colors.terminal.green : tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} opacity={0.7}>
            {isSummaryTab ? (submitting ? 'submitting...' : 'submit') : 'select'}
          </Text>
        </Flex>
        <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} opacity={0.4}>·</Text>
        <Flex align="center" gap={1}>
          <Box as="span" px="4px" py="1px" borderRadius="3px" bg="rgba(255, 255, 255, 0.06)" border="1px solid rgba(255, 255, 255, 0.1)" fontSize="10px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.terminal.foreground} fontWeight="600">esc</Box>
          <Text fontSize="10px" color={tokens.colors.accent.red} fontFamily={tokens.fontFamily.mono} opacity={0.7}>cancel</Text>
        </Flex>
      </Flex>
    </Box>
  )
})
