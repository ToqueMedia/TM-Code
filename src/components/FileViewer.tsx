/**
 * FileViewer — lightweight Monaco editor for standalone files opened from the OS.
 * No project context needed. Minimal chrome, syntax highlighting, Cmd+S to save.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiX } from 'react-icons/fi'
import Editor, { loader } from '@monaco-editor/react'
import * as monacoEditor from 'monaco-editor'
import { invoke } from '@tauri-apps/api/core'
import { tokens } from '@/theme/tokens'

// Use local monaco-editor instead of CDN
loader.config({ monaco: monacoEditor })

interface FileViewerProps {
  filePath: string
  onClose: () => void
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

function FileViewer({ filePath, onClose }: FileViewerProps) {
  const [content, setContent] = useState<string>('')
  const [isDirty, setIsDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const editorRef = useRef<monacoEditor.editor.IStandaloneCodeEditor | null>(null)

  const fileName = getFileName(filePath)
  const language = getLanguageFromPath(filePath)

  useEffect(() => {
    let cancelled = false
    invoke<string>('read_file', { path: filePath })
      .then((data) => {
        if (!cancelled) {
          setContent(data)
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [filePath, content])

  // Cmd+S / Ctrl+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [handleSave])

  const handleEditorMount = useCallback((editor: monacoEditor.editor.IStandaloneCodeEditor) => {
    editorRef.current = editor
    editor.focus()
  }, [])

  const handleChange = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      setContent(value)
      setIsDirty(true)
    }
  }, [])

  if (loading) {
    return (
      <Flex flex="1" align="center" justify="center" bg={tokens.colors.bg.app}>
        <Text color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} fontSize="13px">
          Loading {fileName}...
        </Text>
      </Flex>
    )
  }

  if (error) {
    return (
      <Flex flex="1" direction="column" align="center" justify="center" bg={tokens.colors.bg.app} gap={3}>
        <Text color={tokens.colors.text.secondary} fontSize="13px">Failed to open {fileName}</Text>
        <Text color={tokens.colors.text.muted} fontSize="11px" fontFamily={tokens.fontFamily.mono}>{error}</Text>
        <Box
          as="button"
          onClick={onClose}
          px={3}
          py={1}
          borderRadius="4px"
          bg={tokens.colors.accent.primary}
          color="white"
          fontSize="12px"
          cursor="pointer"
          _hover={{ opacity: 0.9 }}
        >
          Close
        </Box>
      </Flex>
    )
  }

  return (
    <Flex h="100vh" direction="column" bg={tokens.colors.bg.app} overflow="hidden">
      {/* Title bar */}
      <Flex
        height="32px"
        flexShrink={0}
        align="center"
        justify="space-between"
        px={3}
        bg={tokens.colors.bg.sidebar}
        borderBottom={`1px solid ${tokens.colors.border.default}`}
      >
        <Flex align="center" gap={2}>
          <Text
            fontSize="12px"
            fontWeight="500"
            color={tokens.colors.text.primary}
            fontFamily={tokens.fontFamily.mono}
          >
            {fileName}
          </Text>
          {isDirty && (
            <Box w="6px" h="6px" borderRadius="50%" bg={tokens.colors.accent.primary} />
          )}
        </Flex>
        <Flex align="center" gap={2}>
          <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
            {filePath}
          </Text>
          <Box
            as="button"
            onClick={onClose}
            p="2px"
            borderRadius="3px"
            color={tokens.colors.text.disabled}
            _hover={{ color: tokens.colors.text.primary, bg: 'rgba(255,255,255,0.06)' }}
            display="flex"
            alignItems="center"
            justifyContent="center"
          >
            <FiX size={13} />
          </Box>
        </Flex>
      </Flex>

      {/* Monaco editor */}
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
          }}
        />
      </Box>
    </Flex>
  )
}

export default memo(FileViewer)
