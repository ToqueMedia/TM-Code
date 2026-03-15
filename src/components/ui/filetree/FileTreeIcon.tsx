import React from 'react';
import { Icon, Image } from '@chakra-ui/react';
import { getFileIconByExtension, getFolderIconByPath, getFolderIconByName } from '@/utils/iconMapper';
import {
  getSpecialFolderIcon,
  getSpecialFileIcon,
  getExtensionIcon,
  getDefaultFolderIcon,
} from './iconMappings';

interface FileTreeIconProps {
  type: 'file' | 'directory';
  extension?: string;
  fileName?: string;
  fullPath?: string;
  isSelected?: boolean;
  isExpanded?: boolean;
}

/** Resolves the icon + color for a given file or directory entry. */
function getMaterialIconAndColor(
  type: 'file' | 'directory',
  fileName: string | undefined,
  extension: string | undefined,
  isSelected: boolean,
  isExpanded: boolean,
): { icon: React.ElementType; color: string } {
  if (type === 'directory') {
    const name = fileName?.toLowerCase() ?? '';
    return getSpecialFolderIcon(name, isSelected) ?? getDefaultFolderIcon(isSelected, isExpanded);
  }

  const name = fileName?.toLowerCase() ?? '';
  return getSpecialFileIcon(name, isSelected) ?? getExtensionIcon(extension, isSelected);
}

const FileTreeIcon: React.FC<FileTreeIconProps> = ({
  type, extension, fileName, fullPath, isSelected, isExpanded,
}) => {
  // Prefer Material Icon Theme SVGs when available from local assets
  const materialUrl = type === 'directory'
    ? (getFolderIconByPath(fullPath, !!isExpanded) || getFolderIconByName(fileName, !!isExpanded))
    : getFileIconByExtension(extension, fileName);

  if (materialUrl) {
    return (
      <Image
        src={materialUrl}
        alt={fileName || extension || 'file'}
        boxSize="16px"
        mr={2}
        opacity={isSelected ? 1 : 0.95}
        filter={isSelected ? 'none' : 'saturate(1.05)'}
        transition="all 0.2s ease"
        _hover={{
          filter: 'brightness(1.05) saturate(1.2)',
          transform: 'scale(1.05)',
        }}
      />
    );
  }

  const { icon: IconComponent, color } = getMaterialIconAndColor(
    type, fileName, extension, !!isSelected, !!isExpanded,
  );

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

export default FileTreeIcon;
