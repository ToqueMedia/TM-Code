import { useCallback, useRef, useState, type RefObject } from 'react'
import { findHashtagAtCursor, findHashtagTokenEnd } from '../../utils/hashtagParser'
import { filterHashtagOptions, type HashtagOption } from '../../services/agent/hashtagRegistry'

interface UseHashtagMenuOptions {
  /** Textarea owning the cursor — used to read selectionStart and to refocus after insert. */
  textareaRef: RefObject<HTMLTextAreaElement | null>
  /**
   * Imperative setter for the textarea's text. The main prompt wires to
   * `useChatStore.setDraftInput`; local prompt inputs wire to `setInput`.
   * The hook never touches the underlying store — it just calls back.
   */
  setInputValue: (next: string) => void
  /**
   * Imperative reader for the textarea's text. Used by `handleSelect` to
   * compute the replacement using the LATEST value (avoids races where the
   * user typed extra characters between detect and select).
   */
  getInputValue: () => string
}

/**
 * Closed-vocabulary `#hashtag` autocomplete state + handlers.
 *
 * Used by the chat prompt (`usePromptBar`). The hook owns the menu state,
 * the cursor-aware detection, and the keyboard navigation. Callers wire up:
 *
 *   - `detect(text, cursorPos)` from the input change handler — returns
 *     true when a hashtag is in progress so the caller can short-circuit
 *     fall-through into the @mention check.
 *   - `handleKeyDown(e)` from the textarea key handler — returns true
 *     when the key was consumed (caller should `return` and skip its
 *     own nav logic).
 *   - `close()` from the blur handler / send handler.
 */
export function useHashtagMenu({ textareaRef, setInputValue, getInputValue }: UseHashtagMenuOptions) {
  const [show, setShow] = useState(false)
  const [items, setItems] = useState<HashtagOption[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const startRef = useRef(-1)

  /**
   * Inspect text + cursor for an in-progress `#tag`. Updates state and
   * returns true when the menu should be open (short-circuits the caller's
   * `@mention` fall-through). Returns true even when there are zero matches
   * — a `#` with no matching tag still consumes the autocomplete slot so
   * the file picker doesn't pop up.
   */
  const detect = useCallback((text: string, cursorPos: number): boolean => {
    const hashtag = findHashtagAtCursor(text, cursorPos)
    if (!hashtag) {
      setShow(false)
      return false
    }
    const matches = filterHashtagOptions(hashtag.query)
    if (matches.length === 0) {
      setShow(false)
      // Still return true: the caller must NOT fall through to the @mention
      // file picker just because we have no matching tags. The `#` token
      // itself owns the autocomplete slot.
      return true
    }
    setItems(matches)
    setShow(true)
    setSelectedIndex(0)
    startRef.current = hashtag.hashIndex
    return true
  }, [])

  const close = useCallback(() => {
    setShow(false)
  }, [])

  const handleSelect = useCallback((item: HashtagOption) => {
    const currentInput = getInputValue()
    const start = startRef.current
    if (start < 0) return

    const tokenEnd = findHashtagTokenEnd(currentInput, start + 1)
    const before = currentInput.slice(0, start)
    const after = currentInput.slice(tokenEnd)
    const insertion = `${item.tag} `
    const newValue = before + insertion + after
    const newCursor = before.length + insertion.length

    setInputValue(newValue)
    startRef.current = -1
    setShow(false)

    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (ta) {
        ta.selectionStart = newCursor
        ta.selectionEnd = newCursor
        ta.focus()
      }
    })
  }, [getInputValue, setInputValue, textareaRef])

  /** Returns true when the key was consumed (caller should skip its own nav). */
  const handleKeyDown = useCallback((e: React.KeyboardEvent): boolean => {
    if (!show || items.length === 0) return false

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(prev => prev <= 0 ? items.length - 1 : prev - 1)
      return true
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(prev => prev >= items.length - 1 ? 0 : prev + 1)
      return true
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault()
      const selected = items[selectedIndex]
      if (selected) handleSelect(selected)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setShow(false)
      return true
    }

    return false
  }, [show, items, selectedIndex, handleSelect])

  return {
    show,
    items,
    selectedIndex,
    detect,
    close,
    handleSelect,
    handleKeyDown,
  }
}
