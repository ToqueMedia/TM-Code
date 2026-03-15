import React, { memo, useMemo } from 'react'
import {
  HStack,
  Text,
  Box,
  Flex
} from '@chakra-ui/react'
import {
  FiChevronRight,
  FiFolder,
  FiFile,
  FiHome
} from 'react-icons/fi'
import { tokens } from '@/theme/tokens'

interface BreadcrumbsProps {
  filePath?: string
  projectRoot?: string
  onNavigate?: (path: string) => void
}

interface BreadcrumbItem {
  name: string
  path: string
  isFile: boolean
}

const getFileIcon = (fileName: string) => {
  const ext = fileName.split('.').pop()?.toLowerCase()
  const fe = tokens.colors.fileExtension

  const iconColors: { [key: string]: string } = {
    'tsx': tokens.colors.accent.primary,
    'ts': tokens.colors.accent.primary,
    'jsx': fe.jsx,
    'js': fe.js,
    'json': fe.js,
    'md': tokens.colors.accent.primary,
    'css': fe.css,
    'scss': fe.scss,
    'html': fe.html,
    'vue': fe.vue,
    'py': fe.py,
    'rs': fe.rs,
    'go': fe.go,
    'java': fe.java,
    'php': fe.php,
    'rb': fe.rb,
    'swift': fe.swift,
    'kt': fe.kt,
    'dart': fe.dart,
    'yaml': fe.yaml,
    'yml': fe.yml,
    'toml': fe.toml,
    'xml': fe.xml,
    'svg': fe.svg,
  }

  return iconColors[ext || ''] || tokens.colors.text.secondary
}

function Breadcrumbs({ filePath, projectRoot, onNavigate }: BreadcrumbsProps) {
  const breadcrumbs = useMemo(() => {
    if (!filePath || !projectRoot) return []

    const relativePath = filePath.startsWith(projectRoot)
      ? filePath.slice(projectRoot.length)
      : filePath

    const segments = relativePath.split('/').filter(Boolean)
    const items: BreadcrumbItem[] = []

    items.push({
      name: projectRoot.split('/').pop() || 'Project',
      path: projectRoot,
      isFile: false
    })

    let currentPath = projectRoot
    segments.forEach((segment, index) => {
      currentPath += `/${segment}`
      const isLastSegment = index === segments.length - 1

      items.push({
        name: segment,
        path: currentPath,
        isFile: isLastSegment && segment.includes('.')
      })
    })

    return items
  }, [filePath, projectRoot])

  const handleNavigate = (path: string) => {
    if (onNavigate) {
      onNavigate(path)
    }
  }

  if (breadcrumbs.length === 0) {
    return (
      <Flex
        height="28px"
        align="center"
        px={3}
        borderBottom="1px solid"
        borderColor="border.glass"
        bg={tokens.colors.bg.whiteMicro}
      >
        <HStack gap={1}>
          <FiHome size={14} color={tokens.colors.text.secondary} />
          <Text fontSize="xs" color="text.muted">
            No file selected
          </Text>
        </HStack>
      </Flex>
    )
  }

  return (
    <Flex
      height="28px"
      align="center"
      px={3}
      borderBottom="1px solid"
      borderColor="border.glass"
      bg={tokens.colors.bg.whiteMicro}
      overflow="hidden"
    >
      <HStack gap={1} flex="1" minW="0">
        {breadcrumbs.map((item, index) => {
          const isLast = index === breadcrumbs.length - 1
          const isClickable = !isLast && onNavigate

          return (
            <React.Fragment key={item.path}>
              <HStack
                gap={1}
                cursor={isClickable ? 'pointer' : 'default'}
                onClick={isClickable ? () => handleNavigate(item.path) : undefined}
                _hover={isClickable ? { color: 'text.primary' } : {}}
                transition="color 0.2s"
                maxW="150px"
              >
                {index === 0 ? (
                  <FiHome size={12} color={tokens.colors.text.secondary} />
                ) : item.isFile ? (
                  <FiFile size={12} color={getFileIcon(item.name)} />
                ) : (
                  <FiFolder size={12} color={tokens.colors.accent.primary} />
                )}

                <Text
                  fontSize="xs"
                  color={isLast ? 'text.primary' : 'text.secondary'}
                  fontWeight={isLast ? '500' : '400'}
                  whiteSpace="nowrap"
                  overflow="hidden"
                  textOverflow="ellipsis"
                  maxW="120px"
                >
                  {item.name}
                </Text>
              </HStack>

              {!isLast && (
                <FiChevronRight
                  size={10}
                  color={tokens.colors.text.secondary}
                  style={{ flexShrink: 0 }}
                />
              )}
            </React.Fragment>
          )
        })}
      </HStack>

      {/* Fade gradient at end */}
      <Box
        position="absolute"
        right="0"
        top="0"
        bottom="0"
        width="20px"
        bgGradient={tokens.gradient.breadcrumbFade}
        pointerEvents="none"
      />
    </Flex>
  )
}

export default memo(Breadcrumbs)
