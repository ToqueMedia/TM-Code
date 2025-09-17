import React, { useState, useRef, useEffect } from 'react';
import { 
  Box, 
  VStack, 
  HStack, 
  Text, 
  Icon, 
  Button,
  Menu,
  Portal,
  Input,
  Dialog,
  Alert
} from '@chakra-ui/react';
import { 
  FiFolderPlus, 
  FiFilePlus, 
  FiTrash2, 
  FiMoreVertical,
  FiRefreshCw,
  FiEdit2,
  FiChevronRight,
  FiChevronDown,
  FiCopy,
  FiPlus
} from 'react-icons/fi';

// Import more professional icons from react-icons
import { 
  FaFolder, 
  FaFolderOpen, 
  FaFile, 
  FaFileCode, 
  FaFileImage, 
  FaFilePdf, 
  FaFileAlt, 
  FaFileArchive,
  FaFileAudio,
  FaFileVideo
} from 'react-icons/fa';
import { useFileTreeRepository } from '../../stores/fileTreeStore';
import type { FileTreeNode } from '../../types/fileTree';
import FileWatcherService from '../../services/fileWatcherService';

interface FileTreeProps {
  rootPath: string;
  onFileSelect?: (path: string) => void;
  onRefresh?: () => void;
}

interface AlertState {
  show: boolean;
  title: string;
  description: string;
  status: 'success' | 'error';
}

interface TreeNodeProps {
  node: FileTreeNode;
  level: number;
  onFileSelect?: (path: string) => void;
  setAlert: (alert: AlertState) => void;
}

// File icon component with better styling
const FileIcon: React.FC<{ 
  type: 'file' | 'directory'; 
  extension?: string; 
  isSelected?: boolean;
  isExpanded?: boolean;
}> = ({ type, extension, isSelected, isExpanded }) => {
  // File icon based on extension
  const getFileIcon = () => {
    if (type === 'directory') {
      return isExpanded ? FaFolderOpen : FaFolder;
    }
    
    const ext = extension?.toLowerCase();
    switch (ext) {
      case 'js':
      case 'jsx':
        return FaFileCode;
      case 'ts':
      case 'tsx':
        return FaFileCode;
      case 'css':
        return FaFileCode;
      case 'html':
        return FaFileCode;
      case 'json':
        return FaFileCode;
      case 'md':
        return FaFileAlt;
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'svg':
      case 'webp':
        return FaFileImage;
      case 'pdf':
        return FaFilePdf;
      case 'zip':
      case 'rar':
      case 'tar':
      case 'gz':
        return FaFileArchive;
      case 'mp3':
      case 'wav':
      case 'ogg':
        return FaFileAudio;
      case 'mp4':
      case 'avi':
      case 'mov':
        return FaFileVideo;
      default:
        return FaFile;
    }
  };
  
  const IconComponent = getFileIcon();
  
  // Determine color based on file type and selection state
  let color = '#8b949e';
  if (isSelected) {
    color = '#ffffff';
  } else if (type === 'directory') {
    color = '#58a6ff';
  } else {
    const ext = extension?.toLowerCase();
    switch (ext) {
      case 'js':
      case 'jsx':
        color = '#f77f00';
        break;
      case 'ts':
      case 'tsx':
        color = '#58a6ff';
        break;
      case 'css':
        color = '#2ea043';
        break;
      case 'html':
        color = '#e04e4e';
        break;
      case 'json':
        color = '#f1fa8c';
        break;
      case 'md':
        color = '#58a6ff';
        break;
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'svg':
      case 'webp':
        color = '#65a30d';
        break;
      case 'pdf':
        color = '#dc2626';
        break;
      case 'zip':
      case 'rar':
      case 'tar':
      case 'gz':
        color = '#d97706';
        break;
      default:
        color = '#8b949e';
    }
  }
  
  return (
    <Box 
      display="flex" 
      alignItems="center" 
      justifyContent="center"
      width="16px"
      height="16px"
    >
      <Icon as={IconComponent} color={color} />
    </Box>
  );
};

