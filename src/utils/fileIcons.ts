// Maps file extensions and special filenames to SVG icon paths from src/assets/icons/

const EXT_TO_ICON: Record<string, string> = {
  // JavaScript / TypeScript
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'react',
  ts: 'typescript',
  tsx: 'react_ts',
  // Web
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'sass',
  sass: 'sass',
  less: 'less',
  // Data
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  csv: 'document',
  // Markdown
  md: 'markdown',
  mdx: 'markdown',
  // Python
  py: 'python',
  pyw: 'python',
  pyx: 'python',
  // Rust
  rs: 'rust',
  // Go
  go: 'go',
  // Java / Kotlin
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  // C / C++
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  // Swift
  swift: 'swift',
  // Dart
  dart: 'dart',
  // PHP
  php: 'php',
  // Ruby
  rb: 'ruby',
  // Shell
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  // SQL
  sql: 'database',
  // GraphQL
  graphql: 'graphql',
  gql: 'graphql',
  // Docker
  dockerfile: 'docker',
  // Vue / Svelte / Angular
  vue: 'vue',
  svelte: 'svelte',
  // Prisma
  prisma: 'prisma',
  // Images
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  ico: 'image',
  bmp: 'image',
  svg: 'svg',
  // Video
  mp4: 'video',
  avi: 'video',
  mkv: 'video',
  mov: 'video',
  webm: 'video',
  // Audio
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  ogg: 'audio',
  // Fonts
  ttf: 'font',
  otf: 'font',
  woff: 'font',
  woff2: 'font',
  // Documents
  pdf: 'pdf',
  doc: 'document',
  docx: 'document',
  // Config
  ini: 'settings',
  conf: 'settings',
  config: 'settings',
  // Security
  pem: 'key',
  key: 'key',
  crt: 'certificate',
  cert: 'certificate',
  // Logs
  log: 'log',
  // Git
  gitignore: 'git',
  gitattributes: 'git',
  // Lock files
  lock: 'lock',
  // Astro
  astro: 'astro',
}

const FILENAME_TO_ICON: Record<string, string> = {
  'package.json': 'npm',
  'package-lock.json': 'npm',
  'yarn.lock': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  'dockerfile': 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  'readme.md': 'readme',
  'readme.txt': 'readme',
  'changelog.md': 'changelog',
  'license': 'certificate',
  'license.md': 'certificate',
  'license.txt': 'certificate',
  '.env': 'key',
  '.env.local': 'key',
  '.env.development': 'key',
  '.env.production': 'key',
  '.env.example': 'key',
  'tsconfig.json': 'typescript',
  'jsconfig.json': 'javascript',
  'vite.config.js': 'vite',
  'vite.config.ts': 'vite',
  'webpack.config.js': 'webpack',
  'babel.config.js': 'babel',
  '.babelrc': 'babel',
  'postcss.config.js': 'postcss',
  'tailwind.config.js': 'tailwindcss',
  'tailwind.config.ts': 'tailwindcss',
  '.eslintrc.js': 'eslint',
  '.eslintrc.json': 'eslint',
  '.prettierrc': 'prettier',
  'prettier.config.js': 'prettier',
  'jest.config.js': 'jest',
  'jest.config.ts': 'jest',
  'vitest.config.js': 'vitest',
  'vitest.config.ts': 'vitest',
  'next.config.js': 'next',
  'next.config.ts': 'next',
  'next.config.mjs': 'next',
  'nuxt.config.js': 'nuxt',
  'nuxt.config.ts': 'nuxt',
  '.storybook': 'storybook',
  'go.mod': 'go-mod',
  'go.sum': 'go-mod',
  'cargo.toml': 'rust',
  'cargo.lock': 'rust',
}

/**
 * Get the SVG icon path for a given file path.
 * Returns the import path relative to src/assets/icons/
 */
export function getFileIconName(filePath: string): string {
  const fileName = filePath.split('/').pop()?.toLowerCase() || ''

  // Check exact filename first
  const filenameIcon = FILENAME_TO_ICON[fileName]
  if (filenameIcon) return filenameIcon

  // Check extension
  const ext = fileName.includes('.') ? fileName.split('.').pop() || '' : ''
  const extIcon = EXT_TO_ICON[ext]
  if (extIcon) return extIcon

  // Check if it's a test file
  if (fileName.includes('.test.') || fileName.includes('.spec.')) {
    if (ext === 'ts' || ext === 'tsx') return 'test-ts'
    if (ext === 'js' || ext === 'jsx') return 'test-js'
  }

  return 'document'
}

/**
 * Get the full icon URL for use in <img> tags.
 */
export function getFileIconUrl(filePath: string): string {
  const iconName = getFileIconName(filePath)
  return new URL(`../assets/icons/${iconName}.svg`, import.meta.url).href
}
