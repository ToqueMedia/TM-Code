/**
 * SHA-256 hash of a string, returned as hex.
 */
export async function hashString(input: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(input)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Short hash of a project path (first 16 hex chars of SHA-256).
 * Used for project-scoped storage directories.
 */
export async function hashProjectPath(projectPath: string): Promise<string> {
  return (await hashString(projectPath)).slice(0, 16)
}

/**
 * Hash of a file path (first 32 hex chars of SHA-256).
 * Used for safe filenames in checkpoint storage.
 */
export async function hashFilePath(filePath: string): Promise<string> {
  return (await hashString(filePath)).slice(0, 32)
}
