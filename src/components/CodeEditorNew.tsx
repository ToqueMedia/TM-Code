import React, { useState, useEffect, useRef, memo, useCallback, useMemo, Suspense, lazy } from 'react'
import { 
  Flex, 
  Text, 
  HStack, 
  Button, 
  IconButton, 
  Box,
  Menu,
  Separator,
  Spinner
} from '@chakra-ui/react'
import { 
  FiX, 
  FiFile,
  FiGitBranch,
  FiBell,
  FiCode,
  FiAlertCircle,
  FiCpu
} from 'react-icons/fi'
import { 
  SiJavascript, 
  SiTypescript, 
  SiReact, 
  SiCss3, 
  SiHtml5, 
  SiJson, 
  SiMarkdown, 
  SiPython,
  SiNpm,
  SiDocker
} from 'react-icons/si'
import { FaFileImage, FaFilePdf, FaFileArchive } from 'react-icons/fa'
import { autoSaveProjectState, useProjectStore } from '../stores/projectStore'
import { useEditorRepository } from '../stores/editorStore'
import { useCurrentProject } from '../hooks/useProjectState'
import { useCodeEditorState } from '../hooks/useEditorState'
import TypeScriptLspService from '../services/typescriptLspService'
import RecoveryService from '../services/recoveryService'
import WindowService from '../services/windowService'

// Importar novos componentes
import ActivityBar from './ui/ActivityBar'
import ExplorerPanel from './ui/ExplorerPanel'
import SearchPanel from './ui/SearchPanel'
import BottomPanel from './ui/BottomPanel'
import Breadcrumbs from './ui/Breadcrumbs'

// Lazy load componentes pesados
const MonacoEditor = lazy(() => import('./ui/MonacoEditor'))
const FileTreeWorkerPanel = lazy(() => import('./ui/FileTreeWorkerPanel'))
const PerformanceStatus = lazy(() => import('./ui/PerformanceStatus'))

// Loading fallbacks
const EditorSkeleton = () => (
  <Flex 
    flex={1} 
    align="center" 
    justify="center" 
    direction="column"
    gap={2}
  >
    <Spinner size="lg" />
    <Text fontSize="sm" color="text.muted">Loading editor...</Text>
  </Flex>
)

// Status bar item component - Memoizado para evitar re-renders
const StatusBarItem = memo<{ children: React.ReactNode; tooltip?: string }>(({ 
  children, 
  tooltip 
}) => (
  <Box
    px={3}
    py={1}
    fontSize="xs"
    fontWeight="medium"
    cursor="pointer"
    _hover={{ bg: 'whiteAlpha.100' }}
    transition="background 0.2s"
    display="flex"
    alignItems="center"
    gap={1}
    title={tooltip}
  >
    {children}
  </Box>
))

StatusBarItem.displayName = 'StatusBarItem'

// Editor Tab Component - Melhorado
interface EditorTabProps {
  path: string
  name: string
  isDirty: boolean
  isActive: boolean
  onClick: () => void
  onClose: (e: React.MouseEvent) => void
}

