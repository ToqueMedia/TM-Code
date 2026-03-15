export { default as TerminalSession } from './TerminalSession';
export { default as TerminalTabBar } from './TerminalTabBar';
export { default as BackendProcessesSidebar } from './BackendProcessesSidebar';
export { terminalTheme } from './terminalTheme';
export { addColorToItems, formatCommandOutput } from './terminalFormatting';
export {
  getDisplayPath,
  displayPrompt,
  handleChangeDirectory,
  executeCommand,
} from './terminalCommands';
export { setupTerminalInput } from './terminalInput';
export type { TerminalSessionProps } from './TerminalSession';
