import { memo, useImperativeHandle, forwardRef } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiPaperclip } from 'react-icons/fi'
import { useCmdPromptLogic } from '../../hooks/useCmdPromptLogic'
import SlashCommandMenu from '../chat/SlashCommandMenu'
import { TerminalMentionMenu } from './TerminalMentionMenu'
import CmdAttachmentBar from './CmdAttachmentBar'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import type { QueuedCommand } from '../../types/messageQueueTypes'

export interface CmdModePromptInputRef {
  focus: () => void
  hasText: () => boolean
  isMenuOpen: () => boolean
  clearAttachments: () => void
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
    <Box px={3} py={3}>
      <Text
        fontSize="12px"
        color={tokens.colors.text.muted}
        fontFamily={tokens.fontFamily.mono}
        mb={1}
      >
        Queued (press ↑ to edit):
      </Text>
      {commands.map((cmd, i) => (
        <Text
          key={cmd.uuid ?? `q-${i}`}
          fontSize="13px"
          color={tokens.colors.text.muted}
          fontFamily={tokens.fontFamily.mono}
          ml={2}
          opacity={0.8}
        >
          {previewText(cmd.value)}
        </Text>
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
    mentionQuery,
    quickOpenBuilding,
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
    // Attachments — drag handlers live on CmdModeView (whole-area drop zone);
    // this component only owns paste (input-focused) and the visual overlay.
    draftAttachments,
    removeAttachment,
    clearAttachments,
    showImageWarning,
    handlePaste,
    isDragging,
    handleAttachFiles,
  } = useCmdPromptLogic()

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    hasText: () => (textareaRef.current?.value.trim().length ?? 0) > 0,
    isMenuOpen: () => showCommandMenu || showMentionMenu,
    clearAttachments,
  }), [textareaRef, showCommandMenu, showMentionMenu, clearAttachments])

  return (
    <Box
      bg={tokens.colors.terminal.background}
      borderTop="1px solid rgba(255, 255, 255, 0.05)"
      position="relative"
      data-no-drag
    >
      {/* Drop overlay */}
      {isDragging && (
        <Flex
          position="absolute"
          inset={0}
          zIndex={10}
          align="center"
          justify="center"
          bg="rgba(163, 113, 247, 0.06)"
          border="2px dashed rgba(163, 113, 247, 0.3)"
          borderRadius="4px"
          pointerEvents="none"
        >
          <Text
            fontSize="12px"
            fontFamily={tokens.fontFamily.mono}
            color={tokens.colors.accent.purple}
            fontWeight="600"
          >
            {t('cmdMode.dropToAttach')}
          </Text>
        </Flex>
      )}

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
          query={mentionQuery}
          isBuilding={quickOpenBuilding}
          limit={50}
        />
      )}

      {/* Queued messages — terminal style */}
      <QueuedMessagesTerminal commands={queuedCommands} />

      {/* Attachment bar — thumbnails, billing warning, remove buttons */}
      <CmdAttachmentBar
        attachments={draftAttachments}
        onRemove={removeAttachment}
        showImageWarning={showImageWarning}
      />

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
            onPaste={handlePaste}
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

        {/* Attach button */}
        {!isStreaming && (
          <Box
            as="button"
            display="flex"
            alignItems="center"
            justifyContent="center"
            w="24px"
            h="24px"
            mt="2px"
            ml={1}
            borderRadius="4px"
            cursor="pointer"
            color={tokens.colors.text.muted}
            transition="all 0.15s"
            flexShrink={0}
            _hover={{
              color: tokens.colors.accent.purple,
              bg: 'rgba(163, 113, 247, 0.08)',
            }}
            onClick={handleAttachFiles}
            aria-label={t('cmdMode.attachTooltip')}
            title={t('cmdMode.attachTooltip')}
          >
            <FiPaperclip size={13} />
          </Box>
        )}

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
