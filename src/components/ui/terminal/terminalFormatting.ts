/**
 * Output formatting utilities for the terminal.
 * Handles colorizing file items and formatting command output
 * for columnar display.
 */

/**
 * Add ANSI color codes to file/directory items based on their type.
 */
export function addColorToItems(items: string[]): string[] {
  return items.map(item => {
    // Directory coloring (assume items ending with / or common directory names)
    if (item.endsWith('/') || ['node_modules', 'src', 'public', 'dist', 'build', '.git', '.vscode'].includes(item)) {
      return `\x1b[34m${item}\x1b[0m`; // Blue color for directories
    }

    // File type coloring
    const ext = item.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'js': case 'jsx': case 'ts': case 'tsx':
        return `\x1b[33m${item}\x1b[0m`; // Yellow for JS/TS
      case 'json':
        return `\x1b[32m${item}\x1b[0m`; // Green for JSON
      case 'md': case 'txt':
        return `\x1b[36m${item}\x1b[0m`; // Cyan for docs
      case 'css': case 'scss': case 'sass':
        return `\x1b[35m${item}\x1b[0m`; // Magenta for styles
      case 'html': case 'htm':
        return `\x1b[31m${item}\x1b[0m`; // Red for HTML
      case 'png': case 'jpg': case 'jpeg': case 'gif': case 'svg':
        return `\x1b[95m${item}\x1b[0m`; // Bright magenta for images
      case 'gitignore':
      case 'env':
      case 'yml': case 'yaml':
        return `\x1b[90m${item}\x1b[0m`; // Gray for config files
      default:
        return item; // Default - no color
    }
  });
}

/**
 * Format command output for terminal display.
 * Handles special formatting for `ls`, `dir`, `tree`, and generic commands.
 */
export function formatCommandOutput(command: string, output: string, terminalCols: number = 80): string {
  const trimmedCommand = command.trim().split(' ')[0];

  // Format ls output
  if (trimmedCommand === 'ls') {
    const items = output.trim().split(/\s+/).filter(item => item.length > 0);
    if (items.length === 0) return output;

    // Check if it's a long format (ls -l, ls -la, etc)
    if (command.includes('-l')) {
      return output.replace(/\n/g, '\r\n'); // Keep original format but fix line endings
    }

    // Add colors unless using --no-color or similar
    const enhancedItems = command.includes('--no-color') ? items : addColorToItems(items);

    // Calculate optimal column width
    const maxItemLength = Math.max(...items.map(item => item.length)) + 2; // Extra space for padding
    const columnWidth = Math.min(maxItemLength + 2, Math.floor(terminalCols / 3));
    const numColumns = Math.max(1, Math.min(3, Math.floor(terminalCols / columnWidth)));

    if (numColumns === 1) {
      // Single column format
      return enhancedItems.join('\r\n') + '\r\n';
    } else {
      // Multi-column format
      const result: string[] = [];
      for (let i = 0; i < enhancedItems.length; i += numColumns) {
        const row = enhancedItems.slice(i, i + numColumns);
        const formattedRow = row.map((item) => {
          // Remove ANSI codes for padding calculation
          const plainItem = item.replace(/\x1b\[[0-9;]*m/g, '');
          const padding = Math.max(0, columnWidth - plainItem.length);
          return item + ' '.repeat(padding);
        }).join('');
        result.push(formattedRow.trimEnd());
      }
      return result.join('\r\n') + '\r\n';
    }
  }

  // Format directory listing with colors
  if (['dir', 'tree'].includes(trimmedCommand)) {
    return output.replace(/\n/g, '\r\n');
  }

  // Default: just ensure proper line endings
  return output.replace(/\n/g, '\r\n');
}
