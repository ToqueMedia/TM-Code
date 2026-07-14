/**
 * Binary file extensions to skip for text-based read_file operations.
 *
 * Mirrors claude-vaz `constants/files.ts` BINARY_EXTENSIONS. read_file is a
 * text tool — these files can't be meaningfully read as text and would either
 * fail UTF-8 decoding in Rust (current post-read behaviour) or, worse, return
 * garbage. Rejecting by extension up-front (pre-read) matches claude-vaz and
 * gives the model a clear, short error instead of a decode failure.
 *
 * claude-vaz exempts PDF/image/notebook paths because its FileReadTool has
 * dedicated multimodal handlers for those. The TM read_file is text-only
 * (Rust read_to_string), so it rejects all binary extensions unconditionally.
 */
export const BINARY_EXTENSIONS = new Set<string>([
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.tiff',
  '.tif',
  // Videos
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.wmv',
  '.flv',
  '.m4v',
  '.mpeg',
  '.mpg',
  // Audio
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.aac',
  '.m4a',
  '.wma',
  '.aiff',
  '.opus',
  // Archives
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.rar',
  '.xz',
  '.z',
  '.tgz',
  '.iso',
  // Executables/binaries
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.o',
  '.a',
  '.obj',
  '.lib',
  '.app',
  '.msi',
  '.deb',
  '.rpm',
  // Documents
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  // Fonts
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  // Bytecode / VM artifacts
  '.pyc',
  '.pyo',
  '.class',
  '.jar',
  '.war',
  '.ear',
  '.node',
  '.wasm',
  '.rlib',
  // Database files
  '.sqlite',
  '.sqlite3',
  '.db',
  '.mdb',
  '.idx',
  // Design / 3D
  '.psd',
  '.ai',
  '.eps',
  '.sketch',
  '.fig',
  '.xd',
  '.blend',
  '.3ds',
  '.max',
  // Flash
  '.swf',
  '.fla',
  // Lock/profiling data
  '.lockb',
  '.dat',
  '.data',
])

/**
 * Check if a file path has a binary extension. Mirrors claude-vaz
 * `hasBinaryExtension`. Returns true for extensionless paths whose last
 * `.` produces a match (e.g. "foo.sqlite"); returns false when there is no
 * dot at all (handled by the Rust UTF-8 decode check downstream).
 */
export function hasBinaryExtension(filePath: string): boolean {
  const lastDot = filePath.lastIndexOf('.')
  if (lastDot === -1) return false
  const ext = filePath.slice(lastDot).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}
