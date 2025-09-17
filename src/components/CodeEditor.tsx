import React, { useState, useEffect, useRef, memo, useCallback, useMemo, Suspense, lazy } from 'react';
import { 
  Flex, 
  Text, 
  HStack, 
  Button, 
  IconButton, 
  Box,
  Menu,
  ScrollArea,
  Separator,
  Spinner
} from '@chakra-ui/react';
import { 
  FiX, 
  FiCircle, 
  FiFolder,
  FiFile,
  FiPlus,
  FiTerminal,
  FiSettings,
  FiSearch,
  FiGitBranch,
  FiBell,
  FiUser,
  FiCode,
  FiPackage,
  FiAlertCircle,
  FiRefreshCw,
  FiCpu
} from 'react-icons/fi';
import { autoSaveProjectState, useProjectStore } from '../stores/projectStore';
import { useEditorRepository } from '../stores/editorStore';
import { useCurrentProject } from '../hooks/useProjectState';
import { useCodeEditorState } from '../hooks/useEditorState';
import TypeScriptLspService from '../services/typescriptLspService';
import RecoveryService from '../services/recoveryService';
import WindowService from '../services/windowService';

// Lazy load componentes pesados
const FileTree = lazy(() => import('./ui/FileTree'));
const MonacoEditor = lazy(() => import('./ui/MonacoEditor'));
const FileTreeWorkerPanel = lazy(() => import('./ui/FileTreeWorkerPanel'));
const PerformanceStatus = lazy(() => import('./ui/PerformanceStatus'));

// Loading fallbacks para componentes lazy loaded
const FileTreeSkeleton = () => (
  <Box p={4} w="250px">
    <Spinner size="sm" mr={2} />
    <Text fontSize="sm" color="text.muted">Loading file tree...</Text>
  </Box>
);

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
);

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
));

StatusBarItem.displayName = 'StatusBarItem';

// Tab component for editor files - Memoizado com comparação customizada
interface EditorTabProps {
  path: string;
  name: string;
  isDirty: boolean;
  isActive: boolean;
  onClick: () => void;
  onClose: (e: React.MouseEvent) => void;
}

const EditorTab = memo<EditorTabProps>(({ path, name, isDirty, isActive, onClick, onClose }) => {
  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onClose(e);
  }, [onClose]);

  return (
  <Flex
    alignItems="center"
    px={3}
    py={1}
    bg={isActive ? 'bg.editor' : 'bg.sidebar'}
    borderBottom={isActive ? '2px solid' : 'none'}
    borderColor={isActive ? 'blue.500' : 'transparent'}
    fontSize="sm"
    cursor="pointer"
    onClick={onClick}
    _hover={{ bg: isActive ? 'bg.editor' : 'whiteAlpha.100' }}
    transition="all 0.2s"
    role="tab"
    aria-selected={isActive}
    data-path={path}
    borderRadius="md 0 0 0"
    position="relative"
    height="32px"
  >
    <HStack gap={2} align="center">
      <FiFile size={14} color={isActive ? '#58a6ff' : '#8b949e'} />
      <Text 
        fontSize="sm" 
        color={isActive ? 'text.primary' : 'text.secondary'}
        maxW="150px"
        whiteSpace="nowrap"
        overflow="hidden"
        textOverflow="ellipsis"
      >
        {name}
      </Text>
      {isDirty && <FiCircle size={8} color="#58a6ff" />}
      <IconButton
        aria-label={`Close ${name}`}
        onClick={handleClose}
        variant="ghost"
        color="text.secondary"
        size="xs"
        ml={1}
        _hover={{ bg: 'whiteAlpha.200' }}
      >
        <FiX size={12} />
      </IconButton>
    </HStack>
  </Flex>
  );
}, (prevProps, nextProps) => {
  // Custom comparison para evitar re-renders desnecessários
  return (
    prevProps.path === nextProps.path &&
    prevProps.name === nextProps.name &&
    prevProps.isDirty === nextProps.isDirty &&
    prevProps.isActive === nextProps.isActive
  );
});

EditorTab.displayName = 'EditorTab';

// Terminal tab component - Memoizado
interface TerminalTabProps {
  name: string;
  isActive: boolean;
  onClick: () => void;
}

