export function cleanSecret(raw: unknown, authScheme: 'Bearer' | 'none'): string {
  if (typeof raw !== 'string') return ''

  let value = raw.trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim()
  }

  if (authScheme === 'Bearer') {
    value = value.replace(/^Bearer\s+/i, '').trim()
  }

  return value
}

export async function sha256Prefix(value: string, length = 10): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length)
}

export function secretHint(value: string): string {
  if (!value) return '<empty>'
  return value.length <= 6 ? `${value.slice(0, 2)}...` : `${value.slice(0, 4)}...${value.slice(-2)}`
}
