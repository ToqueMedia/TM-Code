/**
 * FileViewer — lightweight Monaco editor for standalone files opened from the OS.
 * No project context needed. Minimal chrome, syntax highlighting, Cmd+S to save.
 *
 * The standalone window is created frameless (`decorations: false`,
 * `titleBarStyle: 'overlay'` — see App.tsx open-with flow), so THIS header is
 * the only window chrome the user gets: it must double as the drag region
 * (startDragging on mousedown, double-click toggles maximize) or the window
 * simply cannot be moved. The drag opt-outs mirror MinimalTitleBar — buttons
 * and anything under [data-no-drag] must keep their clicks, and we avoid
 * data-tauri-drag-region because the native handler keys off attribute
 * PRESENCE on Windows, eating clicks.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, Image, Text } from '@chakra-ui/react'
import { FiCheck, FiCopy, FiX, FiAlertCircle } from 'react-icons/fi'
import Editor, { loader } from '@monaco-editor/react'
import * as monacoEditor from 'monaco-editor'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n/useTranslation'
import { getFileIconUrl } from '@/utils/fileIcons'
import { IS_MAC } from '@/utils/platform'

// Use local monaco-editor instead of CDN
loader.config({ monaco: monacoEditor })

interface FileViewerProps {
  filePath: string
  onClose: () => void
  /** True when this viewer IS the whole window (frameless standalone editor).
   *  Drives the macOS traffic-light inset and the ⌘W-closes-window shortcut.
   *  Inline (main-window) usage leaves both off. */
  standalone?: boolean
}

function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp',
    h: 'c', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php',
    html: 'html', css: 'css', scss: 'scss', less: 'less',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    md: 'markdown', txt: 'plaintext',
    sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
    xml: 'xml', svg: 'xml', graphql: 'graphql',
  }
  return map[ext] ?? 'plaintext'
}

function getFileName(path: string): string {
  return path.split(/[\/\\]/).filter(Boolean).pop() ?? path
}

/** Mirror of MinimalTitleBar's drag opt-out: interactive elements and
 *  explicit [data-no-drag] islands keep their clicks. */
function isDragExempt(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null
  if (!t) return false
  const tag = t.tagName?.toLowerCase() || ''
  if (['button', 'input', 'svg', 'path'].includes(tag)) return true
  if (t.getAttribute?.('role') === 'button') return true
  if (t.closest?.('[data-no-drag]')) return true
  return false
}

function HeaderIconButton({ label, onClick, children }: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Box
      as="button"
      display="flex"
      alignItems="center"
      justifyContent="center"
      w="26px"
      h="26px"
      borderRadius="6px"
      color={tokens.colors.text.disabled}
      cursor="pointer"
      transition={`all ${tokens.transition.fast}`}
      _hover={{ color: tokens.colors.text.primary, bg: 'rgba(255,255,255,0.07)' }}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {children}
    </Box>
  )
}

