import React, { memo, useMemo } from 'react'
import {
  HStack,
  Text,
  Box,
  Flex
} from '@chakra-ui/react'
import {
  FiChevronRight,
  FiHome
} from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { getFileIconByExtension, getFolderIconByName } from '../../utils/iconMapper'

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
        height="26px"
        align="center"
        px={3}
        bg="rgba(255,255,255,0.018)"
        borderTop="1px solid rgba(255,255,255,0.035)"
        borderBottom="1px solid rgba(255,255,255,0.045)"
      >
        <HStack gap={1.5}>
          <FiHome size={12} color={tokens.colors.text.disabled} />
          <Text fontSize="11px" color={tokens.colors.text.disabled}>
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
      bg="rgba(255,255,255,0.018)"
      borderTop="1px solid rgba(255,255,255,0.035)"
      borderBottom="1px solid rgba(255,255,255,0.045)"
      overflow="hidden"
      position="relative"
    >
      <HStack gap={0.5} flex="1" minW="0">
        {breadcrumbs.map((item, index) => {
          const isLast = index === breadcrumbs.length - 1
          const isClickable = !isLast && onNavigate

          // Resolve icon from assets
          let iconSrc: string | undefined
          if (index === 0) {
            // Root project — use home icon (rendered below)
          } else if (item.isFile) {
            const ext = item.name.split('.').pop()?.toLowerCase()
            iconSrc = getFileIconByExtension(ext, item.name)
          } else {
            iconSrc = getFolderIconByName(item.name, false)
          }

          return (
            <React.Fragment key={item.path}>
              <HStack
                gap={1}
                cursor={isClickable ? 'pointer' : 'default'}
                onClick={isClickable ? () => handleNavigate(item.path) : undefined}
                _hover={isClickable ? {
                  color: tokens.colors.text.primary,
                  bg: tokens.colors.bg.hoverSubtle,
                } : {}}
                transition={`all ${tokens.transition.fast}`}
                maxW="150px"
                px={1}
                py={0.5}
                borderRadius="7px"
              >
                {index === 0 ? (
                  <FiHome size={11} color={tokens.colors.text.disabled} style={{ flexShrink: 0 }} />
                ) : iconSrc ? (
                  <img
                    src={iconSrc}
                    alt={item.name}
                    style={{ width: 14, height: 14, flexShrink: 0 }}
                  />
                ) : (
                  <Box
                    w="14px"
                    h="14px"
                    borderRadius="2px"
                    bg={tokens.colors.bg.hoverSubtle}
                    flexShrink={0}
                  />
                )}

                <Text
                  fontSize="11px"
                  color={isLast ? tokens.colors.text.primary : tokens.colors.text.muted}
                  fontWeight={isLast ? '500' : '400'}
                  whiteSpace="nowrap"
                  overflow="hidden"
                  textOverflow="ellipsis"
                  maxW="120px"
                  letterSpacing="0"
                >
                  {item.name}
                </Text>
              </HStack>

              {!isLast && (
                <FiChevronRight
                  size={9}
                  color={tokens.colors.text.disabled}
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
        width="24px"
        bg={`linear-gradient(to right, transparent, ${tokens.colors.bg.app})`}
        pointerEvents="none"
      />
    </Flex>
  )
}

export default memo(Breadcrumbs)