const TreeNode: React.FC<TreeNodeProps> = ({ 
  node, 
  level, 
  onFileSelect,
  setAlert
}) => {
  const { expandedPaths, selectedPath, toggleNode, selectNode, deleteNode, createFileOrDirectory, renameNode, copyNode } = useFileTreeRepository();
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = selectedPath === node.path;
  
  // State for rename modal
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(node.name);
  const renameInputRef = useRef<HTMLInputElement>(null);
  
  // State for create modal
  const [isCreating, setIsCreating] = useState(false);
  const [createType, setCreateType] = useState<'file' | 'directory'>('file');
  const [createName, setCreateName] = useState('');
  const createInputRef = useRef<HTMLInputElement>(null);
  
  // State for copy modal
  const [isCopying, setIsCopying] = useState(false);
  const [copyDestination, setCopyDestination] = useState('');
  const copyInputRef = useRef<HTMLInputElement>(null);
  
  // Focus input when renaming
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);
  
  // Focus input when creating
  useEffect(() => {
    if (isCreating && createInputRef.current) {
      createInputRef.current.focus();
    }
  }, [isCreating]);
  
  // Focus input when copying
  useEffect(() => {
    if (isCopying && copyInputRef.current) {
      copyInputRef.current.focus();
    }
  }, [isCopying]);
  
  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.type === 'directory') {
      toggleNode(node.path);
    }
  };
  
  const handleSelect = () => {
    selectNode(node.path);
    if (node.type === 'file' && onFileSelect) {
      onFileSelect(node.path);
    }
  };
  
  const handleCreate = async (type: 'file' | 'directory') => {
    setCreateType(type);
    setCreateName(type === 'file' ? 'new-file.txt' : 'new-folder');
    setIsCreating(true);
  };
  
  const handleRename = () => {
    setNewName(node.name);
    setIsRenaming(true);
  };
  
  const handleCopy = () => {
    // Default copy destination - same directory with "-copy" suffix
    const baseName = node.name;
    const copyName = node.type === 'directory' 
      ? `${baseName}-copy` 
      : baseName.includes('.') 
        ? `${baseName.split('.').slice(0, -1).join('.')} copy.${baseName.split('.').pop()}`
        : `${baseName} copy`;
    
    setCopyDestination(copyName);
    setIsCopying(true);
  };
  
  const handleDelete = async () => {
    if (window.confirm(`Are you sure you want to delete "${node.name}"?`)) {
      const success = await deleteNode(node.path);
      if (success) {
        setAlert({ show: true, title: 'Success', description: `Deleted ${node.name}`, status: 'success' });
      } else {
        setAlert({ show: true, title: 'Error', description: `Failed to delete ${node.name}`, status: 'error' });
      }
    }
  };
  
  const confirmRename = async () => {
    if (newName && newName !== node.name) {
      const success = await renameNode(node.path, newName);
      if (success) {
        setAlert({ show: true, title: 'Success', description: `Renamed to ${newName}`, status: 'success' });
      } else {
        setAlert({ show: true, title: 'Error', description: `Failed to rename ${node.name}`, status: 'error' });
      }
    }
    setIsRenaming(false);
  };
  
  const confirmCreate = async () => {
    if (createName) {
      const success = await createFileOrDirectory(node.path, createName, createType === 'directory');
      if (success) {
        setAlert({ show: true, title: 'Success', description: `Created ${createName}`, status: 'success' });
      } else {
        setAlert({ show: true, title: 'Error', description: `Failed to create ${createName}`, status: 'error' });
      }
    }
    setIsCreating(false);
    setCreateName('');
  };
  
  const confirmCopy = async () => {
    if (copyDestination) {
      // Construct full destination path
      const parentDir = node.path.substring(0, node.path.lastIndexOf('/'));
      const destinationPath = `${parentDir}/${copyDestination}`;
      
      const success = await copyNode(node.path, destinationPath);
      if (success) {
        setAlert({ show: true, title: 'Success', description: `Copied ${node.name} to ${copyDestination}`, status: 'success' });
      } else {
        setAlert({ show: true, title: 'Error', description: `Failed to copy ${node.name}`, status: 'error' });
      }
    }
    setIsCopying(false);
    setCopyDestination('');
  };
  
  const handleKeyDown = (e: React.KeyboardEvent, callback: () => void) => {
    if (e.key === 'Enter') {
      callback();
    } else if (e.key === 'Escape') {
      setIsRenaming(false);
      setIsCreating(false);
      setIsCopying(false);
    }
  };
  
  return (
    <Box>
      <HStack
        py={1}
        pl={level * 12}
        bg={isSelected ? 'blue.500' : 'transparent'}
        color={isSelected ? 'white' : '#c9d1d9'}
        _hover={{ bg: isSelected ? 'blue.600' : 'rgba(255, 255, 255, 0.05)' }}
        cursor="pointer"
        onClick={handleSelect}
        borderRadius="sm"
        position="relative"
        gap={2}
        height="24px"
      >
        {node.type === 'directory' ? (
          <Icon 
            as={isExpanded ? FiChevronDown : FiChevronRight} 
            onClick={handleToggle}
            cursor="pointer"
            fontSize="14px"
            color={isSelected ? 'white' : '#8b949e'}
          />
        ) : (
          <Box width="14px" />
        )}
        
        <FileIcon 
          type={node.type} 
          extension={node.extension} 
          isSelected={isSelected}
          isExpanded={isExpanded}
        />
        
        {isRenaming ? (
          <Input
            ref={renameInputRef}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => handleKeyDown(e, confirmRename)}
            onBlur={confirmRename}
            size="xs"
            variant="flushed"
            color={isSelected ? 'white' : '#e6edf3'}
            bg={isSelected ? 'blue.500' : 'transparent'}
            flex={1}
            px={1}
            py={0}
            height="20px"
            fontSize="sm"
          />
        ) : (
          <Text 
            fontSize="sm" 
            flex={1} 
            lineClamp={1}
            color={isSelected ? 'white' : '#c9d1d9'}
          >
            {node.name}
          </Text>
        )}
        
        <Menu.Root>
          <Menu.Trigger asChild>
            <Button
              aria-label="File options"
              variant="ghost"
              size="xs"
              color={isSelected ? 'whiteAlpha.800' : '#8b949e'}
              _hover={{ bg: isSelected ? 'whiteAlpha.200' : 'rgba(255, 255, 255, 0.1)' }}
              onClick={(e) => e.stopPropagation()}
              width="20px"
              height="20px"
              minW="20px"
              p={0}
              display="flex"
              alignItems="center"
              justifyContent="center"
            >
              <FiMoreVertical size={12} />
            </Button>
          </Menu.Trigger>
          <Portal>
            <Menu.Positioner>
              <Menu.Content bg="#161b22" borderColor="#30363d" color="#c9d1d9">
                {node.type === 'directory' && (
                  <>
                    <Menu.Item value="new-file" onClick={(e) => { e.stopPropagation(); handleCreate('file'); }} _hover={{ bg: 'rgba(88, 166, 255, 0.1)' }}>
                      <HStack gap={2}>
                        <FiFilePlus size={14} />
                        <span>New File</span>
                      </HStack>
                    </Menu.Item>
                    <Menu.Item value="new-directory" onClick={(e) => { e.stopPropagation(); handleCreate('directory'); }} _hover={{ bg: 'rgba(88, 166, 255, 0.1)' }}>
                      <HStack gap={2}>
                        <FiFolderPlus size={14} />
                        <span>New Folder</span>
                      </HStack>
                    </Menu.Item>
                    <Menu.Separator borderColor="#30363d" />
                  </>
                )}
                <Menu.Item value="copy" onClick={(e) => { e.stopPropagation(); handleCopy(); }} _hover={{ bg: 'rgba(88, 166, 255, 0.1)' }}>
                  <HStack gap={2}>
                    <FiCopy size={14} />
                    <span>Copy</span>
                  </HStack>
                </Menu.Item>
                <Menu.Item value="rename" onClick={(e) => { e.stopPropagation(); handleRename(); }} _hover={{ bg: 'rgba(88, 166, 255, 0.1)' }}>
                  <HStack gap={2}>
                    <FiEdit2 size={14} />
                    <span>Rename</span>
                  </HStack>
                </Menu.Item>
                <Menu.Item value="delete" onClick={(e) => { e.stopPropagation(); handleDelete(); }} _hover={{ bg: 'rgba(248, 81, 73, 0.1)' }}>
                  <HStack gap={2}>
                    <FiTrash2 size={14} />
                    <span>Delete</span>
                  </HStack>
                </Menu.Item>
              </Menu.Content>
            </Menu.Positioner>
          </Portal>
        </Menu.Root>
      </HStack>
      
      {/* Rename Modal */}
      <Dialog.Root open={isRenaming} onOpenChange={() => setIsRenaming(false)}>
        <Dialog.Backdrop bg="rgba(0, 0, 0, 0.8)" />
        <Dialog.Positioner>
          <Dialog.Content bg="#161b22" borderColor="#30363d" color="#c9d1d9">
            <Dialog.Header>
              <Dialog.Title>Rename {node.type}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Input
                ref={renameInputRef}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, confirmRename)}
                size="sm"
                bg="#0d1117"
                borderColor="#30363d"
                color="#c9d1d9"
                _focus={{ borderColor: '#58a6ff', boxShadow: '0 0 0 3px rgba(88, 166, 255, 0.1)' }}
              />
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" size="sm" onClick={() => setIsRenaming(false)} borderColor="#30363d" color="#c9d1d9" _hover={{ bg: 'rgba(255, 255, 255, 0.1)' }}>
                Cancel
              </Button>
              <Button colorPalette="blue" size="sm" onClick={confirmRename} ml={3} bg="#58a6ff" color="#0d1117" _hover={{ bg: '#58a6ff', transform: 'translateY(-2px)' }}>
                Rename
              </Button>
            </Dialog.Footer>
            <Dialog.CloseTrigger color="#8b949e" _hover={{ color: '#f85149' }} />
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
      
      {/* Create Modal */}
      <Dialog.Root open={isCreating} onOpenChange={() => setIsCreating(false)}>
        <Dialog.Backdrop bg="rgba(0, 0, 0, 0.8)" />
        <Dialog.Positioner>
          <Dialog.Content bg="#161b22" borderColor="#30363d" color="#c9d1d9">
            <Dialog.Header>
              <Dialog.Title>Create New {createType === 'file' ? 'File' : 'Folder'}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Input
                ref={createInputRef}
                placeholder={createType === 'file' ? 'filename.txt' : 'folder-name'}
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, confirmCreate)}
                size="sm"
                bg="#0d1117"
                borderColor="#30363d"
                color="#c9d1d9"
                _focus={{ borderColor: '#58a6ff', boxShadow: '0 0 0 3px rgba(88, 166, 255, 0.1)' }}
              />
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" size="sm" onClick={() => setIsCreating(false)} borderColor="#30363d" color="#c9d1d9" _hover={{ bg: 'rgba(255, 255, 255, 0.1)' }}>
                Cancel
              </Button>
              <Button colorPalette="blue" size="sm" onClick={confirmCreate} ml={3} bg="#58a6ff" color="#0d1117" _hover={{ bg: '#58a6ff', transform: 'translateY(-2px)' }}>
                Create
              </Button>
            </Dialog.Footer>
            <Dialog.CloseTrigger color="#8b949e" _hover={{ color: '#f85149' }} />
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
      
      {/* Copy Modal */}
      <Dialog.Root open={isCopying} onOpenChange={() => setIsCopying(false)}>
        <Dialog.Backdrop bg="rgba(0, 0, 0, 0.8)" />
        <Dialog.Positioner>
          <Dialog.Content bg="#161b22" borderColor="#30363d" color="#c9d1d9">
            <Dialog.Header>
              <Dialog.Title>Copy {node.name}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Input
                ref={copyInputRef}
                placeholder="Enter new name"
                value={copyDestination}
                onChange={(e) => setCopyDestination(e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, confirmCopy)}
                size="sm"
                bg="#0d1117"
                borderColor="#30363d"
                color="#c9d1d9"
                _focus={{ borderColor: '#58a6ff', boxShadow: '0 0 0 3px rgba(88, 166, 255, 0.1)' }}
              />
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" size="sm" onClick={() => setIsCopying(false)} borderColor="#30363d" color="#c9d1d9" _hover={{ bg: 'rgba(255, 255, 255, 0.1)' }}>
                Cancel
              </Button>
              <Button colorPalette="blue" size="sm" onClick={confirmCopy} ml={3} bg="#58a6ff" color="#0d1117" _hover={{ bg: '#58a6ff', transform: 'translateY(-2px)' }}>
                Copy
              </Button>
            </Dialog.Footer>
            <Dialog.CloseTrigger color="#8b949e" _hover={{ color: '#f85149' }} />
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
      
      {node.type === 'directory' && isExpanded && node.children && (
        <VStack align="stretch" gap={0} mt={0}>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              level={level + 1}
              onFileSelect={onFileSelect}
              setAlert={setAlert}
            />
          ))}
        </VStack>
      )}
    </Box>
  );
};

