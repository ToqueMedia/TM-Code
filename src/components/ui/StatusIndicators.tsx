import { useEffect, useState, useRef } from 'react'
import { Box, Flex, Text, HStack, VStack } from '@chakra-ui/react'
import { FiZap, FiChevronDown } from 'react-icons/fi'
import { tokens } from '../../theme/tokens'
import { useLayoutStore } from '../../stores/layoutStore'
import { useTranslation } from '@/i18n'

// ─── Isolation Pill ──────────────────────────────────────────────────────────

export function IsolationPill(props: { icon: React.ElementType; label: string; color: string; onClick?: () => void }) {
  const Icon = props.icon
  return (
    <HStack
      gap={1}
      px={2}
      py="3px"
      borderRadius={tokens.radius.full}
      bg="rgba(255, 255, 255, 0.04)"
      border="1px solid"
      borderColor="rgba(255, 255, 255, 0.06)"
      cursor="pointer"
      transition={`all ${tokens.transition.fast}`}
      _hover={{ bg: 'rgba(255, 255, 255, 0.08)', borderColor: 'rgba(255, 255, 255, 0.12)' }}
      onClick={props.onClick}
    >
      <Icon size={10} color={props.color} />
      <Text fontSize="10px" color={props.color} fontWeight="600" fontFamily={tokens.fontFamily.mono}>
        {props.label}
      </Text>
    </HStack>
  )
}

// ─── MCP Indicator ──────────────────────────────────────────────────────────

interface McpServer {
  name: string
  status: string
  tools: unknown[]
}

interface McpIndicatorProps {
  servers: McpServer[]
  isInitializing: boolean
}

export function McpIndicator(props: McpIndicatorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const t = useTranslation()

  const running = props.servers.filter(s => s.status === 'running')
  const errored = props.servers.filter(s => s.status === 'error')
  const totalTools = running.reduce((sum, s) => sum + s.tools.length, 0)

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen])

  // Nothing to show
  if (!props.isInitializing && running.length === 0 && errored.length === 0) {
    return null
  }

  // Determine pill appearance
  let pillColor: string = tokens.colors.accent.green
  let pillLabel = `MCP ${running.length}`
  if (props.isInitializing) {
    pillColor = tokens.colors.accent.orange
    pillLabel = 'MCP...'
  } else if (errored.length > 0 && running.length === 0) {
    pillColor = tokens.colors.accent.red
    pillLabel = `MCP ${errored.length}`
  } else if (running.length > 0) {
    pillLabel = `MCP ${running.length} (${totalTools})`
  }

  return (
    <Box position="relative" ref={ref}>
      <HStack
        gap={1}
        px={2}
        py="3px"
        borderRadius={tokens.radius.full}
        bg="rgba(255, 255, 255, 0.04)"
        border="1px solid"
        borderColor={isOpen ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.06)'}
        cursor="pointer"
        transition={`all ${tokens.transition.fast}`}
        _hover={{ bg: 'rgba(255, 255, 255, 0.08)', borderColor: 'rgba(255, 255, 255, 0.12)' }}
        onClick={() => setIsOpen(!isOpen)}
      >
        <FiZap size={10} color={pillColor} />
        <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
          {pillLabel}
        </Text>
        <FiChevronDown
          size={9}
          color={tokens.colors.text.disabled}
          style={{
            transition: 'transform 0.15s',
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </HStack>

      {/* Dropdown */}
      {isOpen && (
        <VStack
          position="absolute"
          top="calc(100% + 4px)"
          right={0}
          minW="200px"
          bg={tokens.colors.bg.overlay}
          border="1px solid"
          borderColor={tokens.colors.border.panel}
          borderRadius="8px"
          boxShadow="0 8px 24px rgba(0,0,0,0.4)"
          py={1}
          gap={0}
          zIndex={tokens.zIndex.dropdown}
        >
          {props.isInitializing && (
            <McpDropdownItem name="MCP" detail="A iniciar..." color={tokens.colors.accent.orange} />
          )}
          {running.map(server => (
            <McpDropdownItem
              key={server.name}
              name={server.name}
              detail={`${server.tools.length} tools`}
              color={tokens.colors.accent.green}
            />
          ))}
          {errored.map(server => (
            <McpDropdownItem
              key={server.name}
              name={server.name}
              detail={t("misc.error")}
              color={tokens.colors.accent.red}
            />
          ))}
          {running.length === 0 && errored.length === 0 && !props.isInitializing && (
            <Text fontSize="11px" color={tokens.colors.text.disabled} px={3} py={2}>
              Sem servidores MCP
            </Text>
          )}
        </VStack>
      )}
    </Box>
  )
}

function McpDropdownItem(props: { name: string; detail: string; color: string }) {
  return (
    <Flex
      align="center"
      gap={2}
      px={3}
      py="6px"
      w="100%"
      cursor="pointer"
      transition={`all ${tokens.transition.fast}`}
      _hover={{ bg: 'rgba(255, 255, 255, 0.05)' }}
      onClick={() => useLayoutStore.getState().setViewMode('settings')}
    >
      <Box w="6px" h="6px" borderRadius="full" bg={props.color} flexShrink={0} />
      <Text fontSize="11px" color={tokens.colors.text.primary} fontWeight="500" flex={1}>
        {props.name}
      </Text>
      <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
        {props.detail}
      </Text>
    </Flex>
  )
}
