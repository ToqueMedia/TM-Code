import { memo, useEffect, useState, useCallback } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiX } from 'react-icons/fi'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { tokens } from '@/theme/tokens'
import { useLayoutStore } from '@/stores/layoutStore'
import { useProjectStore } from '@/stores/projectStore'
import { FileService } from '@/services/fileService'
import { t } from '@/i18n'

/**
 * Side panel that displays PLAN.md as formatted rendered markdown.
 *
 * Uses the same push-from-right pattern as PreviewView:
 *   - Always mounted (never returns null) — closing sets w=0 + opacity=0
 *   - Flex child in the content area row, flexShrink=0
 *   - Main content area gets flex="1" minW=0 so it shrinks smoothly
 *
 * This avoids layout "jumps" that happen when a flex child mounts/unmounts.
 */
function PlanViewerPanel() {
  const isOpen = useLayoutStore(s => s.isPlanViewerOpen)
  const planViewerPath = useLayoutStore(s => s.planViewerPath)
  const setPlanViewerOpen = useLayoutStore(s => s.setPlanViewerOpen)
  const projectPath = useProjectStore(s => s.currentProject?.path ?? '')

  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load the selected plan artefact when panel opens.
  useEffect(() => {
    if (!isOpen || (!projectPath && !planViewerPath)) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const planPath = planViewerPath ?? `${projectPath}/PLAN.md`
    FileService.readFile(planPath)
      .then(raw => {
        if (cancelled) return
        const stripped = raw.replace(/^---[\s\S]*?---\n?/, '')
        setContent(stripped)
      })
      .catch(() => {
        if (cancelled) return
        setError(t('plan.missing') || 'PLAN.md not found. Run /plan to create one.')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [isOpen, projectPath, planViewerPath])

  const handleClose = useCallback(() => {
    setPlanViewerOpen(false)
  }, [setPlanViewerOpen])

  // Escape key closes
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, handleClose])

  return (
    <Flex
      direction="column"
      w={isOpen ? '750px' : '0px'}
      h="100%"
      flexShrink={0}
      bg={tokens.colors.bg.mainLayout}
      borderLeft={isOpen ? '1px solid rgba(255, 255, 255, 0.06)' : 'none'}
      overflow="hidden"
      // Width snaps (no transition): animating it re-wraps the agent
      // transcript on every frame — text wobble. One reflow, VS Code-style;
      // the inner translate keeps the slide-in feel.
    >
      {/* Inner wrapper — slides content in from the right after the width
          snap. The `transform` doesn't affect flex layout (only visual). */}
      <Flex
        direction="column"
        w="750px"
        h="100%"
        transform={isOpen ? 'translateX(0)' : 'translateX(100%)'}
        opacity={isOpen ? 1 : 0}
        transition="transform 0.35s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.2s ease 0.05s"
      >
        {/* Header */}
        <Flex
          align="center"
          justify="space-between"
          px={4}
          py={2.5}
          borderBottom="1px solid rgba(255, 255, 255, 0.06)"
          flexShrink={0}
        >
          <Text fontSize="13px" fontWeight={600} color={tokens.colors.text.primary}>
            {t('plan.viewFull') || 'Plan'}
          </Text>
          <Box
            as="button"
            display="flex"
            alignItems="center"
            justifyContent="center"
            w="24px"
            h="24px"
            borderRadius="6px"
            color={tokens.colors.text.secondary}
            cursor="pointer"
            transition={`all ${tokens.transition.fast}`}
            _hover={{ bg: 'rgba(255, 255, 255, 0.08)', color: tokens.colors.text.primary }}
            onClick={handleClose}
            aria-label={t('misc.close')}
          >
            <FiX size={14} />
          </Box>
        </Flex>

        {/* Content */}
        <Box flex={1} overflowY="auto" overflowX="hidden" px={6} py={5} css={planMarkdownStyles}>
        {loading && (
          <Text fontSize="12px" color={tokens.colors.text.muted}>...</Text>
        )}
        {error && (
          <Text fontSize="12px" color={tokens.colors.accent.red}>{error}</Text>
        )}
        {!loading && !error && content && (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {content}
          </ReactMarkdown>
        )}
      </Box>
      </Flex>
    </Flex>
  )
}

export default memo(PlanViewerPanel)

/**
 * Markdown styles tailored for the plan viewer — wider prose, better
 * heading hierarchy, table support for structured plan sections.
 */
const planMarkdownStyles = {
  overflowWrap: 'anywhere' as const,
  wordBreak: 'break-word' as const,
  color: 'rgba(255, 255, 255, 0.85)',
  lineHeight: '1.7',

  '& p': {
    margin: '0 0 12px 0',
    lineHeight: '1.75',
    fontSize: '13.5px',
    color: 'rgba(255, 255, 255, 0.85)',
  },
  '& p:last-child': { marginBottom: 0 },

  '& strong': { color: '#ffffff', fontWeight: 600 },
  '& em': { color: 'rgba(255, 255, 255, 0.55)', fontStyle: 'italic' },

  '& ul, & ol': {
    margin: '6px 0 12px 0',
    paddingLeft: '22px',
    fontSize: '13.5px',
  },
  '& li': {
    marginBottom: '5px',
    lineHeight: '1.75',
    '&::marker': { color: 'rgba(255, 255, 255, 0.25)' },
  },
  '& li > ul, & li > ol': {
    margin: '4px 0',
  },

  '& a': {
    color: tokens.colors.accent.primary,
    textDecoration: 'none',
    borderBottom: '1px solid rgba(254, 16, 99, 0.3)',
    transition: 'border-color 0.15s',
    '&:hover': { borderColor: tokens.colors.accent.primary },
  },

  '& code': {
    background: 'rgba(255, 255, 255, 0.07)',
    borderRadius: '4px',
    padding: '2px 6px',
    fontSize: '12px',
    fontFamily: tokens.fontFamily.mono,
    color: '#e6a1c0',
    border: '1px solid rgba(255, 255, 255, 0.05)',
  },
  '& pre': {
    margin: '8px 0 12px',
    padding: '12px 14px',
    background: 'rgba(0, 0, 0, 0.35)',
    borderRadius: '6px',
    border: '1px solid rgba(255, 255, 255, 0.06)',
    overflowX: 'auto' as const,
  },
  '& pre code': {
    background: 'none',
    padding: 0,
    border: 'none',
    color: 'rgba(255, 255, 255, 0.8)',
    borderRadius: 0,
    fontSize: '12px',
    lineHeight: '1.6',
  },

  '& h1': {
    fontSize: '20px',
    fontWeight: 700,
    color: '#ffffff',
    margin: '24px 0 12px',
    letterSpacing: '-0.02em',
    paddingBottom: '6px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
  },
  '& h1:first-of-type': { marginTop: 0 },
  '& h2': {
    fontSize: '17px',
    fontWeight: 600,
    color: '#ffffff',
    margin: '20px 0 10px',
    letterSpacing: '-0.01em',
  },
  '& h3': {
    fontSize: '15px',
    fontWeight: 600,
    color: 'rgba(255, 255, 255, 0.95)',
    margin: '16px 0 8px',
  },
  '& h4': {
    fontSize: '13.5px',
    fontWeight: 600,
    color: 'rgba(255, 255, 255, 0.9)',
    margin: '14px 0 6px',
  },

  '& blockquote': {
    borderLeft: `3px solid ${tokens.colors.accent.primaryMuted}`,
    margin: '12px 0',
    paddingLeft: '14px',
    color: 'rgba(255, 255, 255, 0.6)',
    fontStyle: 'italic',
  },

  '& hr': {
    border: 'none',
    height: '1px',
    background: 'rgba(255, 255, 255, 0.08)',
    margin: '20px 0',
  },

  '& table': {
    borderCollapse: 'collapse' as const,
    width: '100%',
    margin: '14px 0',
    fontSize: '12.5px',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: '6px',
    display: 'block' as const,
    overflowX: 'auto' as const,
    whiteSpace: 'nowrap' as const,
  },
  '& thead': {
    display: 'table-header-group' as const,
  },
  '& tbody': {
    display: 'table-row-group' as const,
  },
  '& th': {
    textAlign: 'left' as const,
    padding: '9px 12px',
    borderBottom: '2px solid rgba(255, 255, 255, 0.1)',
    color: 'rgba(255, 255, 255, 0.9)',
    fontWeight: 600,
    fontSize: '11.5px',
    letterSpacing: '0.03em',
    textTransform: 'uppercase' as const,
    bg: 'rgba(255, 255, 255, 0.03)',
    whiteSpace: 'nowrap' as const,
  },
  '& td': {
    padding: '8px 12px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: '12.5px',
    whiteSpace: 'nowrap' as const,
  },
  '& tr:last-child td': { borderBottom: 'none' },
  '& tr:hover td': { background: 'rgba(255, 255, 255, 0.03)' },
}
