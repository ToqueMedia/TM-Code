import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, forwardRef } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiPaperclip } from 'react-icons/fi'
import { useCmdPromptLogic } from '../../hooks/useCmdPromptLogic'
import SlashCommandMenu from '../chat/SlashCommandMenu'
import HashtagMenu from '../prompt/HashtagMenu'
import { TerminalMentionMenu } from './TerminalMentionMenu'
import CmdAttachmentBar from './CmdAttachmentBar'
import { renderHighlightedPrompt } from '../prompt/promptHighlight'
import { resolveInlineArgHint } from '../prompt/slashArgHint'
import { CMD_MODE_COMMANDS } from '../../services/agent/cmdModeCommands'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import type { QueuedCommand } from '../../types/messageQueueTypes'

// Shared style block — keep textarea + highlight overlay in lockstep so the
// colored slash-command span sits exactly under the real glyphs.
const CMD_TEXT_STYLE: React.CSSProperties = {
  fontSize: '13px',
  fontFamily: tokens.fontFamily.mono,
  lineHeight: '24px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  padding: '2px 0',
  letterSpacing: 'normal',
  tabSize: 2,
}

export interface CmdModePromptInputRef {
  focus: () => void
  blur: () => void
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
    isArgMode,
    showMentionMenu,
    filteredMentions,
    selectedMentionIndex,
    mentionQuery,
    quickOpenBuilding,
    hashtagMenu,
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
    // Attachments — drag handlers live on TerminalView (whole-area drop zone);
    // this component only owns paste (input-focused) and the visual overlay.
    draftAttachments,
    removeAttachment,
    clearAttachments,
    showImageWarning,
    handlePaste,
    isDragging,
    handleAttachFiles,
    preSendTransformRef,
  } = useCmdPromptLogic()

  // ─── Paste compacting ───
  // When the user pastes a large block of text (>5 lines), show a compact
  // placeholder in the textarea ("[Pasted text #1 +N lines]") and store
  // the real text in a ref. When the message is sent, the preSendTransform
  // replaces placeholders with real text so the agent sees the full content.
  const PASTE_MIN_LINES = 5
  const pastedBlocksRef = useRef<Map<number, string>>(new Map())
  const pasteCounterRef = useRef(0)

  // Register the transform so handleSend expands placeholders automatically
  useEffect(() => {
    preSendTransformRef.current = (text: string) => {
      if (pastedBlocksRef.current.size === 0) return text
      let expanded = text
      for (const [id, realText] of pastedBlocksRef.current) {
        // Match "[Pasted text #<id> ...]"
        const re = new RegExp(`\\[Pasted text #${id}\\s[^\\]]*\\]`)
        expanded = expanded.replace(re, realText)
      }
      pastedBlocksRef.current.clear()
      return expanded
    }
    return () => { preSendTransformRef.current = null }
  }, [preSendTransformRef])

  const handlePasteWithCompact = useCallback((e: React.ClipboardEvent) => {
    // Let the attachment handler run first (images, files)
    handlePaste(e)
    if (e.defaultPrevented) return

    // Check if the pasted text is large
    const text = e.clipboardData?.getData('text')
    if (!text) return
    const lineCount = text.split('\n').length
    if (lineCount <= PASTE_MIN_LINES) return

    // Large paste — compact it
    e.preventDefault()
    pasteCounterRef.current++
    const id = pasteCounterRef.current
    const placeholder = `[Pasted text #${id} +${lineCount} lines]`
    pastedBlocksRef.current.set(id, text)

    // Insert placeholder at cursor position
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const before = input.slice(0, start)
    const after = input.slice(end)
    handleInputChange(before + placeholder + after)

    // Restore cursor after placeholder
    requestAnimationFrame(() => {
      const pos = start + placeholder.length
      ta.setSelectionRange(pos, pos)
    })
  }, [handlePaste, input, handleInputChange, textareaRef])

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    blur: () => textareaRef.current?.blur(),
    hasText: () => (textareaRef.current?.value.trim().length ?? 0) > 0,
    isMenuOpen: () => showCommandMenu || showMentionMenu || hashtagMenu.show,
    clearAttachments,
  }), [textareaRef, showCommandMenu, showMentionMenu, hashtagMenu.show, clearAttachments])

  // Listen for cmd-clear-input event (dispatched by Ctrl+K shortcut in TerminalView)
  useEffect(() => {
    const onClear = () => {
      handleInputChange('')
      pastedBlocksRef.current.clear()
      textareaRef.current?.focus()
    }
    window.addEventListener('cmd-clear-input', onClear)
    return () => window.removeEventListener('cmd-clear-input', onClear)
  }, [handleInputChange, textareaRef])

  // cmd-insert-text — chip `[Image #N]` inserido no texto quando uma imagem
  // é colada/anexada (paridade claude-vaz: o placeholder vive NO input; no
  // submit a imagem só segue se o placeholder ainda lá estiver). Inserção na
  // posição do caret, com o caret reposto a seguir ao texto inserido.
  useEffect(() => {
    const onInsert = (e: Event) => {
      const text = (e as CustomEvent<string>).detail
      if (!text) return
      const ta = textareaRef.current
      const current = ta?.value ?? ''
      const start = ta?.selectionStart ?? current.length
      const end = ta?.selectionEnd ?? current.length
      const next = current.slice(0, start) + text + current.slice(end)
      handleInputChange(next)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (el) {
          el.focus()
          const caret = start + text.length
          el.setSelectionRange(caret, caret)
        }
      })
    }
    window.addEventListener('cmd-insert-text', onInsert)
    return () => window.removeEventListener('cmd-insert-text', onInsert)
  }, [handleInputChange, textareaRef])

  // Sync textarea scroll → highlight overlay so the colored slash-command
  // span stays under the actual glyphs when content scrolls past 6 rows.
  const [scrollTop, setScrollTop] = useState(0)
  const handleScroll = useCallback(() => {
    if (textareaRef.current) setScrollTop(textareaRef.current.scrollTop)
  }, [textareaRef])

  // Auto-resize textarea to fit content (same pattern as PromptTextarea).
  // useLayoutEffect so the height is set synchronously before paint — avoids
  // the flash of collapsed-then-expanded height on every keystroke.
  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const maxHeight = 6 * 24
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`
  }, [input])

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
          borderRadius={0}
          pointerEvents="none"
        >
          <Text
            fontSize="12px"
            fontFamily={tokens.fontFamily.mono}
            color={tokens.colors.accent.purple}
            fontWeight="600"
          >
            {t('terminalMode.dropToAttach')}
          </Text>
        </Flex>
      )}

      {/* Slash command autocomplete */}
      {showCommandMenu && (
        <SlashCommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={handleCommandSelect}
          showArgsHint={isArgMode}
          theme="purple"
          direction="up"
          maxHeight={260}
        />
      )}

      {/* #hashtag autocomplete */}
      {hashtagMenu.show && (
        <HashtagMenu
          items={hashtagMenu.items}
          selectedIndex={hashtagMenu.selectedIndex}
          onSelect={hashtagMenu.handleSelect}
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

        <Box
          flex="1"
          position="relative"
          // CRITICAL: clipping must live on the parent (not the overlay) so the
          // transformed overlay can't leak above/below the textarea's visible
          // bounds when the user scrolls inside the textarea. Same fix applied
          // to PromptTextarea.tsx — see detailed comment there.
          overflow="hidden"
          // The textarea uses WebkitTextFillColor: transparent so the colored
          // overlay below can be seen — the same property cascades into
          // ::placeholder, hiding the empty-state hint. Re-color it here.
          css={{
            '& > textarea::placeholder': {
              color: tokens.colors.text.disabled,
              WebkitTextFillColor: tokens.colors.text.disabled,
              opacity: 1,
            },
            // Transparent text would also hide the selection — restore it so
            // copy/paste in CMD mode actually shows what's selected.
            '& > textarea::selection': {
              color: tokens.colors.terminal.foreground,
              WebkitTextFillColor: tokens.colors.terminal.foreground,
              background: 'rgba(163, 113, 247, 0.35)',
            },
            // Hide native scrollbar so content width stays equal to overlay's.
            // Same fix as PromptTextarea.tsx — see detailed comment there.
            '& > textarea::-webkit-scrollbar': {
              width: 0,
              height: 0,
            },
          }}
        >
          {/* Highlight overlay (slash-command tone). Behind the textarea;
              textarea text is transparent so only the colored span shows. */}
          <Box
            aria-hidden
            position="absolute"
            inset={0}
            pointerEvents="none"
            color={tokens.colors.terminal.foreground}
            style={{
              ...CMD_TEXT_STYLE,
              transform: `translateY(-${scrollTop}px)`,
            }}
          >
            {renderHighlightedPrompt(input)}
            {(() => {
              // Inline argument hint for slash commands \u2014 same UX as
              // chat mode's PromptTextarea via the shared
              // resolveInlineArgHint helper. Pure visual; the textarea
              // value is unchanged. Cheap enough to compute inline (one
              // startsWith + Map lookup per render).
              const hint = resolveInlineArgHint(input, CMD_MODE_COMMANDS)
              if (!hint) return null
              return (
                <Box
                  as="span"
                  color={tokens.colors.text.disabled}
                  opacity={0.7}
                  userSelect="none"
                >
                  {input.endsWith(' ') ? hint : ` ${hint}`}
                </Box>
              )
            })()}
            {input.endsWith('\n') ? '\u200b' : null}
          </Box>

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePasteWithCompact}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onScroll={handleScroll}
            placeholder={isStreaming ? '' : 'Type a command or message…'}
            aria-label="Terminal Mode input"
            rows={1}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            style={{
              ...CMD_TEXT_STYLE,
              width: '100%',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'transparent',
              caretColor: tokens.colors.terminal.foreground,
              WebkitTextFillColor: 'transparent',
              resize: 'none',
              maxHeight: `${6 * 24}px`,
              overflowY: 'auto',
              position: 'relative',
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
            borderRadius={tokens.radius.sm}
            cursor="pointer"
            color={tokens.colors.text.muted}
            transition="all 0.15s"
            flexShrink={0}
            _hover={{
              color: tokens.colors.accent.purple,
              bg: 'rgba(163, 113, 247, 0.08)',
            }}
            onClick={handleAttachFiles}
            aria-label={t('terminalMode.attachTooltip')}
            title={t('terminalMode.attachTooltip')}
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
