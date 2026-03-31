import React, { memo, useState, useCallback, useRef, useEffect } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiSend } from 'react-icons/fi'
import { useChatStore } from '../../stores/chatStore'
import { useProjectStore } from '../../stores/projectStore'
import { useAuthStore } from '../../stores/authStore'
import { slashCommandRegistry, type SlashCommand } from '../../services/agent/slashCommandRegistry'
import { runAgentWithCallbacks } from '../../services/agent/agentRunner'
import SlashCommandMenu from './SlashCommandMenu'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

function PromptInput() {
  const [input, setInput] = useState('')
  const [showCommandMenu, setShowCommandMenu] = useState(false)
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([])
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isStreaming = useChatStore(s => s.isStreaming)
  const currentProject = useProjectStore(s => s.currentProject)

  // Cleanup blur timeout on unmount
  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
    }
  }, [])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const maxHeight = 6 * 24
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
  }, [input])

  const handleInputChange = useCallback((value: string) => {
    setInput(value)

    // Only show command menu when typing the command itself (no space yet = no args)
    const firstWord = value.split(' ')[0]
    if (value.startsWith('/') && !value.includes(' ')) {
      const commands = slashCommandRegistry.filterCommands(firstWord)
      setFilteredCommands(commands)
      setShowCommandMenu(commands.length > 0)
      setSelectedCommandIndex(0)
    } else {
      setShowCommandMenu(false)
    }
  }, [])

  const handleCommandSelect = useCallback((command: SlashCommand) => {
    setInput(command.name + ' ')
    setShowCommandMenu(false)
    textareaRef.current?.focus()
  }, [])

  const handleSend = useCallback(async () => {
    const prompt = input.trim()
    if (!prompt || isStreaming) return

    const { isAuthenticated } = useAuthStore.getState()
    if (!isAuthenticated) return

    setInput('')
    setShowCommandMenu(false)

    // Check if it's a slash command
    if (slashCommandRegistry.isSlashCommand(prompt)) {
      const command = slashCommandRegistry.getCommand(prompt)
      if (!command) return

      if (!command.enabled) {
        useChatStore.getState().addSystemMessage(`Command ${command.name} is not yet available.`)
        return
      }

      const projectPath = currentProject?.path
      if (!projectPath) {
        useChatStore.getState().addSystemMessage('No project open. Open a project first.')
        return
      }

      const args = slashCommandRegistry.getArgs(prompt)
      await command.execute(args, projectPath)
      return
    }

    // Normal prompt — use shared agent runner
    await runAgentWithCallbacks(prompt, {
      addUserMessage: true,
      useConversationHistory: true,
    })
  }, [input, isStreaming, currentProject])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Handle command menu navigation
      if (showCommandMenu && filteredCommands.length > 0) {
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedCommandIndex(prev =>
            prev <= 0 ? filteredCommands.length - 1 : prev - 1
          )
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedCommandIndex(prev =>
            prev >= filteredCommands.length - 1 ? 0 : prev + 1
          )
          return
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) {
          e.preventDefault()
          const selected = filteredCommands[selectedCommandIndex]
          if (selected) {
            handleCommandSelect(selected)
          }
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowCommandMenu(false)
          return
        }
      }

      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend, showCommandMenu, filteredCommands, selectedCommandIndex, handleCommandSelect]
  )

  const canSend = input.trim().length > 0 && !isStreaming

  return (
    <Box px={4} py={3} bg={tokens.colors.bg.app} position="relative">
      {/* Slash command autocomplete menu */}
      {showCommandMenu && (
        <SlashCommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={handleCommandSelect}
        />
      )}

      <Box
        borderRadius="14px"
        border="1px solid rgba(255, 255, 255, 0.08)"
        bg="rgba(255, 255, 255, 0.03)"
        overflow="hidden"
        transition="all 0.2s"
        cursor="text"
        onClick={() => textareaRef.current?.focus()}
        css={{
          '&:focus-within': {
            borderColor: 'rgba(254, 16, 99, 0.35)',
            boxShadow: '0 0 0 1px rgba(254, 16, 99, 0.1), 0 4px 20px rgba(254, 16, 99, 0.06)',
          },
        }}
      >
        <Flex align="flex-end" gap={2} px={3} py="10px">
          <Box flex="1" position="relative">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={() => {
                // Delay to allow click on menu items to fire before menu closes
                if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
                blurTimeoutRef.current = setTimeout(() => setShowCommandMenu(false), 150)
              }}
              placeholder="Ask TM Code to help with your code... (type / for commands)"
              aria-label={t("prompt.ariaLabel")}
              disabled={isStreaming}
              rows={1}
              style={{
                width: '100%',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: tokens.colors.text.primary,
                fontSize: '13.5px',
                fontFamily: tokens.fontFamily.ui,
                resize: 'none',
                lineHeight: '24px',
                maxHeight: `${6 * 24}px`,
                overflowY: 'auto',
                opacity: isStreaming ? 0.4 : 1,
                letterSpacing: '-0.005em',
              }}
            />
          </Box>
          <Flex
            as="button"
            w="30px"
            h="30px"
            borderRadius="8px"
            bg={canSend ? tokens.gradient.accentPrimary : 'transparent'}
            align="center"
            justify="center"
            cursor={canSend ? 'pointer' : 'default'}
            transition="all 0.15s"
            flexShrink={0}
            onClick={handleSend}
            aria-disabled={!canSend}
            opacity={canSend ? 1 : 0.3}
            boxShadow={canSend ? '0 2px 10px rgba(254, 16, 99, 0.3)' : 'none'}
            _hover={canSend ? { transform: 'scale(1.05)', boxShadow: '0 4px 16px rgba(254, 16, 99, 0.4)' } : undefined}
            _active={canSend ? { transform: 'scale(0.95)' } : undefined}
          >
            <FiSend size={14} color={canSend ? '#ffffff' : tokens.colors.text.disabled} />
          </Flex>
        </Flex>

        {/* Shortcut hint */}
        <Flex
          px={3}
          py="5px"
          justify="flex-end"
          borderTop="1px solid rgba(255, 255, 255, 0.03)"
        >
          <Text fontSize="10px" color="rgba(255,255,255,0.15)" letterSpacing="0.02em">
            {navigator.platform.includes('Mac') ? '\u2318' : 'Ctrl'} + Enter to send
          </Text>
        </Flex>
      </Box>
    </Box>
  )
}

export default memo(PromptInput)
