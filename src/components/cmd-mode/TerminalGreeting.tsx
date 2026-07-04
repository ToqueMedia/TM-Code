import { memo, useEffect, useMemo, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { useSettingsStore } from '../../stores/settingsStore'
import { buildTipPool } from './terminalTips'
import { tokens } from '@/theme/tokens'
import { basename } from '@/utils/platform'
import { useTranslation } from '@/i18n/useTranslation'
import { invoke } from '@/utils/invokeMetrics'

interface TerminalGreetingProps {
  projectPath: string
}

// Banner ASCII (figlet "ANSI Regular") — boas-vindas estilo terminal nativo
// (neofetch/btop). Substitui a listagem completa de comandos no arranque:
// os comandos agora aparecem UM de cada vez como dica rotativa abaixo —
// menos parede de texto, mais descoberta progressiva (pedido do user
// 2026-06-11). whiteSpace=pre + fontSize fixo pequeno para não rebentar em
// split-pane; o banner é decorativo, por isso aria-hidden + sem seleção.
const ASCII_BANNER = `████████ ███    ███      ██████  ██████  ██████  ███████
   ██    ████  ████     ██      ██    ██ ██   ██ ██
   ██    ██ ████ ██     ██      ██    ██ ██   ██ █████
   ██    ██  ██  ██     ██      ██    ██ ██   ██ ██
   ██    ██      ██      ██████  ██████  ██████  ███████`

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

  // Pool de dicas: cada comando vira uma dica individual + as dicas fixas de
  // navegação. Uma dica aleatória por montagem — abrir esta superfície várias
  // vezes vai expondo o catálogo inteiro sem nunca despejar a lista completa.
  const tip = useMemo(() => {
    const pool = buildTipPool(t)
    return pool[Math.floor(Math.random() * pool.length)]
  }, [t])

  return (
    <Box mb={2} fontFamily={tokens.fontFamily.mono}>
      {/* Banner ASCII */}
      <Box
        as="pre"
        aria-hidden
        userSelect="none"
        fontSize="9px"
        lineHeight="1.25"
        letterSpacing="0"
        color={tokens.colors.accent.purple}
        opacity={0.85}
        whiteSpace="pre"
        overflow="hidden"
        fontFamily={tokens.fontFamily.mono}
        m={0}
        mt={1}
      >
        {ASCII_BANNER}
      </Box>

      <Text fontSize="12px" color={tokens.colors.terminal.green} fontWeight="600" mt={2}>
        {t('terminalMode.greeting.welcome')}
      </Text>
      <Text fontSize="12px" color={tokens.colors.text.disabled} mt="2px">
        {projectName}&nbsp;&nbsp;
        <Text as="span" opacity={0.5}>{projectPath}</Text>
      </Text>
      {gitInfo && (
        <Text
          fontSize="12px"
          color={tokens.colors.text.disabled}
          mt="2px"
          fontFamily={tokens.fontFamily.mono}
          // Branch + latest commit on a SINGLE line — a long commit subject is
          // truncated with an ellipsis instead of wrapping to extra rows.
          lineClamp={1}
          wordBreak="break-all"
        >
          <Text as="span" color={tokens.colors.accent.green}>→ {gitInfo.branch}</Text>
          {gitInfo.lastCommit && (
            <Text as="span" ml={2} opacity={0.5}>{gitInfo.lastCommit}</Text>
          )}
        </Text>
      )}

      <Box mt={2} mb={1} h="1px" bg="rgba(255,255,255,0.06)" />

      {/* Dica rotativa — uma por sessão, em vez da lista completa de comandos.
          minW=0 + quebra de palavra: dicas longas (ex.: /plan — …) embrulham
          dentro do contentor em vez de empurrar a largura para fora. */}
      <Flex gap={2} align="baseline" mt={1} minW={0}>
        <Text
          fontFamily={tokens.fontFamily.mono}
          fontSize="12px"
          color={tokens.colors.accent.purple}
          fontWeight="600"
          flexShrink={0}
        >
          {t('terminalMode.greeting.tipLabel')}
        </Text>
        <Text
          fontFamily={tokens.fontFamily.mono}
          fontSize="12px"
          color={tokens.colors.text.muted}
          minW={0}
          wordBreak="break-word"
          css={{ overflowWrap: 'anywhere' }}
        >
          {tip}
        </Text>
      </Flex>

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
