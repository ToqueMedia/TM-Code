import { useAuthStore } from '../authStore'

// Helper: reset the store to initial state before each test
function resetStore() {
  useAuthStore.setState({
    user: null,
    isAuthenticated: false,
    isLoading: true,
    error: null,
  })
}

describe('authStore', () => {
  beforeEach(() => {
    resetStore()
  })

  describe('initial state', () => {
    it('has no user', () => {
      expect(useAuthStore.getState().user).toBeNull()
    })

    it('is not authenticated', () => {
      expect(useAuthStore.getState().isAuthenticated).toBe(false)
    })

    it('is loading on startup', () => {
      expect(useAuthStore.getState().isLoading).toBe(true)
    })

    it('has no error', () => {
      expect(useAuthStore.getState().error).toBeNull()
    })
  })

  describe('setUser', () => {
    it('sets the user and marks as authenticated', () => {
      const user = { uid: 'user-123', email: 'test@example.com', displayName: null, photoURL: null }
      useAuthStore.getState().setUser(user)

      const state = useAuthStore.getState()
      expect(state.user).toEqual(user)
      expect(state.isAuthenticated).toBe(true)
      expect(state.isLoading).toBe(false)
      expect(state.error).toBeNull()
    })

    it('clears user when set to null', () => {
      const user = { uid: 'user-123', email: 'test@example.com', displayName: null, photoURL: null }
      useAuthStore.getState().setUser(user)
      useAuthStore.getState().setUser(null)

      const state = useAuthStore.getState()
      expect(state.user).toBeNull()
      expect(state.isAuthenticated).toBe(false)
      expect(state.isLoading).toBe(false)
    })

    it('clears any previous error', () => {
      useAuthStore.getState().setError('Login failed')
      expect(useAuthStore.getState().error).toBe('Login failed')

      useAuthStore.getState().setUser({ uid: 'u1', email: null, displayName: null, photoURL: null })
      expect(useAuthStore.getState().error).toBeNull()
    })
  })

  describe('setError', () => {
    it('sets the error message', () => {
      useAuthStore.getState().setError('Invalid credentials')
      expect(useAuthStore.getState().error).toBe('Invalid credentials')
    })

    it('stops loading when error is set', () => {
      expect(useAuthStore.getState().isLoading).toBe(true)
      useAuthStore.getState().setError('Network error')
      expect(useAuthStore.getState().isLoading).toBe(false)
    })
  })

  describe('setLoading', () => {
    it('updates loading state', () => {
      useAuthStore.getState().setLoading(false)
      expect(useAuthStore.getState().isLoading).toBe(false)

      useAuthStore.getState().setLoading(true)
      expect(useAuthStore.getState().isLoading).toBe(true)
    })
  })

  describe('clear', () => {
    it('resets user and authentication state', () => {
      useAuthStore.getState().setUser({ uid: 'u1', email: 'a@b.com', displayName: null, photoURL: null })
      useAuthStore.getState().setError('some error')

      useAuthStore.getState().clear()

      const state = useAuthStore.getState()
      expect(state.user).toBeNull()
      expect(state.isAuthenticated).toBe(false)
      expect(state.error).toBeNull()
    })
  })
})
