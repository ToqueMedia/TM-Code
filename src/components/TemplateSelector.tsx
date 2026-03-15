import React, { useState } from 'react'
import {
  Box,
  Flex,
  Grid,
  Heading,
  Text,
  VStack,
  HStack,
  Button,
} from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { templateService, Template } from '../services/templateService'

interface TemplateSelectorProps {
  onSelectTemplate: (template: Template) => void
  onSelectEmpty: () => void
  onBack: () => void
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
}) => {
  const [selected, setSelected] = useState<Template | null>(null)
  const categories: Template['category'][] = ['frontend', 'backend', 'fullstack']

  const handleConfirm = () => {
    if (selected) {
      onSelectTemplate(selected)
    }
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
    >
      {/* Header */}
      <Flex
        px={8}
        py={5}
        borderBottom={`1px solid ${tokens.colors.border.subtle}`}
        alignItems="center"
        justifyContent="space-between"
        flexShrink={0}
      >
        <VStack gap={1} alignItems="flex-start">
          <Heading fontSize="20px" fontWeight="700" color={tokens.colors.text.primary}>
            Choose a template
          </Heading>
          <Text fontSize="13px" color={tokens.colors.text.muted}>
            Start with a Hello World boilerplate or create an empty project
          </Text>
        </VStack>

        <HStack gap={3}>
          <Button
            variant="ghost"
            size="sm"
            color={tokens.colors.text.secondary}
            _hover={{ color: tokens.colors.text.primary, bg: tokens.colors.bg.hoverSubtle }}
            onClick={onBack}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            bg={tokens.colors.accent.primary}
            color="white"
            _hover={{ bg: tokens.colors.accent.primaryDark }}
            disabled={!selected}
            opacity={selected ? 1 : 0.5}
            onClick={handleConfirm}
          >
            Create Project
          </Button>
        </HStack>
      </Flex>

      {/* Content */}
      <Box flex={1} overflow="auto" px={8} py={6}>
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
                  Empty Project
                </Text>
                <Text fontSize="11px" color={tokens.colors.text.muted}>
                  Start from scratch — no template, no boilerplate
                </Text>
              </VStack>
            </HStack>
          </Box>
        </VStack>
      </Box>
    </Flex>
  )
}

export default TemplateSelector
