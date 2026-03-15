// src/stores/toastStore.ts — Toast notification state management

import { create } from 'zustand'

export type ToastType = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: string
  type: ToastType
  message: string
  createdAt: number
}

interface ToastState {
  toasts: Toast[]
  addToast: (type: ToastType, message: string, durationMs?: number) => string
  removeToast: (id: string) => void
}

const MAX_VISIBLE_TOASTS = 5
const DEFAULT_DURATION_MS = 5000
const ERROR_DURATION_MS = 10000

let nextId = 1
const autoRemoveTimers = new Map<string, ReturnType<typeof setTimeout>>()

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  addToast: (type, message, durationMs?) => {
    const id = `toast-${nextId++}`
    const toast: Toast = {
      id,
      type,
      message,
      createdAt: Date.now(),
    }

    set((state) => {
      const updated = [...state.toasts, toast]
      // Evict oldest toasts beyond max visible limit
      if (updated.length > MAX_VISIBLE_TOASTS) {
        const evicted = updated.slice(0, updated.length - MAX_VISIBLE_TOASTS)
        for (const t of evicted) {
          const timer = autoRemoveTimers.get(t.id)
          if (timer) { clearTimeout(timer); autoRemoveTimers.delete(t.id) }
        }
        return { toasts: updated.slice(-MAX_VISIBLE_TOASTS) }
      }
      return { toasts: updated }
    })

    // Auto-remove after duration
    const duration = durationMs ?? (type === 'error' ? ERROR_DURATION_MS : DEFAULT_DURATION_MS)
    const timer = setTimeout(() => {
      autoRemoveTimers.delete(id)
      get().removeToast(id)
    }, duration)
    autoRemoveTimers.set(id, timer)

    return id
  },

  removeToast: (id) => {
    const timer = autoRemoveTimers.get(id)
    if (timer) { clearTimeout(timer); autoRemoveTimers.delete(id) }
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
  },
}))
