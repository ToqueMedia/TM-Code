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
import HashtagMenu from './prompt/HashtagMenu'
import QueuedMessagesPreview from './prompt/QueuedMessagesPreview'
import AgentTasksPanel from './chat/AgentTasksPanel'
import SubAgentStatusBar from './chat/SubAgentStatusBar'
import { usePromptBar } from './prompt/usePromptBar'
import KeyBindingDisplay from './ui/KeyBindingDisplay'

function PromptBar() {
  const {
    hasInputContent,
    setInput,
    textareaRef,
    isStreaming,
    isAgentBusy,
    queueAsTask,
    setQueueAsTask,
    isScaffolding,
    isSendBlocked,
    isDisabled,
    hasPendingCredential,
    viewMode,
    canToggleDevServer,
    isDevServerActive,
    isDevServerStarting,
    isImprovingPrompt,
    canUndoImprovePrompt,
    handleSend,
    handleStop,
    handleKeyDown,
    handleBlur,
    toggleEditor,
    handleImprovePrompt,
    handleUndoImprovePrompt,
    toggleDevServer,
    showCommandMenu,
    filteredCommands,
    selectedCommandIndex,
    isArgMode,
    handleCommandSelect,
    showMentionMenu,
    filteredMentions,
    selectedMentionIndex,
    handleMentionSelect,
    hashtagMenu,
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
      px={{ base: 3, md: 4 }}
      py={{ base: 2.5, md: 3 }}
      bg="rgba(10, 10, 10, 0.96)"
      borderTop="1px solid rgba(255, 255, 255, 0.04)"
      flexShrink={0}
      position="relative"
    >
      <Box maxW="980px" mx="auto" position="relative">
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

        {/* #hashtag autocomplete menu */}
        {hashtagMenu.show && (
          <HashtagMenu
            items={hashtagMenu.items}
            selectedIndex={hashtagMenu.selectedIndex}
            onSelect={hashtagMenu.handleSelect}
          />
        )}

        {/* Agent task list — same update_tasks data used by the workspace status bar.
            Sits above the queue strip so it's the highest persistent context
            block: the user sees what the agent is doing now, then what's
            waiting next, then the input. */}
        <AgentTasksPanel />

        {/* Queued messages preview (above input) */}
        <QueuedMessagesPreview />

        {/* Main input container */}
        <Box
          bg="rgba(17, 17, 17, 0.96)"
          borderRadius="12px"
          border={`1px solid ${isDragging ? tokens.colors.accent.primary : tokens.colors.border.panel}`}
          outline={isDragging ? `1px dashed ${tokens.colors.accent.primary}` : 'none'}
          outlineOffset="-2px"
          overflow="visible"
          boxShadow="0 16px 40px rgba(0, 0, 0, 0.22)"
          transition={`border-color ${tokens.transition.normal}, box-shadow ${tokens.transition.normal}, background ${tokens.transition.normal}`}
          cursor="text"
          onClick={() => textareaRef.current?.focus()}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          _focusWithin={{
            borderColor: tokens.colors.accent.primary,
            boxShadow: `0 0 0 1px ${tokens.colors.accent.primaryMuted}, 0 18px 44px rgba(0, 0, 0, 0.32)`,
            bg: 'rgba(20, 20, 20, 0.98)',
          }}
        >
          <PromptTextarea
            textareaRef={textareaRef}
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
            isAgentBusy={isAgentBusy}
            queueAsTask={queueAsTask}
            onQueueModeChange={setQueueAsTask}
            hasInput={(hasInputContent || draftAttachments.length > 0) && !isSendBlocked}
            onToggleEditor={toggleEditor}
            onImprovePrompt={handleImprovePrompt}
            onUndoImprovePrompt={handleUndoImprovePrompt}
            onToggleDevServer={toggleDevServer}
            canToggleDevServer={canToggleDevServer}
            isDevServerActive={isDevServerActive}
            isDevServerStarting={isDevServerStarting}
            isImprovingPrompt={isImprovingPrompt}
            canUndoImprovePrompt={canUndoImprovePrompt}
            onSend={handleSend}
            onStop={handleStop}
            onAttach={handleAttachFiles}
            attachmentCount={draftAttachments.length}
          />
        </Box>

        {/* Hint */}
        <Flex justify="center" align="center" gap={1.5} mt={1.5} flexWrap="wrap" minH="19px">
          {isScaffolding ? (
            <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>{t('prompt.settingUp')}</Text>
          ) : isDisabled ? (
            <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>{hasPendingCredential ? t('prompt.completeCredentialForm') : t('prompt.awaitingPermission')}</Text>
          ) : isAgentBusy ? (
            <>
              <KeyBindingDisplay binding={{ key: 'Enter' }} size="sm" />
              <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>
                {queueAsTask ? t('prompt.queueTaskHint') : t('prompt.queueHint')}
              </Text>
              <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>·</Text>
              <KeyBindingDisplay binding={{ key: 'Enter', shift: true }} size="sm" />
              <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>{t('prompt.newLine')}</Text>
            </>
          ) : (
            <>
              <KeyBindingDisplay binding={{ key: 'Enter' }} size="sm" />
              <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>{t('prompt.toSend')}</Text>
              <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>·</Text>
              <KeyBindingDisplay binding={{ key: 'Enter', shift: true }} size="sm" />
              <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>{t('prompt.newLine')}</Text>
            </>
          )}
        </Flex>

        <SubAgentStatusBar />
      </Box>
    </Box>
  )
}

export default memo(PromptBar)
