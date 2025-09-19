import { invoke } from '@tauri-apps/api/core';

export interface SearchOptions {
  case_sensitive: boolean;
  whole_word: boolean;
  use_regex: boolean;
  include_patterns: string[];
  exclude_patterns: string[];
  max_results?: number;
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

export interface SearchResult {
  query: string;
  total_files: number;
  total_matches: number;
  files: FileSearchResult[];
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
      console.error('Error checking ripgrep availability:', error);
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
          duration_ms: 0,
          truncated: false,
        };
      }

      const result = await invoke('search_in_files', {
        query,
        directory,
        options,
      }) as SearchResult;

      return result;
    } catch (error) {
      console.error('Search error:', error);
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
      console.error('Replace error:', error);
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
    maxResults?: number
  ): SearchOptions {
    const defaultOptions = this.getDefaultOptions();
    
    return {
      case_sensitive: caseSensitive,
      whole_word: wholeWord,
      use_regex: useRegex,
      include_patterns: includePatterns 
        ? this.parsePatterns(includePatterns)
        : [],
      exclude_patterns: excludePatterns
        ? this.parsePatterns(excludePatterns)
        : defaultOptions.exclude_patterns,
      max_results: maxResults || defaultOptions.max_results,
    };
  }

  // Format search results for display
  formatResultsForDisplay(searchResult: SearchResult) {
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

  // Get relative path for display
  private getRelativePath(fullPath: string): string {
    // Simple relative path extraction - could be enhanced
    const segments = fullPath.split('/');
    const srcIndex = segments.findIndex(seg => seg === 'src');
    
    if (srcIndex >= 0) {
      return segments.slice(srcIndex).join('/');
    }
    
    return segments.slice(-3).join('/'); // Last 3 segments
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

    this.searchTimeout = setTimeout(async () => {
      try {
        const result = await this.searchInFiles(query, directory, options);
        callback(result);
      } catch (error) {
        console.error('Debounced search error:', error);
        callback({
          query,
          total_files: 0,
          total_matches: 0,
          files: [],
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