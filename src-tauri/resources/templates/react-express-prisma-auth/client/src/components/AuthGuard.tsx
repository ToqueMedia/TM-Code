import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'

interface AuthGuardProps {
  children: JSX.Element
}

export function AuthGuard({ children }: AuthGuardProps): JSX.Element {
  const user = useAuthStore((s) => s.user)
  const loading = useAuthStore((s) => s.loading)
  if (loading) return <p style={{ padding: 16 }}>Loading…</p>
  if (!user) return <Navigate to="/login" replace />
  return children
}
