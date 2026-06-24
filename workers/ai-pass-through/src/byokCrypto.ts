// AES-256-GCM at-rest encryption for Team BYOK provider keys.
//
// The team's API key is stored ENCRYPTED in the `team:{teamId}` KV value (the
// control-plane encrypts on publish; the data-plane decrypts on read) so a KV
// dump (e.g. the control-plane's list-all-kv script) never exposes raw keys.
// Both workers ship an identical copy of this module + share the
// `TEAM_BYOK_ENC_KEY` secret (base64 of 32 random bytes = AES-256).
//
// Ciphertext format: `tbk1:<base64url-nopad iv>:<base64url-nopad ciphertext>`.
// The `tbk1` tag versions the scheme so a future rotation can coexist.

const VERSION = 'tbk1'

function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64ToBytes(b64: string): Uint8Array {
  const norm = b64.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(norm)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(keyB64)
  if (raw.length !== 32) {
    throw new Error(`TEAM_BYOK_ENC_KEY must be base64 of 32 bytes (got ${raw.length})`)
  }
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** Encrypt a secret → `tbk1:iv:ct`. Used by the control-plane on publish. */
export async function encryptSecret(plaintext: string, keyB64: string): Promise<string> {
  const key = await importKey(keyB64)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext) as BufferSource,
  )
  return `${VERSION}:${bytesToB64(iv)}:${bytesToB64(new Uint8Array(ct))}`
}

/** True for values produced by encryptSecret (lets callers tolerate legacy/plain). */
export function isEncryptedSecret(value: string): boolean {
  return typeof value === 'string' && value.startsWith(`${VERSION}:`)
}

/** Decrypt a `tbk1:iv:ct` blob. Throws on a malformed blob or wrong key. */
export async function decryptSecret(blob: string, keyB64: string): Promise<string> {
  const parts = blob.split(':')
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new Error('malformed Team BYOK ciphertext')
  }
  const iv = b64ToBytes(parts[1])
  const ct = b64ToBytes(parts[2])
  const key = await importKey(keyB64)
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ct as BufferSource,
  )
  return new TextDecoder().decode(pt)
}
