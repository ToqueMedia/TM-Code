import { memo, useState, useCallback, useEffect } from 'react'
import { VStack } from '@chakra-ui/react'
import { FiSearch, FiX, FiMoreHorizontal } from 'react-icons/fi'
import { PanelHeader } from './PanelHeader'
import { OptionButton } from './OptionButton'
import SearchService, { SearchResult } from '../../services/searchService'
import { useProjectStore } from '../../stores/projectStore'
import { logger } from '../../utils/logger'
import SearchInputArea from './search/SearchInputArea'
import SearchFilters from './search/SearchFilters'
import SearchResultsList from './search/SearchResultsList'
import { FileResult, FileMatchResult, convertToFileResults } from './search/types'

interface SearchPanelProps {
  onFileSelect?: (path: string, line?: number, column?: number) => void
}

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

  useEffect(() => {
    async function checkRipgrep() {
      try {
        const available = await SearchService.shared.checkRipgrepAvailable()
        setRipgrepAvailable(available)
        if (!available) setError('ripgrep (rg) is not installed. Please install it for search functionality.')
      } catch {
        setRipgrepAvailable(false)
        setError('Failed to check ripgrep availability')
      }
    }
    checkRipgrep()
    // Cancel pending debounced search on unmount
    return () => SearchService.shared.cancelSearch()
  }, [])

  const buildOpts = useCallback(() =>
    SearchService.shared.buildSearchOptions(caseSensitive, wholeWord, useRegex, includePatterns, excludePatterns),
    [caseSensitive, wholeWord, useRegex, includePatterns, excludePatterns]
  )

  const handleSearch = useCallback(async () => {
    if (!searchTerm.trim() || !currentProject?.path || !ripgrepAvailable) return
    setIsSearching(true)
    setError(null)
    try {
      const result = await SearchService.shared.searchInFiles(searchTerm, currentProject.path, buildOpts())
      setSearchResult(result)
      setFileResults(convertToFileResults(result))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
      setSearchResult(null)
      setFileResults([])
    } finally {
      setIsSearching(false)
    }
  }, [searchTerm, currentProject?.path, ripgrepAvailable, buildOpts])

  const handleSearchTermChange = useCallback((value: string) => {
    setSearchTerm(value)
    if (value.trim() && currentProject?.path) {
      SearchService.shared.debouncedSearch(value.trim(), currentProject.path, buildOpts(), (result) => {
        setSearchResult(result)
        setFileResults(convertToFileResults(result))
      })
    }
  }, [currentProject?.path, buildOpts])

  const toggleFileExpansion = useCallback((filePath: string) => {
    setFileResults(prev => prev.map(f => f.file === filePath ? { ...f, isExpanded: !f.isExpanded } : f))
  }, [])

  const handleResultClick = useCallback((result: FileMatchResult) => {
    onFileSelect?.(result.file, result.line, result.column)
  }, [onFileSelect])

  const handleReplace = useCallback(async () => {
    if (!replaceTerm.trim() || !currentProject?.path || !searchTerm.trim()) return
    try {
      const affectedFiles = await SearchService.shared.replaceInFiles(searchTerm, replaceTerm, currentProject.path, buildOpts())
      await handleSearch()
      logger.debug('search', `Replaced "${searchTerm}" with "${replaceTerm}" in ${affectedFiles} files`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Replace failed')
    }
  }, [searchTerm, replaceTerm, currentProject?.path, buildOpts, handleSearch])

  const clearSearch = useCallback(() => {
    SearchService.shared.cancelSearch()
    setSearchTerm('')
    setReplaceTerm('')
    setFileResults([])
    setSearchResult(null)
    setError(null)
  }, [])

  return (
    <VStack height="100%" bg="bg.sidebar" align="stretch" gap={0}>
      <PanelHeader
        title="Search"
        rightControls={
          <>
            <OptionButton label="Toggle replace" icon={FiSearch} isActive={isReplaceVisible} onClick={() => setIsReplaceVisible(!isReplaceVisible)} />
            <OptionButton label="Clear search" icon={FiX} onClick={clearSearch} />
            <OptionButton label="More options" icon={FiMoreHorizontal} onClick={() => logger.debug('search', 'More options clicked')} />
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
      />
    </VStack>
  )
}

export default memo(SearchPanel)
