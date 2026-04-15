import { memo, useImperativeHandle, forwardRef } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { useCmdPromptLogic } from '../../hooks/useCmdPromptLogic'
import SlashCommandMenu from '../chat/SlashCommandMenu'
import { TerminalMentionMenu } from './TerminalMentionMenu'
import { tokens } from '@/theme/tokens'
import type { QueuedCommand } from '../../types/messageQueueTypes'

export interface CmdModePromptInputRef {
  focus: () => void
  hasText: () => boolean
}

// ─── Terminal-style queued messages ───

function previewText(value: QueuedCommand['value']): string {
  if (typeof value === 'string') return value
  return value.map(b => (b.type === 'text' ? b.text : '[attachment]')).join(' ')
}

const QueuedMessagesTerminal = memo(function QueuedMessagesTerminal({
  commands,
}: {
  commands: readonly QueuedCommand[]
}) {
  if (commands.length === 0) return null

  return (
    <Box px={2} pb={1} borderTop="1px solid rgba(255,255,255,0.04)">
      {commands.map((cmd, i) => (
        <Flex
          key={cmd.uuid ?? `q-${i}`}
          align="center"
          gap={2}
          py="2px"
        >
          {/* Queued indicator */}
          <Flex align="center" gap={1} flexShrink={0}>
            <Box
              w="4px"
              h="4px"
              borderRadius="full"
              bg={tokens.colors.accent.purple}
              opacity={0.5}
              css={{
                animation: 'qPulse 2s ease-in-out infinite',
                '@keyframes qPulse': { '0%, 100%': { opacity: 0.3 }, '50%': { opacity: 0.8 } },
              }}
            />
            <Text fontSize="9px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} fontWeight="600" letterSpacing="0.08em">
              queued
            </Text>
          </Flex>

          {/* Message preview */}
          <Text
            fontSize="11px"
            color={tokens.colors.text.muted}
            fontFamily={tokens.fontFamily.mono}
            flex="1"
            lineClamp={1}
            opacity={0.8}
          >
            {previewText(cmd.value)}
          </Text>
        </Flex>
      ))}
    </Box>
  )
})

// ─── CmdModePromptInput ───

const CmdModePromptInput = memo(forwardRef<CmdModePromptInputRef>(function CmdModePromptInput(_props, ref) {
  const {
    input,
    showCommandMenu,
    filteredCommands,
    selectedCommandIndex,
    showMentionMenu,
    filteredMentions,
    selectedMentionIndex,
    textareaRef,
    isStreaming,
    queuedCommands,
    projectPath,
    handleInputChange,
    handleCommandSelect,
    handleMentionSelect,
    handleKeyDown,
    handleFocus,
    handleBlur,
  } = useCmdPromptLogic()

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    hasText: () => (textareaRef.current?.value.trim().length ?? 0) > 0,
  }), [textareaRef])

  return (
    <Box
      bg={tokens.colors.terminal.background}
      borderTop="1px solid rgba(255, 255, 255, 0.05)"
      position="relative"
      data-no-drag
    >
      {/* Slash command autocomplete */}
      {showCommandMenu && (
        <SlashCommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={handleCommandSelect}
          theme="purple"
          direction="up"
          maxHeight={260}
        />
      )}

      {/* @mention menu — positioned absolute inside the outer Box (position="relative") */}
      {showMentionMenu && (
        <TerminalMentionMenu
          items={filteredMentions}
          selectedIndex={selectedMentionIndex}
          onSelect={handleMentionSelect}
          projectPath={projectPath}
        />
      )}

      {/* Queued messages — terminal style */}
      <QueuedMessagesTerminal commands={queuedCommands} />

      {/* Prompt bar */}
      <Flex
        align="flex-start"
        gap={0}
        px={2}
        py={2}
      >
        {/* Terminal prompt glyph */}
        <Text
          fontFamily={tokens.fontFamily.mono}
          fontSize="13px"
          color={isStreaming ? tokens.colors.text.disabled : tokens.colors.accent.purple}
          mr={2}
          fontWeight="600"
          lineHeight="24px"
          flexShrink={0}
          userSelect="none"
          mt="2px"
          transition="color 0.15s"
        >
          ❯
        </Text>

        <Box flex="1" position="relative">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={handleFocus}
            onBlur={handleBlur}
            placeholder={isStreaming ? '' : 'Type a command or message…'}
            aria-label="CMD Mode input"
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
              color: tokens.colors.terminal.foreground,
              fontSize: '13px',
              fontFamily: tokens.fontFamily.mono,
              resize: 'none',
              lineHeight: '24px',
              padding: '2px 0',
              maxHeight: `${6 * 24}px`,
              overflowY: 'auto',
            }}
          />
        </Box>

        {/* Streaming indicator — keyboard: Esc to stop */}
        {isStreaming && (
          <Text
            fontSize="10px"
            color={tokens.colors.text.disabled}
            fontFamily={tokens.fontFamily.mono}
            flexShrink={0}
            ml={2}
            mt="4px"
            userSelect="none"
          >
            esc
          </Text>
        )}
      </Flex>
    </Box>
  )
}))

export default CmdModePromptInput
