import { useEffect, useRef } from 'react';
import type { Monaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { toqueMediaTheme, toqueMediaSoftTheme } from '../themes/toqueMediaTheme';
import { logger } from '../utils/logger';

// Global state to track theme initialization
let themesInitialized = false;

/**
 * Custom hook to manage Monaco Editor theme persistence
 * Ensures that the custom theme is applied and maintained throughout the editor lifecycle
 */
export function useMonacoTheme(
  editorInstance: editor.IStandaloneCodeEditor | null,
  monaco: Monaco | null
) {
  const themeAppliedRef = useRef(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize themes globally
  useEffect(() => {
    if (monaco && !themesInitialized) {
      try {
        monaco.editor.defineTheme('toquemedia-vibrant', toqueMediaTheme);
        monaco.editor.defineTheme('toquemedia-soft', toqueMediaSoftTheme);
        themesInitialized = true;
        logger.theme('ToqueMedia themes initialized globally');
      } catch (error) {
        logger.error('theme', 'Error initializing themes', error);
      }
    }
  }, [monaco]);

  // Apply theme to editor instance
  const applyTheme = (themeName: string = 'toquemedia-vibrant') => {
    if (!editorInstance || !monaco) return false;

    try {
      // Apply theme globally
      monaco.editor.setTheme(themeName);
      
      // Apply theme to specific editor instance
      editorInstance.updateOptions({ theme: themeName });
      
      logger.theme(`Theme '${themeName}' applied successfully`);
      return true;
    } catch (error) {
      logger.error('theme', 'Error applying theme', error);
      
      // Fallback to vs-dark
      try {
        monaco.editor.setTheme('vs-dark');
        editorInstance.updateOptions({ theme: 'vs-dark' });
        logger.theme('Fallback to vs-dark theme applied');
      } catch (fallbackError) {
        logger.error('theme', 'Even fallback theme failed', fallbackError);
      }
      
      return false;
    }
  };

  // Apply theme when editor is ready
  useEffect(() => {
    if (editorInstance && monaco && themesInitialized && !themeAppliedRef.current) {
      const success = applyTheme();
      if (success) {
        themeAppliedRef.current = true;
      }

      // Apply theme with delays to ensure it sticks
      setTimeout(() => applyTheme(), 100);
      setTimeout(() => applyTheme(), 500);
      setTimeout(() => applyTheme(), 1000);
    }
  }, [editorInstance, monaco]);

  // Set up theme persistence monitoring
  useEffect(() => {
    if (editorInstance && monaco && themesInitialized) {
      // Clear any existing interval
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }

      // Monitor and reapply theme every 10 seconds
      intervalRef.current = setInterval(() => {
        applyTheme();
      }, 10000);

      // Cleanup interval on unmount
      return () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
        }
      };
    }
  }, [editorInstance, monaco]);

  // Listen for Monaco editor theme changes and override them
  useEffect(() => {
    if (monaco && themesInitialized) {
      // Override any external theme changes
      const originalSetTheme = monaco.editor.setTheme;
      monaco.editor.setTheme = function(themeName: string) {
        // Allow our themes, but override others with our theme
        if (themeName.startsWith('toquemedia-')) {
          return originalSetTheme.call(this, themeName);
        } else {
          logger.theme(`Theme change intercepted: ${themeName} -> toquemedia-vibrant`);
          return originalSetTheme.call(this, 'toquemedia-vibrant');
        }
      };

      // Cleanup on unmount
      return () => {
        monaco.editor.setTheme = originalSetTheme;
      };
    }
  }, [monaco]);

  // Return utility functions
  return {
    applyTheme,
    themesInitialized,
    switchToVibrant: () => applyTheme('toquemedia-vibrant'),
    switchToSoft: () => applyTheme('toquemedia-soft'),
  };
}

export default useMonacoTheme;