const FileTree: React.FC<FileTreeProps> = ({ 
  rootPath, 
  onFileSelect,
  onRefresh
}) => {
  const { root, loading, error, loadFileTree, refresh } = useFileTreeRepository();
  const fileWatcherRef = useRef(FileWatcherService.getInstance());
  const [alert, setAlert] = useState<AlertState>({ show: false, title: '', description: '', status: 'success' });

  useEffect(() => {
    if (alert.show) {
      const timer = setTimeout(() => {
        setAlert({ show: false, title: '', description: '', status: 'success' });
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [alert]);
  
  useEffect(() => {
    if (rootPath) {
      loadFileTree(rootPath);
      
      // Set up file system watching
      const setupWatching = async () => {
        try {
          await fileWatcherRef.current.watchDirectory(rootPath);
        } catch (error) {
          console.error('Failed to set up file watching:', error);
        }
      };
      
      setupWatching();
    }
    
    // Clean up watching when component unmounts
    return () => {
      fileWatcherRef.current.unwatchAll();
    };
  }, [rootPath, loadFileTree]);
  
  const handleRefresh = async () => {
    try {
      await refresh();
      if (onRefresh) onRefresh();
      setAlert({ show: true, title: 'Refreshed', description: 'File tree updated', status: 'success' });
    } catch (error) {
      setAlert({ show: true, title: 'Error', description: 'Failed to refresh file tree', status: 'error' });
    }
  };
  
  if (loading) {
    return (
      <Box p={3} bg="#0d1117" color="#c9d1d9">
        <Text fontSize="sm" color="#8b949e">Loading file tree...</Text>
      </Box>
    );
  }
  
  if (error) {
    return (
      <Box p={3} bg="#0d1117" color="#c9d1d9">
        <Text fontSize="sm" color="#f85149">Error: {error}</Text>
        <Button 
          mt={2} 
          size="xs" 
          variant="outline"
          onClick={handleRefresh}
          borderColor="#30363d"
          color="#c9d1d9"
          _hover={{ bg: 'rgba(255, 255, 255, 0.1)' }}
        >
          <HStack gap={2}>
            <FiRefreshCw size={12} />
            <span>Retry</span>
          </HStack>
        </Button>
      </Box>
    );
  }
  
  if (!root) {
    return (
      <Box p={3} bg="#0d1117" color="#c9d1d9">
        <Text fontSize="sm" color="#8b949e">No file tree available</Text>
        <Button 
          mt={2} 
          size="xs" 
          variant="outline"
          onClick={handleRefresh}
          borderColor="#30363d"
          color="#c9d1d9"
          _hover={{ bg: 'rgba(255, 255, 255, 0.1)' }}
        >
          <HStack gap={2}>
            <FiRefreshCw size={12} />
            <span>Refresh</span>
          </HStack>
        </Button>
      </Box>
    );
  }
  
  return (
    <VStack align="stretch" gap={0} p={2} bg="#0d1117" color="#c9d1d9">
      {alert.show && (
        <Alert.Root status={alert.status} mb={2} size="sm" bg={alert.status === 'success' ? 'rgba(46, 160, 67, 0.1)' : 'rgba(248, 81, 73, 0.1)'} borderColor={alert.status === 'success' ? 'rgba(46, 160, 67, 0.4)' : 'rgba(248, 81, 73, 0.4)'}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{alert.title}</Alert.Title>
            <Alert.Description>{alert.description}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      <HStack justify="space-between" mb={2} px={1}>
        <Text fontWeight="semibold" fontSize="sm" color="#c9d1d9">
          Explorer
        </Text>
        <HStack gap={1}>
          <Button
              aria-label="New"
              size="xs"
              variant="ghost"
              onClick={() => {
                // Default to creating a new file in the root
                const createNewFile = async () => {
                  const success = await useFileTreeRepository.getState().createFileOrDirectory(root.path, 'new-file.txt', false);
                  if (success) {
                    setAlert({ show: true, title: 'Success', description: 'Created new file', status: 'success' });
                  } else {
                    setAlert({ show: true, title: 'Error', description: 'Failed to create file', status: 'error' });
                  }
                };
                createNewFile();
              }}
              title="New file/folder"
              color="#8b949e"
              _hover={{ bg: 'rgba(255, 255, 255, 0.1)' }}
            >
              <FiPlus size={14} />
            </Button>
          <Button
              aria-label="Refresh"
              size="xs"
              variant="ghost"
              onClick={handleRefresh}
              title="Refresh"
              color="#8b949e"
              _hover={{ bg: 'rgba(255, 255, 255, 0.1)' }}
            >
              <FiRefreshCw size={14} />
            </Button>
        </HStack>
      </HStack>
      <TreeNode
        node={root}
        level={0}
        onFileSelect={onFileSelect}
        setAlert={setAlert}
      />
    </VStack>
  );
};

export default FileTree;