function FileViewer({ filePath, onClose, standalone }: FileViewerProps) {
  const t = useTranslation()
  const [content, setContent] = useState<string>('')
  const [isDirty, setIsDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)
  const [pathCopied, setPathCopied] = useState(false)
  const [cursor, setCursor] = useState({ line: 1, col: 1 })
  const [lineCount, setLineCount] = useState(0)
  const editorRef = useRef<monacoEditor.editor.IStandaloneCodeEditor | null>(null)
  const savedFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fileName = getFileName(filePath)
  const language = getLanguageFromPath(filePath)

  useEffect(() => {
    let cancelled = false
    invoke<string>('read_file', { path: filePath })
      .then((data) => {
        if (!cancelled) {
          setContent(data)
          setLineCount(data.split('\n').length)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [filePath])

  const handleSave = useCallback(async () => {
    const value = editorRef.current?.getValue() ?? content
    try {
      await invoke('write_file', { path: filePath, content: value })
      setIsDirty(false)
      setSavedFlash(true)
      if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current)
      savedFlashTimer.current = setTimeout(() => setSavedFlash(false), 2500)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [filePath, content])

  useEffect(() => () => {
    if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current)
  }, [])

  // Cmd+S / Ctrl+S saves; in the standalone window Cmd+W closes it (there is
  // no native title bar, so without this the only way out is the ✕ button).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
      if (standalone && (e.metaKey || e.ctrlKey) && e.key === 'w') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [handleSave, onClose, standalone])

  const handleEditorMount = useCallback((editor: monacoEditor.editor.IStandaloneCodeEditor) => {
    editorRef.current = editor
    editor.onDidChangeCursorPosition((e) => {
      setCursor({ line: e.position.lineNumber, col: e.position.column })
    })
    editor.focus()
  }, [])

  const handleChange = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      setContent(value)
      setLineCount(value.split('\n').length)
      setIsDirty(true)
    }
  }, [])

  const handleCopyPath = useCallback(() => {
    navigator.clipboard.writeText(filePath).catch(() => {})
    setPathCopied(true)
    setTimeout(() => setPathCopied(false), 1600)
  }, [filePath])

  // Window drag + double-click maximize — the whole header is the drag
  // surface (same contract as MinimalTitleBar). In inline mode this moves
  // the MAIN window, which is exactly what a header drag should do there.
  const handleHeaderMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    if (isDragExempt(e.target)) return
    getCurrentWindow().startDragging().catch(() => {})
  }, [])

  const handleHeaderDoubleClick = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    if (isDragExempt(e.target)) return
    try {
      const win = getCurrentWindow()
      const isMax = await win.isMaximized()
      if (isMax) await win.unmaximize()
      else await win.maximize()
    } catch { /* not running under Tauri */ }
  }, [])

  return (
    <Flex h="100%" w="100%" direction="column" bg={tokens.colors.bg.app} overflow="hidden">
      {/* Title bar — always rendered (even while loading/erroring) so the
          frameless window stays draggable in every state. */}
      <Flex
        height="38px"
        flexShrink={0}
        align="center"
        gap={2}
        // Standalone macOS windows keep the native traffic lights overlaid
        // top-left (titleBarStyle: 'overlay') — reserve their space.
        pl={standalone && IS_MAC ? '78px' : 3}
        pr={2}
        bg={tokens.colors.bg.sidebar}
        borderBottom={`1px solid ${tokens.colors.border.default}`}
        userSelect="none"
        onMouseDown={handleHeaderMouseDown}
        onDoubleClick={handleHeaderDoubleClick}
      >
        <Image src={getFileIconUrl(filePath)} w="15px" h="15px" flexShrink={0} pointerEvents="none" />
        <Text
          fontSize="12.5px"
          fontWeight="600"
          color={tokens.colors.text.primary}
          whiteSpace="nowrap"
          overflow="hidden"
          textOverflow="ellipsis"
          maxW="40%"
          flexShrink={0}
          pointerEvents="none"
        >
          {fileName}
        </Text>
        {isDirty && (
          <Box
            w="7px"
            h="7px"
            borderRadius="full"
            bg={tokens.colors.accent.primary}
            flexShrink={0}
            title={t('fileViewer.unsaved')}
          />
        )}
        {/* Full path, truncated from the LEFT so the tail (the informative
            part) stays visible; the tooltip carries the whole thing. */}
        <Text
          fontSize="11px"
          color={tokens.colors.text.disabled}
          fontFamily={tokens.fontFamily.mono}
          whiteSpace="nowrap"
          overflow="hidden"
          textOverflow="ellipsis"
          flex="1"
          minW={0}
          textAlign="left"
          title={filePath}
          pointerEvents="none"
          css={{ direction: 'rtl' }}
        >
          {filePath}
        </Text>

        <Flex align="center" gap={1} flexShrink={0} data-no-drag>
          {isDirty && (
            <Flex
              as="button"
              align="center"
              gap={1.5}
              h="26px"
              px="10px"
              borderRadius="6px"
              bg={tokens.colors.accent.primary}
              color="white"
              fontSize="11px"
              fontWeight="600"
              cursor="pointer"
              transition={`all ${tokens.transition.fast}`}
              _hover={{ opacity: 0.88 }}
              onClick={handleSave}
            >
              {t('fileViewer.save')}
              <Text as="span" fontSize="10px" opacity={0.75} fontFamily={tokens.fontFamily.mono}>
                {IS_MAC ? '⌘S' : 'Ctrl+S'}
              </Text>
            </Flex>
          )}
          <HeaderIconButton label={t('fileViewer.copyPath')} onClick={handleCopyPath}>
            {pathCopied ? <FiCheck size={13} color={tokens.colors.accent.green} /> : <FiCopy size={13} />}
          </HeaderIconButton>
          <HeaderIconButton label={t('fileViewer.close')} onClick={onClose}>
            <FiX size={14} />
          </HeaderIconButton>
        </Flex>
      </Flex>

      {/* Body */}
      {loading ? (
        <Flex flex="1" align="center" justify="center" direction="column" gap={3}>
          <Box
            w="18px"
            h="18px"
            borderRadius="full"
            border={`2px solid ${tokens.colors.border.panel}`}
            borderTopColor={tokens.colors.accent.primary}
            css={{ animation: 'fvSpin 0.8s linear infinite', '@keyframes fvSpin': { to: { transform: 'rotate(360deg)' } } }}
          />
          <Text color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} fontSize="12px">
            {t('fileViewer.loading').replace('{fileName}', fileName)}
          </Text>
        </Flex>
      ) : error ? (
        <Flex flex="1" align="center" justify="center" px={6}>
          <Flex
            direction="column"
            align="center"
            gap={3}
            maxW="440px"
            px={6}
            py={5}
            borderRadius="10px"
            bg="rgba(248, 81, 73, 0.04)"
            border="1px solid rgba(248, 81, 73, 0.18)"
          >
            <Box color={tokens.colors.accent.red}>
              <FiAlertCircle size={20} />
            </Box>
            <Text color={tokens.colors.text.primary} fontSize="13px" fontWeight="600" textAlign="center">
              {t('fileViewer.failedOpen').replace('{fileName}', fileName)}
            </Text>
            <Text
              color={tokens.colors.text.muted}
              fontSize="11px"
              fontFamily={tokens.fontFamily.mono}
              textAlign="center"
              wordBreak="break-word"
            >
              {error}
            </Text>
            <Box
              as="button"
              onClick={onClose}
              mt={1}
              px={4}
              py="6px"
              borderRadius="6px"
              bg={tokens.colors.accent.primary}
              color="white"
              fontSize="12px"
              fontWeight="600"
              cursor="pointer"
              transition={`all ${tokens.transition.fast}`}
              _hover={{ opacity: 0.88 }}
            >
              {t('fileViewer.close')}
            </Box>
          </Flex>
        </Flex>
      ) : (
        <>
          <Box flex="1" minH={0}>
            <Editor
              language={language}
              value={content}
              theme="vs-dark"
              onChange={handleChange}
              onMount={handleEditorMount}
              options={{
                fontSize: 13,
                fontFamily: '"SF Mono", "Menlo", "Consolas", monospace',
                lineHeight: 1.5,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                automaticLayout: true,
                tabSize: 2,
                renderLineHighlight: 'line',
                cursorBlinking: 'smooth',
                smoothScrolling: true,
                padding: { top: 12, bottom: 12 },
                stickyScroll: { enabled: false },
              }}
            />
          </Box>

          {/* Status bar — language, size, cursor, save state. */}
          <Flex
            h="24px"
            flexShrink={0}
            align="center"
            justify="space-between"
            px={3}
            bg={tokens.colors.bg.sidebar}
            borderTop={`1px solid ${tokens.colors.border.default}`}
            fontSize="10.5px"
            fontFamily={tokens.fontFamily.mono}
            color={tokens.colors.text.disabled}
            userSelect="none"
          >
            <Flex align="center" gap={3} minW={0}>
              <Text textTransform="uppercase" letterSpacing="0.05em">{language}</Text>
              <Text>{t('fileViewer.lines').replace('{count}', String(lineCount))}</Text>
            </Flex>
            <Flex align="center" gap={3} flexShrink={0}>
              {savedFlash && !isDirty && (
                <Flex align="center" gap={1} color={tokens.colors.accent.green}>
                  <FiCheck size={11} />
                  <Text>{t('fileViewer.saved')}</Text>
                </Flex>
              )}
              {isDirty && (
                <Text color={tokens.colors.accent.orange}>{t('fileViewer.unsaved')}</Text>
              )}
              <Text>Ln {cursor.line}, Col {cursor.col}</Text>
            </Flex>
          </Flex>
        </>
      )}
    </Flex>
  )
}

export default memo(FileViewer)
