import { SearchResult } from '../../../services/searchService'

export interface FileMatchResult {
  id: string
  file: string
  line: number
  column: number
  text: string
  match: string
  context: string
}

export interface FileResult {
  file: string
  matches: FileMatchResult[]
  isExpanded: boolean
}

export function convertToFileResults(result: SearchResult): FileResult[] {
  // Collapse all by default to avoid rendering thousands of match nodes at once.
  // Only expand the first 5 files for immediate visibility.
  return result.files.map((file, idx) => ({
    file: file.file_path,
    isExpanded: idx < 5,
    matches: file.matches.map(match => ({
      id: `${file.file_path}-${match.line_number}-${match.column}`,
      file: file.file_path,
      line: match.line_number,
      column: match.column,
      text: match.text,
      match: match.match_text,
      context: match.text
    }))
  }))
}
