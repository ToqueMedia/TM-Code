import { Box, Text, HStack, Badge } from '@chakra-ui/react'
import { useFileTreeRepository } from '../../stores/fileTreeStore'
import { useFileTreeWorkerStore } from '../../stores/fileTreeWorkerStore'

interface PerformanceStatusProps {
  compact?: boolean
}

export default function PerformanceStatus({ compact = false }: PerformanceStatusProps) {
  const processingStats = useFileTreeRepository(state => state.processingStats)
  const isProcessingInBackground = useFileTreeRepository(state => state.isProcessingInBackground)
  const workerStats = useFileTreeWorkerStore(state => state.lastProcessed)
  const isWorkerLoading = useFileTreeWorkerStore(state => state.isLoading)
  
  // Se não há stats para mostrar, não renderiza
  if (!processingStats && !workerStats) {
    return null
  }

  const formatTime = (ms: number | undefined): string => {
    if (ms === undefined) return 'N/A'
    if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`
    if (ms < 1000) return `${ms.toFixed(1)}ms`
    return `${(ms / 1000).toFixed(2)}s`
  }

  const formatCount = (count: number | undefined): string => {
    if (count === undefined) return 'N/A'
    if (count < 1000) return count.toString()
    if (count < 1000000) return `${(count / 1000).toFixed(1)}K`
    return `${(count / 1000000).toFixed(1)}M`
  }

  if (compact) {
    return (
      <HStack 
        gap={2}
        fontSize="xs"
        color="text.muted"
      >
        {(isProcessingInBackground || isWorkerLoading) && (
          <Badge 
            colorPalette="yellow" 
            variant="solid" 
            size="xs"
          >
            Processing...
          </Badge>
        )}
        
        {processingStats?.lastProcessingTime && (
          <Text 
            cursor="help"
            title={`Main thread processing: ${formatTime(processingStats.lastProcessingTime)} for ${formatCount(processingStats.nodeCount)} nodes`}
          >
            Main: {formatTime(processingStats.lastProcessingTime)}
          </Text>
        )}
        
        {workerStats?.processingTime && (
          <Text 
            cursor="help"
            title={`Web Worker processing: ${formatTime(workerStats.processingTime)} for ${formatCount(workerStats.nodeCount)} nodes`}
          >
            Worker: {formatTime(workerStats.processingTime)}
          </Text>
        )}
        
        {processingStats?.lastProcessingTime && workerStats?.processingTime && (
          <Badge 
            colorPalette={workerStats.processingTime < processingStats.lastProcessingTime ? 'green' : 'red'}
            variant="subtle"
            size="xs"
            cursor="help"
            title={`Performance improvement: ${((1 - workerStats.processingTime / processingStats.lastProcessingTime) * 100).toFixed(1)}% faster with Web Worker`}
          >
            {workerStats.processingTime < processingStats.lastProcessingTime ? '↗' : '↘'} 
            {Math.abs(((1 - workerStats.processingTime / processingStats.lastProcessingTime) * 100)).toFixed(0)}%
          </Badge>
        )}
      </HStack>
    )
  }

  return (
    <Box
      bg="gray.900"
      border="1px solid"
      borderColor="gray.700"
      borderRadius="md"
      p={3}
      fontSize="sm"
    >
      <Text 
        fontWeight="semibold" 
        mb={2}
        color="white"
      >
        Performance Stats
      </Text>
      
      <HStack 
        gap={4} 
        wrap="wrap"
        align="center"
      >
        {(isProcessingInBackground || isWorkerLoading) && (
          <Badge 
            colorPalette="yellow" 
            variant="solid"
          >
            Processing in Background...
          </Badge>
        )}
        
        {processingStats && (
          <Box>
            <Text 
              fontSize="xs" 
              color="gray.400" 
              mb={1}
            >
              Main Thread
            </Text>
            <HStack gap={2}>
              <Text color="white">
                {formatTime(processingStats.lastProcessingTime)}
              </Text>
              <Text 
                fontSize="xs" 
                color="gray.500"
              >
                ({formatCount(processingStats.nodeCount)} nodes)
              </Text>
            </HStack>
          </Box>
        )}
        
        {workerStats && (
          <Box>
            <Text 
              fontSize="xs" 
              color="gray.400" 
              mb={1}
            >
              Web Worker
            </Text>
            <HStack gap={2}>
              <Text color="white">
                {formatTime(workerStats.processingTime)}
              </Text>
              <Text 
                fontSize="xs" 
                color="gray.500"
              >
                ({formatCount(workerStats.nodeCount)} nodes)
              </Text>
            </HStack>
          </Box>
        )}
        
        {processingStats?.lastProcessingTime && workerStats?.processingTime && (
          <Box>
            <Text 
              fontSize="xs" 
              color="gray.400" 
              mb={1}
            >
              Improvement
            </Text>
            <HStack gap={2}>
              <Badge 
                colorPalette={workerStats.processingTime < processingStats.lastProcessingTime ? 'green' : 'red'}
                variant="solid"
              >
                {workerStats.processingTime < processingStats.lastProcessingTime ? '↗' : '↘'} 
                {Math.abs(((1 - workerStats.processingTime / processingStats.lastProcessingTime) * 100)).toFixed(1)}%
              </Badge>
              <Text 
                fontSize="xs" 
                color="gray.500"
              >
                {workerStats.processingTime < processingStats.lastProcessingTime ? 'faster' : 'slower'}
              </Text>
            </HStack>
          </Box>
        )}
        
        {(!processingStats || !workerStats) && (
          <Text 
            fontSize="xs" 
            color="gray.500"
          >
            Process files to see performance comparison
          </Text>
        )}
      </HStack>
    </Box>
  )
}