import { memo, useEffect, useState, useCallback, useMemo } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiX } from 'react-icons/fi'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { tokens } from '@/theme/tokens'
import { useLayoutStore } from '@/stores/layoutStore'
import { useProjectStore } from '@/stores/projectStore'
import { FileService } from '@/services/fileService'
import { markdownComponents, markdownStyles } from './MessageBubble'
import { t } from '@/i18n'

/**
 * Side panel that slides in from the right to display PLAN.md as
 * formatted rendered markdown. Replaces the previous behaviour of
 * opening PLAN.md in the Monaco editor.
 *
 * Mounts in MainLayout. Visibility controlled by
 * `layoutStore.isPlanViewerOpen`. Content loaded on open.
 */
function PlanViewerPanel() {
  const isOpen = useLayoutStore(s => s.isPlanViewerOpen)
  const setPlanViewerOpen = useLayoutStore(s => s.setPlanViewerOpen)
  const projectPath = useProjectStore(s => s.currentProject?.path ?? '')

  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load PLAN.md when panel opens
  useEffect(() => {
    if (!isOpen || !projectPath) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const planPath = `${projectPath}/PLAN.md`
    FileService.readFile(planPath)
      .then(raw => {
        if (cancelled) return
        // Strip frontmatter (YAML between --- markers)
        const stripped = raw.replace(/^---[\s\S]*?---\n?/, '')
        setContent(stripped)
      })
      .catch(() => {
        if (cancelled) return
        setError(t('plan.missing') ?? 'PLAN.md not found. Run /plan to create one.')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [isOpen, projectPath])

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

  // Memoise markdown components to avoid re-creating on every render
  const mdComponents = useMemo(() => markdownComponents, [])

  if (!isOpen) return null

  return (
    <Box
      position="absolute"
      top={0}
      right={0}
      bottom={0}
      w="420px"
      maxW="50vw"
      bg={tokens.colors.bg.mainLayout}
      borderLeft="1px solid rgba(255, 255, 255, 0.06)"
      zIndex={20}
      display="flex"
      flexDirection="column"
      overflow="hidden"
      animation="slideInRight 0.2s ease-out"
      css={{
        '@keyframes slideInRight': {
          from: { transform: 'translateX(100%)', opacity: 0 },
          to: { transform: 'translateX(0)', opacity: 1 },
        },
      }}
    >
      {/* Header */}
      <Flex
        align="center"
        justify="space-between"
        px={4}
        py={2}
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
          aria-label="Close plan viewer"
        >
          <FiX size={14} />
        </Box>
      </Flex>

      {/* Content */}
      <Box flex={1} overflowY="auto" px={5} py={4} css={markdownStyles}>
        {loading && (
          <Text fontSize="12px" color={tokens.colors.text.muted}>
            ...
          </Text>
        )}
        {error && (
          <Text fontSize="12px" color={tokens.colors.accent.red}>
            {error}
          </Text>
        )}
        {!loading && !error && content && (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {content}
          </ReactMarkdown>
        )}
      </Box>
    </Box>
  )
}

export default memo(PlanViewerPanel)
