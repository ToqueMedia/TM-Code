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

// ── Session encryption (AES-256-GCM) ─────────────────────────────────
// Key derived from projectPath + home dir (user-specific on shared machines).

const SESSION_KEY_CACHE = new Map<string, CryptoKey>()

/** Safe binary→base64 that doesn't overflow the stack on large payloads. */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function deriveSessionKey(projectPath: string): Promise<CryptoKey> {
  const cached = SESSION_KEY_CACHE.get(projectPath)
  if (cached) return cached

  const encoder = new TextEncoder()
  // Include home dir as user-specific salt so two users with the same
  // project path on different accounts can't decrypt each other's sessions.
  let homeDir = ''
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    homeDir = await invoke<string>('get_home_directory')
  } catch { /* fallback: empty */ }
  const seed = `${homeDir}:${projectPath}`

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(seed),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode('toquemedia-studio-session-v2'),
      iterations: 100_000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  SESSION_KEY_CACHE.set(projectPath, key)
  return key
}

/**
 * Encrypt plaintext and return a JSON envelope (avoids prefix collision with plain JSON).
 * Format: `{"_enc":2,"d":"<base64(iv + ciphertext)>"}`
 */
export async function encryptSession(plaintext: string, projectPath: string): Promise<string> {
  const key = await deriveSessionKey(projectPath)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return JSON.stringify({ _enc: 2, d: uint8ToBase64(combined) })
}

/**
 * Decrypt a session produced by encryptSession.
 * Returns null for unencrypted (legacy) content or decryption failure.
 */
export async function decryptSession(encrypted: string, projectPath: string): Promise<string | null> {
  // Detect encrypted envelope — both v1 prefix and v2 JSON
  let b64Data: string | null = null

  if (encrypted.startsWith('ENC1:')) {
    // Legacy v1 format
    b64Data = encrypted.slice(5)
  } else {
    try {
      const parsed = JSON.parse(encrypted)
      if (parsed?._enc && parsed?.d) b64Data = parsed.d
    } catch { /* not JSON — plain text session */ }
  }

  if (!b64Data) return null // unencrypted legacy session — caller falls back to raw

  try {
    const key = await deriveSessionKey(projectPath)
    const raw = base64ToUint8(b64Data)
    const iv = raw.slice(0, 12)
    const ciphertext = raw.slice(12)
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    return new TextDecoder().decode(decrypted)
  } catch {
    return null
  }
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
