import { memo, useEffect, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiX } from 'react-icons/fi'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { tokens } from '@/theme/tokens'
import { useLayoutStore } from '../../stores/layoutStore'
import { FileService } from '../../services/fileService'
import { t } from '@/i18n'
import { terminalMarkdownComponents } from './terminalHelpers'

interface TerminalPlanViewerPanelProps {
  /** Project root — fallback when the approval card didn't pass an explicit path. */
  projectPath: string
}

// Largura fixa do painel. O conteúdo interno usa a MESMA largura (minW) para
// não refluir durante a animação de abertura (o wrapper externo cresce de 0 →
// PANEL_WIDTH com overflow:hidden, revelando o conteúdo da esquerda p/ direita).
const PANEL_WIDTH = '640px'

/**
 * Painel lateral (estilo shell) que mostra o PLAN.md renderizado.
 *
 * No layout principal esta função é do PlanViewerPanel. O TerminalView NÃO
 * monta esse painel, por isso o botão "Ver Plano Completo"
 * (TerminalPlanApprovalCard → setPlanViewerOpen) alternava o estado sem nada a
 * ouvir — o plano nunca aparecia. Este componente é o ouvinte desta superfície.
 *
 * Contrato refined-terminal: mono, chrome plano, acento roxo único, sem tweens
 * bombásticos (apenas uma transição de largura). Push-from-right como o
 * TerminalPanel: flex child com flexShrink=0; o conteúdo principal tem
 * flex=1/minW=0 e encolhe suavemente.
 *
 * Escape é tratado pelo TerminalView (listener de captura à janela), que fecha
 * este painel ANTES de sair desta superfície — por isso aqui não há listener próprio
 * de Escape (evita duplo tratamento).
 */
function TerminalPlanViewerPanel({ projectPath }: TerminalPlanViewerPanelProps) {
  const isOpen = useLayoutStore(s => s.isPlanViewerOpen)
  const planViewerPath = useLayoutStore(s => s.planViewerPath)
  const setPlanViewerOpen = useLayoutStore(s => s.setPlanViewerOpen)

  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const planPath = planViewerPath ?? (projectPath ? `${projectPath}/PLAN.md` : null)
  const fileName = planPath ? planPath.split(/[\\/]/).pop() || 'PLAN.md' : 'PLAN.md'

  // Carrega o plano quando o painel abre. Só lê em aberto (evita I/O fechado).
  useEffect(() => {
    if (!isOpen || !planPath) return
    let cancelled = false
    setLoading(true)
    setError(null)
    FileService.readFile(planPath)
      .then(raw => {
        if (cancelled) return
        // Remove o frontmatter YAML (---…---) — ruído para o leitor humano.
        const stripped = raw.replace(/^---[\s\S]*?---\n?/, '')
        setContent(stripped)
      })
      .catch(() => {
        if (cancelled) return
        setError(t('plan.missing') || 'PLAN.md not found. Run /plan to create one.')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [isOpen, planPath])

  return (
    <Flex
      direction="column"
      w={isOpen ? PANEL_WIDTH : '0px'}
      h="100%"
      flexShrink={0}
      bg={tokens.colors.terminal.background}
      borderLeft={isOpen ? `1px solid ${tokens.colors.terminal.chromeHairline}` : 'none'}
      overflow="hidden"
      fontFamily={tokens.fontFamily.mono}
      transition="width 0.22s cubic-bezier(0.32, 0.72, 0, 1)"
    >
      {/* Largura fixa interna — o conteúdo não reflui durante a animação. */}
      <Flex direction="column" w={PANEL_WIDTH} minW={PANEL_WIDTH} h="100%">
        {/* Header plano — prompt-marker '>' + nome do ficheiro + fechar. */}
        <Flex
          align="center"
          justify="space-between"
          gap={2}
          px={3}
          py="8px"
          flexShrink={0}
          bg={tokens.colors.terminal.statusbarBg}
          borderBottom={`1px solid ${tokens.colors.terminal.chromeHairline}`}
        >
          <Flex align="center" gap={2} minW={0}>
            <Text
              fontSize="13px"
              fontWeight="800"
              color={tokens.colors.accent.purple}
              fontFamily={tokens.fontFamily.mono}
              flexShrink={0}
              lineHeight="1.4"
            >
              &gt;
            </Text>
            <Text
              fontSize="12px"
              color={tokens.colors.text.primary}
              fontFamily={tokens.fontFamily.mono}
              fontWeight="600"
              letterSpacing="0.04em"
              textTransform="uppercase"
              minW={0}
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
            >
              {fileName}
            </Text>
          </Flex>
          <Flex
            as="button"
            align="center"
            gap={1.5}
            flexShrink={0}
            px="6px"
            py="2px"
            borderRadius={tokens.radius.sm}
            color={tokens.colors.text.muted}
            cursor="pointer"
            transition={`all ${tokens.transition.fast}`}
            _hover={{ bg: 'rgba(255,255,255,0.06)', color: tokens.colors.text.primary }}
            onClick={() => setPlanViewerOpen(false)}
            aria-label={t('misc.close')}
          >
            <Text as="span" fontSize="10px" fontFamily={tokens.fontFamily.mono} letterSpacing="0.06em" userSelect="none">
              esc
            </Text>
            <FiX size={13} />
          </Flex>
        </Flex>

        {/* Conteúdo — markdown em estilo terminal (terminalMarkdownComponents). */}
        <Box
          flex={1}
          overflowY="auto"
          overflowX="hidden"
          px={4}
          py={3}
          fontSize="13px"
          color={tokens.colors.terminal.foreground}
          lineHeight="1.65"
          wordBreak="break-word"
          css={{
            overflowWrap: 'anywhere',
            scrollbarGutter: 'stable',
            '&::-webkit-scrollbar': { width: '4px' },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
            '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.08)', borderRadius: '2px' },
          }}
        >
          {loading && (
            <Text fontSize="12px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
              {t('terminalMode.view.loadingSession') || '…'}
            </Text>
          )}
          {!loading && error && (
            <Text fontSize="12px" color={tokens.colors.accent.red} fontFamily={tokens.fontFamily.mono}>
              {error}
            </Text>
          )}
          {!loading && !error && content && (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={terminalMarkdownComponents}>
              {content}
            </ReactMarkdown>
          )}
        </Box>
      </Flex>
    </Flex>
  )
}

export default memo(TerminalPlanViewerPanel)