const TerminalTab = memo<TerminalTabProps>(({ name, isActive, onClick }) => (
  <Flex
    alignItems="center"
    px={3}
    py={1}
    bg={isActive ? 'bg.editor' : 'bg.sidebar'}
    borderBottom={isActive ? '2px solid' : 'none'}
    borderColor={isActive ? 'blue.500' : 'transparent'}
    fontSize="sm"
    cursor="pointer"
    onClick={onClick}
    _hover={{ bg: isActive ? 'bg.editor' : 'whiteAlpha.100' }}
    transition="all 0.2s"
    borderRadius="md 0 0 0"
    height="32px"
  >
    <HStack gap={2} align="center">
      <FiTerminal size={14} color={isActive ? '#58a6ff' : '#8b949e'} />
      <Text 
        fontSize="sm" 
        color={isActive ? 'text.primary' : 'text.secondary'}
      >
        {name}
      </Text>
    </HStack>
  </Flex>
));

TerminalTab.displayName = 'TerminalTab';

export function CodeEditor() {
  const currentProject = useCurrentProject();
  const { 
    openFiles, 
    activeFile, 
    handleFileSelect, 
    handleCloseFile, 
    handleSetActiveFile 
  } = useCodeEditorState();
  
  // Singletons com ref para evitar re-criações
  const lspServiceRef = useMemo(() => TypeScriptLspService.getInstance(), []);
  const recoveryServiceRef = useMemo(() => RecoveryService.getInstance(), []);
  const windowServiceRef = useMemo(() => WindowService.getInstance(), []);
  
  // Ação de fechar projeto memoizada
  const closeProject = useCallback(() => {
    // Usar action direta do store para evitar dependência desnecessária
    const { closeProject } = useProjectStore.getState();
    closeProject();
  }, []);
  
  // Estados locais da UI
  const [activeTerminalTab, setActiveTerminalTab] = useState('terminal');
  const [isFileTreeExpanded, setIsFileTreeExpanded] = useState(true);
  const [isTerminalExpanded, setIsTerminalExpanded] = useState(true);
  const [isWorkerPanelVisible, setIsWorkerPanelVisible] = useState(false);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  
  // Refs para elementos DOM
  const fileTreeRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);
  
  // Handlers memoizados
  const handleCursorPositionChange = useCallback((line: number, column: number) => {
    setCursorPosition({ line, column });
  }, []);
  
  const toggleFileTree = useCallback(() => {
    setIsFileTreeExpanded(prev => !prev);
  }, []);
  
  const toggleTerminal = useCallback(() => {
    setIsTerminalExpanded(prev => !prev);
  }, []);
  
  const handleTerminalTabClick = useCallback((tab: string) => {
    setActiveTerminalTab(tab);
  }, []);
  
  const toggleWorkerPanel = useCallback(() => {
    setIsWorkerPanelVisible(prev => !prev);
  }, []);

  // Initialize services when project is opened
  useEffect(() => {
    if (!currentProject) {
      // Reset services when project is closed
      lspServiceRef.reset();
      recoveryServiceRef.stopRecoveryMonitoring();
      windowServiceRef.reset();
      return;
    }

    // Use AbortController for better cleanup
    const abortController = new AbortController();
    const { signal } = abortController;

    // Initialize services
    const initializeServices = async () => {
      try {
        await lspServiceRef.initialize(currentProject.path);
        recoveryServiceRef.startRecoveryMonitoring();
        await windowServiceRef.initialize();
      } catch (error) {
        console.error('Failed to initialize services:', error);
      }
    };

    initializeServices();

    // Set up window state change listener with abort signal
    const handleWindowStateChange = (event: CustomEvent) => {
      if (!signal.aborted) {
        useProjectStore.getState().setWindowState(event.detail);
      }
    };

    window.addEventListener('windowStateChange', handleWindowStateChange as EventListener, { signal });

    // Cleanup function
    return () => {
      abortController.abort();
      lspServiceRef.reset();
      recoveryServiceRef.stopRecoveryMonitoring();
      windowServiceRef.reset();
    };
  }, [currentProject, lspServiceRef, recoveryServiceRef, windowServiceRef]);

  // Save project state periodically with debouncing
  useEffect(() => {
    if (!currentProject) return;

    // Set up auto-save on changes
    const unsubscribe = useEditorRepository.subscribe(() => {
      // Trigger auto-save when editor state changes
      autoSaveProjectState();
    });

    return unsubscribe;
  }, [currentProject]);

  // Handle window close event
  useEffect(() => {
    const abortController = new AbortController();
    
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Cancel the event to prompt the user
      e.preventDefault();
      e.returnValue = ''; // Required for Chrome
      return ''; // Required for other browsers
    };

    window.addEventListener('beforeunload', handleBeforeUnload, { 
      signal: abortController.signal 
    });
    
    return () => {
      abortController.abort();
    };
  }, []);

  if (!currentProject) {
    return null;
  }

  return (
    <Flex 
      direction="column" 
      flex="1" 
      bg="bg.editor"
      color="text.primary"
      height="100vh"
      overflow="hidden"
    >
      {/* Top Menu Bar */}
      <Flex
        height="30px"
        bg="bg.sidebar"
        borderBottom="1px solid"
        borderColor="border.glass"
        alignItems="center"
        px={2}
        fontSize="sm"
        fontWeight="medium"
      >
        <HStack gap={4} height="100%">
          <Menu.Root>
            <Menu.Trigger asChild>
              <Button 
                variant="ghost" 
                size="sm" 
                fontWeight="normal"
                px={2}
                _hover={{ bg: 'whiteAlpha.100' }}
              >
                File
              </Button>
            </Menu.Trigger>
            <Menu.Positioner>
              <Menu.Content>
                <Menu.Item value="new-file">New File</Menu.Item>
                <Menu.Item value="new-folder">New Folder</Menu.Item>
                <Menu.Separator />
                <Menu.Item value="open">Open...</Menu.Item>
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
              <Button 
                variant="ghost" 
                size="sm" 
                fontWeight="normal"
                px={2}
                _hover={{ bg: 'whiteAlpha.100' }}
              >
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
              <Button 
                variant="ghost" 
                size="sm" 
                fontWeight="normal"
                px={2}
                _hover={{ bg: 'whiteAlpha.100' }}
              >
                View
              </Button>
            </Menu.Trigger>
            <Menu.Positioner>
              <Menu.Content>
                <Menu.Item 
                  value="toggle-sidebar" 
                  onClick={toggleFileTree}
                >
                  Toggle Sidebar
                </Menu.Item>
                <Menu.Item 
                  value="toggle-terminal" 
                  onClick={toggleTerminal}
                >
                  Toggle Terminal
                </Menu.Item>
                <Menu.Item 
                  value="toggle-worker-panel" 
                  onClick={toggleWorkerPanel}
                >
                  Toggle Worker Panel
                </Menu.Item>
              </Menu.Content>
            </Menu.Positioner>
          </Menu.Root>
          
          <Menu.Root>
            <Menu.Trigger asChild>
              <Button 
                variant="ghost" 
                size="sm" 
                fontWeight="normal"
                px={2}
                _hover={{ bg: 'whiteAlpha.100' }}
              >
                Run
              </Button>
            </Menu.Trigger>
            <Menu.Positioner>
              <Menu.Content>
                <Menu.Item value="run">Run</Menu.Item>
                <Menu.Item value="debug">Debug</Menu.Item>
                <Menu.Item value="build">Build</Menu.Item>
              </Menu.Content>
            </Menu.Positioner>
          </Menu.Root>
        </HStack>
        
        <HStack gap={2} marginLeft="auto">
          <IconButton 
            aria-label="Search" 
            variant="ghost" 
            size="sm" 
          >
            <FiSearch />
          </IconButton>
          <IconButton 
            aria-label="Worker Panel" 
            variant="ghost" 
            size="sm"
            onClick={toggleWorkerPanel}
            bg={isWorkerPanelVisible ? 'whiteAlpha.200' : 'transparent'}
          >
            <FiCpu />
          </IconButton>
          <IconButton 
            aria-label="Notifications" 
            variant="ghost" 
            size="sm" 
          >
            <FiBell />
          </IconButton>
          <IconButton 
            aria-label="Settings" 
            variant="ghost" 
            size="sm" 
          >
            <FiSettings />
          </IconButton>
          <IconButton 
            aria-label="User" 
            variant="ghost" 
            size="sm" 
          >
            <FiUser />
          </IconButton>
        </HStack>
      </Flex>

      {/* Main Content Area */}
      <Flex flex="1" overflow="hidden">
        {/* Sidebar - File Explorer */}
        {isFileTreeExpanded && (
          <Flex
            width={{ base: '100%', md: '260px' }}
            bg="bg.sidebar"
            borderRight="1px solid"
            borderColor="border.glass"
            direction="column"
            ref={fileTreeRef}
          >
            {/* Sidebar Header */}
            <Flex
              alignItems="center"
              p={2}
              borderBottom="1px solid"
              borderColor="border.glass"
            >
              <Flex
                flex="1"
                alignItems="center"
                justifyContent="space-between"
              >
                <HStack gap={2}>
                  <FiFolder size={16} color="#58a6ff" />
                  <Text 
                    fontSize="sm" 
                    fontWeight="600"
                    color="text.primary"
                    maxWidth="180px"
                    whiteSpace="nowrap"
                    overflow="hidden"
                    textOverflow="ellipsis"
                  >
                    {currentProject.name}
                  </Text>
                </HStack>
                <HStack gap={1}>
                  <IconButton
                    aria-label="Refresh"
                    variant="ghost"
                    color="text.secondary"
                    size="xs"
                  >
                    <FiRefreshCw size={14} />
                  </IconButton>
                  <IconButton
                    aria-label="Add"
                    variant="ghost"
                    color="text.secondary"
                    size="xs"
                  >
                    <FiPlus size={14} />
                  </IconButton>
                  <IconButton
                    aria-label="Close sidebar"
                    variant="ghost"
                    color="text.secondary"
                    size="xs"
                    onClick={toggleFileTree}
                  >
                    <FiX size={14} />
                  </IconButton>
                </HStack>
              </Flex>
            </Flex>

            {/* File Tree */}
            <ScrollArea.Root flex="1" overflowY="auto">
              <ScrollArea.Viewport p={2}>
                <Suspense fallback={<FileTreeSkeleton />}>
                  <FileTree rootPath={currentProject.path} onFileSelect={handleFileSelect} />
                </Suspense>
              </ScrollArea.Viewport>
              <ScrollArea.Scrollbar 
                orientation="vertical"
              >
                <ScrollArea.Thumb />
              </ScrollArea.Scrollbar>
            </ScrollArea.Root>
          </Flex>
        )}

        {/* Editor Area */}
        <Flex
          flex="1"
          bg="bg.editor"
          direction="column"
          ref={editorRef}
        >
          {/* Tab Bar */}
          <Flex
            minHeight="32px"
            bg="bg.sidebar"
            borderBottom="1px solid"
            borderColor="border.glass"
            overflowX="auto"
            px={1}
            py={1}
            gap={1}
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
              >
                No files open
              </Flex>
            )}
          </Flex>

          {/* Editor Content */}
          <Flex
            flex="1"
            overflow="hidden"
          >
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
                <FiCode size={48} color="#8b949e" />
                <Text mt={4} fontSize="lg" color="text.secondary">
                  Welcome to ToqueMedia Studio
                </Text>
                <Text mt={2} fontSize="sm" color="text.muted">
                  Open a file to start editing
                </Text>
              </Flex>
            )}
          </Flex>
        </Flex>
      </Flex>

      {/* Terminal Panel */}
      {isTerminalExpanded && (
        <Flex
          height={{ base: '200px', md: '250px' }}
          bg="bg.terminal"
          borderTop="1px solid"
          borderColor="border.glass"
          direction="column"
          ref={terminalRef}
        >
          {/* Terminal Tabs */}
          <Flex
            minHeight="32px"
            bg="bg.sidebar"
            borderBottom="1px solid"
            borderColor="border.glass"
            overflowX="auto"
            px={1}
            py={1}
            gap={1}
          >
            <TerminalTab
              name="Terminal"
              isActive={activeTerminalTab === 'terminal'}
              onClick={() => handleTerminalTabClick('terminal')}
            />
            <TerminalTab
              name="Output"
              isActive={activeTerminalTab === 'output'}
              onClick={() => handleTerminalTabClick('output')}
            />
            <TerminalTab
              name="Debug Console"
              isActive={activeTerminalTab === 'debug'}
              onClick={() => handleTerminalTabClick('debug')}
            />
          </Flex>
          
          {/* Terminal Content */}
          <Flex flex="1" direction="column" overflow="hidden">
            <ScrollArea.Root flex="1" overflowY="auto">
              <ScrollArea.Viewport p={3} fontFamily="mono" fontSize="sm">
                <Text color="#58a6ff">
                  Microsoft Windows [Version 10.0.19044.2728]
                </Text>
                <Text color="text.muted">
                  (c) Microsoft Corporation. All rights reserved.
                </Text>
                <Box height="8px" />
                <Text>
                  <Text as="span" color="#a371f7">C:\Users\dev&gt;</Text>
                  <Text as="span" color="#58a6ff">npm start</Text>
                </Text>
                <Text color="#2ea043">
                  Starting development server...
                </Text>
                <Text color="#58a6ff">
                  [INFO] Starting build process...
                </Text>
                <Text color="#2ea043">
                  [SUCCESS] Build completed successfully
                </Text>
                <Text color="#f77f00">
                  [WARN] Some dependencies are outdated
                </Text>
                <Text color="#58a6ff">
                  [INFO] Server running on http://localhost:3000
                </Text>
              </ScrollArea.Viewport>
              <ScrollArea.Scrollbar 
                orientation="vertical"
              >
                <ScrollArea.Thumb />
              </ScrollArea.Scrollbar>
            </ScrollArea.Root>
            
            {/* Terminal Input */}
            <Flex
              alignItems="center"
              px={3}
              py={2}
              borderTop="1px solid"
              borderColor="border.glass"
            >
              <Text as="span" color="#a371f7" mr={2} fontFamily="mono">
                C:\Users\dev&gt;
              </Text>
              <Box
                flex="1"
                height="20px"
                bg="transparent"
                outline="none"
                contentEditable
                fontFamily="mono"
                fontSize="sm"
                color="text.primary"
                _focus={{ outline: 'none' }}
              />
            </Flex>
          </Flex>
        </Flex>
      )}

      {/* Status Bar */}
      <Flex
        height="24px"
        bg="bg.sidebar"
        borderTop="1px solid"
        borderColor="border.glass"
        alignItems="center"
        fontSize="xs"
        fontWeight="medium"
      >
        <HStack gap={0} height="100%">
          <StatusBarItem tooltip="Git branch">
            <FiGitBranch size={12} />
            <Text>main</Text>
          </StatusBarItem>
          
          <Separator orientation="vertical" height="16px" mx={1} />
          
          <StatusBarItem tooltip="Language mode">
            <FiCode size={12} />
            <Text>TypeScript</Text>
          </StatusBarItem>
          
          <Separator orientation="vertical" height="16px" mx={1} />
          
          <StatusBarItem tooltip="Line and column">
            <Text>Ln {cursorPosition.line}, Col {cursorPosition.column}</Text>
          </StatusBarItem>
          
          <Separator orientation="vertical" height="16px" mx={1} />
          
          <StatusBarItem tooltip="Encoding">
            <Text>UTF-8</Text>
          </StatusBarItem>
          
          <Separator orientation="vertical" height="16px" mx={1} />
          
          <StatusBarItem tooltip="Line endings">
            <Text>LF</Text>
          </StatusBarItem>
        </HStack>
        
        <HStack gap={0} height="100%" marginLeft="auto">
          <Suspense fallback={null}>
            <PerformanceStatus compact />
          </Suspense>
          
          <Separator orientation="vertical" height="16px" mx={1} />
          
          <StatusBarItem tooltip="Errors and warnings">
            <FiAlertCircle size={12} color="#f77f00" />
            <Text>2</Text>
          </StatusBarItem>
          
          <Separator orientation="vertical" height="16px" mx={1} />
          
          <StatusBarItem tooltip="Packages">
            <FiPackage size={12} />
            <Text>12</Text>
          </StatusBarItem>
          
          <Separator orientation="vertical" height="16px" mx={1} />
          
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
  );
}
