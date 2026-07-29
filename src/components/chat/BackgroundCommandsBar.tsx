/**
 * BackgroundCommandsBar — compact strip below the composer showing shell
 * commands the agent left running in the background (execute_command_background),
 * with a user-facing Cancel.
 *
 * This is the ONLY surface for them while the agent is "asleep" waiting for
 * the auto-wake: AgentActivityIndicator unmounts when streaming ends, so
 * without this strip a live background process is invisible and uncancellable.
 *
 * Positional twin of SubAgentStatusBar: the composer bar belongs to the MAIN
 * run — background commands owned by parallel tasks (owner = taskId) surface
 * in their own task context, never here (same doctrine as the !ownerTaskId
 * filter in SubAgentStatusBar).
 */

import { memo, useEffect, useMemo, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { useBackgroundCommandStore, type BackgroundCommand } from '@/stores/backgroundCommandStore'
import { cancelBackgroundCommand } from '@/services/agent/backgroundCommands/cancelBackgroundCommand'

const pulseCss = {
  animation: 'bgCmdPulse 1.5s ease-in-out infinite',
  '@keyframes bgCmdPulse': {
    '0%, 100%': { opacity: 1 },
    '50%': { opacity: 0.4 },
  },
}

function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  return `${mins}m ${secs % 60}s`
}

function CancelButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Text
      as="button"
      fontSize="11px"
      color={tokens.colors.accent.primary}
      cursor="pointer"
      _hover={{ textDecoration: 'underline' }}
      onClick={onClick}
      bg="none"
      border="none"
      p={0}
      flexShrink={0}
    >
      {label}
    </Text>
  )
}

function CommandRow({ cmd, now, label }: { cmd: BackgroundCommand; now: number; label?: string }) {
  return (
    <Flex align="center" gap="8px" minW={0}>
      {/* Caso singular: a própria row é a strip — dot + rótulo de contexto. */}
      {label && (
        <>
          <Box
            w="6px"
            h="6px"
            borderRadius="full"
            bg={tokens.colors.accent.primary}
            css={pulseCss}
            flexShrink={0}
          />
          <Text fontSize="12px" color={tokens.colors.text.secondary} flexShrink={0}>
            {label}
          </Text>
          <Text fontSize="12px" color={tokens.colors.text.disabled} flexShrink={0}>·</Text>
        </>
      )}
      <Text
        fontSize="12px"
        color={tokens.colors.text.secondary}
        fontFamily={tokens.fontFamily.mono}
        flex="1"
        minW={0}
        whiteSpace="nowrap"
        overflow="hidden"
        textOverflow="ellipsis"
        title={cmd.command}
      >
        {cmd.command}
      </Text>
      <Text
        fontSize="11px"
        color={tokens.colors.text.disabled}
        fontFamily={tokens.fontFamily.mono}
        flexShrink={0}
        css={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {formatElapsed(now - cmd.startedAt)}
      </Text>
      <CancelButton
        label={t('prompt.bgCommands.cancel')}
        onClick={() => { void cancelBackgroundCommand(cmd.id) }}
      />
    </Flex>
  )
}

function BackgroundCommandsBar() {
  const commands = useBackgroundCommandStore(s => s.commands)
  const running = useMemo(
    () =>
      Array.from(commands.values())
        .filter(c => c.status === 'running' && c.owner === 'main')
        .sort((a, b) => a.startedAt - b.startedAt),
    [commands],
  )

  // Relógio de 1s para o elapsed — só corre enquanto a strip está visível.
  const [now, setNow] = useState(() => Date.now())
  const active = running.length > 0
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])

  if (running.length === 0) return null

  return (
    <Flex
      direction="column"
      gap="6px"
      px={3}
      py={1.5}
      mt={1.5}
      borderRadius="6px"
      bg="rgba(255,255,255,0.02)"
      border="1px solid"
      borderColor="rgba(255,255,255,0.06)"
    >
      {running.length > 1 && (
        <Flex align="center" gap="8px">
          <Box
            w="6px"
            h="6px"
            borderRadius="full"
            bg={tokens.colors.accent.primary}
            css={pulseCss}
            flexShrink={0}
          />
          <Text fontSize="12px" color={tokens.colors.text.secondary} flex="1">
            {t('prompt.bgCommands.many').replace('{count}', String(running.length))}
          </Text>
          <CancelButton
            label={t('prompt.bgCommands.cancelAll')}
            onClick={() => { for (const cmd of running) void cancelBackgroundCommand(cmd.id) }}
          />
        </Flex>
      )}
      {running.map(cmd => (
        <CommandRow
          key={cmd.id}
          cmd={cmd}
          now={now}
          label={running.length === 1 ? t('prompt.bgCommands.one') : undefined}
        />
      ))}
    </Flex>
  )
}

export default memo(BackgroundCommandsBar)
