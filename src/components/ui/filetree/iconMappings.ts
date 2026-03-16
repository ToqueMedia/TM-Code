import React from 'react';
import { tokens } from '@/theme/tokens';

import {
  SiJavascript, SiReact, SiHtml5, SiCss, SiJson, SiMarkdown,
  SiPython, SiDocker, SiNpm, SiNodedotjs, SiGit,
  SiWebpack, SiVite, SiTailwindcss, SiSass, SiLess, SiStylus,
  SiYaml, SiGraphql, SiPrettier, SiEslint, SiJest, SiVitest,
  SiCypress, SiStorybook, SiBabel, SiPostcss, SiSvelte,
  SiVuedotjs, SiAngular, SiNextdotjs, SiNuxt, SiPrisma,
  SiVercel, SiNetlify, SiGithub, SiAndroid, SiIos, SiFlutter
} from 'react-icons/si';
import {
  FaFileImage, FaFilePdf, FaFileArchive, FaFile, FaFileCode,
  FaFileAlt, FaDatabase, FaCog, FaLock, FaKey, FaServer,
  FaMobile, FaDesktop, FaGem, FaCube, FaLayerGroup,
  FaPuzzlePiece, FaBook, FaCertificate, FaFileContract,
  FaClipboardList
} from 'react-icons/fa';
import {
  RiFolder3Fill, RiFolder3Line, RiFolderSettingsLine,
  RiFolderCloudLine, RiFolderMusicLine, RiFolderVideoLine,
  RiFolderImageLine, RiFolderOpenLine, RiFolderTransferLine,
  RiFolderWarningLine
} from 'react-icons/ri';
import TypeScriptIcon from '@/components/icons/TypeScriptIcon';

export type IconResult = { icon: React.ElementType; color: string };

const selected = tokens.colors.text.inverse;
const fi = tokens.colors.fileIcon;

/** Returns an icon+color for a well-known folder name, or null. */
export function getSpecialFolderIcon(
  name: string,
  isSelected: boolean,
): IconResult | null {
  const map: Record<string, IconResult> = {
    'node_modules':   { icon: SiNodedotjs,           color: isSelected ? selected : fi.nodeModules },
    'src':            { icon: RiFolder3Fill,          color: isSelected ? selected : fi.src },
    'public':         { icon: RiFolderOpenLine,       color: isSelected ? selected : fi.public },
    'assets':         { icon: RiFolderImageLine,      color: isSelected ? selected : fi.assets },
    'images':         { icon: RiFolderImageLine,      color: isSelected ? selected : fi.images },
    'components':     { icon: FaFileCode,             color: isSelected ? selected : fi.components },
    'pages':          { icon: FaFileCode,             color: isSelected ? selected : fi.pages },
    'hooks':          { icon: FaFileCode,             color: isSelected ? selected : fi.hooks },
    'services':       { icon: RiFolderCloudLine,      color: isSelected ? selected : fi.services },
    'utils':          { icon: RiFolderSettingsLine,    color: isSelected ? selected : fi.utils },
    'lib':            { icon: FaFileCode,             color: isSelected ? selected : fi.lib },
    'api':            { icon: RiFolderCloudLine,      color: isSelected ? selected : fi.api },
    'config':         { icon: RiFolderSettingsLine,    color: isSelected ? selected : fi.config },
    'styles':         { icon: RiFolderImageLine,      color: isSelected ? selected : fi.styles },
    'css':            { icon: RiFolderImageLine,      color: isSelected ? selected : fi.css },
    'sass':           { icon: RiFolderImageLine,      color: isSelected ? selected : fi.sass },
    'scss':           { icon: RiFolderImageLine,      color: isSelected ? selected : fi.sass },
    'less':           { icon: RiFolderImageLine,      color: isSelected ? selected : '#1d365d' },
    'docs':           { icon: FaBook,                 color: isSelected ? selected : fi.docs },
    'documentation':  { icon: FaBook,                 color: isSelected ? selected : fi.docs },
    'test':           { icon: RiFolderWarningLine,    color: isSelected ? selected : fi.test },
    'tests':          { icon: RiFolderWarningLine,    color: isSelected ? selected : fi.test },
    '__tests__':      { icon: RiFolderWarningLine,    color: isSelected ? selected : fi.test },
    'spec':           { icon: RiFolderWarningLine,    color: isSelected ? selected : fi.test },
    'specs':          { icon: RiFolderWarningLine,    color: isSelected ? selected : fi.test },
    'build':          { icon: RiFolderTransferLine,   color: isSelected ? selected : fi.build },
    'dist':           { icon: RiFolderTransferLine,   color: isSelected ? selected : fi.build },
    'out':            { icon: RiFolderTransferLine,   color: isSelected ? selected : fi.build },
    'output':         { icon: RiFolderTransferLine,   color: isSelected ? selected : fi.build },
    '.git':           { icon: SiGit,                  color: isSelected ? selected : fi.git },
    '.github':        { icon: SiGithub,               color: isSelected ? selected : fi.github },
    '.vscode':        { icon: FaFileCode,             color: isSelected ? selected : fi.vscode },
    '.next':          { icon: SiNextdotjs,            color: isSelected ? selected : fi.next },
    '.nuxt':          { icon: SiNuxt,            color: isSelected ? selected : fi.nuxt },
    'android':        { icon: SiAndroid,              color: isSelected ? selected : fi.android },
    'ios':            { icon: SiIos,                  color: isSelected ? selected : fi.ios },
    'mobile':         { icon: FaMobile,               color: isSelected ? selected : fi.generic },
    'desktop':        { icon: FaDesktop,              color: isSelected ? selected : fi.generic },
    'server':         { icon: FaServer,               color: isSelected ? selected : fi.generic },
    'database':       { icon: FaDatabase,             color: isSelected ? selected : fi.database },
    'security':       { icon: FaLock,                 color: isSelected ? selected : fi.security },
    'auth':           { icon: FaLock,                 color: isSelected ? selected : fi.auth },
    'middleware':     { icon: FaLayerGroup,            color: isSelected ? selected : fi.middleware },
    'plugins':        { icon: FaPuzzlePiece,          color: isSelected ? selected : fi.plugins },
    'vendor':         { icon: FaCube,                 color: isSelected ? selected : fi.vendor },
    'packages':       { icon: FaCube,                 color: isSelected ? selected : fi.vendor },
  };

  return map[name] ?? null;
}

