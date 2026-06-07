import { memo, useEffect, useMemo, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { useSettingsStore } from '../../stores/settingsStore'
import { CMD_MODE_COMMANDS } from '../../services/agent/cmdModeCommands'
import { slashCommandRegistry } from '../../services/agent/slashCommandRegistry'
import { tokens } from '@/theme/tokens'
import { basename } from '@/utils/platform'
import { useTranslation } from '@/i18n/useTranslation'
import { invoke } from '@/utils/invokeMetrics'

interface TerminalGreetingProps {
  projectPath: string
}

export const TerminalGreeting = memo(function TerminalGreeting({ projectPath }: TerminalGreetingProps) {
  const t = useTranslation()
  const sandboxEnabled = useSettingsStore(s => s.sandboxEnabled)
  const projectName = basename(projectPath) || projectPath

  // Git info — branch + last commit (like starship/powerlevel10k)
  const [gitInfo, setGitInfo] = useState<{ branch: string; lastCommit: string } | null>(null)
  useEffect(() => {
    if (!projectPath) return
    let cancelled = false
    Promise.all([
      invoke<string>('git_current_branch', { projectPath }).catch(() => null),
      invoke<string>('execute_command', { command: 'git log -1 --format="%h %s"', cwd: projectPath, timeoutSecs: 5 })
        .then((r: unknown) => {
          const res = r as { stdout?: string; success?: boolean }
          return res?.success ? (res.stdout ?? '').trim() : null
        })
        .catch(() => null),
    ]).then(([branch, commit]) => {
      if (!cancelled && branch) setGitInfo({ branch, lastCommit: commit || '' })
    })
    return () => { cancelled = true }
  }, [projectPath])

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
        {t('terminalMode.greeting.title')}
      </Text>
      <Text fontSize="13px" color={tokens.colors.text.disabled} mt="2px">
        {projectName}&nbsp;&nbsp;
        <Text as="span" opacity={0.5}>{projectPath}</Text>
      </Text>
      {gitInfo && (
        <Text fontSize="12px" color={tokens.colors.text.disabled} mt="2px" fontFamily={tokens.fontFamily.mono}>
          <Text as="span" color={tokens.colors.accent.green}>→ {gitInfo.branch}</Text>
          {gitInfo.lastCommit && (
            <Text as="span" ml={2} opacity={0.5}>{gitInfo.lastCommit}</Text>
          )}
        </Text>
      )}
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
            {t('terminalMode.greeting.navigateHistory')}  ·  <Text as="span" color={tokens.colors.accent.purple}>@</Text> {t('terminalMode.greeting.mentionFile')}  ·  <Text as="span" color={tokens.colors.accent.purple}>!</Text> {t('terminalMode.greeting.runShell')}
          </Text>
        </Flex>
      </Box>
      {sandboxEnabled && (
        <Flex align="center" gap={1.5} mt={2}>
          <Text fontSize="10px" color={tokens.colors.accent.orange} fontFamily={tokens.fontFamily.mono}>⚠</Text>
          <Text fontSize="10px" color={tokens.colors.accent.orange} fontFamily={tokens.fontFamily.mono} opacity={0.8}>
            {t('terminalMode.greeting.sandboxActive')}
          </Text>
        </Flex>
      )}
    </Box>
  )
})
