import { memo, useState, useCallback, useEffect, useRef } from 'react'
import { VStack } from '@chakra-ui/react'
import { FiSearch, FiX, FiMoreHorizontal } from 'react-icons/fi'
import { PanelHeader } from './PanelHeader'
import { OptionButton } from './OptionButton'
import SearchService, { SearchResult } from '../../services/searchService'
import { useProjectStore } from '../../stores/projectStore'
import { logger } from '../../utils/logger'
import { t } from '@/i18n'
import SearchInputArea from './search/SearchInputArea'
import SearchFilters from './search/SearchFilters'
import SearchResultsList from './search/SearchResultsList'
import { FileResult, FileMatchResult, convertToFileResults } from './search/types'

interface SearchPanelProps {
  onFileSelect?: (path: string, line?: number, column?: number) => void
}

// Max files rendered to prevent DOM explosion
const MAX_RENDERED_FILES = 200

function SearchPanel({ onFileSelect }: SearchPanelProps) {
  const [searchTerm, setSearchTerm] = useState('')
  const [replaceTerm, setReplaceTerm] = useState('')
  const [isReplaceVisible, setIsReplaceVisible] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [fileResults, setFileResults] = useState<FileResult[]>([])
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ripgrepAvailable, setRipgrepAvailable] = useState<boolean | null>(null)
  const [includePatterns, setIncludePatterns] = useState('')
  const [excludePatterns, setExcludePatterns] = useState('')
  const currentProject = useProjectStore(state => state.currentProject)

  // Use refs for search options to avoid dependency loop in handleSearchTermChange
  const caseSensitiveRef = useRef(caseSensitive)
  const wholeWordRef = useRef(wholeWord)
  const useRegexRef = useRef(useRegex)
  const includePatternsRef = useRef(includePatterns)
  const excludePatternsRef = useRef(excludePatterns)

  // Keep refs in sync
  caseSensitiveRef.current = caseSensitive
  wholeWordRef.current = wholeWord
  useRegexRef.current = useRegex
  includePatternsRef.current = includePatterns
  excludePatternsRef.current = excludePatterns

  useEffect(() => {
    async function checkRipgrep() {
      try {
        const available = await SearchService.shared.checkRipgrepAvailable()
        setRipgrepAvailable(available)
        if (!available) setError(t('search.ripgrepMissing'))
      } catch {
        setRipgrepAvailable(false)
        setError(t('search.ripgrepCheckFailed'))
      }
    }
    checkRipgrep()
    return () => SearchService.shared.cancelSearch()
  }, [])

  // Build options from current ref values (no dependency issues)
  const buildCurrentOpts = useCallback(() =>
    SearchService.shared.buildSearchOptions(
      caseSensitiveRef.current, wholeWordRef.current, useRegexRef.current,
      includePatternsRef.current, excludePatternsRef.current
    ),
    [] // stable — reads from refs
  )

  const applyResults = useCallback((result: SearchResult) => {
    setSearchResult(result)
    // Limit rendered files and collapse all by default to prevent DOM explosion
    const files = convertToFileResults(result)
    setFileResults(files.slice(0, MAX_RENDERED_FILES))
  }, [])

  const handleSearch = useCallback(async () => {
    if (!searchTerm.trim() || !currentProject?.path || !ripgrepAvailable) return
    setIsSearching(true)
    setError(null)
    try {
      const result = await SearchService.shared.searchInFiles(searchTerm, currentProject.path, buildCurrentOpts())
      applyResults(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
      setSearchResult(null)
      setFileResults([])
    } finally {
      setIsSearching(false)
    }
  }, [searchTerm, currentProject?.path, ripgrepAvailable, buildCurrentOpts, applyResults])

  // Stable callback — uses refs for options, no dependency on buildOpts
  const handleSearchTermChange = useCallback((value: string) => {
    setSearchTerm(value)
    if (value.trim() && currentProject?.path) {
      SearchService.shared.debouncedSearch(value.trim(), currentProject.path, buildCurrentOpts(), (result) => {
        applyResults(result)
      })
    } else if (!value.trim()) {
      setFileResults([])
      setSearchResult(null)
    }
  }, [currentProject?.path, buildCurrentOpts, applyResults])

  const toggleFileExpansion = useCallback((filePath: string) => {
    setFileResults(prev => prev.map(f => f.file === filePath ? { ...f, isExpanded: !f.isExpanded } : f))
  }, [])

  const handleResultClick = useCallback((result: FileMatchResult) => {
    onFileSelect?.(result.file, result.line, result.column)
  }, [onFileSelect])

  const handleReplace = useCallback(async () => {
    if (!replaceTerm.trim() || !currentProject?.path || !searchTerm.trim()) return
    try {
      const affectedFiles = await SearchService.shared.replaceInFiles(searchTerm, replaceTerm, currentProject.path, buildCurrentOpts())
      await handleSearch()
      logger.debug('search', `Replaced "${searchTerm}" with "${replaceTerm}" in ${affectedFiles} files`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Replace failed')
    }
  }, [searchTerm, replaceTerm, currentProject?.path, buildCurrentOpts, handleSearch])

  const clearSearch = useCallback(() => {
    SearchService.shared.cancelSearch()
    setSearchTerm('')
    setReplaceTerm('')
    setFileResults([])
    setSearchResult(null)
    setError(null)
  }, [])

  // Re-search when options change (if there's an active search term)
  useEffect(() => {
    if (searchTerm.trim() && currentProject?.path && ripgrepAvailable) {
      SearchService.shared.debouncedSearch(searchTerm.trim(), currentProject.path, buildCurrentOpts(), (result) => {
        applyResults(result)
      }, 500)
    }
  }, [caseSensitive, wholeWord, useRegex, includePatterns, excludePatterns])

  return (
    <VStack height="100%" bg="bg.sidebar" align="stretch" gap={0}>
      <PanelHeader
        title={t('search.title')}
        rightControls={
          <>
            <OptionButton label={t('search.toggleReplace')} icon={FiSearch} isActive={isReplaceVisible} onClick={() => setIsReplaceVisible(!isReplaceVisible)} />
            <OptionButton label={t('search.clearSearch')} icon={FiX} onClick={clearSearch} />
            <OptionButton label={t('search.moreOptions')} icon={FiMoreHorizontal} onClick={() => logger.debug('search', 'More options clicked')} />
          </>
        }
      />
      <SearchInputArea
        searchTerm={searchTerm} replaceTerm={replaceTerm} isReplaceVisible={isReplaceVisible}
        isSearching={isSearching} caseSensitive={caseSensitive} wholeWord={wholeWord} useRegex={useRegex}
        ripgrepAvailable={ripgrepAvailable} hasProject={!!currentProject}
        onSearchTermChange={handleSearchTermChange} onReplaceTermChange={setReplaceTerm} onSearch={handleSearch}
        onToggleCaseSensitive={() => setCaseSensitive(!caseSensitive)}
        onToggleWholeWord={() => setWholeWord(!wholeWord)}
        onToggleRegex={() => setUseRegex(!useRegex)}
      />
      <SearchFilters
        includePatterns={includePatterns} excludePatterns={excludePatterns}
        onIncludeChange={setIncludePatterns} onExcludeChange={setExcludePatterns}
      />
      <SearchResultsList
        fileResults={fileResults} searchResult={searchResult} searchTerm={searchTerm}
        isSearching={isSearching} isReplaceVisible={isReplaceVisible} replaceTerm={replaceTerm} error={error}
        onToggleFileExpansion={toggleFileExpansion} onResultClick={handleResultClick} onReplace={handleReplace}
        onFileSelect={(path) => onFileSelect?.(path, 1, 1)}
      />
    </VStack>
  )
}

export default memo(SearchPanel)
