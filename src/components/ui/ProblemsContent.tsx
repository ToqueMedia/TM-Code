import { memo } from 'react'
import { Flex, Text, Box, ScrollArea } from '@chakra-ui/react'
import { FiAlertTriangle, FiXCircle, FiInfo } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'

interface Problem {
  id: string
  type: 'error' | 'warning' | 'info'
  message: string
  file: string
  line: number
  column: number
}

const getIcon = (type: Problem['type']) => {
  switch (type) {
    case 'error': return FiXCircle
    case 'warning': return FiAlertTriangle
    case 'info': return FiInfo
  }
}

const getColor = (type: Problem['type']) => {
  switch (type) {
    case 'error': return tokens.colors.accent.red
    case 'warning': return tokens.colors.accent.orange
    case 'info': return tokens.colors.status.info
  }
}

const ProblemsContent = memo(() => {
  const problems: Problem[] = [
    {
      id: '1',
      type: 'error',
      message: "Cannot find module 'react'",
      file: 'src/App.tsx',
      line: 1,
      column: 18
    },
    {
      id: '2',
      type: 'warning',
      message: 'Unused variable: data',
      file: 'src/components/Header.tsx',
      line: 12,
      column: 7
    },
    {
      id: '3',
      type: 'info',
      message: 'Consider using const assertion',
      file: 'src/utils/constants.ts',
      line: 5,
      column: 14
    }
  ]

  return (
    <ScrollArea.Root flex="1">
      <ScrollArea.Viewport>
        {problems.map((problem) => {
          const Icon = getIcon(problem.type)
          const color = getColor(problem.type)

          return (
            <Flex
              key={problem.id}
              align="center"
              px={3}
              py={2}
              borderBottom="1px solid"
              borderColor="border.glass"
              cursor="pointer"
              _hover={{ bg: 'whiteAlpha.050' }}
            >
              {Icon && <Icon size={14} color={color} />}
              <Box ml={3} flex="1" minW="0">
                <Text fontSize="sm" color="text.primary" mb={1}>
                  {problem.message}
                </Text>
                <Text fontSize="xs" color="text.muted">
                  {problem.file}:{problem.line}:{problem.column}
                </Text>
              </Box>
            </Flex>
          )
        })}
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar orientation="vertical">
        <ScrollArea.Thumb />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  )
})

ProblemsContent.displayName = 'ProblemsContent'

export default ProblemsContent
