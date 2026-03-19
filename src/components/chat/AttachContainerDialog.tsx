import { memo, useState, useEffect, useCallback } from 'react'
import { Box, Flex, Text, VStack } from '@chakra-ui/react'
import { FiBox, FiRefreshCw, FiX, FiMinusCircle } from 'react-icons/fi'
import ContainerService, { RunningContainer } from '../../services/containerService'
import { useContainerStore } from '../../stores/containerStore'
import { useProjectStore } from '../../stores/projectStore'
import { tokens } from '@/theme/tokens'

interface AttachContainerDialogProps {
  isOpen: boolean
  onClose: () => void
}

function AttachContainerDialog({ isOpen, onClose }: AttachContainerDialogProps) {
  const [containers, setContainers] = useState<RunningContainer[]>([])
  const [loading, setLoading] = useState(false)
  const [attaching, setAttaching] = useState<string | null>(null)
  const currentProject = useProjectStore(s => s.currentProject)
  const attachToContainer = useContainerStore(s => s.attachToContainer)
  const isAttached = useContainerStore(s => s.isAttached)
  const containerInfo = useContainerStore(s => s.containerInfo)
  const stopContainer = useContainerStore(s => s.stopContainer)

  const loadContainers = useCallback(async () => {
    setLoading(true)
    const list = await ContainerService.shared.listRunningContainers()
    setContainers(list)
    setLoading(false)
  }, [])

  // Load on open
  useEffect(() => {
    if (isOpen) loadContainers()
  }, [isOpen, loadContainers])

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  const handleAttach = useCallback(async (container: RunningContainer) => {
    if (!currentProject) return
    setAttaching(container.id)
    const ok = await attachToContainer(
      container.name,
      currentProject.id,
      currentProject.path
    )
    setAttaching(null)
    if (ok) onClose()
  }, [currentProject, attachToContainer, onClose])

  const handleDetach = useCallback(async () => {
    if (!currentProject) return
    await stopContainer(currentProject.id)
    onClose()
  }, [currentProject, stopContainer, onClose])

  if (!isOpen) return null

  return (
    <Box
      position="fixed"
      inset={0}
      zIndex={200}
      display="flex"
      alignItems="center"
      justifyContent="center"
      bg="rgba(0, 0, 0, 0.5)"
      onClick={onClose}
    >
      <Box
        bg={tokens.colors.bg.overlay}
        border={`1px solid ${tokens.colors.border.panel}`}
        borderRadius="12px"
        w="480px"
        maxH="440px"
        overflow="hidden"
        boxShadow="0 16px 48px rgba(0,0,0,0.5)"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        {/* Header */}
        <Flex
          align="center"
          justify="space-between"
          px={4}
          py={3}
          borderBottom={`1px solid ${tokens.colors.border.subtle}`}
        >
          <Flex align="center" gap={2}>
            <FiBox size={14} color={tokens.colors.accent.primary} />
            <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>
              Attach to Running Container
            </Text>
          </Flex>
          <Flex align="center" gap={1}>
            <Box
              as="button"
              display="flex"
              alignItems="center"
              justifyContent="center"
              w="24px"
              h="24px"
              borderRadius="5px"
              cursor="pointer"
              color={tokens.colors.text.muted}
              transition={`all ${tokens.transition.fast}`}
              _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
              onClick={loadContainers}
              aria-label="Refresh"
            >
              <FiRefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
            </Box>
            <Box
              as="button"
              display="flex"
              alignItems="center"
              justifyContent="center"
              w="24px"
              h="24px"
              borderRadius="5px"
              cursor="pointer"
              color={tokens.colors.text.muted}
              transition={`all ${tokens.transition.fast}`}
              _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
              onClick={onClose}
              aria-label="Close"
            >
              <FiX size={13} />
            </Box>
          </Flex>
        </Flex>

        {/* Currently active container indicator */}
        {containerInfo && (
          <Flex
            align="center"
            justify="space-between"
            px={4}
            py="8px"
            bg="rgba(46, 160, 67, 0.06)"
            borderBottom={`1px solid ${tokens.colors.border.subtle}`}
          >
            <Flex align="center" gap={2}>
              <Box w="6px" h="6px" borderRadius="full" bg={tokens.colors.accent.green} />
              <Text fontSize="11px" color={tokens.colors.accent.greenBright} fontWeight="500">
                {isAttached ? 'Attached to' : 'Active'}: {containerInfo.containerName}
              </Text>
            </Flex>
            {/* Only allow disconnect for externally attached containers, not managed ones */}
            {isAttached && (
              <Box
                as="button"
                display="flex"
                alignItems="center"
                gap="4px"
                px={2}
                py="3px"
                borderRadius="4px"
                fontSize="10px"
                fontWeight="600"
                color={tokens.colors.accent.red}
                cursor="pointer"
                transition={`all ${tokens.transition.fast}`}
                _hover={{ bg: 'rgba(248, 81, 73, 0.1)' }}
                onClick={handleDetach}
              >
                <FiMinusCircle size={10} />
                Disconnect
              </Box>
            )}
          </Flex>
        )}

        {/* Container list */}
        <VStack gap={0} overflowY="auto" maxH="320px">
          {loading && containers.length === 0 && (
            <Text fontSize="12px" color={tokens.colors.text.muted} py={6}>
              A carregar containers...
            </Text>
          )}

          {!loading && containers.length === 0 && (
            <VStack py={6} gap={2}>
              <Text fontSize="12px" color={tokens.colors.text.muted}>
                Nenhum container externo a correr
              </Text>
              <Text fontSize="11px" color={tokens.colors.text.disabled}>
                Containers tmcode-* geridos pelo IDE sao ocultados
              </Text>
            </VStack>
          )}

          {containers.map(container => {
            const isActive = containerInfo?.containerName === container.name
            const isManaged = container.name.startsWith('tmcode-')
            const canAttach = !isActive && !isManaged

            return (
              <Flex
                key={container.id}
                w="100%"
                align="center"
                gap={3}
                px={4}
                py="10px"
                cursor={canAttach ? 'pointer' : 'default'}
                transition={`all ${tokens.transition.fast}`}
                _hover={canAttach ? { bg: 'rgba(255, 255, 255, 0.04)' } : {}}
                onClick={canAttach ? () => handleAttach(container) : undefined}
                opacity={attaching && attaching !== container.id ? 0.4 : isManaged && !isActive ? 0.5 : 1}
                bg={isActive ? 'rgba(46, 160, 67, 0.04)' : 'transparent'}
              >
                <Box
                  w="8px"
                  h="8px"
                  borderRadius="full"
                  bg={isActive ? tokens.colors.accent.green : tokens.colors.accent.purple}
                  flexShrink={0}
                />
                <Box flex={1} minW={0}>
                  <Flex align="center" gap={2}>
                    <Text
                      fontSize="12px"
                      fontWeight="600"
                      color={isManaged && !isActive ? tokens.colors.text.muted : tokens.colors.text.primary}
                      truncate
                    >
                      {container.name}
                    </Text>
                    {isActive && (
                      <Text fontSize="9px" color={tokens.colors.accent.greenBright} fontWeight="600" flexShrink={0}>
                        ACTIVE
                      </Text>
                    )}
                    {isManaged && !isActive && (
                      <Text fontSize="9px" color={tokens.colors.text.disabled} fontWeight="500" flexShrink={0}>
                        managed
                      </Text>
                    )}
                  </Flex>
                  <Flex gap={2} mt="2px">
                    <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
                      {container.image}
                    </Text>
                    <Text fontSize="10px" color={tokens.colors.text.disabled}>
                      {container.status}
                    </Text>
                  </Flex>
                </Box>
                <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
                  {container.id}
                </Text>
                {attaching === container.id && (
                  <Text fontSize="10px" color={tokens.colors.accent.primary}>
                    Connecting...
                  </Text>
                )}
              </Flex>
            )
          })}
        </VStack>
      </Box>
    </Box>
  )
}

export default memo(AttachContainerDialog)
