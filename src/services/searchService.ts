import { invoke } from '@/utils/invokeMetrics';
import { logger } from '../utils/logger';
import QuickOpenService from './quickOpenService';

export interface SearchOptions {
  case_sensitive: boolean;
  whole_word: boolean;
  use_regex: boolean;
  include_patterns: string[];
  exclude_patterns: string[];
  max_results?: number;
  context_lines?: number;
  /** Respeitar `.gitignore`. Omitido = sim (o Rust assume o default honesto). */
  respect_gitignore?: boolean;
}

export interface SearchMatch {
  line_number: number;
  column: number;
  text: string;
  match_text: string;
  context_before: string[];
  context_after: string[];
}

export interface FileSearchResult {
  file_path: string;
  matches: SearchMatch[];
  total_matches: number;
}

export interface FileNameMatch {
  file_path: string;
  file_name: string;
}

export interface SearchResult {
  query: string;
  total_files: number;
  total_matches: number;
  files: FileSearchResult[];
  file_name_matches: FileNameMatch[];
  duration_ms: number;
  truncated: boolean;
}

export default class SearchService {
  static shared = new SearchService();

  // Check if ripgrep is available on the system
  async checkRipgrepAvailable(): Promise<boolean> {
    try {
      const result = await invoke('check_ripgrep_available') as boolean;
      return result;
    } catch (error) {
      logger.error('search', 'Error checking ripgrep availability:', error);
      return false;
    }
  }

  // Perform global search across files
  async searchInFiles(
    query: string,
    directory: string,
    options: SearchOptions
  ): Promise<SearchResult> {
    try {
      if (!query.trim()) {
        return {
          query,
          total_files: 0,
          total_matches: 0,
          files: [],
          file_name_matches: [],
          duration_ms: 0,
          truncated: false,
        };
      }

      const result = await invoke('search_in_files', {
        query,
        directory,
        options,
      }) as SearchResult;

      // File name search: use QuickOpenService's in-memory index (instant, no IPC)
      const fileMatches = QuickOpenService.getInstance().search(query.trim(), 20);
      result.file_name_matches = fileMatches.map(f => ({
        file_path: f.path,
        file_name: f.name,
      }));

      return result;
    } catch (error) {
      logger.error('search', 'Search error:', error);
      throw new Error(`Search failed: ${error}`);
    }
  }

  // Replace text across files
  async replaceInFiles(
    query: string,
    replacement: string,
    directory: string,
    options: SearchOptions
  ): Promise<number> {
    try {
      if (!query.trim()) {
        throw new Error('Search query cannot be empty');
      }

      const affectedFiles = await invoke('replace_in_files', {
        query,
        replacement,
        directory,
        options,
      }) as number;

      return affectedFiles;
    } catch (error) {
      logger.error('search', 'Replace error:', error);
      throw new Error(`Replace failed: ${error}`);
    }
  }

  // Get default search options
  getDefaultOptions(): SearchOptions {
    return {
      case_sensitive: false,
      whole_word: false,
      use_regex: false,
      include_patterns: [],
      exclude_patterns: [
        'node_modules/**',
        '.git/**',
        'dist/**',
        'build/**',
        '.next/**',
        'coverage/**',
        '*.min.js',
        '*.map'
      ],
      max_results: 1000,
      context_lines: 0,
    };
  }

  // Parse include/exclude patterns from string
  parsePatterns(patternsString: string): string[] {
    return patternsString
      .split(',')
      .map(pattern => pattern.trim())
      .filter(pattern => pattern.length > 0);
  }

  // Build search options from UI state
  buildSearchOptions(
    caseSensitive: boolean,
    wholeWord: boolean,
    useRegex: boolean,
    includePatterns: string = '',
    excludePatterns: string = '',
    maxResults?: number,
    contextLines?: number,
    /** Ver `.gitignore`'d paths (build output, vendored code). Default: não. */
    includeIgnored: boolean = false
  ): SearchOptions {
    const defaultOptions = this.getDefaultOptions();
    
    return {
      case_sensitive: caseSensitive,
      whole_word: wholeWord,
      use_regex: useRegex,
      // O agente ganhou este escape quando a busca passou a filtrar por
      // omissão; o painel humano ficou sem ele — o developer via menos do que
      // o modelo podia pedir. Mesma opção, mesma semântica.
      respect_gitignore: !includeIgnored,
      include_patterns: includePatterns 
        ? this.parsePatterns(includePatterns)
        : [],
      exclude_patterns: excludePatterns
        ? this.parsePatterns(excludePatterns)
        : defaultOptions.exclude_patterns,
      max_results: maxResults || defaultOptions.max_results,
      context_lines: contextLines ?? defaultOptions.context_lines,
    };
  }

  // Format search results for display
  formatResultsForDisplay(searchResult: SearchResult, searchDir?: string) {
    if (searchDir) this.currentSearchDir = searchDir;
    return {
      ...searchResult,
      files: searchResult.files.map(file => ({
        ...file,
        file_path: this.getRelativePath(file.file_path),
        matches: file.matches.map(match => ({
          ...match,
          text: this.highlightMatch(match.text, match.match_text),
          line_display: `${match.line_number}:${match.column}`,
        }))
      }))
    };
  }

  // Store the current search directory for relative path computation
  private currentSearchDir: string = '';

  // Get relative path for display using the project root
  private getRelativePath(fullPath: string): string {
    if (this.currentSearchDir && fullPath.startsWith(this.currentSearchDir)) {
      const relative = fullPath.slice(this.currentSearchDir.length);
      return (relative.startsWith('/') || relative.startsWith('\\')) ? relative.slice(1) : relative;
    }
    return fullPath;
  }

  // Highlight matching text
  private highlightMatch(text: string, matchText: string): string {
    if (!matchText) return text;
    
    const regex = new RegExp(`(${this.escapeRegex(matchText)})`, 'gi');
    return text.replace(regex, '<mark>$1</mark>');
  }

  // Escape regex special characters
  private escapeRegex(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Debounced search function
  private searchTimeout: NodeJS.Timeout | null = null;
  
  debouncedSearch(
    query: string,
    directory: string,
    options: SearchOptions,
    callback: (result: SearchResult) => void,
    delay: number = 300
  ): void {
    if (this.searchTimeout) {
      clearTimeout(this.searchTimeout);
    }

    const capturedDirectory = directory;
    this.searchTimeout = setTimeout(async () => {
      try {
        // Validate the directory is still the current project (guards against stale closure
        // if user switches project during the debounce delay)
        const { useProjectStore } = await import('../stores/projectStore');
        const currentPath = useProjectStore.getState().currentProject?.path;
        if (currentPath && !capturedDirectory.startsWith(currentPath)) return;

        const result = await this.searchInFiles(query, capturedDirectory, options);
        callback(result);
      } catch (error) {
        logger.error('search', 'Debounced search error:', error);
        callback({
          query,
          total_files: 0,
          total_matches: 0,
          files: [],
          file_name_matches: [],
          duration_ms: 0,
          truncated: false,
        });
      }
    }, delay);
  }

  // Cancel ongoing search
  cancelSearch(): void {
    if (this.searchTimeout) {
      clearTimeout(this.searchTimeout);
      this.searchTimeout = null;
    }
  }
}
