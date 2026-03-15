import { tokens } from '@/theme/tokens';
import type { ITheme } from '@xterm/xterm';

/**
 * XTerm terminal theme built from design tokens.
 */
export const terminalTheme: ITheme = {
  background: tokens.colors.terminal.background,
  foreground: tokens.colors.terminal.foreground,
  cursor: tokens.colors.terminal.cursor,
  cursorAccent: tokens.colors.terminal.cursorAccent,
  selectionBackground: tokens.colors.terminal.selectionBackground,
  black: tokens.colors.terminal.black,
  red: tokens.colors.terminal.red,
  green: tokens.colors.terminal.green,
  yellow: tokens.colors.terminal.yellow,
  blue: tokens.colors.terminal.blue,
  magenta: tokens.colors.terminal.magenta,
  cyan: tokens.colors.terminal.cyan,
  white: tokens.colors.terminal.white,
  brightBlack: tokens.colors.terminal.brightBlack,
  brightRed: tokens.colors.terminal.brightRed,
  brightGreen: tokens.colors.terminal.brightGreen,
  brightYellow: tokens.colors.terminal.brightYellow,
  brightBlue: tokens.colors.terminal.brightBlue,
  brightMagenta: tokens.colors.terminal.brightMagenta,
  brightCyan: tokens.colors.terminal.brightCyan,
  brightWhite: tokens.colors.terminal.brightWhite,
};
