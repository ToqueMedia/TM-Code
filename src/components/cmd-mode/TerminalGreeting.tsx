import { memo, useMemo } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { useSettingsStore } from '../../stores/settingsStore'
import { CMD_MODE_COMMANDS } from '../../services/agent/cmdModeCommands'
import { slashCommandRegistry } from '../../services/agent/slashCommandRegistry'
import { tokens } from '@/theme/tokens'
import { basename } from '@/utils/platform'

interface TerminalGreetingProps {
  projectPath: string
}

export const TerminalGreeting = memo(function TerminalGreeting({ projectPath }: TerminalGreetingProps) {
  const sandboxEnabled = useSettingsStore(s => s.sandboxEnabled)
  const projectName = basename(projectPath) || projectPath

  const commands = useMemo(() => {
    const entries = [...CMD_MODE_COMMANDS, ...slashCommandRegistry.listCommands()]
      .filter(c => c.enabled)
      .map(c => [c.name, c.description] as [string, string])
    const seen = new Set<string>()
    return entries.filter(([name]) => (seen.has(name) ? false : (seen.add(name), true)))
  }, [])

  return (
    <Box mb={2} fontFamily={tokens.fontFamily.mono}>
      <Text fontSize="13px" color={tokens.colors.terminal.green} fontWeight="600">
        ◆ TM Code · terminal mode
      </Text>
      <Text fontSize="13px" color={tokens.colors.text.disabled} mt="2px">
        {projectName}&nbsp;&nbsp;
        <Text as="span" opacity={0.5}>{projectPath}</Text>
      </Text>
      <Box mt={2} mb={1} h="1px" bg="rgba(255,255,255,0.06)" />
      {/* Column width is the max command name (+2ch padding) — auto-scales as new
          commands land. ch unit respects the monospace font metrics across
          platforms; prior 72px hard-coded clipped longer command names. */}
      <Box fontSize="13px" lineHeight="1.8">
        {commands.map(([cmd, desc]) => (
          <Flex key={cmd} gap={2} align="baseline">
            <Text
              fontFamily={tokens.fontFamily.mono}
              fontSize="13px"
              color={tokens.colors.accent.purple}
              fontWeight="600"
              flexShrink={0}
              whiteSpace="nowrap"
              minW="16ch"
            >
              {cmd}
            </Text>
            <Text fontFamily={tokens.fontFamily.mono} fontSize="13px" color={tokens.colors.text.muted}>
              {desc}
            </Text>
          </Flex>
        ))}
        <Flex gap={2} align="baseline" mt="2px">
          <Text
            fontFamily={tokens.fontFamily.mono}
            fontSize="13px"
            color={tokens.colors.text.disabled}
            flexShrink={0}
            whiteSpace="nowrap"
            minW="16ch"
          >
            ↑ ↓
          </Text>
          <Text fontFamily={tokens.fontFamily.mono} fontSize="13px" color={tokens.colors.text.disabled}>
            navigate history  ·  <Text as="span" color={tokens.colors.accent.purple}>@</Text> mention a file  ·  <Text as="span" color={tokens.colors.accent.purple}>!</Text> run shell
          </Text>
        </Flex>
      </Box>
      {sandboxEnabled && (
        <Flex align="center" gap={1.5} mt={2}>
          <Text fontSize="10px" color={tokens.colors.accent.orange} fontFamily={tokens.fontFamily.mono}>⚠</Text>
          <Text fontSize="10px" color={tokens.colors.accent.orange} fontFamily={tokens.fontFamily.mono} opacity={0.8}>
            sandbox mode active
          </Text>
        </Flex>
      )}
    </Box>
  )
})
