import { FileService } from '../services/fileService';

export interface QueuedFile {
  path: string;
  content: string;
  timestamp: number;
  retryCount: number;
}

export class AutoSaveQueue {
  private static instance: AutoSaveQueue | null = null;
  private queue: Map<string, QueuedFile> = new Map();
  private timer: number | null = null;
  private isProcessing = false;
  private readonly debounceDelay = 5000; // 5 segundos (aumentado de 1s)
  private readonly batchSize = 10; // Processar até 10 arquivos por vez
  private readonly maxRetries = 3;

  private constructor() {
    // Privado para singleton
  }

  static getInstance(): AutoSaveQueue {
    if (!AutoSaveQueue.instance) {
      AutoSaveQueue.instance = new AutoSaveQueue();
    }
    return AutoSaveQueue.instance;
  }

  static destroy() {
    if (AutoSaveQueue.instance) {
      AutoSaveQueue.instance.clear();
      AutoSaveQueue.instance = null;
    }
  }

  /**
   * Adiciona um arquivo à queue de auto-save
   */
  addToQueue(path: string, content: string): void {
    const existingFile = this.queue.get(path);
    
    // Se o arquivo já existe na queue, atualiza apenas o conteúdo e timestamp
    this.queue.set(path, {
      path,
      content,
      timestamp: Date.now(),
      retryCount: existingFile?.retryCount || 0
    });

    this.scheduleSave();
  }

  /**
   * Remove um arquivo da queue (usado quando salvo manualmente)
   */
  removeFromQueue(path: string): void {
    this.queue.delete(path);
  }

  /**
   * Agenda o processamento da queue
   */
  private scheduleSave(): void {
    // Se já está processando, não agenda novo timer
    if (this.isProcessing) {
      return;
    }

    // Cancela timer anterior se existir
    if (this.timer) {
      window.clearTimeout(this.timer);
    }

    // Agenda novo processamento
    this.timer = window.setTimeout(() => {
      this.processBatch();
    }, this.debounceDelay);
  }

  /**
   * Processa a queue em batches
   */
  private async processBatch(): Promise<void> {
    if (this.isProcessing || this.queue.size === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      // Pega os arquivos mais antigos primeiro (FIFO)
      const files = Array.from(this.queue.values())
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(0, this.batchSize);

      if (files.length === 0) {
        return;
      }

      // Processa arquivos em paralelo (mas limitado pelo batch size)
      const results = await Promise.allSettled(
        files.map(file => this.saveFile(file))
      );

      // Processa resultados
      results.forEach((result, index) => {
        const file = files[index];
        
        if (result.status === 'fulfilled') {
          // Sucesso - remove da queue
          this.queue.delete(file.path);
          console.debug(`Auto-saved: ${file.path}`);
        } else {
          // Falha - incrementa retry count
          if (file.retryCount < this.maxRetries) {
            this.queue.set(file.path, {
              ...file,
              retryCount: file.retryCount + 1,
              timestamp: Date.now() + (file.retryCount + 1) * 2000 // Backoff exponencial
            });
            console.warn(`Failed to auto-save ${file.path}, retry ${file.retryCount + 1}/${this.maxRetries}`);
          } else {
            // Máximo de tentativas atingido - remove da queue
            this.queue.delete(file.path);
            console.error(`Failed to auto-save ${file.path} after ${this.maxRetries} retries:`, result.reason);
          }
        }
      });

      // Se ainda há arquivos na queue, agenda novo processamento
      if (this.queue.size > 0) {
        this.scheduleSave();
      }

    } catch (error) {
      console.error('Error processing auto-save batch:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Salva um arquivo individual
   */
  private async saveFile(file: QueuedFile): Promise<void> {
    try {
      await FileService.writeFile(file.path, file.content);
    } catch (error) {
      throw new Error(`Failed to save ${file.path}: ${error}`);
    }
  }

  /**
   * Força o processamento imediato de todos os arquivos na queue
   */
  async flushAll(): Promise<void> {
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }

    while (this.queue.size > 0) {
      await this.processBatch();
      
      // Pequena pausa para evitar sobrecarga
      if (this.queue.size > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  /**
   * Força o salvamento de um arquivo específico
   */
  async flushFile(path: string): Promise<void> {
    const file = this.queue.get(path);
    if (!file) {
      return;
    }

    try {
      await this.saveFile(file);
      this.queue.delete(path);
      console.debug(`Force saved: ${path}`);
    } catch (error) {
      console.error(`Failed to force save ${path}:`, error);
      throw error;
    }
  }

  /**
   * Limpa toda a queue sem salvar
   */
  clear(): void {
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue.clear();
    this.isProcessing = false;
  }

  /**
   * Retorna estatísticas da queue
   */
  getStats(): {
    queueSize: number;
    isProcessing: boolean;
    oldestFile?: string;
    newestFile?: string;
  } {
    if (this.queue.size === 0) {
      return { queueSize: 0, isProcessing: this.isProcessing };
    }

    const files = Array.from(this.queue.values());
    const sorted = files.sort((a, b) => a.timestamp - b.timestamp);

    return {
      queueSize: this.queue.size,
      isProcessing: this.isProcessing,
      oldestFile: sorted[0]?.path,
      newestFile: sorted[sorted.length - 1]?.path
    };
  }

  /**
   * Verifica se um arquivo está na queue
   */
  hasFile(path: string): boolean {
    return this.queue.has(path);
  }

  /**
   * Retorna o tempo restante até o próximo processamento
   */
  getTimeUntilNextSave(): number {
    if (!this.timer) {
      return 0;
    }
    
    // Esta é uma aproximação - o timer real pode variar
    return this.debounceDelay;
  }
}