/** Returns an icon+color for a well-known file name, or null. */
export function getSpecialFileIcon(
  name: string,
  isSelected: boolean,
): IconResult | null {
  const map: Record<string, IconResult> = {
    'package.json':          { icon: SiNpm,         color: isSelected ? selected : fi.npm },
    'package-lock.json':     { icon: SiNpm,         color: isSelected ? selected : fi.npm },
    'yarn.lock':             { icon: SiNpm,         color: isSelected ? selected : fi.yarn },
    'pnpm-lock.yaml':        { icon: SiNpm,         color: isSelected ? selected : fi.pnpm },
    'dockerfile':            { icon: SiDocker,      color: isSelected ? selected : fi.docker },
    'docker-compose.yml':    { icon: SiDocker,      color: isSelected ? selected : fi.docker },
    'docker-compose.yaml':   { icon: SiDocker,      color: isSelected ? selected : fi.docker },
    '.gitignore':            { icon: SiGit,         color: isSelected ? selected : fi.gitFile },
    '.gitattributes':        { icon: SiGit,         color: isSelected ? selected : fi.gitFile },
    'readme.md':             { icon: FaBook,        color: isSelected ? selected : fi.readme },
    'readme.txt':            { icon: FaBook,        color: isSelected ? selected : fi.readme },
    'changelog.md':          { icon: FaClipboardList, color: isSelected ? selected : '#2196f3' },
    'license':               { icon: FaCertificate, color: isSelected ? selected : '#ff9800' },
    'license.md':            { icon: FaCertificate, color: isSelected ? selected : '#ff9800' },
    'license.txt':           { icon: FaCertificate, color: isSelected ? selected : '#ff9800' },
    '.env':                  { icon: FaKey,         color: isSelected ? selected : '#ecd53f' },
    '.env.local':            { icon: FaKey,         color: isSelected ? selected : '#ecd53f' },
    '.env.development':      { icon: FaKey,         color: isSelected ? selected : '#4caf50' },
    '.env.production':       { icon: FaKey,         color: isSelected ? selected : '#f44336' },
    '.env.example':          { icon: FaKey,         color: isSelected ? selected : '#9e9e9e' },
    'tsconfig.json':         { icon: TypeScriptIcon, color: isSelected ? selected : '#3178C6' },
    'jsconfig.json':         { icon: SiJavascript,  color: isSelected ? selected : '#f7df1e' },
    'webpack.config.js':     { icon: SiWebpack,     color: isSelected ? selected : '#8dd6f9' },
    'vite.config.js':        { icon: SiVite,        color: isSelected ? selected : '#646cff' },
    'vite.config.ts':        { icon: SiVite,        color: isSelected ? selected : '#646cff' },
    'babel.config.js':       { icon: SiBabel,       color: isSelected ? selected : '#f9dc3e' },
    '.babelrc':              { icon: SiBabel,       color: isSelected ? selected : '#f9dc3e' },
    'postcss.config.js':     { icon: SiPostcss,     color: isSelected ? selected : '#dd3a0a' },
    'tailwind.config.js':    { icon: SiTailwindcss, color: isSelected ? selected : '#06b6d4' },
    'tailwind.config.ts':    { icon: SiTailwindcss, color: isSelected ? selected : '#06b6d4' },
    '.eslintrc.js':          { icon: SiEslint,      color: isSelected ? selected : '#4b32c3' },
    '.eslintrc.json':        { icon: SiEslint,      color: isSelected ? selected : '#4b32c3' },
    '.prettierrc':           { icon: SiPrettier,    color: isSelected ? selected : '#f7b93e' },
    'prettier.config.js':    { icon: SiPrettier,    color: isSelected ? selected : '#f7b93e' },
    'jest.config.js':        { icon: SiJest,        color: isSelected ? selected : '#c21325' },
    'jest.config.ts':        { icon: SiJest,        color: isSelected ? selected : '#c21325' },
    'vitest.config.js':      { icon: SiVitest,      color: isSelected ? selected : '#729b1b' },
    'vitest.config.ts':      { icon: SiVitest,      color: isSelected ? selected : '#729b1b' },
    'cypress.config.js':     { icon: SiCypress,     color: isSelected ? selected : '#17202c' },
    'cypress.config.ts':     { icon: SiCypress,     color: isSelected ? selected : '#17202c' },
    '.storybook/main.js':    { icon: SiStorybook,   color: isSelected ? selected : '#ff4785' },
    'next.config.js':        { icon: SiNextdotjs,   color: isSelected ? selected : fi.next },
    'nuxt.config.js':        { icon: SiNuxt,   color: isSelected ? selected : fi.nuxt },
    'nuxt.config.ts':        { icon: SiNuxt,   color: isSelected ? selected : fi.nuxt },
    'vercel.json':           { icon: SiVercel,      color: isSelected ? selected : '#000000' },
    'netlify.toml':          { icon: SiNetlify,     color: isSelected ? selected : '#00c7b7' },
  };

  return map[name] ?? null;
}

