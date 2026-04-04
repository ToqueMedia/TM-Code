import React, { useCallback, useState } from 'react'
import {
  Box,
  Flex,
  Grid,
  Heading,
  Text,
  VStack,
  HStack,
  Button,
  Input,
} from '@chakra-ui/react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { templateService, Template } from '../services/templateService'
import { LoadingSpinner } from './ui/LoadingSpinner'
import WindowControls from './ui/WindowControls'
import { IS_MAC } from '@/utils/platform'

interface TemplateSelectorProps {
  onSelectTemplate: (template: Template, projectName: string) => void
  onSelectEmpty: () => void
  onBack: () => void
  isLoading?: boolean
}

const categoryLabels: Record<string, string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  fullstack: 'Full-stack',
}

const frameworkIcons: Record<string, string> = {
  react: '⚛️',
  nextjs: '▲',
  vue: '💚',
  nuxt: '💚',
  svelte: '🔥',
  angular: '🅰️',
  astro: '🚀',
  express: '📡',
  fastify: '⚡',
  go: '🐹',
  python: '🐍',
  'react+express': '⚛️',
}

const TemplateCard: React.FC<{
  template: Template
  isSelected: boolean
  onClick: () => void
}> = ({ template, isSelected, onClick }) => (
  <Box
    bg={isSelected ? tokens.colors.accent.primarySubtle : tokens.colors.bg.card}
    border={`1px solid ${isSelected ? tokens.colors.accent.primaryBorder : tokens.colors.bg.cardBorder}`}
    borderRadius="12px"
    p={4}
    cursor="pointer"
    transition="all 0.2s ease"
    _hover={{
      borderColor: tokens.colors.accent.primaryMuted,
      bg: tokens.colors.bg.hoverSubtle,
      transform: 'translateY(-2px)',
    }}
    onClick={onClick}
  >
    <HStack gap={3} mb={2}>
      <Flex
        width="36px"
        height="36px"
        borderRadius="8px"
        alignItems="center"
        justifyContent="center"
        fontSize="18px"
        bg={tokens.colors.bg.whiteSubtle}
        flexShrink={0}
      >
        {frameworkIcons[template.framework] || '📦'}
      </Flex>
      <VStack gap={0} alignItems="flex-start">
        <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>
          {template.name}
        </Text>
        <Text fontSize="11px" color={tokens.colors.text.muted}>
          {template.description}
        </Text>
      </VStack>
    </HStack>
  </Box>
)

