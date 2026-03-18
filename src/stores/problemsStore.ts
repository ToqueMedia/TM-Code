import { create } from 'zustand'
import TypeScriptLspService from '../services/typescriptLspService'
import { logger } from '../utils/logger'

export interface Diagnostic {
  id: string
  file: string
  line: number
  column: number
  message: string
  severity: 'error' | 'warning' | 'info'
  code: number
}

interface ProblemsState {
  diagnostics: Diagnostic[]
  isScanning: boolean
  lastScanAt: number | null
}

interface ProblemsActions {
  scanFile: (filePath: string) => Promise<void>
  scanProject: () => Promise<void>
  removeFile: (filePath: string) => void
  clear: () => void
}

/**
 * Small delay so the Monaco TS worker can reprocess a model
 * after its content changes before we read diagnostics.
 */
const WORKER_SETTLE_MS = 150

const waitForWorker = () => new Promise<void>(r => setTimeout(r, WORKER_SETTLE_MS))

/**
 * Yield to the browser event-loop between scan batches
 * so the UI stays responsive during large project scans.
 */
const yieldToUI = () => new Promise<void>(r => setTimeout(r, 0))

/** Monotonically increasing ID so scanProject can detect stale runs. */
let scanGeneration = 0

export const useProblemsStore = create<ProblemsState & ProblemsActions>()((set, get) => ({
  diagnostics: [],
  isScanning: false,
  lastScanAt: null,

  scanFile: async (filePath: string) => {
    const lsp = TypeScriptLspService.getInstance()
    if (!lsp.ready) return

    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    if (!['ts', 'tsx', 'js', 'jsx'].includes(ext)) return

    // Wait for the Monaco worker to settle after model content update
    await waitForWorker()

    try {
      const results = await lsp.getDiagnostics(filePath)
      const newDiags: Diagnostic[] = results.map((d, i) => ({
        id: `${filePath}:${d.line}:${d.column}:${i}`,
        file: filePath,
        line: d.line,
        column: d.column,
        message: d.message,
        severity: d.severity,
        code: d.code,
      }))

      set(state => ({
        diagnostics: [
          ...state.diagnostics.filter(d => d.file !== filePath),
          ...newDiags,
        ],
      }))
    } catch (error) {
      logger.error('problems', `Failed to scan ${filePath}:`, error)
    }
  },

  scanProject: async () => {
    const lsp = TypeScriptLspService.getInstance()
    if (!lsp.ready) return
    if (get().isScanning) return

    const gen = ++scanGeneration
    set({ isScanning: true })

    // Wait for any recent model updates to settle in the worker
    await waitForWorker()

    const allFiles = lsp.getAllFiles()
    const tsFiles = allFiles.filter(f => {
      const ext = f.split('.').pop()?.toLowerCase() || ''
      return ['ts', 'tsx', 'js', 'jsx'].includes(ext)
    })

    const allDiags: Diagnostic[] = []

    const BATCH_SIZE = 10
    for (let i = 0; i < tsFiles.length; i += BATCH_SIZE) {
      // Abort if a newer scan was requested (e.g. clear() or another scanProject)
      if (scanGeneration !== gen) {
        set({ isScanning: false })
        return
      }

      const batch = tsFiles.slice(i, i + BATCH_SIZE)
      const results = await Promise.allSettled(
        batch.map(async (filePath) => {
          try {
            const diags = await lsp.getDiagnostics(filePath)
            return diags.map((d, idx) => ({
              id: `${filePath}:${d.line}:${d.column}:${idx}`,
              file: filePath,
              line: d.line,
              column: d.column,
              message: d.message,
              severity: d.severity,
              code: d.code,
            }))
          } catch {
            return []
          }
        })
      )

      for (const result of results) {
        if (result.status === 'fulfilled') {
          allDiags.push(...result.value)
        }
      }

      // Yield to the event-loop so the UI stays responsive
      await yieldToUI()
    }

    // Only commit if this is still the latest scan
    if (scanGeneration !== gen) {
      set({ isScanning: false })
      return
    }

    set({
      diagnostics: allDiags,
      isScanning: false,
      lastScanAt: Date.now(),
    })

    logger.info('problems', `Project scan complete: ${allDiags.length} diagnostic(s)`)
  },

  removeFile: (filePath: string) => {
    set(state => ({
      diagnostics: state.diagnostics.filter(d => d.file !== filePath),
    }))
  },

  clear: () => {
    // Invalidate any running scan so it aborts on next batch check
    ++scanGeneration
    // Release cache references
    _prevDiagnostics = null
    _cachedGrouped = {}
    set({ diagnostics: [], isScanning: false, lastScanAt: null })
  },
}))

// Selectors
export const selectErrorCount = (state: ProblemsState) =>
  state.diagnostics.filter(d => d.severity === 'error').length

export const selectWarningCount = (state: ProblemsState) =>
  state.diagnostics.filter(d => d.severity === 'warning').length

export const selectInfoCount = (state: ProblemsState) =>
  state.diagnostics.filter(d => d.severity === 'info').length

/** Cached grouped-by-file selector — returns the same reference when diagnostics haven't changed. */
let _prevDiagnostics: Diagnostic[] | null = null
let _cachedGrouped: Record<string, Diagnostic[]> = {}

export const selectDiagnosticsByFile = (state: ProblemsState) => {
  if (state.diagnostics === _prevDiagnostics) return _cachedGrouped
  _prevDiagnostics = state.diagnostics
  const grouped: Record<string, Diagnostic[]> = {}
  for (const d of state.diagnostics) {
    if (!grouped[d.file]) grouped[d.file] = []
    grouped[d.file].push(d)
  }
  _cachedGrouped = grouped
  return grouped
}
