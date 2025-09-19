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
  FiCopy
} from 'react-icons/fi';

// Import Material Icon Theme inspired icons
import {
  SiJavascript,
  SiReact,
  SiHtml5,
  SiCss3,
  SiJson,
  SiMarkdown,
  SiPython,
  SiDocker,
  SiNpm,
  SiNodedotjs,
  SiGit,
  SiWebpack,
  SiVite,
  SiTailwindcss,
  SiSass,
  SiLess,
  SiStylus,
  SiYaml,
  SiGraphql,
  SiPrettier,
  SiEslint,
  SiJest,
  SiVitest,
  SiCypress,
  SiStorybook,
  SiBabel,
  SiPostcss,
  SiSvelte,
  SiVuedotjs,
  SiAngular,
  SiNextdotjs,
  SiNuxtdotjs,
  SiPrisma,
  SiVercel,
  SiNetlify,
  SiGithub,
  SiAndroid,
  SiIos,
  SiFlutter
} from 'react-icons/si';
import {
  FaFileImage,
  FaFilePdf,
  FaFileArchive,
  FaFile,
  FaFileCode,
  FaFileAlt,
  FaDatabase,
  FaCog,
  FaLock,
  FaKey,
  FaServer,
  FaMobile,
  FaDesktop,
  FaGem,
  FaCube,
  FaLayerGroup,
  FaPuzzlePiece,
  FaBook,
  FaCertificate,
  FaFileContract,
  FaClipboardList
} from 'react-icons/fa';
import {
  RiFolder3Fill,
  RiFolder3Line,
  RiFolderSettingsLine,
  RiFolderCloudLine,
  RiFolderMusicLine,
  RiFolderVideoLine,
  RiFolderImageLine,
  RiFolderOpenLine,
  RiFolderTransferLine,
  RiFolderWarningLine
} from 'react-icons/ri';
import { useFileTreeRepository } from '../../stores/fileTreeStore';
import type { FileTreeNode } from '../../types/fileTree';
import FileWatcherService from '../../services/fileWatcherService';
import TypeScriptIcon from '../icons/TypeScriptIcon';

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

