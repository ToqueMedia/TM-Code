import { useToastStore } from '../toastStore'

// Helper: reset the store to initial state before each test
function resetStore() {
  useToastStore.setState({ toasts: [] })
}

describe('toastStore', () => {
  beforeEach(() => {
    resetStore()
  })

  describe('initial state', () => {
    it('starts with no toasts', () => {
      expect(useToastStore.getState().toasts).toEqual([])
    })
  })

  describe('addToast', () => {
    it('adds a toast with correct type and message', () => {
      const id = useToastStore.getState().addToast('success', 'File saved')

      const toasts = useToastStore.getState().toasts
      expect(toasts).toHaveLength(1)
      expect(toasts[0].id).toBe(id)
      expect(toasts[0].type).toBe('success')
      expect(toasts[0].message).toBe('File saved')
      expect(toasts[0].createdAt).toBeGreaterThan(0)
    })

    it('creates error toast', () => {
      useToastStore.getState().addToast('error', 'Something failed')

      const toasts = useToastStore.getState().toasts
      expect(toasts[0].type).toBe('error')
      expect(toasts[0].message).toBe('Something failed')
    })

    it('creates warning toast', () => {
      useToastStore.getState().addToast('warning', 'Careful!')

      const toasts = useToastStore.getState().toasts
      expect(toasts[0].type).toBe('warning')
    })

    it('creates info toast', () => {
      useToastStore.getState().addToast('info', 'Update available')

      const toasts = useToastStore.getState().toasts
      expect(toasts[0].type).toBe('info')
    })

    it('returns a unique id for each toast', () => {
      const id1 = useToastStore.getState().addToast('info', 'First')
      const id2 = useToastStore.getState().addToast('info', 'Second')
      expect(id1).not.toBe(id2)
    })

    it('accumulates multiple toasts', () => {
      useToastStore.getState().addToast('info', 'First')
      useToastStore.getState().addToast('success', 'Second')
      useToastStore.getState().addToast('error', 'Third')

      expect(useToastStore.getState().toasts).toHaveLength(3)
    })
  })

  describe('removeToast', () => {
    it('removes a toast by id', () => {
      const id = useToastStore.getState().addToast('info', 'Will be removed')
      expect(useToastStore.getState().toasts).toHaveLength(1)

      useToastStore.getState().removeToast(id)
      expect(useToastStore.getState().toasts).toHaveLength(0)
    })

    it('only removes the targeted toast', () => {
      const id1 = useToastStore.getState().addToast('info', 'Keep me')
      const id2 = useToastStore.getState().addToast('error', 'Remove me')
      useToastStore.getState().addToast('success', 'Keep me too')

      useToastStore.getState().removeToast(id2)

      const toasts = useToastStore.getState().toasts
      expect(toasts).toHaveLength(2)
      expect(toasts.find(t => t.id === id1)).toBeDefined()
      expect(toasts.find(t => t.id === id2)).toBeUndefined()
    })

    it('does nothing when removing a non-existent id', () => {
      useToastStore.getState().addToast('info', 'Existing')
      useToastStore.getState().removeToast('non-existent-id')
      expect(useToastStore.getState().toasts).toHaveLength(1)
    })
  })
})