const EditorTab = memo<EditorTabProps>(({ path, name, isDirty, isActive, onClick, onClose }) => {
  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onClose(e)
  }, [onClose])

  const getFileIconComponent = (fileName: string) => {
    const ext = fileName.split('.').pop()?.toLowerCase()
    const name = fileName.toLowerCase()
    
    // Special files based on name
    if (name === 'package.json') {
      return { icon: SiNpm, color: '#cb3837' }
    }
    if (name === 'dockerfile') {
      return { icon: SiDocker, color: '#2496ed' }
    }
    
    // Extension based icons
    switch (ext) {
      case 'js':
        return { icon: SiJavascript, color: '#f7df1e' }
      case 'jsx':
        return { icon: SiReact, color: '#61dafb' }
      case 'ts':
        return { icon: SiTypescript, color: '#3178c6' }
      case 'tsx':
        return { icon: SiReact, color: '#61dafb' }
      case 'css':
        return { icon: SiCss3, color: '#1572b6' }
      case 'html':
        return { icon: SiHtml5, color: '#e34f26' }
      case 'json':
        return { icon: SiJson, color: '#ffff00' }
      case 'md':
        return { icon: SiMarkdown, color: '#0066cc' }
      case 'py':
        return { icon: SiPython, color: '#3776ab' }
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'svg':
      case 'webp':
        return { icon: FaFileImage, color: '#2ea043' }
      case 'pdf':
        return { icon: FaFilePdf, color: '#dc2626' }
      case 'zip':
      case 'rar':
      case 'tar':
      case 'gz':
        return { icon: FaFileArchive, color: '#d97706' }
      default:
        return { icon: FiFile, color: '#8b949e' }
    }
  }

  return (
    <Flex
      className={`vscode-tab ${isActive ? 'active' : ''}`}
      alignItems="center"
      px={3}
      py={0}
      bg={isActive ? '#1e1e1e' : '#2d2d30'}
      borderRight="1px solid #1e1f22"
      fontSize="13px"
      cursor="pointer"
      onClick={onClick}
      _hover={{ 
        bg: isActive ? '#1e1e1e' : '#37373d',
      }}
      transition="background-color 0.1s ease"
      role="tab"
      aria-selected={isActive}
      data-path={path}
      borderRadius="0"
      position="relative"
      height="35px"
      minW="0"
      maxW="240px"
      color={isActive ? '#ffffff' : '#969696'}
      borderTop={isActive ? '1px solid #007acc' : '1px solid transparent'}
    >
      <HStack gap={2} align="center" minW="0">
        {(() => {
          const { icon: IconComponent, color } = getFileIconComponent(name)
          return <IconComponent size={16} color={color} />
        })()} 
        <Text 
          fontSize="13px" 
          fontWeight="400"
          maxW="160px"
          whiteSpace="nowrap"
          overflow="hidden"
          textOverflow="ellipsis"
          fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif"
        >
          {name}
        </Text>
        {isDirty && (
          <Box
            w="8px"
            h="8px"
            borderRadius="full"
            bg={isActive ? '#ffffff' : '#969696'}
            flexShrink={0}
            ml={1}
          />
        )}
        <IconButton
          aria-label={`Close ${name}`}
          onClick={handleClose}
          variant="ghost"
          color={isActive ? '#ffffff' : '#969696'}
          size="xs"
          _hover={{ 
            bg: 'rgba(255, 255, 255, 0.1)',
            color: '#ffffff'
          }}
          opacity={isActive ? 1 : 0}
          _groupHover={{ opacity: 1 }}
          transition="opacity 0.1s ease"
          borderRadius="3px"
          width="22px"
          height="22px"
          minW="22px"
        >
          <FiX size={14} />
        </IconButton>
      </HStack>
    </Flex>
  )
}, (prevProps, nextProps) => {
  return (
    prevProps.path === nextProps.path &&
    prevProps.name === nextProps.name &&
    prevProps.isDirty === nextProps.isDirty &&
    prevProps.isActive === nextProps.isActive
  )
})

EditorTab.displayName = 'EditorTab'

