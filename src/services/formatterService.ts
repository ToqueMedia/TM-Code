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

export class FormatterService {
  private static instance: FormatterService;

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

  async formatCode(code: string, languageId: string, options?: Record<string, unknown>): Promise<string | null> {
    const parser = this.getParser(languageId);
    if (!parser) return null;

    try {
      const formatted = await format(code, {
        parser,
        plugins,
        singleQuote: true,
        semi: true,
        trailingComma: 'all',
        printWidth: 100,
        tabWidth: 2,
        useTabs: false,
        ...options,
      });
      return formatted;
    } catch (err) {
      logger.warn('formatter', `Prettier failed for ${languageId}:`, err);
      return null;
    }
  }
}
