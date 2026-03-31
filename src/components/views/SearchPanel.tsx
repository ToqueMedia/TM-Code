import React, { memo, useState, useCallback, useRef, useEffect } from 'react'
import { Flex, Text, Box, Input, VStack } from '@chakra-ui/react'
import { VscSearch, VscChevronDown, VscChevronRight, VscCaseSensitive, VscRegex, VscWholeWord } from 'react-icons/vsc'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import SearchService, { type SearchResult, type FileSearchResult } from '@/services/searchService'
import { useCurrentProject } from '@/hooks/useProjectState'
import { useEditorRepository } from '@/stores/editorStore'
import { getFileIconByExtension } from '@/utils/iconMapper'

function SearchPanel() {
  const currentProject = useCurrentProject()
  const projectPath = currentProject?.path ?? ''

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleSearch = useCallback(async (q: string) => {
    if (!q.trim() || !projectPath) {
      setResults(null)
      return
    }
    setSearching(true)
    try {
      const result = await SearchService.shared.searchInFiles(q, projectPath, {
        case_sensitive: caseSensitive,
        whole_word: wholeWord,
        use_regex: useRegex,
        include_patterns: [],
        exclude_patterns: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/target/**'],
        max_results: 500,
      })
      setResults(result)
    } catch (err) {
      console.error('Search failed:', err)
      setResults(null)
    }
    setSearching(false)
  }, [projectPath, caseSensitive, wholeWord, useRegex])

  // Re-search when toggle flags change
  useEffect(() => {
    if (query.trim()) handleSearch(query)
  }, [caseSensitive, wholeWord, useRegex]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => handleSearch(val), 400)
  }, [handleSearch])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (debounceRef.current) clearTimeout(debounceRef.current)
      handleSearch(query)
    }
  }, [handleSearch, query])

  const openFileAtLine = useCallback((filePath: string, line: number, column: number) => {
    useEditorRepository.getState().openFile(filePath)
    // Pin the file (not preview)
    useEditorRepository.getState().pinFile(filePath)
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('monaco:revealPosition', {
        detail: { file: filePath, line, column }
      }))
    }, 200)
  }, [])

  const toggleFileCollapse = useCallback((filePath: string) => {
    setCollapsedFiles(prev => {
      const next = new Set(prev)
      if (next.has(filePath)) next.delete(filePath)
      else next.add(filePath)
      return next
    })
  }, [])

  const relativePath = useCallback((fullPath: string) => {
    return projectPath ? fullPath.replace(projectPath + '/', '') : fullPath
  }, [projectPath])

  return (
    <Flex direction="column" height="100%" overflow="hidden">
      {/* Header */}
      <Flex
        align="center"
        justify="space-between"
        px={3}
        h="34px"
        flexShrink={0}
        borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
      >
        <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.secondary} textTransform="uppercase" letterSpacing="0.05em">
          Search
        </Text>
      </Flex>

      {/* Search input */}
      <Box px={2.5} pt={2} pb={1.5} flexShrink={0}>
        <Flex
          align="center"
          bg={tokens.colors.bg.input}
          border={`1px solid ${tokens.colors.border.input}`}
          borderRadius="4px"
          _focusWithin={{
            borderColor: tokens.colors.accent.primaryBorder,
            boxShadow: `0 0 0 1px ${tokens.colors.accent.primarySubtle}`,
          }}
          px={1.5}
          gap={1}
        >
          <VscSearch size={12} color={tokens.colors.text.muted} style={{ flexShrink: 0 }} />
          <Input
            ref={inputRef}
            value={query}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={t("search.placeholder")}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            fontSize="12px"
            fontFamily={tokens.fontFamily.ui}
            bg="transparent"
            border="none"
            color={tokens.colors.text.primary}
            _placeholder={{ color: tokens.colors.text.disabled }}
            _focus={{ boxShadow: 'none' }}
            height="26px"
            px={0}
            flex={1}
          />
          {/* Toggle buttons */}
          <ToggleButton active={caseSensitive} onClick={() => setCaseSensitive(v => !v)} title={t("search.matchCase")}>
            <VscCaseSensitive size={14} />
          </ToggleButton>
          <ToggleButton active={wholeWord} onClick={() => setWholeWord(v => !v)} title={t("search.matchWholeWord")}>
            <VscWholeWord size={14} />
          </ToggleButton>
          <ToggleButton active={useRegex} onClick={() => setUseRegex(v => !v)} title={t("search.useRegex")}>
            <VscRegex size={14} />
          </ToggleButton>
        </Flex>
      </Box>

      {/* Results summary */}
      {results && (
        <Box px={3} pb={1} flexShrink={0}>
          <Text fontSize="11px" color={tokens.colors.text.muted}>
            {results.total_matches} result{results.total_matches !== 1 ? 's' : ''} in {results.total_files} file{results.total_files !== 1 ? 's' : ''}
            {results.truncated && <Text as="span" color={tokens.colors.accent.orange}> (truncated)</Text>}
          </Text>
        </Box>
      )}

      {/* Results list */}
      <Box flex={1} overflowY="auto">
        {searching && (
          <Text fontSize="11px" color={tokens.colors.text.muted} px={3} py={4}>Searching...</Text>
        )}
        {results && results.files.length === 0 && !searching && (
          <Text fontSize="12px" color={tokens.colors.text.muted} px={3} py={6} textAlign="center">
            No results found
          </Text>
        )}
        {results?.files.map(file => (
          <FileResult
            key={file.file_path}
            file={file}
            relPath={relativePath(file.file_path)}
            isCollapsed={collapsedFiles.has(file.file_path)}
            onToggle={() => toggleFileCollapse(file.file_path)}
            onMatchClick={(line, col) => openFileAtLine(file.file_path, line, col)}
            query={query}
          />
        ))}
      </Box>
    </Flex>
  )
}

// ── Toggle Button ────────────────────────────────────────────────────────

const ToggleButton = memo<{
  active: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}>(({ active, onClick, title, children }) => (
  <Box
    as="button"
    display="flex"
    alignItems="center"
    justifyContent="center"
    w="20px"
    h="20px"
    borderRadius="3px"
    bg={active ? tokens.colors.accent.primarySubtle : 'transparent'}
    color={active ? tokens.colors.accent.primary : tokens.colors.text.disabled}
    cursor="pointer"
    flexShrink={0}
    title={title}
    _hover={{ color: tokens.colors.text.primary, bg: tokens.colors.bg.hoverSubtle }}
    onClick={onClick}
  >
    {children}
  </Box>
))

ToggleButton.displayName = 'ToggleButton'

// ── File Result ──────────────────────────────────────────────────────────

const FileResult = memo<{
  file: FileSearchResult
  relPath: string
  isCollapsed: boolean
  onToggle: () => void
  onMatchClick: (line: number, col: number) => void
  query: string
}>(({ file, relPath, isCollapsed, onToggle, onMatchClick, query }) => {
  const fileName = relPath.split('/').pop() || relPath
  const dirPath = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : ''
  const ext = fileName.split('.').pop()?.toLowerCase()
  const iconUrl = getFileIconByExtension(ext, fileName)

  return (
    <Box>
      {/* File header */}
      <Flex
        align="center"
        gap={1.5}
        px={2}
        h="22px"
        cursor="pointer"
        _hover={{ bg: tokens.colors.bg.hoverSubtle }}
        onClick={onToggle}
        userSelect="none"
      >
        {isCollapsed
          ? <VscChevronRight size={11} color={tokens.colors.text.muted} />
          : <VscChevronDown size={11} color={tokens.colors.text.muted} />
        }
        {iconUrl ? (
          <img src={iconUrl} alt="" style={{ width: 14, height: 14, flexShrink: 0 }} />
        ) : (
          <Box w="14px" h="14px" flexShrink={0} />
        )}
        <Text fontSize="12px" color={tokens.colors.text.primary} fontWeight="500" whiteSpace="nowrap" flexShrink={0}>
          {fileName}
        </Text>
        {dirPath && (
          <Text fontSize="11px" color={tokens.colors.text.disabled} truncate>
            {dirPath}
          </Text>
        )}
        <Box
          ml="auto"
          px={1.5}
          borderRadius={tokens.radius.full}
          bg="rgba(255, 255, 255, 0.1)"
          flexShrink={0}
        >
          <Text fontSize="10px" fontWeight="600" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono} lineHeight="16px">
            {file.total_matches}
          </Text>
        </Box>
      </Flex>

      {/* Matches */}
      {!isCollapsed && (
        <VStack gap={0} align="stretch">
          {file.matches.map((match, i) => (
            <Flex
              key={`${match.line_number}-${i}`}
              align="center"
              gap={1}
              px={2}
              pl={7}
              h="20px"
              cursor="pointer"
              fontSize="12px"
              _hover={{ bg: tokens.colors.bg.hoverSubtle }}
              onClick={() => onMatchClick(match.line_number, match.column)}
            >
              <Text
                flex={1}
                color={tokens.colors.text.secondary}
                fontFamily={tokens.fontFamily.mono}
                fontSize="11px"
                truncate
              >
                <HighlightedText text={match.text.trim()} query={query} />
              </Text>
            </Flex>
          ))}
        </VStack>
      )}
    </Box>
  )
})

FileResult.displayName = 'FileResult'

// Safe text highlighting — no dangerouslySetInnerHTML
const HighlightedText = memo<{ text: string; query: string }>(({ text, query }) => {
  if (!query) return <>{text}</>
  try {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
    return (
      <>
        {parts.map((part, i) =>
          part.toLowerCase() === query.toLowerCase() ? (
            <span key={i} style={{ background: tokens.colors.accent.primaryMuted, color: tokens.colors.text.primary, borderRadius: 2 }}>
              {part}
            </span>
          ) : (
            <React.Fragment key={i}>{part}</React.Fragment>
          )
        )}
      </>
    )
  } catch {
    return <>{text}</>
  }
})

HighlightedText.displayName = 'HighlightedText'

export default memo(SearchPanel)
