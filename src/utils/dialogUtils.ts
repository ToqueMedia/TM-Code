// src/utils/dialogUtils.ts

/**
 * Checks if we're running in a Tauri context (Tauri v2 compatible)
 * @returns boolean indicating if we're in a Tauri context
 */
function isTauriContext(): boolean {
  try {
    // @ts-ignore
    return !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
  } catch (error) {
    return false;
  }
}

/**
 * Opens a directory selection dialog using Tauri's dialog plugin
 * @returns Promise resolving to the selected directory path or null if cancelled
 */
export async function openDirectoryDialog(): Promise<string | null> {
  try {
    // Check if we're in a Tauri context (Tauri v2 compatible)
    const isTauri = isTauriContext();
    
    console.log('Tauri context check:', isTauri);
    
    if (!isTauri) {
      // In a browser context, we can't use the native dialog
      throw new Error('Directory selection is only available in the desktop app.');
    }
    
    // Dynamically import the dialog plugin to avoid issues in browser context
    console.log('Importing dialog plugin...');
    const { open } = await import('@tauri-apps/plugin-dialog');
    console.log('Dialog plugin imported successfully');
    
    console.log('Opening directory dialog...');
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Select project directory'
    });
    
    console.log('Selected path:', selected);
    return selected as string | null;
  } catch (error: unknown) {
    console.error('Failed to open directory dialog:', error);
    if (error instanceof Error) {
      throw new Error(error.message || 'Failed to open directory dialog. Please try again.');
    } else {
      throw new Error('Failed to open directory dialog. Please try again.');
    }
  }
}