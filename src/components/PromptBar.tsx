import { memo } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { useProjectStore } from '@/stores/projectStore'
import PromptTextarea from './prompt/PromptTextarea'
import PromptActions from './prompt/PromptActions'
import AttachmentChips from './prompt/AttachmentChips'
import SlashCommandMenu from './chat/SlashCommandMenu'
import MentionMenu from './prompt/MentionMenu'
import QueuedMessagesPreview from './prompt/QueuedMessagesPreview'
import { usePromptBar } from './prompt/usePromptBar'
import KeyBindingDisplay from './ui/KeyBindingDisplay'

function PromptBar() {
  const {
    input,
    setInput,
    textareaRef,
    isStreaming,
    isAgentBusy,
    isScaffolding,
    isSendBlocked,
    isDisabled,
    viewMode,
    hasPreview,
    handleSend,
    handleStop,
    handleKeyDown,
    handleBlur,
    toggleEditor,
    togglePreview,
    showCommandMenu,
    filteredCommands,
    selectedCommandIndex,
    isArgMode,
    handleCommandSelect,
    showMentionMenu,
    filteredMentions,
    selectedMentionIndex,
    handleMentionSelect,
    draftAttachments,
    handleAttachFiles,
    handlePaste,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
    handleRemoveAttachment,
    isDragging,
  } = usePromptBar()

  const projectPath = useProjectStore(s => s.currentProject?.path || '')

  return (
    <Box
      px={4}
      py={3}
      bg={tokens.colors.bg.mainLayout}
      flexShrink={0}
      position="relative"
    >
      <Box maxW="900px" mx="auto" position="relative">
        {/* Slash command autocomplete menu */}
        {showCommandMenu && (
          <SlashCommandMenu
            commands={filteredCommands}
            selectedIndex={selectedCommandIndex}
            onSelect={handleCommandSelect}
            showArgsHint={isArgMode}
          />
        )}

        {/* @mention autocomplete menu */}
        {showMentionMenu && (
          <MentionMenu
            items={filteredMentions}
            selectedIndex={selectedMentionIndex}
            onSelect={handleMentionSelect}
            projectPath={projectPath}
          />
        )}

        {/* Queued messages preview (above input) */}
        <QueuedMessagesPreview />

        {/* Main input container */}
        <Box
          bg={tokens.colors.bg.panel}
          borderRadius="14px"
          border={`1px solid ${isDragging ? tokens.colors.accent.primary : tokens.colors.border.panel}`}
          outline={isDragging ? `1px dashed ${tokens.colors.accent.primary}` : 'none'}
          outlineOffset="-2px"
          overflow="visible"
          transition={`border-color ${tokens.transition.normal}, box-shadow ${tokens.transition.normal}`}
          cursor="text"
          onClick={() => textareaRef.current?.focus()}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          _focusWithin={{
            borderColor: tokens.colors.accent.primary,
          }}
        >
          <PromptTextarea
            textareaRef={textareaRef}
            value={input}
            onChange={setInput}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            onPaste={handlePaste}
            disabled={isDisabled}
            isAgentBusy={isAgentBusy}
          />

          {draftAttachments.length > 0 && (
            <AttachmentChips
              attachments={draftAttachments}
              onRemove={handleRemoveAttachment}
            />
          )}

          <PromptActions
            viewMode={viewMode}
            isStreaming={isStreaming}
            hasInput={!!(input.trim() || draftAttachments.length > 0) && !isSendBlocked}
            hasPreview={hasPreview}
            onToggleEditor={toggleEditor}
            onTogglePreview={togglePreview}
            onSend={handleSend}
            onStop={handleStop}
            onAttach={handleAttachFiles}
            attachmentCount={draftAttachments.length}
          />
        </Box>

        {/* Hint */}
        <Flex justify="center" align="center" gap={1.5} mt={1.5}>
          {isScaffolding ? (
            <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>{t('prompt.settingUp')}</Text>
          ) : isDisabled ? (
            <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>{t('prompt.awaitingPermission')}</Text>
          ) : isAgentBusy ? (
            <>
              <KeyBindingDisplay binding={{ key: 'Enter', meta: true }} size="sm" />
              <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>{t('prompt.queueHint')}</Text>
            </>
          ) : (
            <>
              <KeyBindingDisplay binding={{ key: 'Enter', meta: true }} size="sm" />
              <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>{t('prompt.toSend')}</Text>
            </>
          )}
        </Flex>
      </Box>
    </Box>
  )
}

export default memo(PromptBar)
