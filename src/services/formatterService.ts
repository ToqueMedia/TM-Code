import { format } from 'prettier/standalone';
import * as prettierPluginBabel from 'prettier/plugins/babel';
import * as prettierPluginEstree from 'prettier/plugins/estree';
import * as prettierPluginTypescript from 'prettier/plugins/typescript';
import * as prettierPluginHtml from 'prettier/plugins/html';
import * as prettierPluginCss from 'prettier/plugins/postcss';
import * as prettierPluginMarkdown from 'prettier/plugins/markdown';
import { FileService } from './fileService';
import { logger } from '../utils/logger';

const plugins = [
  prettierPluginBabel,
  prettierPluginEstree,
  prettierPluginTypescript,
  prettierPluginHtml,
  prettierPluginCss,
  prettierPluginMarkdown,
];

// Map Monaco language IDs to Prettier parser names
// Only include languages whose parser plugins are bundled
const languageToParser: Record<string, string> = {
  javascript: 'babel',
  typescript: 'typescript',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  markdown: 'markdown',
};

// Fallback defaults when no .prettierrc is found
const DEFAULT_OPTIONS: Record<string, unknown> = {
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
};

// Config file names to search (in priority order)
const CONFIG_FILES = ['.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js'];

export class FormatterService {
  private static instance: FormatterService;
  private projectConfig: Record<string, unknown> | null = null;
  private projectConfigPath: string | null = null;
  private configLoadedAt: number = 0;

  static getInstance(): FormatterService {
    if (!FormatterService.instance) {
      FormatterService.instance = new FormatterService();
    }
    return FormatterService.instance;
  }

  canFormat(languageId: string): boolean {
    return languageId in languageToParser;
  }

  getParser(languageId: string): string | null {
    return languageToParser[languageId] || null;
  }

  /**
   * Load .prettierrc from the project root.
   * Caches for 30s then re-reads on next format.
   */
  async loadProjectConfig(projectPath: string): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (this.projectConfig && this.projectConfigPath === projectPath && now - this.configLoadedAt < 30000) {
      return this.projectConfig;
    }

    this.projectConfigPath = projectPath;
    this.projectConfig = {};
    this.configLoadedAt = now;

    for (const configFile of CONFIG_FILES) {
      try {
        const raw = await FileService.readFile(`${projectPath}/${configFile}`);
        if (configFile.endsWith('.json') || configFile === '.prettierrc') {
          try {
            this.projectConfig = JSON.parse(raw);
          } catch (parseErr) {
            logger.warn('formatter', `Invalid JSON in ${configFile}:`, parseErr);
            continue; // Try next config file
          }
          break;
        }
      } catch {
        // File not found — try next
      }
    }

    return this.projectConfig ?? {};
  }

  /** Clear cached config (call when project changes) */
  clearConfigCache(): void {
    this.projectConfig = null;
    this.projectConfigPath = null;
  }

  async formatCode(code: string, languageId: string, options?: Record<string, unknown>): Promise<string | null> {
    const parser = this.getParser(languageId);
    if (!parser) return null;

    try {
      const formatted = await format(code, {
        parser,
        plugins,
        ...DEFAULT_OPTIONS,
        ...this.projectConfig,  // Project config overrides defaults
        ...options,             // Explicit options override everything
      });
      return formatted;
    } catch (err) {
      logger.warn('formatter', `Prettier failed for ${languageId}:`, err);
      return null;
    }
  }
}
