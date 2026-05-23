import { create } from 'zustand'

// ─── Types ───

export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

export interface PendingAskUserQuestion {
  id: string
  questions: Question[]
  resolve: (answers: Record<string, string | string[]>) => void
}

// ─── State shape ───

interface AskUserQuestionState {
  pending: Map<string, PendingAskUserQuestion>
}

interface AskUserQuestionActions {
  /**
   * Open an interactive question form in the chat/terminal.
   * Returns the synchronously-generated request id and a promise that
   * resolves when the user submits all answers.
   */
  request: (questions: Question[]) => {
    id: string
    promise: Promise<Record<string, string | string[]>>
  }
  submit: (id: string, answers: Record<string, string | string[]>) => void
  cancel: (id: string) => void
  /** Reject any in-flight requests — called when the agent loop is cancelled. */
  clearAll: () => void
}

// ─── Generator ───

let counter = 0
function generateQuestionId(): string {
  counter++
  return `ask-${Date.now()}-${counter}`
}

// ─── Store ───

export const useAskUserQuestionStore = create<
  AskUserQuestionState & AskUserQuestionActions
>((set, get) => ({
  pending: new Map(),

  request: (questions) => {
    const id = generateQuestionId()
    let resolveFn: (r: Record<string, string | string[]>) => void = () => {}
    const promise = new Promise<Record<string, string | string[]>>((resolve) => {
      resolveFn = resolve
    })
    const entry: PendingAskUserQuestion = {
      id,
      questions,
      resolve: resolveFn,
    }
    set((state) => {
      const next = new Map(state.pending)
      next.set(id, entry)
      return { pending: next }
    })
    return { id, promise }
  },

  submit: (id, answers) => {
    const entry = get().pending.get(id)
    if (!entry) return
    set((state) => {
      const next = new Map(state.pending)
      next.delete(id)
      return { pending: next }
    })
    entry.resolve(answers)
  },

  cancel: (id) => {
    const entry = get().pending.get(id)
    if (!entry) return
    set((state) => {
      const next = new Map(state.pending)
      next.delete(id)
      return { pending: next }
    })
    // Empty answers = user cancelled
    entry.resolve({})
  },

  clearAll: () => {
    const { pending } = get()
    for (const entry of pending.values()) {
      entry.resolve({})
    }
    set({ pending: new Map() })
  },
}))
