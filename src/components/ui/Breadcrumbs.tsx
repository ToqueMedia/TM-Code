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
  
  // Retorna cores baseadas na extensão
  const iconColors: { [key: string]: string } = {
    'tsx': '#58a6ff',
    'ts': '#58a6ff', 
    'jsx': '#61dafb',
    'js': '#f7df1e',
    'json': '#f7df1e',
    'md': '#58a6ff',
    'css': '#1572b6',
    'scss': '#cf649a',
    'html': '#e34f26',
    'vue': '#4fc08d',
    'py': '#3776ab',
    'rs': '#ce422b',
    'go': '#00add8',
    'java': '#ed8b00',
    'php': '#777bb4',
    'rb': '#cc342d',
    'swift': '#fa7343',
    'kt': '#7f52ff',
    'dart': '#0175c2',
    'yaml': '#cb171e',
    'yml': '#cb171e',
    'toml': '#9c4221',
    'xml': '#e34f26',
    'svg': '#ff9900'
  }

  return iconColors[ext || ''] || '#8b949e'
}

function Breadcrumbs({ filePath, projectRoot, onNavigate }: BreadcrumbsProps) {
  const breadcrumbs = useMemo(() => {
    if (!filePath || !projectRoot) return []

    // Remove project root do caminho
    const relativePath = filePath.startsWith(projectRoot) 
      ? filePath.slice(projectRoot.length)
      : filePath

    // Divide o caminho em segmentos
    const segments = relativePath.split('/').filter(Boolean)
    const items: BreadcrumbItem[] = []

    // Adiciona o projeto como primeiro item
    items.push({
      name: projectRoot.split('/').pop() || 'Project',
      path: projectRoot,
      isFile: false
    })

    // Adiciona cada segmento do caminho
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
        bg="rgba(255, 255, 255, 0.01)"
      >
        <HStack gap={1}>
          <FiHome size={14} color="#8b949e" />
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
      bg="rgba(255, 255, 255, 0.01)"
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
                  <FiHome size={12} color="#8b949e" />
                ) : item.isFile ? (
                  <FiFile size={12} color={getFileIcon(item.name)} />
                ) : (
                  <FiFolder size={12} color="#58a6ff" />
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
                  color="#8b949e" 
                  style={{ flexShrink: 0 }}
                />
              )}
            </React.Fragment>
          )
        })}
      </HStack>
      
      {/* Fade gradient no final se necessário */}
      <Box
        position="absolute"
        right="0"
        top="0"
        bottom="0"
        width="20px"
        bgGradient="linear(to-r, transparent, rgba(13, 17, 23, 0.8))"
        pointerEvents="none"
      />
    </Flex>
  )
}

export default memo(Breadcrumbs)