/** Returns an icon+color based on file extension. */
export function getExtensionIcon(
  ext: string | undefined,
  isSelected: boolean,
): IconResult {
  switch (ext?.toLowerCase()) {
    case 'js': case 'mjs':
      return { icon: SiJavascript, color: isSelected ? selected : '#f7df1e' };
    case 'jsx':
      return { icon: SiReact, color: isSelected ? selected : '#61dafb' };
    case 'ts': case 'tsx':
      return { icon: TypeScriptIcon, color: isSelected ? selected : '#3178C6' };
    case 'vue':
      return { icon: SiVuedotjs, color: isSelected ? selected : '#4fc08d' };
    case 'svelte':
      return { icon: SiSvelte, color: isSelected ? selected : '#ff3e00' };
    case 'angular':
      return { icon: SiAngular, color: isSelected ? selected : '#dd0031' };
    case 'css':
      return { icon: SiCss, color: isSelected ? selected : '#1572b6' };
    case 'scss': case 'sass':
      return { icon: SiSass, color: isSelected ? selected : '#cc6699' };
    case 'less':
      return { icon: SiLess, color: isSelected ? selected : '#1d365d' };
    case 'styl': case 'stylus':
      return { icon: SiStylus, color: isSelected ? selected : '#b3d107' };
    case 'html': case 'htm':
      return { icon: SiHtml5, color: isSelected ? selected : '#e34f26' };
    case 'xml': case 'xhtml':
      return { icon: FaFileCode, color: isSelected ? selected : '#ff6600' };
    case 'json':
      return { icon: SiJson, color: isSelected ? selected : '#ffd500' };
    case 'yml': case 'yaml':
      return { icon: SiYaml, color: isSelected ? selected : '#cb171e' };
    case 'toml':
      return { icon: FaCog, color: isSelected ? selected : '#9c4221' };
    case 'md': case 'markdown':
      return { icon: SiMarkdown, color: isSelected ? selected : '#083fa1' };
    case 'mdx':
      return { icon: SiMarkdown, color: isSelected ? selected : '#fcb32c' };
    case 'txt':
      return { icon: FaFileAlt, color: isSelected ? selected : '#607d8b' };
    case 'rtf':
      return { icon: FaFileAlt, color: isSelected ? selected : '#795548' };
    case 'py':
      return { icon: SiPython, color: isSelected ? selected : '#306998' };
    case 'rb':
      return { icon: FaGem, color: isSelected ? selected : '#cc342d' };
    case 'php':
      return { icon: FaFileCode, color: isSelected ? selected : '#777bb4' };
    case 'go':
      return { icon: FaFileCode, color: isSelected ? selected : '#00add8' };
    case 'rs':
      return { icon: FaFileCode, color: isSelected ? selected : '#dea584' };
    case 'java':
      return { icon: FaFileCode, color: isSelected ? selected : '#ed8b00' };
    case 'c':
      return { icon: FaFileCode, color: isSelected ? selected : '#a8b9cc' };
    case 'cpp': case 'cc': case 'cxx':
      return { icon: FaFileCode, color: isSelected ? selected : '#00599c' };
    case 'cs':
      return { icon: FaFileCode, color: isSelected ? selected : '#239120' };
    case 'swift':
      return { icon: FaFileCode, color: isSelected ? selected : '#fa7343' };
    case 'kt':
      return { icon: FaFileCode, color: isSelected ? selected : '#7f52ff' };
    case 'dart':
      return { icon: SiFlutter, color: isSelected ? selected : '#0175c2' };
    case 'graphql': case 'gql':
      return { icon: SiGraphql, color: isSelected ? selected : '#e10098' };
    case 'sql':
      return { icon: FaDatabase, color: isSelected ? selected : '#336791' };
    case 'db': case 'sqlite': case 'sqlite3':
      return { icon: FaDatabase, color: isSelected ? selected : '#003b57' };
    case 'prisma':
      return { icon: SiPrisma, color: isSelected ? selected : '#2d3748' };
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'bmp':
      return { icon: FaFileImage, color: isSelected ? selected : '#4caf50' };
    case 'svg':
      return { icon: FaFileImage, color: isSelected ? selected : '#ff9800' };
    case 'webp': case 'avif':
      return { icon: FaFileImage, color: isSelected ? selected : '#2196f3' };
    case 'ico': case 'icns':
      return { icon: FaFileImage, color: isSelected ? selected : '#9c27b0' };
    case 'mp4': case 'avi': case 'mkv': case 'mov': case 'webm':
      return { icon: RiFolderVideoLine, color: isSelected ? selected : '#f44336' };
    case 'mp3': case 'wav': case 'flac': case 'ogg':
      return { icon: RiFolderMusicLine, color: isSelected ? selected : '#e91e63' };
    case 'zip': case 'rar': case '7z':
      return { icon: FaFileArchive, color: isSelected ? selected : '#ff6f00' };
    case 'tar': case 'gz': case 'bz2':
      return { icon: FaFileArchive, color: isSelected ? selected : '#795548' };
    case 'pdf':
      return { icon: FaFilePdf, color: isSelected ? selected : '#f40f02' };
    case 'doc': case 'docx':
      return { icon: FaFileContract, color: isSelected ? selected : '#2b579a' };
    case 'xls': case 'xlsx':
      return { icon: FaFileContract, color: isSelected ? selected : '#217346' };
    case 'ppt': case 'pptx':
      return { icon: FaFileContract, color: isSelected ? selected : '#d24726' };
    case 'ini': case 'conf': case 'config':
      return { icon: FaCog, color: isSelected ? selected : '#6c757d' };
    case 'env':
      return { icon: FaKey, color: isSelected ? selected : '#ffc107' };
    case 'log':
      return { icon: FaFileAlt, color: isSelected ? selected : '#28a745' };
    case 'pem': case 'key': case 'crt': case 'cert':
      return { icon: FaLock, color: isSelected ? selected : '#dc3545' };
    default:
      return { icon: FaFile, color: isSelected ? selected : '#8e9297' };
  }
}

/** Default folder icon (expanded vs collapsed). */
export function getDefaultFolderIcon(isSelected: boolean, isExpanded: boolean): IconResult {
  return {
    icon: isExpanded ? RiFolder3Line : RiFolder3Fill,
    color: isSelected ? selected : fi.defaultFolder,
  };
}
