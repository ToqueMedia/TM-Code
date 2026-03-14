import { invoke } from '@tauri-apps/api/core';
import { logger } from '../utils/logger';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

export interface ProcessInfo {
  pid: number;
  command: string;
  args: string[];
  cwd: string;
}

export default class TerminalService {
  static shared = new TerminalService();

  // Executar comando simples e retornar resultado
  async executeCommand(command: string, cwd?: string): Promise<CommandResult> {
    try {
      let workingDir = cwd;
      if (!workingDir) {
        try {
          workingDir = await invoke('get_current_directory') as string;
        } catch {
          workingDir = '/'; // Fallback
        }
      }
      
      const result = await invoke('execute_command', {
        command,
        cwd: workingDir,
      });

      return result as CommandResult;
    } catch (error) {
      logger.error('terminal', 'Failed to execute command:', error);
      throw new Error(`Failed to execute command: ${error}`);
    }
  }

  // Iniciar processo interativo (para terminal em tempo real)
  async startInteractiveShell(cwd?: string): Promise<ProcessInfo> {
    try {
      let workingDir = cwd;
      if (!workingDir) {
        try {
          workingDir = await invoke('get_current_directory') as string;
        } catch {
          workingDir = '/'; // Fallback
        }
      }
      
      const processInfo = await invoke('start_interactive_shell', {
        cwd: workingDir,
      });

      return processInfo as ProcessInfo;
    } catch (error) {
      logger.error('terminal', 'Failed to start interactive shell:', error);
      throw new Error(`Failed to start interactive shell: ${error}`);
    }
  }

  // Enviar input para processo interativo
  async sendInput(pid: number, input: string): Promise<void> {
    try {
      await invoke('send_input_to_process', {
        pid,
        input,
      });
    } catch (error) {
      logger.error('terminal', 'Failed to send input to process:', error);
      throw new Error(`Failed to send input to process: ${error}`);
    }
  }

  // Matar processo
  async killProcess(pid: number): Promise<void> {
    try {
      await invoke('kill_process', {
        pid,
      });
    } catch (error) {
      logger.error('terminal', 'Failed to kill process:', error);
      throw new Error(`Failed to kill process: ${error}`);
    }
  }

  // Obter diretório atual
  async getCurrentDirectory(): Promise<string> {
    try {
      const cwd = await invoke('get_current_directory');
      return cwd as string;
    } catch (error) {
      logger.error('terminal', 'Failed to get current directory:', error);
      return '/'; // Fallback for Unix-like systems
    }
  }

  // Verificar se comando existe
  async commandExists(command: string): Promise<boolean> {
    try {
      const exists = await invoke('command_exists', { command });
      return exists as boolean;
    } catch (error) {
      logger.error('terminal', 'Failed to check if command exists:', error);
      return false;
    }
  }

  // Obter variáveis de ambiente
  async getEnvironmentVariables(): Promise<Record<string, string>> {
    try {
      const envVars = await invoke('get_environment_variables');
      return envVars as Record<string, string>;
    } catch (error) {
      logger.error('terminal', 'Failed to get environment variables:', error);
      return {};
    }
  }

  // Mudar diretório
  async changeDirectory(path: string): Promise<string> {
    try {
      const newCwd = await invoke('change_directory', { path });
      return newCwd as string;
    } catch (error) {
      logger.error('terminal', 'Failed to change directory:', error);
      throw new Error(`Failed to change directory: ${error}`);
    }
  }

  // Completar comando/path (para autocomplete)
  async getCompletions(partial: string, cwd?: string): Promise<string[]> {
    try {
      let workingDir = cwd;
      if (!workingDir) {
        try {
          workingDir = await invoke('get_current_directory') as string;
        } catch {
          workingDir = '/'; // Fallback
        }
      }
      
      const completions = await invoke('get_completions', {
        partial,
        cwd: workingDir,
      });

      return completions as string[];
    } catch (error) {
      logger.error('terminal', 'Failed to get completions:', error);
      return [];
    }
  }

  // Obter histórico de comandos
  async getCommandHistory(): Promise<string[]> {
    try {
      const history = await invoke('get_command_history');
      return history as string[];
    } catch (error) {
      logger.error('terminal', 'Failed to get command history:', error);
      return [];
    }
  }

  // Salvar comando no histórico
  async saveCommandToHistory(command: string): Promise<void> {
    try {
      await invoke('save_command_to_history', { command });
    } catch (error) {
      logger.error('terminal', 'Failed to save command to history:', error);
    }
  }

  // Limpar histórico
  async clearHistory(): Promise<void> {
    try {
      await invoke('clear_command_history');
    } catch (error) {
      logger.error('terminal', 'Failed to clear command history:', error);
    }
  }
}