export function CodeEditorNew() {
  const currentProject = useCurrentProject()
  const { 
    openFiles, 
    activeFile, 
    handleFileSelect, 
    handleCloseFile, 
    handleSetActiveFile 
  } = useCodeEditorState()
  
  // Singletons com ref para evitar re-criações
  const lspServiceRef = useMemo(() => TypeScriptLspService.getInstance(), [])
  const recoveryServiceRef = useMemo(() => RecoveryService.getInstance(), [])
  const windowServiceRef = useMemo(() => WindowService.getInstance(), [])
  
  // Estados locais da UI
  const [activeActivity, setActiveActivity] = useState('explorer')
  const [isBottomPanelVisible, setIsBottomPanelVisible] = useState(true)
  const [isWorkerPanelVisible, setIsWorkerPanelVisible] = useState(false)
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 })
  
  // Refs para elementos DOM
  const editorRef = useRef<HTMLDivElement>(null)
  
  // Ação de fechar projeto memoizada
  const closeProject = useCallback(() => {
    const { closeProject } = useProjectStore.getState()
    closeProject()
  }, [])
  
  // Handlers memoizados
  const handleCursorPositionChange = useCallback((line: number, column: number) => {
    setCursorPosition({ line, column })
  }, [])
  
  const handleActivityChange = useCallback((activity: string) => {
    setActiveActivity(activity)
  }, [])
  
  const toggleBottomPanel = useCallback(() => {
    setIsBottomPanelVisible(prev => !prev)
  }, [])
  
  const closeBottomPanel = useCallback(() => {
    setIsBottomPanelVisible(false)
  }, [])
  
  const toggleWorkerPanel = useCallback(() => {
    setIsWorkerPanelVisible(prev => !prev)
  }, [])

  // Initialize services when project is opened
  useEffect(() => {
    if (!currentProject) {
      lspServiceRef.reset()
      recoveryServiceRef.stopRecoveryMonitoring()
      windowServiceRef.reset()
      return
    }

    const abortController = new AbortController()
    const { signal } = abortController

    const initializeServices = async () => {
      try {
        await lspServiceRef.initialize(currentProject.path)
        recoveryServiceRef.startRecoveryMonitoring()
        await windowServiceRef.initialize()
      } catch (error) {
        console.error('Failed to initialize services:', error)
      }
    }

    initializeServices()

    const handleWindowStateChange = (event: CustomEvent) => {
      if (!signal.aborted) {
        useProjectStore.getState().setWindowState(event.detail)
      }
    }

    window.addEventListener('windowStateChange', handleWindowStateChange as EventListener, { signal })

    return () => {
      abortController.abort()
      lspServiceRef.reset()
      recoveryServiceRef.stopRecoveryMonitoring()
      windowServiceRef.reset()
    }
  }, [currentProject, lspServiceRef, recoveryServiceRef, windowServiceRef])

  // Save project state periodically
  useEffect(() => {
    if (!currentProject) return

    const unsubscribe = useEditorRepository.subscribe(() => {
      autoSaveProjectState()
    })

    return unsubscribe
  }, [currentProject])

  // Handle window close event
  useEffect(() => {
    const abortController = new AbortController()
    
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
      return ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload, { 
      signal: abortController.signal 
    })
    
    return () => {
      abortController.abort()
    }
  }, [])

  // Render sidebar panel based on active activity
  const renderSidebarPanel = () => {
    switch (activeActivity) {
      case 'explorer':
        return <ExplorerPanel onFileSelect={handleFileSelect} />
      case 'search':
        return <SearchPanel onFileSelect={handleFileSelect} />
      case 'source-control':
        return <SourceControlPanel />
      case 'run-debug':
        return <RunDebugPanel />
      case 'extensions':
        return <ExtensionsPanel />
      default:
        return <ExplorerPanel onFileSelect={handleFileSelect} />
    }
  }

  if (!currentProject) {
    return null
  }

  return (
    <Flex 
      direction="column" 
      flex="1" 
      bg="#1e1e1e"
      color="#cccccc"
      height="100vh"
      overflow="hidden"
    >
      {/* Menu Bar */}
      <Flex
        height="30px"
        bg="#323233"
        borderBottom="1px solid #1e1f22"
        alignItems="center"
        px={2}
        fontSize="13px"
        fontWeight="400"
        justify="space-between"
      >
        <HStack gap={4} height="100%">
          <Menu.Root>
            <Menu.Trigger asChild>
              <Button variant="ghost" size="sm" fontWeight="normal" px={2}>
                File
              </Button>
            </Menu.Trigger>
            <Menu.Positioner>
              <Menu.Content>
                <Menu.Item value="new-file">New File</Menu.Item>
                <Menu.Item value="open-folder">Open Folder...</Menu.Item>
                <Menu.Separator />
                <Menu.Item value="save">Save</Menu.Item>
                <Menu.Item value="save-as">Save As...</Menu.Item>
                <Menu.Separator />
                <Menu.Item value="close-project" onClick={closeProject}>Close Project</Menu.Item>
              </Menu.Content>
            </Menu.Positioner>
          </Menu.Root>
          
          <Menu.Root>
            <Menu.Trigger asChild>
              <Button variant="ghost" size="sm" fontWeight="normal" px={2}>
                Edit
              </Button>
            </Menu.Trigger>
            <Menu.Positioner>
              <Menu.Content>
                <Menu.Item value="undo">Undo</Menu.Item>
                <Menu.Item value="redo">Redo</Menu.Item>
                <Menu.Separator />
                <Menu.Item value="cut">Cut</Menu.Item>
                <Menu.Item value="copy">Copy</Menu.Item>
                <Menu.Item value="paste">Paste</Menu.Item>
              </Menu.Content>
            </Menu.Positioner>
          </Menu.Root>
          
          <Menu.Root>
            <Menu.Trigger asChild>
              <Button variant="ghost" size="sm" fontWeight="normal" px={2}>
                View
              </Button>
            </Menu.Trigger>
            <Menu.Positioner>
              <Menu.Content>
                <Menu.Item value="toggle-panel" onClick={toggleBottomPanel}>
                  Toggle Panel
                </Menu.Item>
                <Menu.Item value="toggle-worker-panel" onClick={toggleWorkerPanel}>
                  Toggle Worker Panel
                </Menu.Item>
              </Menu.Content>
            </Menu.Positioner>
          </Menu.Root>
          
          <Menu.Root>
            <Menu.Trigger asChild>
              <Button variant="ghost" size="sm" fontWeight="normal" px={2}>
                Terminal
              </Button>
            </Menu.Trigger>
            <Menu.Positioner>
              <Menu.Content>
                <Menu.Item value="new-terminal">New Terminal</Menu.Item>
                <Menu.Item value="split-terminal">Split Terminal</Menu.Item>
              </Menu.Content>
            </Menu.Positioner>
          </Menu.Root>
        </HStack>
        
        <HStack gap={1}>
          <IconButton aria-label="Notifications" variant="ghost" size="xs">
            <FiBell size={12} />
          </IconButton>
          <IconButton 
            aria-label="Worker Panel" 
            variant="ghost" 
            size="xs"
            onClick={toggleWorkerPanel}
            bg={isWorkerPanelVisible ? 'whiteAlpha.200' : 'transparent'}
          >
            <FiCpu size={12} />
          </IconButton>
        </HStack>
      </Flex>

      {/* Main Content Area */}
      <Flex flex="1" overflow="hidden">
        {/* Activity Bar */}
        <ActivityBar
          activeActivity={activeActivity}
          onActivityChange={handleActivityChange}
        />

        {/* Sidebar Panel */}
        <Box
          width="300px"
          bg="bg.sidebar"
          borderRight="1px solid #1e1f22"
          height="100%"
        >
          {renderSidebarPanel()}
        </Box>

        {/* Editor Area */}
        <Flex
          flex="1"
          bg="bg.editor"
          direction="column"
          ref={editorRef}
        >
          {/* Editor Tabs */}
          <Flex
            className="vscode-tabs"
            minHeight="35px"
            bg="#2d2d30"
            borderBottom="1px solid #1e1f22"
            overflowX="auto"
            align="center"
          >
            {openFiles.map((file) => (
              <EditorTab
                key={file.path}
                path={file.path}
                name={file.path.split('/').pop() || 'Untitled'}
                isDirty={file.isDirty}
                isActive={activeFile === file.path}
                onClick={() => handleSetActiveFile(file.path)}
                onClose={(e) => handleCloseFile(file.path, e)}
              />
            ))}
            
            {openFiles.length === 0 && (
              <Flex
                alignItems="center"
                justifyContent="center"
                flex="1"
                color="text.secondary"
                fontSize="sm"
                height="35px"
              >
                No tabs open
              </Flex>
            )}
          </Flex>

          {/* Breadcrumbs */}
          <Breadcrumbs
            filePath={activeFile || undefined}
            projectRoot={currentProject.path}
            onNavigate={(path) => console.log('Navigate to:', path)}
          />

          {/* Editor Content */}
          <Flex flex="1" overflow="hidden">
            {activeFile ? (
              <Suspense fallback={<EditorSkeleton />}>
                <MonacoEditor 
                  path={activeFile} 
                  onCursorPositionChange={handleCursorPositionChange} 
                />
              </Suspense>
            ) : (
              <Flex
                flex="1"
                alignItems="center"
                justifyContent="center"
                bg="bg.editor"
                direction="column"
                p={8}
              >
                <FiCode size={64} color="#58a6ff" opacity={0.3} />
                <Text mt={4} fontSize="xl" color="text.primary" fontWeight="600">
                  Welcome to ToqueMedia Studio
                </Text>
                <Text mt={2} fontSize="sm" color="text.muted" textAlign="center" maxW="400px">
                  Open a file from the explorer or create a new file to start coding.
                </Text>
              </Flex>
            )}
          </Flex>
        </Flex>
      </Flex>

      {/* Bottom Panel */}
      <BottomPanel
        isVisible={isBottomPanelVisible}
        onToggle={toggleBottomPanel}
        onClose={closeBottomPanel}
      />

      {/* Status Bar */}
      <Flex
        height="24px"
        bg="blue.600"
        color="white"
        alignItems="center"
        fontSize="xs"
        fontWeight="medium"
        px={2}
      >
        <HStack gap={0} height="100%">
          <StatusBarItem tooltip="Git branch">
            <FiGitBranch size={12} />
            <Text>main</Text>
          </StatusBarItem>
          
          <Separator orientation="vertical" height="16px" mx={2} />
          
          <StatusBarItem tooltip="Language mode">
            <FiCode size={12} />
            <Text>TypeScript</Text>
          </StatusBarItem>
          
          <Separator orientation="vertical" height="16px" mx={2} />
          
          <StatusBarItem tooltip="Line and column">
            <Text>Ln {cursorPosition.line}, Col {cursorPosition.column}</Text>
          </StatusBarItem>
          
          <Separator orientation="vertical" height="16px" mx={2} />
          
          <StatusBarItem tooltip="Encoding">
            <Text>UTF-8</Text>
          </StatusBarItem>
        </HStack>
        
        <HStack gap={0} height="100%" marginLeft="auto">
          <Suspense fallback={null}>
            <PerformanceStatus compact />
          </Suspense>
          
          <Separator orientation="vertical" height="16px" mx={2} />
          
          <StatusBarItem tooltip="Errors and warnings">
            <FiAlertCircle size={12} />
            <Text>0</Text>
          </StatusBarItem>
          
          <Separator orientation="vertical" height="16px" mx={2} />
          
          <StatusBarItem tooltip="Current project">
            <Text>{currentProject.name}</Text>
          </StatusBarItem>
        </HStack>
      </Flex>
      
      {/* Web Worker Panel */}
      <Suspense fallback={null}>
        <FileTreeWorkerPanel 
          isVisible={isWorkerPanelVisible}
          onClose={() => setIsWorkerPanelVisible(false)}
        />
      </Suspense>
    </Flex>
  )
}

// Placeholder components for missing panels

const SourceControlPanel = memo(() => (
  <Box p={4} color="text.muted">
    <Text fontSize="sm">Source control panel coming soon...</Text>
  </Box>
))

const RunDebugPanel = memo(() => (
  <Box p={4} color="text.muted">
    <Text fontSize="sm">Run & debug panel coming soon...</Text>
  </Box>
))

const ExtensionsPanel = memo(() => (
  <Box p={4} color="text.muted">
    <Text fontSize="sm">Extensions panel coming soon...</Text>
  </Box>
))

SourceControlPanel.displayName = 'SourceControlPanel'
RunDebugPanel.displayName = 'RunDebugPanel'
ExtensionsPanel.displayName = 'ExtensionsPanel'

export default CodeEditorNew