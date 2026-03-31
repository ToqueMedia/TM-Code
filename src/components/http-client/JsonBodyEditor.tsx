import React, { memo, useRef, useMemo, useCallback } from 'react'
import { tokens } from '@/theme/tokens'

interface JsonBodyEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

const PAIRS: Record<string, string> = { '{': '}', '[': ']', '"': '"' }
const CLOSERS = new Set(['}', ']', '"'])
const TAB = '    '

// Reuse the same token regex from ResponseViewer
const JSON_TOKEN_REGEX = /("(?:[^"\\]|\\.)*")\s*:|("(?:[^"\\]|\\.)*")|(true|false)|(null)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

const TOKEN_COLORS = {
  key: tokens.colors.accent.purple,
  string: tokens.colors.accent.greenBright,
  boolean: tokens.colors.accent.blueBright,
  null: tokens.colors.text.disabled,
  number: tokens.colors.accent.orangeBright,
}

const sharedStyle: React.CSSProperties = {
  fontFamily: tokens.fontFamily.mono,
  fontSize: tokens.fontSize.xs,
  lineHeight: '1.7',
  padding: '12px',
  margin: 0,
  border: 'none',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  tabSize: 4,
}

function JsonBodyEditor({ value, onChange, placeholder }: JsonBodyEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)
  // Keep a ref to the latest value so keydown handler never reads stale closures
  const valueRef = useRef(value)
  valueRef.current = value

  const highlighted = useMemo(() => highlightSource(value), [value])

  // Sync scroll between textarea and highlighted overlay
  const handleScroll = useCallback(() => {
    const ta = textareaRef.current
    const pre = preRef.current
    if (ta && pre) {
      pre.scrollTop = ta.scrollTop
      pre.scrollLeft = ta.scrollLeft
    }
  }, [])

  const setCursor = useCallback((pos: number) => {
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (ta) ta.selectionStart = ta.selectionEnd = pos
    })
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = textareaRef.current
    if (!ta) return
    const val = valueRef.current
    const { selectionStart: start, selectionEnd: end } = ta
    const before = val.slice(0, start)
    const after = val.slice(end)

    // ── Tab / Shift+Tab ──
    if (e.key === 'Tab') {
      e.preventDefault()
      if (e.shiftKey) {
        // Shift+Tab → remove up to 4 leading spaces from current line
        const lines = before.split('\n')
        const currentLine = lines[lines.length - 1]
        const stripped = currentLine.replace(/^ {1,4}/, '')
        const removed = currentLine.length - stripped.length
        if (removed > 0) {
          lines[lines.length - 1] = stripped
          const newVal = lines.join('\n') + after
          onChange(newVal)
          setCursor(start - removed)
        }
      } else {
        onChange(before + TAB + after)
        setCursor(start + 4)
      }
      return
    }

    // ── Auto-close pairs: { → {}, [ → [], " → "" ──
    if (PAIRS[e.key]) {
      // Skip auto-close " if inside a string (odd number of unescaped quotes before cursor)
      if (e.key === '"') {
        const quotesBefore = (before.match(/(?<!\\)"/g) || []).length
        // If closing an open quote, skip auto-pair and just type it
        if (quotesBefore % 2 === 1 && after[0] === '"') {
          e.preventDefault()
          setCursor(start + 1)
          return
        }
      }

      e.preventDefault()
      onChange(before + e.key + PAIRS[e.key] + after)
      setCursor(start + 1)
      return
    }

    // ── Skip over closing char if already there ──
    if (CLOSERS.has(e.key) && val[start] === e.key && start === end) {
      e.preventDefault()
      setCursor(start + 1)
      return
    }

    // ── Enter ──
    if (e.key === 'Enter') {
      const lastLine = before.split('\n').pop() || ''
      const indent = lastLine.match(/^\s*/)?.[0] || ''
      const charBefore = before[before.length - 1]
      const charAfter = after[0]

      // Enter between {|} or [|] → expand with indent
      if ((charBefore === '{' && charAfter === '}') || (charBefore === '[' && charAfter === ']')) {
        e.preventDefault()
        const inner = '\n' + indent + TAB
        const close = '\n' + indent
        onChange(before + inner + close + after)
        setCursor(start + inner.length)
        return
      }

      // Enter after { or [ → new line with extra indent
      if (charBefore === '{' || charBefore === '[' || charBefore === ',') {
        e.preventDefault()
        const extra = (charBefore === '{' || charBefore === '[') ? TAB : ''
        const nl = '\n' + indent + extra
        onChange(before + nl + after)
        setCursor(start + nl.length)
        return
      }

      // Regular Enter → maintain current indentation
      e.preventDefault()
      const nl = '\n' + indent
      onChange(before + nl + after)
      setCursor(start + nl.length)
      return
    }

    // ── Backspace: delete pair if empty ──
    if (e.key === 'Backspace' && start === end && start > 0) {
      const pair = val.slice(start - 1, start + 1)
      if (pair === '{}' || pair === '[]' || pair === '""') {
        e.preventDefault()
        onChange(val.slice(0, start - 1) + val.slice(start + 1))
        setCursor(start - 1)
        return
      }
    }
  }, [onChange, setCursor])

  return (
    <div style={{ position: 'relative', flex: 1, overflow: 'hidden', display: 'flex' }}>
      <div style={{ position: 'relative', flex: 1, overflow: 'auto' }}>
        {/* Highlighted overlay */}
        <pre
          ref={preRef}
          aria-hidden
          style={{
            ...sharedStyle,
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            pointerEvents: 'none',
            color: tokens.colors.text.primary,
            overflow: 'auto',
          }}
        >
          {value ? highlighted : (
            <span style={{ color: tokens.colors.text.disabled }}>{placeholder}</span>
          )}
        </pre>

        {/* Editable textarea — transparent text, visible caret */}
        <textarea
          ref={textareaRef}
          style={{
            ...sharedStyle,
            position: 'relative',
            width: '100%',
            height: '100%',
            background: 'transparent',
            color: 'transparent',
            caretColor: tokens.colors.text.primary,
            outline: 'none',
            resize: 'none',
            zIndex: 1,
          }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onScroll={handleScroll}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          data-gramm="false"
        />
      </div>
    </div>
  )
}

/** Highlight JSON source tokens — works on partial/invalid JSON too. */
function highlightSource(src: string): (string | React.JSX.Element)[] {
  if (!src) return []

  const result: (string | React.JSX.Element)[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let id = 0

  const regex = new RegExp(JSON_TOKEN_REGEX.source, 'g')

  while ((match = regex.exec(src)) !== null) {
    if (match.index > lastIndex) {
      result.push(src.slice(lastIndex, match.index))
    }

    if (match[1]) {
      // Key
      result.push(<span key={id++} style={{ color: TOKEN_COLORS.key }}>{match[1]}</span>)
      result.push(':')
    } else if (match[2]) {
      // String
      result.push(<span key={id++} style={{ color: TOKEN_COLORS.string }}>{match[2]}</span>)
    } else if (match[3]) {
      // Boolean
      result.push(<span key={id++} style={{ color: TOKEN_COLORS.boolean }}>{match[3]}</span>)
    } else if (match[4]) {
      // Null
      result.push(<span key={id++} style={{ color: TOKEN_COLORS.null }}>{match[4]}</span>)
    } else if (match[5]) {
      // Number
      result.push(<span key={id++} style={{ color: TOKEN_COLORS.number }}>{match[5]}</span>)
    }

    lastIndex = regex.lastIndex
  }

  if (lastIndex < src.length) {
    result.push(src.slice(lastIndex))
  }

  return result
}

export default memo(JsonBodyEditor)
