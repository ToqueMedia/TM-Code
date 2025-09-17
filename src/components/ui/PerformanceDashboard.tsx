import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Box,
  Text,
  HStack,
  VStack,
  Badge,
  Button,
  Separator,
  Grid,
  Card,
  Tabs,
  IconButton,
  Menu,
  Progress
} from '@chakra-ui/react'
import { 
  FiActivity, 
  FiCpu, 
  FiHardDrive, 
  FiClock, 
  FiTrendingUp, 
  FiTrendingDown,
  FiAlertTriangle,
  FiDownload,
  FiRefreshCw,
  FiSettings,
  FiX,
  FiMaximize2,
  FiMinimize2
} from 'react-icons/fi'
import PerformanceMonitor, { PerformanceSnapshot } from '../../services/performanceMonitor'

interface PerformanceDashboardProps {
  isVisible: boolean
  onClose?: () => void
  isCompact?: boolean
}

interface AlertItem {
  id: string
  type: 'warning' | 'error' | 'info'
  message: string
  timestamp: number
  metric?: string
  value?: number
  threshold?: number
}

export default function PerformanceDashboard({ 
  isVisible, 
  onClose, 
  isCompact = false 
}: PerformanceDashboardProps) {
  const [currentSnapshot, setCurrentSnapshot] = useState<PerformanceSnapshot | null>(null)
  const [snapshots, setSnapshots] = useState<PerformanceSnapshot[]>([])
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [isMonitoring, setIsMonitoring] = useState(false)
  const [selectedTab, setSelectedTab] = useState('overview')
  const [isExpanded, setIsExpanded] = useState(!isCompact)
  const [updateInterval, setUpdateInterval] = useState(1000)

  const monitor = useMemo(() => PerformanceMonitor.getInstance(), [])

  // Inicia/para monitoramento
  const toggleMonitoring = useCallback(() => {
    if (isMonitoring) {
      monitor.stopMonitoring()
    } else {
      monitor.startMonitoring()
    }
    setIsMonitoring(!isMonitoring)
  }, [isMonitoring, monitor])

  // Atualiza dados em tempo real
  useEffect(() => {
    if (!isVisible || !isMonitoring) return

    const interval = setInterval(() => {
      const latest = monitor.getLatestSnapshot()
      const allSnapshots = monitor.getSnapshots()
      
      if (latest) {
        setCurrentSnapshot(latest)
        setSnapshots(allSnapshots.slice(-50)) // Últimos 50 snapshots
        checkForAlerts(latest)
      }
    }, updateInterval)

    return () => clearInterval(interval)
  }, [isVisible, isMonitoring, monitor, updateInterval])

  // Verifica alertas baseado no snapshot atual
  const checkForAlerts = useCallback((snapshot: PerformanceSnapshot) => {
    const newAlerts: AlertItem[] = []

    // Alert de memória alta (>100MB)
    if (snapshot.memory && snapshot.memory.usedJSHeapSize > 100 * 1024 * 1024) {
      newAlerts.push({
        id: `memory-${Date.now()}`,
        type: 'warning',
        message: 'High memory usage detected',
        timestamp: Date.now(),
        metric: 'memory',
        value: snapshot.memory.usedJSHeapSize,
        threshold: 100 * 1024 * 1024
      })
    }

    // Alert de FPS baixo (<30)
    if (snapshot.fps < 30) {
      newAlerts.push({
        id: `fps-${Date.now()}`,
        type: 'error',
        message: 'Low FPS detected',
        timestamp: Date.now(),
        metric: 'fps',
        value: snapshot.fps,
        threshold: 30
      })
    }

    // Alert de erros
    if (snapshot.errors.length > 0) {
      newAlerts.push({
        id: `errors-${Date.now()}`,
        type: 'error',
        message: `${snapshot.errors.length} errors detected`,
        timestamp: Date.now(),
        metric: 'errors',
        value: snapshot.errors.length
      })
    }

    if (newAlerts.length > 0) {
      setAlerts(prev => [...newAlerts, ...prev].slice(0, 20)) // Máximo 20 alertas
    }
  }, [])

  // Exporta dados de performance
  const exportData = useCallback(() => {
    const data = monitor.exportData()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    
    const a = document.createElement('a')
    a.href = url
    a.download = `performance-data-${new Date().toISOString()}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    
    URL.revokeObjectURL(url)
  }, [monitor])

  // Limpa dados
  const clearData = useCallback(() => {
    monitor.clearData()
    setSnapshots([])
    setAlerts([])
    setCurrentSnapshot(null)
  }, [monitor])

  // Formatação de valores
  const formatMemory = useCallback((bytes: number) => {
    const mb = bytes / (1024 * 1024)
    return `${mb.toFixed(1)} MB`
  }, [])

  const formatDuration = useCallback((ms: number) => {
    if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`
    if (ms < 1000) return `${ms.toFixed(1)}ms`
    return `${(ms / 1000).toFixed(2)}s`
  }, [])

  // Calcula tendências
  const getTrend = useCallback((values: number[], current: number) => {
    if (values.length < 2) return 'stable'
    const recent = values.slice(-5).reduce((sum, v) => sum + v, 0) / 5
    const older = values.slice(-10, -5).reduce((sum, v) => sum + v, 0) / 5
    
    if (recent > older * 1.1) return 'up'
    if (recent < older * 0.9) return 'down'
    return 'stable'
  }, [])

  if (!isVisible) return null

  // Modo compacto
  if (isCompact || !isExpanded) {
    return (
      <Card.Root
        position="fixed"
        top="60px"
        right="20px"
        width="320px"
        bg="gray.900"
        borderColor="gray.700"
        zIndex="1000"
      >
        <Card.Header>
          <HStack justify="space-between">
            <HStack gap={2}>
              <FiActivity size={16} color="#58a6ff" />
              <Text fontWeight="semibold" fontSize="sm" color="white">
                Performance
              </Text>
              <Badge 
                colorPalette={isMonitoring ? 'green' : 'gray'}
                variant="solid"
                size="xs"
              >
                {isMonitoring ? 'Live' : 'Paused'}
              </Badge>
            </HStack>
            
            <HStack gap={1}>
              <IconButton
                aria-label="Expand"
                size="xs"
                variant="ghost"
                onClick={() => setIsExpanded(true)}
              >
                <FiMaximize2 size={14} />
              </IconButton>
              {onClose && (
                <IconButton
                  aria-label="Close"
                  size="xs"
                  variant="ghost"
                  onClick={onClose}
                >
                  <FiX size={14} />
                </IconButton>
              )}
            </HStack>
          </HStack>
        </Card.Header>

        <Card.Body>
          <VStack gap={3} align="stretch">
            {currentSnapshot && (
              <>
                {/* Memory */}
                <HStack justify="space-between">
                  <HStack gap={2}>
                    <FiHardDrive size={14} color="#a371f7" />
                    <Text fontSize="xs" color="gray.400">Memory</Text>
                  </HStack>
                  <Text fontSize="xs" color="white">
                    {currentSnapshot.memory ? formatMemory(currentSnapshot.memory.usedJSHeapSize) : 'N/A'}
                  </Text>
                </HStack>

                {/* FPS */}
                <HStack justify="space-between">
                  <HStack gap={2}>
                    <FiCpu size={14} color="#2ea043" />
                    <Text fontSize="xs" color="gray.400">FPS</Text>
                  </HStack>
                  <HStack gap={1}>
                    <Text fontSize="xs" color="white">
                      {currentSnapshot.fps}
                    </Text>
                    {getTrend(snapshots.map(s => s.fps), currentSnapshot.fps) === 'up' && (
                      <FiTrendingUp size={12} color="#2ea043" />
                    )}
                    {getTrend(snapshots.map(s => s.fps), currentSnapshot.fps) === 'down' && (
                      <FiTrendingDown size={12} color="#f85149" />
                    )}
                  </HStack>
                </HStack>

                {/* Errors */}
                {currentSnapshot.errors.length > 0 && (
                  <HStack justify="space-between">
                    <HStack gap={2}>
                      <FiAlertTriangle size={14} color="#f85149" />
                      <Text fontSize="xs" color="red.400">Errors</Text>
                    </HStack>
                    <Text fontSize="xs" color="red.400">
                      {currentSnapshot.errors.length}
                    </Text>
                  </HStack>
                )}
              </>
            )}

            <Button
              size="sm"
              colorPalette={isMonitoring ? 'red' : 'green'}
              onClick={toggleMonitoring}
            >
              {isMonitoring ? 'Stop' : 'Start'} Monitoring
            </Button>
          </VStack>
        </Card.Body>
      </Card.Root>
    )
  }

  // Modo expandido
  return (
    <Box
      position="fixed"
      top="0"
      right="0"
      width="600px"
      height="100vh"
      bg="gray.900"
      borderLeft="1px solid"
      borderColor="gray.700"
      zIndex="1000"
      overflowY="auto"
    >
      {/* Header */}
      <HStack
        p={4}
        borderBottom="1px solid"
        borderColor="gray.700"
        justify="space-between"
      >
        <HStack gap={2}>
          <FiActivity size={20} color="#58a6ff" />
          <Text fontSize="lg" fontWeight="bold" color="white">
            Performance Dashboard
          </Text>
          <Badge 
            colorPalette={isMonitoring ? 'green' : 'gray'}
            variant="solid"
          >
            {isMonitoring ? 'Live Monitoring' : 'Monitoring Paused'}
          </Badge>
        </HStack>

        <HStack gap={1}>
          <IconButton
            aria-label="Minimize"
            size="sm"
            variant="ghost"
            onClick={() => setIsExpanded(false)}
          >
            <FiMinimize2 size={16} />
          </IconButton>
          {onClose && (
            <IconButton
              aria-label="Close"
              size="sm"
              variant="ghost"
              onClick={onClose}
            >
              <FiX size={16} />
            </IconButton>
          )}
        </HStack>
      </HStack>

      {/* Controls */}
      <HStack
        p={3}
        borderBottom="1px solid"
        borderColor="gray.700"
        justify="space-between"
        bg="gray.800"
      >
        <HStack gap={2}>
          <Button
            size="sm"
            colorPalette={isMonitoring ? 'red' : 'green'}
            onClick={toggleMonitoring}
          >
            {isMonitoring ? 'Stop' : 'Start'} Monitoring
          </Button>
          
          <Button
            size="sm"
            variant="outline"
            onClick={clearData}
            disabled={!currentSnapshot}
          >
            <FiRefreshCw size={14} />
            Clear Data
          </Button>
        </HStack>

        <HStack gap={2}>
          <Button
            size="sm"
            variant="outline"
            onClick={exportData}
            disabled={!currentSnapshot}
          >
            <FiDownload size={14} />
            Export
          </Button>
          
          <Menu.Root>
            <Menu.Trigger asChild>
              <IconButton
                aria-label="Settings"
                size="sm"
                variant="outline"
              >
                <FiSettings size={14} />
              </IconButton>
            </Menu.Trigger>
            <Menu.Positioner>
              <Menu.Content>
                <Menu.Item value="1s" onClick={() => setUpdateInterval(1000)}>
                  Update: 1s
                </Menu.Item>
                <Menu.Item value="5s" onClick={() => setUpdateInterval(5000)}>
                  Update: 5s
                </Menu.Item>
                <Menu.Item value="10s" onClick={() => setUpdateInterval(10000)}>
                  Update: 10s
                </Menu.Item>
              </Menu.Content>
            </Menu.Positioner>
          </Menu.Root>
        </HStack>
      </HStack>

      {/* Content */}
      <Box p={4}>
        <Tabs.Root value={selectedTab} onValueChange={(e) => setSelectedTab(e.value)}>
          <Tabs.List>
            <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
            <Tabs.Trigger value="memory">Memory</Tabs.Trigger>
            <Tabs.Trigger value="performance">Performance</Tabs.Trigger>
            <Tabs.Trigger value="alerts">
              Alerts {alerts.length > 0 && `(${alerts.length})`}
            </Tabs.Trigger>
          </Tabs.List>

          <Box mt={4}>
            <Tabs.Content value="overview">
              {currentSnapshot ? (
                <VStack gap={4} align="stretch">
                  {/* Métricas principais */}
                  <Grid templateColumns="repeat(2, 1fr)" gap={4}>
                    <Card.Root>
                      <Card.Body>
                        <VStack align="start" gap={2}>
                          <HStack>
                            <FiHardDrive color="#a371f7" />
                            <Text fontSize="sm" fontWeight="semibold" color="white">
                              Memory Usage
                            </Text>
                          </HStack>
                          <Text fontSize="2xl" fontWeight="bold" color="white">
                            {currentSnapshot.memory ? formatMemory(currentSnapshot.memory.usedJSHeapSize) : 'N/A'}
                          </Text>
                          {currentSnapshot.memory && (
                            <Progress
                              value={(currentSnapshot.memory.usedJSHeapSize / currentSnapshot.memory.jsHeapSizeLimit) * 100}
                              size="sm"
                              colorPalette="purple"
                            />
                          )}
                        </VStack>
                      </Card.Body>
                    </Card.Root>

                    <Card.Root>
                      <Card.Body>
                        <VStack align="start" gap={2}>
                          <HStack>
                            <FiCpu color="#2ea043" />
                            <Text fontSize="sm" fontWeight="semibold" color="white">
                              FPS
                            </Text>
                          </HStack>
                          <HStack gap={2}>
                            <Text fontSize="2xl" fontWeight="bold" color="white">
                              {currentSnapshot.fps}
                            </Text>
                            {getTrend(snapshots.map(s => s.fps), currentSnapshot.fps) === 'up' && (
                              <FiTrendingUp color="#2ea043" />
                            )}
                            {getTrend(snapshots.map(s => s.fps), currentSnapshot.fps) === 'down' && (
                              <FiTrendingDown color="#f85149" />
                            )}
                          </HStack>
                          <Progress
                            value={Math.min(currentSnapshot.fps / 60 * 100, 100)}
                            size="sm"
                            colorPalette="green"
                          />
                        </VStack>
                      </Card.Body>
                    </Card.Root>
                  </Grid>

                  {/* Custom Metrics */}
                  {currentSnapshot.customMetrics.length > 0 && (
                    <Card.Root>
                      <Card.Header>
                        <Text fontSize="md" fontWeight="semibold" color="white">
                          Custom Metrics
                        </Text>
                      </Card.Header>
                      <Card.Body>
                        <VStack gap={2} align="stretch">
                          {currentSnapshot.customMetrics.slice(0, 5).map((metric, index) => (
                            <HStack key={index} justify="space-between">
                              <Text fontSize="sm" color="gray.400">
                                {metric.type}
                              </Text>
                              <Text fontSize="sm" color="white">
                                {formatDuration(metric.value)}
                              </Text>
                            </HStack>
                          ))}
                        </VStack>
                      </Card.Body>
                    </Card.Root>
                  )}
                </VStack>
              ) : (
                <Box textAlign="center" py={8}>
                  <Text color="gray.400">
                    Start monitoring to see performance data
                  </Text>
                </Box>
              )}
            </Tabs.Content>

            <Tabs.Content value="memory">
              {currentSnapshot?.memory ? (
                <VStack gap={4} align="stretch">
                  <Grid templateColumns="repeat(3, 1fr)" gap={4}>
                    <Card.Root>
                      <Card.Body textAlign="center">
                        <Text fontSize="sm" color="gray.400" mb={2}>Used Heap</Text>
                        <Text fontSize="xl" fontWeight="bold" color="white">
                          {formatMemory(currentSnapshot.memory.usedJSHeapSize)}
                        </Text>
                      </Card.Body>
                    </Card.Root>

                    <Card.Root>
                      <Card.Body textAlign="center">
                        <Text fontSize="sm" color="gray.400" mb={2}>Total Heap</Text>
                        <Text fontSize="xl" fontWeight="bold" color="white">
                          {formatMemory(currentSnapshot.memory.totalJSHeapSize)}
                        </Text>
                      </Card.Body>
                    </Card.Root>

                    <Card.Root>
                      <Card.Body textAlign="center">
                        <Text fontSize="sm" color="gray.400" mb={2}>Heap Limit</Text>
                        <Text fontSize="xl" fontWeight="bold" color="white">
                          {formatMemory(currentSnapshot.memory.jsHeapSizeLimit)}
                        </Text>
                      </Card.Body>
                    </Card.Root>
                  </Grid>

                  <Card.Root>
                    <Card.Body>
                      <Text fontSize="sm" color="gray.400" mb={2}>Memory Usage Over Time</Text>
                      <Box height="200px" bg="gray.800" borderRadius="md" p={4}>
                        <Text color="gray.500" textAlign="center">
                          Chart placeholder - integrate with charting library
                        </Text>
                      </Box>
                    </Card.Body>
                  </Card.Root>
                </VStack>
              ) : (
                <Box textAlign="center" py={8}>
                  <Text color="gray.400">No memory data available</Text>
                </Box>
              )}
            </Tabs.Content>

            <Tabs.Content value="performance">
              <VStack gap={4} align="stretch">
                <Card.Root>
                  <Card.Header>
                    <Text fontSize="md" fontWeight="semibold" color="white">
                      Performance Metrics History
                    </Text>
                  </Card.Header>
                  <Card.Body>
                    <Text color="gray.400">
                      Snapshots recorded: {snapshots.length}
                    </Text>
                    <Text color="gray.400">
                      Update interval: {updateInterval / 1000}s
                    </Text>
                  </Card.Body>
                </Card.Root>
              </VStack>
            </Tabs.Content>

            <Tabs.Content value="alerts">
              <VStack gap={3} align="stretch">
                {alerts.length > 0 ? (
                  alerts.map((alert) => (
                    <Card.Root key={alert.id}>
                      <Card.Body>
                        <HStack justify="space-between">
                          <HStack gap={2}>
                            <FiAlertTriangle 
                              color={alert.type === 'error' ? '#f85149' : '#f77f00'} 
                            />
                            <VStack align="start" gap={1}>
                              <Text fontSize="sm" fontWeight="semibold" color="white">
                                {alert.message}
                              </Text>
                              <Text fontSize="xs" color="gray.400">
                                {new Date(alert.timestamp).toLocaleTimeString()}
                              </Text>
                            </VStack>
                          </HStack>
                          
                          {alert.value && (
                            <Badge 
                              colorPalette={alert.type === 'error' ? 'red' : 'yellow'}
                              variant="solid"
                            >
                              {alert.metric === 'memory' ? formatMemory(alert.value) : alert.value}
                            </Badge>
                          )}
                        </HStack>
                      </Card.Body>
                    </Card.Root>
                  ))
                ) : (
                  <Box textAlign="center" py={8}>
                    <Text color="gray.400">No alerts</Text>
                  </Box>
                )}
              </VStack>
            </Tabs.Content>
          </Box>
        </Tabs.Root>
      </Box>
    </Box>
  )
}