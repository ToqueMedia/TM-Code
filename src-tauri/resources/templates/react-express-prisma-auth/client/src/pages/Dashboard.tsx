import { useAuthStore } from '../store/authStore'

export function Dashboard(): JSX.Element {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  return (
    <div style={{ maxWidth: 600, margin: '2rem auto', fontFamily: 'system-ui' }}>
      <h1>Dashboard</h1>
      <p>Welcome, {user?.name ?? user?.email}.</p>
      {user?.avatarUrl && (
        <img
          src={user.avatarUrl}
          alt={user.name ?? user.email}
          referrerPolicy="no-referrer"
          style={{ width: 64, height: 64, borderRadius: '50%' }}
        />
      )}
      <button onClick={logout} style={{ marginTop: 16, padding: 10 }}>
        Sign out
      </button>
    </div>
  )
}
