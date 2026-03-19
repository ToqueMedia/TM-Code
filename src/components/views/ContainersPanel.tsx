import { memo, useState, useEffect, useCallback } from 'react'
import { Box, Flex, Text, VStack } from '@chakra-ui/react'
import { FiBox, FiRefreshCw, FiMinusCircle, FiLink } from 'react-icons/fi'
import ContainerService, { RunningContainer } from '../../services/containerService'
import { useContainerStore } from '../../stores/containerStore'
import { useProjectStore } from '../../stores/projectStore'
import { tokens } from '@/theme/tokens'

function ContainersPanel() {
  const [containers, setContainers] = useState<RunningContainer[]>([])
  const [loading, setLoading] = useState(false)
  const [attaching, setAttaching] = useState<string | null>(null)
  const currentProject = useProjectStore(s => s.currentProject)
  const attachToContainer = useContainerStore(s => s.attachToContainer)
  const containerInfo = useContainerStore(s => s.containerInfo)
  const isAttachedExternal = useContainerStore(s => s.isAttached)
  const stopContainer = useContainerStore(s => s.stopContainer)

  const loadContainers = useCallback(async () => {
    setLoading(true)
    try {
      const list = await ContainerService.shared.listRunningContainers()
      setContainers(list)
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => { loadContainers() }, [loadContainers])

  const handleAttach = useCallback(async (container: RunningContainer) => {
    if (!currentProject) return
    setAttaching(container.id)
    try {
      await attachToContainer(container.name, currentProject.id, currentProject.path)
    } catch {}
    setAttaching(null)
    loadContainers()
  }, [currentProject, attachToContainer, loadContainers])

  const handleDetach = useCallback(async () => {
    if (!currentProject) return
    await stopContainer(currentProject.id)
    loadContainers()
  }, [currentProject, stopContainer, loadContainers])

  // Determine which container is the active one for this project
  const activeContainerName = containerInfo?.containerName ?? null

  return (
    <Flex direction="column" height="100%" overflow="hidden">
      {/* Header */}
      <Flex
        align="center"
        justify="space-between"
        px={3}
        py={2}
        flexShrink={0}
        borderBottom={`1px solid ${tokens.colors.border.subtle}`}
      >
        <Text
          fontSize="11px"
          fontWeight="600"
          textTransform="uppercase"
          letterSpacing="0.5px"
          color={tokens.colors.text.muted}
        >
          Containers
        </Text>
        <Box
          as="button"
          display="flex"
          alignItems="center"
          justifyContent="center"
          w="22px"
          h="22px"
          borderRadius="4px"
          cursor="pointer"
          color={tokens.colors.text.muted}
          transition={`all ${tokens.transition.fast}`}
          _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
          onClick={loadContainers}
        >
          <FiRefreshCw
            size={12}
            style={loading ? { animation: 'spin 1s linear infinite' } : undefined}
          />
        </Box>
      </Flex>

      {/* Container list */}
      <VStack gap={0} flex={1} overflowY="auto" align="stretch">
        {loading && containers.length === 0 && (
          <Flex justify="center" py={8}>
            <Text fontSize="11px" color={tokens.colors.text.muted}>Loading...</Text>
          </Flex>
        )}

        {!loading && containers.length === 0 && (
          <Flex direction="column" align="center" py={8} gap={2} px={3}>
            <FiBox size={24} color={tokens.colors.text.disabled} />
            <Text fontSize="11px" color={tokens.colors.text.muted} textAlign="center">
              No running containers
            </Text>
            <Text fontSize="10px" color={tokens.colors.text.disabled} textAlign="center">
              Start a container with Docker or Colima
            </Text>
          </Flex>
        )}

        {containers.map((container, i) => {
          const isManaged = container.name.startsWith('tmcode-')
          const isThisAttached = activeContainerName === container.name
          const canAttach = !isManaged && !isThisAttached

          return (
            <Box
              key={container.id}
              px={3}
              py={2.5}
              transition={`all ${tokens.transition.fast}`}
              animation={`slideIn 0.15s ease ${i * 0.03}s both`}
              opacity={attaching && attaching !== container.id ? 0.4 : 1}
              bg={isThisAttached ? 'rgba(46, 160, 67, 0.06)' : 'transparent'}
            >
              {/* Container info row */}
              <Flex align="center" gap={2}>
                <Box
                  w="7px"
                  h="7px"
                  borderRadius="full"
                  bg={isThisAttached ? tokens.colors.accent.green : isManaged ? tokens.colors.text.disabled : tokens.colors.accent.purple}
                  flexShrink={0}
                />
                <Text
                  fontSize="12px"
                  fontWeight={isThisAttached ? '600' : '500'}
                  color={isManaged ? tokens.colors.text.muted : tokens.colors.text.primary}
                  truncate
                  flex={1}
                >
                  {container.name}
                </Text>
                {isManaged && (
                  <Text fontSize="9px" color={tokens.colors.text.disabled} fontWeight="500" flexShrink={0}>
                    managed
                  </Text>
                )}
                {isThisAttached && (
                  <FiLink size={10} color={tokens.colors.accent.green} />
                )}
              </Flex>

              {/* Image + status */}
              <Flex gap={2} mt="2px" pl="15px">
                <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} truncate>
                  {container.image}
                </Text>
                <Text fontSize="10px" color={tokens.colors.text.disabled} flexShrink={0}>
                  {container.status}
                </Text>
              </Flex>

              {/* Action row */}
              <Flex mt="6px" pl="15px" gap={2}>
                {/* Disconnect only for externally attached, never for managed */}
                {isThisAttached && isAttachedExternal && (
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
                    bg="rgba(248, 81, 73, 0.08)"
                    cursor="pointer"
                    transition={`all ${tokens.transition.fast}`}
                    _hover={{ bg: 'rgba(248, 81, 73, 0.15)' }}
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleDetach(); }}
                  >
                    <FiMinusCircle size={10} />
                    Disconnect
                  </Box>
                )}

                {canAttach && (
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
                    color={tokens.colors.accent.primary}
                    bg="rgba(254, 16, 99, 0.06)"
                    cursor="pointer"
                    transition={`all ${tokens.transition.fast}`}
                    _hover={{ bg: 'rgba(254, 16, 99, 0.12)' }}
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleAttach(container); }}
                  >
                    <FiLink size={10} />
                    Attach
                  </Box>
                )}

                {attaching === container.id && (
                  <Text fontSize="10px" color={tokens.colors.accent.primary}>
                    Connecting...
                  </Text>
                )}
              </Flex>
            </Box>
          )
        })}
      </VStack>

      <style>{`
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes slideIn { from { opacity: 0; transform: translateX(-8px) } to { opacity: 1; transform: translateX(0) } }
        @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
      `}</style>
    </Flex>
  )
}

export default memo(ContainersPanel)