// Material Icon Theme inspired FileIcon component
const FileIcon: React.FC<{
  type: 'file' | 'directory';
  extension?: string;
  fileName?: string;
  isSelected?: boolean;
  isExpanded?: boolean;
}> = ({ type, extension, fileName, isSelected, isExpanded }) => {
  
  const getMaterialIconAndColor = () => {
    if (type === 'directory') {
      const name = fileName?.toLowerCase() || '';
      
      // Special folders with custom icons and colors
      const specialFolders: Record<string, { icon: any; color: string }> = {
        'node_modules': { icon: SiNodedotjs, color: isSelected ? 'white' : '#8cc84b' },
        'src': { icon: RiFolder3Fill, color: isSelected ? 'white' : '#42a5f5' },
        'public': { icon: RiFolderOpenLine, color: isSelected ? 'white' : '#66bb6a' },
        'assets': { icon: RiFolderImageLine, color: isSelected ? 'white' : '#ffa726' },
        'images': { icon: RiFolderImageLine, color: isSelected ? 'white' : '#ec407a' },
        'components': { icon: FaFileCode, color: isSelected ? 'white' : '#26c6da' },
        'pages': { icon: FaFileCode, color: isSelected ? 'white' : '#ab47bc' },
        'hooks': { icon: FaFileCode, color: isSelected ? 'white' : '#ef5350' },
        'services': { icon: RiFolderCloudLine, color: isSelected ? 'white' : '#42a5f5' },
        'utils': { icon: RiFolderSettingsLine, color: isSelected ? 'white' : '#78909c' },
        'lib': { icon: FaFileCode, color: isSelected ? 'white' : '#5c6bc0' },
        'api': { icon: RiFolderCloudLine, color: isSelected ? 'white' : '#26a69a' },
        'config': { icon: RiFolderSettingsLine, color: isSelected ? 'white' : '#ff7043' },
        'styles': { icon: RiFolderImageLine, color: isSelected ? 'white' : '#8d6e63' },
        'css': { icon: RiFolderImageLine, color: isSelected ? 'white' : '#1976d2' },
        'sass': { icon: RiFolderImageLine, color: isSelected ? 'white' : '#cf649a' },
        'scss': { icon: RiFolderImageLine, color: isSelected ? 'white' : '#cf649a' },
        'less': { icon: RiFolderImageLine, color: isSelected ? 'white' : '#1d365d' },
        'docs': { icon: FaBook, color: isSelected ? 'white' : '#43a047' },
        'documentation': { icon: FaBook, color: isSelected ? 'white' : '#43a047' },
        'test': { icon: RiFolderWarningLine, color: isSelected ? 'white' : '#f57c00' },
        'tests': { icon: RiFolderWarningLine, color: isSelected ? 'white' : '#f57c00' },
        '__tests__': { icon: RiFolderWarningLine, color: isSelected ? 'white' : '#f57c00' },
        'spec': { icon: RiFolderWarningLine, color: isSelected ? 'white' : '#f57c00' },
        'specs': { icon: RiFolderWarningLine, color: isSelected ? 'white' : '#f57c00' },
        'build': { icon: RiFolderTransferLine, color: isSelected ? 'white' : '#795548' },
        'dist': { icon: RiFolderTransferLine, color: isSelected ? 'white' : '#795548' },
        'out': { icon: RiFolderTransferLine, color: isSelected ? 'white' : '#795548' },
        'output': { icon: RiFolderTransferLine, color: isSelected ? 'white' : '#795548' },
        '.git': { icon: SiGit, color: isSelected ? 'white' : '#f05033' },
        '.github': { icon: SiGithub, color: isSelected ? 'white' : '#24292e' },
        '.vscode': { icon: FaFileCode, color: isSelected ? 'white' : '#007acc' },
        '.next': { icon: SiNextdotjs, color: isSelected ? 'white' : '#000000' },
        '.nuxt': { icon: SiNuxtdotjs, color: isSelected ? 'white' : '#00c58e' },
        'android': { icon: SiAndroid, color: isSelected ? 'white' : '#3ddc84' },
        'ios': { icon: SiIos, color: isSelected ? 'white' : '#000000' },
        'mobile': { icon: FaMobile, color: isSelected ? 'white' : '#607d8b' },
        'desktop': { icon: FaDesktop, color: isSelected ? 'white' : '#607d8b' },
        'server': { icon: FaServer, color: isSelected ? 'white' : '#607d8b' },
        'database': { icon: FaDatabase, color: isSelected ? 'white' : '#4caf50' },
        'security': { icon: FaLock, color: isSelected ? 'white' : '#f44336' },
        'auth': { icon: FaLock, color: isSelected ? 'white' : '#ff9800' },
        'middleware': { icon: FaLayerGroup, color: isSelected ? 'white' : '#9c27b0' },
        'plugins': { icon: FaPuzzlePiece, color: isSelected ? 'white' : '#00bcd4' },
        'vendor': { icon: FaCube, color: isSelected ? 'white' : '#607d8b' },
        'packages': { icon: FaCube, color: isSelected ? 'white' : '#607d8b' }
      };
      
      if (specialFolders[name]) {
        return specialFolders[name];
      }
      
      // Default folder icon
      return {
        icon: isExpanded ? RiFolder3Line : RiFolder3Fill,
        color: isSelected ? 'white' : '#90caf9'
      };
    }
    
    // Files
    const ext = extension?.toLowerCase();
    const name = fileName?.toLowerCase() || '';
    
    // Special files with custom icons and vibrant colors
    const specialFiles: Record<string, { icon: any; color: string }> = {
      'package.json': { icon: SiNpm, color: isSelected ? 'white' : '#cc3534' },
      'package-lock.json': { icon: SiNpm, color: isSelected ? 'white' : '#cc3534' },
      'yarn.lock': { icon: SiNpm, color: isSelected ? 'white' : '#2c8ebb' },
      'pnpm-lock.yaml': { icon: SiNpm, color: isSelected ? 'white' : '#f69220' },
      'dockerfile': { icon: SiDocker, color: isSelected ? 'white' : '#0db7ed' },
      'docker-compose.yml': { icon: SiDocker, color: isSelected ? 'white' : '#0db7ed' },
      'docker-compose.yaml': { icon: SiDocker, color: isSelected ? 'white' : '#0db7ed' },
      '.gitignore': { icon: SiGit, color: isSelected ? 'white' : '#f05033' },
      '.gitattributes': { icon: SiGit, color: isSelected ? 'white' : '#f05033' },
      'readme.md': { icon: FaBook, color: isSelected ? 'white' : '#4caf50' },
      'readme.txt': { icon: FaBook, color: isSelected ? 'white' : '#4caf50' },
      'changelog.md': { icon: FaClipboardList, color: isSelected ? 'white' : '#2196f3' },
      'license': { icon: FaCertificate, color: isSelected ? 'white' : '#ff9800' },
      'license.md': { icon: FaCertificate, color: isSelected ? 'white' : '#ff9800' },
      'license.txt': { icon: FaCertificate, color: isSelected ? 'white' : '#ff9800' },
      '.env': { icon: FaKey, color: isSelected ? 'white' : '#ecd53f' },
      '.env.local': { icon: FaKey, color: isSelected ? 'white' : '#ecd53f' },
      '.env.development': { icon: FaKey, color: isSelected ? 'white' : '#4caf50' },
      '.env.production': { icon: FaKey, color: isSelected ? 'white' : '#f44336' },
      '.env.example': { icon: FaKey, color: isSelected ? 'white' : '#9e9e9e' },
      'tsconfig.json': { icon: TypeScriptIcon, color: isSelected ? 'white' : '#3178C6' },
      'jsconfig.json': { icon: SiJavascript, color: isSelected ? 'white' : '#f7df1e' },
      'webpack.config.js': { icon: SiWebpack, color: isSelected ? 'white' : '#8dd6f9' },
      'vite.config.js': { icon: SiVite, color: isSelected ? 'white' : '#646cff' },
      'vite.config.ts': { icon: SiVite, color: isSelected ? 'white' : '#646cff' },
      'babel.config.js': { icon: SiBabel, color: isSelected ? 'white' : '#f9dc3e' },
      '.babelrc': { icon: SiBabel, color: isSelected ? 'white' : '#f9dc3e' },
      'postcss.config.js': { icon: SiPostcss, color: isSelected ? 'white' : '#dd3a0a' },
      'tailwind.config.js': { icon: SiTailwindcss, color: isSelected ? 'white' : '#06b6d4' },
      'tailwind.config.ts': { icon: SiTailwindcss, color: isSelected ? 'white' : '#06b6d4' },
      '.eslintrc.js': { icon: SiEslint, color: isSelected ? 'white' : '#4b32c3' },
      '.eslintrc.json': { icon: SiEslint, color: isSelected ? 'white' : '#4b32c3' },
      '.prettierrc': { icon: SiPrettier, color: isSelected ? 'white' : '#f7b93e' },
      'prettier.config.js': { icon: SiPrettier, color: isSelected ? 'white' : '#f7b93e' },
      'jest.config.js': { icon: SiJest, color: isSelected ? 'white' : '#c21325' },
      'jest.config.ts': { icon: SiJest, color: isSelected ? 'white' : '#c21325' },
      'vitest.config.js': { icon: SiVitest, color: isSelected ? 'white' : '#729b1b' },
      'vitest.config.ts': { icon: SiVitest, color: isSelected ? 'white' : '#729b1b' },
      'cypress.config.js': { icon: SiCypress, color: isSelected ? 'white' : '#17202c' },
      'cypress.config.ts': { icon: SiCypress, color: isSelected ? 'white' : '#17202c' },
      '.storybook/main.js': { icon: SiStorybook, color: isSelected ? 'white' : '#ff4785' },
      'next.config.js': { icon: SiNextdotjs, color: isSelected ? 'white' : '#000000' },
      'nuxt.config.js': { icon: SiNuxtdotjs, color: isSelected ? 'white' : '#00c58e' },
      'nuxt.config.ts': { icon: SiNuxtdotjs, color: isSelected ? 'white' : '#00c58e' },
      'vercel.json': { icon: SiVercel, color: isSelected ? 'white' : '#000000' },
      'netlify.toml': { icon: SiNetlify, color: isSelected ? 'white' : '#00c7b7' },
    };
    
    // Check special files first
    if (specialFiles[name]) {
      return specialFiles[name];
    }
    
    // Extension-based icons with more specific colors
    switch (ext) {
      // JavaScript & TypeScript
      case 'js':
        return { icon: SiJavascript, color: isSelected ? 'white' : '#f7df1e' };
      case 'mjs':
        return { icon: SiJavascript, color: isSelected ? 'white' : '#f7df1e' };
      case 'jsx':
        return { icon: SiReact, color: isSelected ? 'white' : '#61dafb' };
      case 'ts':
        return { icon: TypeScriptIcon, color: isSelected ? 'white' : '#3178C6' };
      case 'tsx':
        return { icon: TypeScriptIcon, color: isSelected ? 'white' : '#3178C6' };
      case 'vue':
        return { icon: SiVuedotjs, color: isSelected ? 'white' : '#4fc08d' };
      case 'svelte':
        return { icon: SiSvelte, color: isSelected ? 'white' : '#ff3e00' };
      case 'angular':
        return { icon: SiAngular, color: isSelected ? 'white' : '#dd0031' };
      
      // Styles
      case 'css':
        return { icon: SiCss3, color: isSelected ? 'white' : '#1572b6' };
      case 'scss':
      case 'sass':
        return { icon: SiSass, color: isSelected ? 'white' : '#cc6699' };
      case 'less':
        return { icon: SiLess, color: isSelected ? 'white' : '#1d365d' };
      case 'styl':
      case 'stylus':
        return { icon: SiStylus, color: isSelected ? 'white' : '#b3d107' };
      
      // Markup & Data
      case 'html':
      case 'htm':
        return { icon: SiHtml5, color: isSelected ? 'white' : '#e34f26' };
      case 'xml':
      case 'xhtml':
        return { icon: FaFileCode, color: isSelected ? 'white' : '#ff6600' };
      case 'json':
        return { icon: SiJson, color: isSelected ? 'white' : '#ffd500' };
      case 'yml':
      case 'yaml':
        return { icon: SiYaml, color: isSelected ? 'white' : '#cb171e' };
      case 'toml':
        return { icon: FaCog, color: isSelected ? 'white' : '#9c4221' };
      
      // Documentation
      case 'md':
      case 'markdown':
        return { icon: SiMarkdown, color: isSelected ? 'white' : '#083fa1' };
      case 'mdx':
        return { icon: SiMarkdown, color: isSelected ? 'white' : '#fcb32c' };
      case 'txt':
        return { icon: FaFileAlt, color: isSelected ? 'white' : '#607d8b' };
      case 'rtf':
        return { icon: FaFileAlt, color: isSelected ? 'white' : '#795548' };
      
      // Programming Languages
      case 'py':
        return { icon: SiPython, color: isSelected ? 'white' : '#306998' };
      case 'rb':
        return { icon: FaGem, color: isSelected ? 'white' : '#cc342d' };
      case 'php':
        return { icon: FaFileCode, color: isSelected ? 'white' : '#777bb4' };
      case 'go':
        return { icon: FaFileCode, color: isSelected ? 'white' : '#00add8' };
      case 'rs':
        return { icon: FaFileCode, color: isSelected ? 'white' : '#dea584' };
      case 'java':
        return { icon: FaFileCode, color: isSelected ? 'white' : '#ed8b00' };
      case 'c':
        return { icon: FaFileCode, color: isSelected ? 'white' : '#a8b9cc' };
      case 'cpp':
      case 'cc':
      case 'cxx':
        return { icon: FaFileCode, color: isSelected ? 'white' : '#00599c' };
      case 'cs':
        return { icon: FaFileCode, color: isSelected ? 'white' : '#239120' };
      case 'swift':
        return { icon: FaFileCode, color: isSelected ? 'white' : '#fa7343' };
      case 'kt':
        return { icon: FaFileCode, color: isSelected ? 'white' : '#7f52ff' };
      case 'dart':
        return { icon: SiFlutter, color: isSelected ? 'white' : '#0175c2' };
      
      // GraphQL & API
      case 'graphql':
      case 'gql':
        return { icon: SiGraphql, color: isSelected ? 'white' : '#e10098' };
      
      // Databases
      case 'sql':
        return { icon: FaDatabase, color: isSelected ? 'white' : '#336791' };
      case 'db':
      case 'sqlite':
      case 'sqlite3':
        return { icon: FaDatabase, color: isSelected ? 'white' : '#003b57' };
      case 'prisma':
        return { icon: SiPrisma, color: isSelected ? 'white' : '#2d3748' };
      
      // Images
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'bmp':
        return { icon: FaFileImage, color: isSelected ? 'white' : '#4caf50' };
      case 'svg':
        return { icon: FaFileImage, color: isSelected ? 'white' : '#ff9800' };
      case 'webp':
      case 'avif':
        return { icon: FaFileImage, color: isSelected ? 'white' : '#2196f3' };
      case 'ico':
      case 'icns':
        return { icon: FaFileImage, color: isSelected ? 'white' : '#9c27b0' };
      
      // Videos & Audio
      case 'mp4':
      case 'avi':
      case 'mkv':
      case 'mov':
      case 'webm':
        return { icon: RiFolderVideoLine, color: isSelected ? 'white' : '#f44336' };
      case 'mp3':
      case 'wav':
      case 'flac':
      case 'ogg':
        return { icon: RiFolderMusicLine, color: isSelected ? 'white' : '#e91e63' };
      
      // Archives
      case 'zip':
      case 'rar':
      case '7z':
        return { icon: FaFileArchive, color: isSelected ? 'white' : '#ff6f00' };
      case 'tar':
      case 'gz':
      case 'bz2':
        return { icon: FaFileArchive, color: isSelected ? 'white' : '#795548' };
      
      // Documents
      case 'pdf':
        return { icon: FaFilePdf, color: isSelected ? 'white' : '#f40f02' };
      case 'doc':
      case 'docx':
        return { icon: FaFileContract, color: isSelected ? 'white' : '#2b579a' };
      case 'xls':
      case 'xlsx':
        return { icon: FaFileContract, color: isSelected ? 'white' : '#217346' };
      case 'ppt':
      case 'pptx':
        return { icon: FaFileContract, color: isSelected ? 'white' : '#d24726' };
      
      // Configuration & Environment
      case 'ini':
      case 'conf':
      case 'config':
        return { icon: FaCog, color: isSelected ? 'white' : '#6c757d' };
      case 'env':
        return { icon: FaKey, color: isSelected ? 'white' : '#ffc107' };
      case 'log':
        return { icon: FaFileAlt, color: isSelected ? 'white' : '#28a745' };
      
      // Security
      case 'pem':
      case 'key':
      case 'crt':
      case 'cert':
        return { icon: FaLock, color: isSelected ? 'white' : '#dc3545' };
      
      // Default fallback
      default:
        return {
          icon: FaFile,
          color: isSelected ? 'white' : '#8e9297'
        };
    }
  };
  
  const { icon: IconComponent, color } = getMaterialIconAndColor();
  
  return (
    <Icon
      as={IconComponent}
      color={color}
      fontSize="16px"
      mr={2}
      filter={isSelected ? 'none' : 'brightness(0.9) saturate(1.1)'}
      transition="all 0.2s ease"
      _hover={{
        filter: 'brightness(1.1) saturate(1.2)',
        transform: 'scale(1.05)',
      }}
    />
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
        py={0}
        pl={level * 8 + 4}
        pr={2}
        bg={isSelected ? 'rgba(9, 71, 113, 0.31)' : 'transparent'}
        color={isSelected ? '#ffffff' : '#cccccc'}
        _hover={{ bg: isSelected ? 'rgba(9, 71, 113, 0.31)' : 'rgba(255, 255, 255, 0.04)' }}
        cursor="pointer"
        onClick={handleSelect}
        borderRadius={0}
        position="relative"
        gap={0}
        minHeight="22px"
        alignItems="center"
        minW="max-content"
        w="100%"
      >
        {node.type === 'directory' ? (
          <Icon 
            as={isExpanded ? FiChevronDown : FiChevronRight} 
            onClick={handleToggle}
            cursor="pointer"
            fontSize="10px"
            color={isSelected ? '#ffffff' : '#cccccc'}
            width="16px"
            height="16px"
            display="flex"
            alignItems="center"
            justifyContent="center"
            mr={1}
          />
        ) : (
          <Box width="17px" />
        )}
        
        <FileIcon
          type={node.type}
          extension={node.extension}
          fileName={node.name}
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
            color={isSelected ? 'white' : '#cccccc'}
            bg={isSelected ? '#37415A' : 'transparent'}
            flex={1}
            px={1}
            py={0}
            height="20px"
            fontSize="sm"
          />
        ) : (
          <Text 
            fontSize="13px" 
            flex={1} 
            lineClamp={1}
            color={isSelected ? '#ffffff' : '#cccccc'}
            fontWeight="400"
            fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif"
            letterSpacing="0.02em"
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
        <Dialog.Backdrop bg="blackAlpha.800" />
        <Dialog.Positioner>
          <Dialog.Content 
            bg="bg.panel" 
            borderColor="border" 
            color="fg"
            shadow="xl"
            borderRadius="lg"
            maxW="400px"
          >
            <Dialog.Header pb={3}>
              <Dialog.Title fontSize="lg" fontWeight="600">
                Create New {createType === 'file' ? 'File' : 'Folder'}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body py={4}>
              <Input
                ref={createInputRef}
                placeholder={createType === 'file' ? 'filename.txt' : 'folder-name'}
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, confirmCreate)}
                size="md"
                bg="bg"
                borderColor="border"
                color="fg"
                _focus={{ 
                  borderColor: 'blue.emphasized', 
                  boxShadow: '0 0 0 1px var(--chakra-colors-blue-emphasized)'
                }}
              />
            </Dialog.Body>
            <Dialog.Footer pt={4}>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => setIsCreating(false)} 
                borderColor="border" 
                color="fg.muted" 
                _hover={{ bg: 'bg.muted', color: 'fg' }}
              >
                Cancel
              </Button>
              <Button 
                colorPalette="blue" 
                size="sm" 
                onClick={confirmCreate} 
                ml={3}
                bg="blue.solid" 
                color="blue.contrast" 
                _hover={{ bg: 'blue.emphasized' }}
              >
                Create
              </Button>
            </Dialog.Footer>
            <Dialog.CloseTrigger 
              color="fg.muted" 
              _hover={{ color: 'red.solid' }}
            />
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
      
      {/* Copy Modal */}
      <Dialog.Root open={isCopying} onOpenChange={() => setIsCopying(false)}>
        <Dialog.Backdrop bg="blackAlpha.800" />
        <Dialog.Positioner>
          <Dialog.Content 
            bg="bg.panel" 
            borderColor="border" 
            color="fg"
            shadow="xl"
            borderRadius="lg"
            maxW="400px"
          >
            <Dialog.Header pb={3}>
              <Dialog.Title fontSize="lg" fontWeight="600">
                Copy {node.name}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body py={4}>
              <Input
                ref={copyInputRef}
                placeholder="Enter new name"
                value={copyDestination}
                onChange={(e) => setCopyDestination(e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, confirmCopy)}
                size="md"
                bg="bg"
                borderColor="border"
                color="fg"
                _focus={{ 
                  borderColor: 'blue.emphasized', 
                  boxShadow: '0 0 0 1px var(--chakra-colors-blue-emphasized)'
                }}
              />
            </Dialog.Body>
            <Dialog.Footer pt={4}>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => setIsCopying(false)} 
                borderColor="border" 
                color="fg.muted" 
                _hover={{ bg: 'bg.muted', color: 'fg' }}
              >
                Cancel
              </Button>
              <Button 
                colorPalette="blue" 
                size="sm" 
                onClick={confirmCopy} 
                ml={3}
                bg="blue.solid" 
                color="blue.contrast" 
                _hover={{ bg: 'blue.emphasized' }}
              >
                Copy
              </Button>
            </Dialog.Footer>
            <Dialog.CloseTrigger 
              color="fg.muted" 
              _hover={{ color: 'red.solid' }}
            />
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
      
      {node.type === 'directory' && isExpanded && node.children && (
        <VStack 
          align="stretch" 
          gap={0} 
          mt={1}
        >
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              level={level + 0.5}
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
      <Box p={3} bg="#252526" color="#cccccc">
        <Text fontSize="sm" color="#8b949e">Loading file tree...</Text>
      </Box>
    );
  }
  
  if (error) {
    return (
      <Box p={3} bg="#252526" color="#cccccc">
        <Text fontSize="sm" color="#f85149">Error: {error}</Text>
        <Button 
          mt={2} 
          size="xs" 
          variant="outline"
          onClick={handleRefresh}
          borderColor="#30363d"
          color="#cccccc"
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
      <Box p={3} bg="#252526" color="#cccccc">
        <Text fontSize="sm" color="#8b949e">No file tree available</Text>
        <Button 
          mt={2} 
          size="xs" 
          variant="outline"
          onClick={handleRefresh}
          borderColor="#30363d"
          color="#cccccc"
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
    <Box
      className="vscode-sidebar"
      bg="#252526" 
      color="#cccccc"
      height="100%"
      overflow="hidden"
    >
      {alert.show && (
        <Alert.Root 
          status={alert.status} 
          mb={2} 
          size="sm" 
          bg={alert.status === 'success' ? 'rgba(46, 160, 67, 0.1)' : 'rgba(248, 81, 73, 0.1)'} 
          borderColor={alert.status === 'success' ? 'rgba(46, 160, 67, 0.4)' : 'rgba(248, 81, 73, 0.4)'}
          mx={2}
          mt={2}
        >
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{alert.title}</Alert.Title>
            <Alert.Description>{alert.description}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      
      <Box 
        flex={1} 
        overflowY="auto" 
        overflowX="auto"
        pt={1}
        minW="100%"
      >
        <TreeNode
          node={root}
          level={0}
          onFileSelect={onFileSelect}
          setAlert={setAlert}
        />
      </Box>
    </Box>
  );
};

export default FileTree;