const TemplateSelector: React.FC<TemplateSelectorProps> = ({
  onSelectTemplate,
  onSelectEmpty,
  onBack,
  isLoading = false,
}) => {
  const [selected, setSelected] = useState<Template | null>(null)
  const [projectName, setProjectName] = useState('')
  const categories: Template['category'][] = ['frontend', 'backend', 'fullstack']

  const sanitizedName = projectName.trim().replace(/\s+/g, '-').toLowerCase()
  const isNameValid = sanitizedName.length > 0 && /^[a-z0-9][a-z0-9._-]*$/.test(sanitizedName)

  const handleConfirm = () => {
    if (selected && isNameValid) {
      onSelectTemplate(selected, sanitizedName)
    }
  }

  const handleDrag = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    const tag = t.tagName?.toLowerCase() || ''
    if (['button', 'input', 'svg', 'path'].includes(tag)) return
    if (t.getAttribute?.('role') === 'button') return
    if (t.closest?.('[data-no-drag]')) return
    getCurrentWindow().startDragging().catch(() => {})
  }, [])

  async function handleClose() {
    try { await getCurrentWindow().close() } catch { /* noop */ }
  }

  async function handleMinimize() {
    try { await getCurrentWindow().minimize() } catch { /* noop */ }
  }

  async function handleFullToggle() {
    try {
      const win = getCurrentWindow()
      if (/Mac/.test(navigator.platform || '')) {
        const fs = await win.isFullscreen()
        await win.setFullscreen(!fs)
      } else {
        const isMax = await win.isMaximized()
        if (isMax) await win.unmaximize()
        else await win.maximize()
      }
    } catch { /* noop */ }
  }

  return (
    <Flex
      position="fixed"
      top={0}
      left={0}
      right={0}
      bottom={0}
      bg={tokens.colors.bg.welcome}
      zIndex={tokens.zIndex.modal}
      flexDirection="column"
      overflow="hidden"
      onMouseDown={handleDrag}
    >
      {/* Window controls — macOS: top-left, Windows/Linux: top-right */}
      {IS_MAC ? (
        <Box position="absolute" top={3} left={4} zIndex={10}>
          <WindowControls
            onClose={handleClose}
            onMinimize={handleMinimize}
            onMaximize={handleFullToggle}
          />
        </Box>
      ) : (
        <Box position="absolute" top={0} right={0} zIndex={10}>
          <WindowControls
            onClose={handleClose}
            onMinimize={handleMinimize}
            onMaximize={handleFullToggle}
          />
        </Box>
      )}

      {/* Header */}
      <Flex
        px={8}
        py={5}
        pt={10}
        borderBottom={`1px solid ${tokens.colors.border.subtle}`}
        alignItems="center"
        justifyContent="space-between"
        flexShrink={0}
      >
        <VStack gap={1} alignItems="flex-start">
          <Heading fontSize="20px" fontWeight="700" color={tokens.colors.text.primary}>
            {t('misc.chooseTemplate')}
          </Heading>
          <Text fontSize="13px" color={tokens.colors.text.muted}>
            {t('misc.chooseTemplateDesc')}
          </Text>
        </VStack>

        <HStack gap={3}>
          <Input
            placeholder={t("misc.projectName")}
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm() }}
            size="sm"
            width="200px"
            bg={tokens.colors.bg.card}
            border={`1px solid ${projectName && !isNameValid ? tokens.colors.accent.red : tokens.colors.border.subtle}`}
            borderRadius="6px"
            color={tokens.colors.text.primary}
            fontSize="13px"
            _placeholder={{ color: tokens.colors.text.muted }}
            _focus={{ borderColor: tokens.colors.accent.primary, outline: 'none' }}
            disabled={isLoading}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <Button
            variant="ghost"
            size="sm"
            color={tokens.colors.text.secondary}
            _hover={{ color: tokens.colors.text.primary, bg: tokens.colors.bg.hoverSubtle }}
            onClick={onBack}
            disabled={isLoading}
          >
            {t('misc.cancel')}
          </Button>
          <Button
            size="sm"
            bg={tokens.colors.accent.primary}
            color="white"
            _hover={{ bg: tokens.colors.accent.primaryDark }}
            disabled={!selected || !isNameValid || isLoading}
            opacity={selected && isNameValid && !isLoading ? 1 : 0.5}
            onClick={handleConfirm}
          >
            {t('misc.createProject')}
          </Button>
        </HStack>
      </Flex>

      {/* Content */}
      <Box flex={1} overflow="auto" px={8} py={6} data-no-drag>
        <VStack gap={8} alignItems="stretch" maxW="900px" mx="auto">
          {categories.map(category => {
            const templates = templateService.getByCategory(category)
            if (templates.length === 0) return null

            return (
              <VStack key={category} gap={3} alignItems="stretch">
                <Text
                  fontSize="12px"
                  fontWeight="600"
                  textTransform="uppercase"
                  color={tokens.colors.text.muted}
                  letterSpacing="0.5px"
                >
                  {categoryLabels[category]}
                </Text>

                <Grid
                  templateColumns="repeat(auto-fill, minmax(260px, 1fr))"
                  gap={3}
                >
                  {templates.map(template => (
                    <TemplateCard
                      key={template.id}
                      template={template}
                      isSelected={selected?.id === template.id}
                      onClick={() => setSelected(template)}
                    />
                  ))}
                </Grid>
              </VStack>
            )
          })}

          {/* Empty Project option */}
          <Box
            bg={tokens.colors.bg.card}
            border={`1px solid ${tokens.colors.bg.cardBorder}`}
            borderRadius="12px"
            p={4}
            cursor="pointer"
            transition="all 0.2s ease"
            _hover={{
              borderColor: tokens.colors.accent.primaryMuted,
              bg: tokens.colors.bg.hoverSubtle,
            }}
            onClick={onSelectEmpty}
          >
            <HStack gap={3}>
              <Flex
                width="36px"
                height="36px"
                borderRadius="8px"
                alignItems="center"
                justifyContent="center"
                fontSize="18px"
                bg={tokens.colors.bg.whiteSubtle}
                flexShrink={0}
              >
                📂
              </Flex>
              <VStack gap={0} alignItems="flex-start">
                <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>
                  {t('misc.emptyProject')}
                </Text>
                <Text fontSize="11px" color={tokens.colors.text.muted}>
                  {t('misc.emptyProjectDesc')}
                </Text>
              </VStack>
            </HStack>
          </Box>
        </VStack>
      </Box>

      {/* Loading overlay */}
      {isLoading && (
        <Flex
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          bg="rgba(10, 14, 19, 0.85)"
          zIndex={20}
          alignItems="center"
          justifyContent="center"
          backdropFilter="blur(4px)"
        >
          <LoadingSpinner size="lg" label={t('misc.creatingProject')} />
        </Flex>
      )}
    </Flex>
  )
}

export default TemplateSelector
