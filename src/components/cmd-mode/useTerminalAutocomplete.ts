import { useCallback, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { invoke } from '@/utils/invokeMetrics'
import TerminalService from '../../services/terminalService'
import { logger } from '@/utils/logger'

interface UseTerminalAutocompleteProps {
  sessionId: string
  projectPath: string
}

interface AutocompleteState {
  completions: string[]
  selectedIndex: number
  menuPosition: { top: number; left: number } | null
  isLoading: boolean
}

export function useTerminalAutocomplete({ sessionId, projectPath }: UseTerminalAutocompleteProps) {
  const [state, setState] = useState<AutocompleteState>({
    completions: [],
    selectedIndex: 0,
    menuPosition: null,
    isLoading: false,
  })

  const completionSeq = useRef(0)
  const wordRef = useRef('')

  const closeMenu = useCallback(() => {
    completionSeq.current++
    setState({
      completions: [],
      selectedIndex: 0,
      menuPosition: null,
      isLoading: false,
    })
  }, [])

  const getCurrentWord = useCallback((term: Terminal): string => {
    const buffer = term.buffer.active
    const absRow = buffer.baseY + buffer.cursorY
    const line = buffer.getLine(absRow)
    if (!line) return ''
    const text = line.translateToString(true)
    const col = buffer.cursorX
    const before = text.slice(0, col)
    const lastSpace = before.lastIndexOf(' ')
    return before.slice(lastSpace + 1)
  }, [])

  const getMenuPosition = useCallback((term: Terminal): { top: number; left: number } => {
    const el = term.element
    if (!el) return { top: 0, left: 0 }
    const cellW = el.clientWidth / term.cols
    const cellH = el.clientHeight / term.rows
    const buffer = term.buffer.active

    // Position menu below cursor, but flip above if near bottom
    const cursorY = buffer.cursorY + 1
    const maxRows = term.rows
    const menuHeight = 200 // approximate menu height in pixels
    const availableSpaceBelow = (maxRows - cursorY) * cellH

    const top = availableSpaceBelow < menuHeight
      ? (cursorY - 1) * cellH - menuHeight - 4
      : cursorY * cellH + 4

    return {
      top,
      left: buffer.cursorX * cellW,
    }
  }, [])

  const applyCompletion = useCallback((term: Terminal, completion: string, word: string) => {
    closeMenu()
    const backspaces = '\x7f'.repeat(word.length)
    const separator = completion.endsWith('/') ? '' : ' '
    invoke('write_to_pty', { sessionId, data: backspaces + completion + separator }).catch((err) => {
      logger.warn('terminal-panel', 'applyCompletion write_to_pty failed:', err)
    })
    term.focus()
  }, [sessionId, closeMenu])

  const handleTab = useCallback((term: Terminal) => {
    const hasMenu = state.completions.length > 0

    if (hasMenu) {
      const selected = state.completions[state.selectedIndex]
      if (selected) applyCompletion(term, selected, wordRef.current)
      return true
    }

    const word = getCurrentWord(term)
    if (!word) {
      invoke('write_to_pty', { sessionId, data: '\t' }).catch(() => {})
      return true
    }

    wordRef.current = word
    const seq = ++completionSeq.current

    setState(prev => ({ ...prev, isLoading: true }))

    TerminalService.shared.getCompletions(word, projectPath)
      .then((results: string[]) => {
        if (completionSeq.current !== seq) return

        setState(prev => ({ ...prev, isLoading: false }))

        if (!results || results.length === 0) {
          invoke('write_to_pty', { sessionId, data: '\t' }).catch(() => {})
          return
        }

        if (results.length === 1) {
          applyCompletion(term, results[0], word)
          return
        }

        setState({
          completions: results,
          selectedIndex: 0,
          menuPosition: getMenuPosition(term),
          isLoading: false,
        })
      })
      .catch(() => {
        if (completionSeq.current !== seq) return
        setState(prev => ({ ...prev, isLoading: false }))
        invoke('write_to_pty', { sessionId, data: '\t' }).catch(() => {})
      })

    return true
  }, [sessionId, projectPath, state.completions, state.selectedIndex, getCurrentWord, getMenuPosition, applyCompletion])

  const handleKeyDown = useCallback((term: Terminal, data: string): boolean => {
    const hasMenu = state.completions.length > 0

    if (!hasMenu) return false

    if (data === '\x1b[B') { // Down arrow
      setState(prev => ({
        ...prev,
        selectedIndex: (prev.selectedIndex + 1) % prev.completions.length,
      }))
      return true
    }

    if (data === '\x1b[A') { // Up arrow
      setState(prev => ({
        ...prev,
        selectedIndex: (prev.selectedIndex - 1 + prev.completions.length) % prev.completions.length,
      }))
      return true
    }

    if (data === '\r' || data === '\n') { // Enter
      const sel = state.completions[state.selectedIndex]
      if (sel) applyCompletion(term, sel, wordRef.current)
      return true
    }

    if (data === '\x1b') { // Escape
      closeMenu()
      return true
    }

    // Any other key closes menu
    closeMenu()
    return false
  }, [state.completions, state.selectedIndex, applyCompletion, closeMenu])

  const selectCompletion = useCallback((term: Terminal, item: string) => {
    applyCompletion(term, item, wordRef.current)
  }, [applyCompletion])

  return {
    completions: state.completions,
    selectedIndex: state.selectedIndex,
    menuPosition: state.menuPosition,
    isLoading: state.isLoading,
    handleTab,
    handleKeyDown,
    selectCompletion,
    closeMenu,
  }
}
