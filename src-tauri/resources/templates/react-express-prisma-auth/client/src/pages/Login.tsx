import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useGoogleSignIn } from '../lib/useGoogleSignIn'
import { authFetch, setAuthToken } from '../lib/authClient'
import { useAuthStore, type User } from '../store/authStore'

export function Login(): JSX.Element {
  const navigate = useNavigate()
  const googleBtnRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useGoogleSignIn(googleBtnRef, {
    onSuccess: () => navigate('/dashboard'),
    onError: (err) => setError(err.message),
  })

  const handleEmailSignin = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const email = String(form.get('email') ?? '')
    const password = String(form.get('password') ?? '')
    setError(null)
    setSubmitting(true)
    try {
      const tokenRes = await fetch('/api/auth/proxy/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (!tokenRes.ok) {
        const body = (await tokenRes.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || 'Invalid email or password')
      }
      const tokens = (await tokenRes.json()) as { idToken: string; refreshToken: string }
      setAuthToken(tokens.idToken, tokens.refreshToken)
      const syncRes = await authFetch('/api/auth/sync', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      if (!syncRes.ok) throw new Error('Failed to load user data')
      const user = (await syncRes.json()) as User
      useAuthStore.getState().setUser(user)
      navigate('/dashboard')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: '4rem auto', fontFamily: 'system-ui' }}>
      <h1>Sign in</h1>
      <form onSubmit={handleEmailSignin}>
        <input name="email" type="email" placeholder="Email" required style={{ display: 'block', width: '100%', padding: 8, marginBottom: 8 }} />
        <input name="password" type="password" placeholder="Password" required style={{ display: 'block', width: '100%', padding: 8, marginBottom: 8 }} />
        <button type="submit" disabled={submitting} style={{ width: '100%', padding: 10 }}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <hr style={{ margin: '1.5rem 0' }} />
      <div ref={googleBtnRef} />
    </div>
  )
}
