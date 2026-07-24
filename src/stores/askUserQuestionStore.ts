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
  /** Tarefa paralela que perguntou (badge "Pergunta" nas task rows). */
  origin?: { taskId: string; label: string; sessionId?: string; projectId?: string }
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
  request: (questions: Question[], origin?: { taskId: string; label: string; sessionId?: string; projectId?: string }) => {
    id: string
    promise: Promise<Record<string, string | string[]>>
  }
  submit: (id: string, answers: Record<string, string | string[]>) => void
  cancel: (id: string) => void
  /** Reject the MAIN run's in-flight requests (task-owned survive). */
  clearAll: () => void
  /** Cancela as perguntas pendentes de UMA tarefa paralela parada. */
  cancelByOrigin: (taskId: string) => void
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

  request: (questions, origin) => {
    const id = generateQuestionId()
    let resolveFn: (r: Record<string, string | string[]>) => void = () => {}
    const promise = new Promise<Record<string, string | string[]>>((resolve) => {
      resolveFn = resolve
    })
    const entry: PendingAskUserQuestion = {
      id,
      questions,
      ...(origin ? { origin } : {}),
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
    // Só as perguntas do RUN PRINCIPAL — as de tarefas paralelas (origin)
    // sobrevivem ao stop do main e caem via cancelByOrigin.
    const { pending } = get()
    const keep = new Map<string, PendingAskUserQuestion>()
    for (const [id, entry] of pending) {
      if (entry.origin) keep.set(id, entry)
      else entry.resolve({})
    }
    set({ pending: keep })
  },

  cancelByOrigin: (taskId) => {
    const { pending } = get()
    const keep = new Map<string, PendingAskUserQuestion>()
    for (const [id, entry] of pending) {
      if (entry.origin?.taskId === taskId) entry.resolve({})
      else keep.set(id, entry)
    }
    set({ pending: keep })
  },
}))
