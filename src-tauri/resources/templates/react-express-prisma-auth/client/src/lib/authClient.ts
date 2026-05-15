// Auth helper. Owns the JWT lifecycle: storage, attach-to-request, auto-refresh.
//
// Design notes:
//   - sessionStorage (not localStorage) so tokens are gone when the tab closes
//   - single in-flight refresh promise to prevent thundering-herd refresh on
//     parallel 401s from multiple page-load fetches
//   - `setAuthToken` is mandatory after every successful proxy call — the
//     auth-proxy skill enforces this rule because skipping it makes the
//     subsequent /api/auth/sync call return 401
const TOKEN_KEY = '_auth_token'
const REFRESH_KEY = '_refresh_token'

export function setAuthToken(token: string | null, refreshToken?: string | null): void {
  if (token) sessionStorage.setItem(TOKEN_KEY, token)
  else sessionStorage.removeItem(TOKEN_KEY)
  if (refreshToken !== undefined) {
    if (refreshToken) sessionStorage.setItem(REFRESH_KEY, refreshToken)
    else sessionStorage.removeItem(REFRESH_KEY)
  }
}

export function getAuthToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY)
}

let refreshing: Promise<boolean> | null = null

async function tryRefresh(): Promise<boolean> {
  const rt = sessionStorage.getItem(REFRESH_KEY)
  if (!rt) return false
  const res = await fetch('/api/auth/proxy/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: rt }),
  })
  if (!res.ok) return false
  const data = (await res.json()) as { idToken?: string; refreshToken?: string }
  if (!data.idToken) return false
  setAuthToken(data.idToken, data.refreshToken)
  return true
}

export async function authFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const buildHeaders = (): Headers => {
    const h = new Headers(opts.headers)
    const token = getAuthToken()
    if (token) h.set('Authorization', `Bearer ${token}`)
    if (!h.has('Content-Type') && opts.body) h.set('Content-Type', 'application/json')
    return h
  }

  let res = await fetch(url, { ...opts, headers: buildHeaders() })
  if (res.status === 401 && sessionStorage.getItem(REFRESH_KEY)) {
    if (!refreshing) refreshing = tryRefresh()
    const ok = await refreshing
    refreshing = null
    if (ok) {
      res = await fetch(url, { ...opts, headers: buildHeaders() })
    }
  }
  return res
}
