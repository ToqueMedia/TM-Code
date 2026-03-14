import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { logger } from './logger';

export class WindowManager {
  private static instance: WindowManager;
  private windows: Map<string, WebviewWindow> = new Map();

  private constructor() {}

  static getInstance(): WindowManager {
    if (!WindowManager.instance) {
      WindowManager.instance = new WindowManager();
    }
    return WindowManager.instance;
  }

  async createWindow(windowId: string, options?: Partial<{ title: string; url: string; width: number; height: number }>): Promise<WebviewWindow> {
    // Check if window already exists
    if (this.windows.has(windowId)) {
      const existingWindow = this.windows.get(windowId)!;
      await existingWindow.show();
      await existingWindow.setFocus();
      return existingWindow;
    }

    // Create new window
    const window = new WebviewWindow(windowId, {
      title: options?.title || 'Diamond IDE',
      url: options?.url || '/index.html',
      width: options?.width || 1200,
      height: options?.height || 800,
      resizable: true,
      maximizable: true,
      minimizable: true,
      closable: true,
    });

    this.windows.set(windowId, window);
    
    // Handle window close event
    window.onCloseRequested(() => {
      this.windows.delete(windowId);
    });

    return window;
  }

  getWindow(windowId: string): WebviewWindow | undefined {
    return this.windows.get(windowId);
  }

  getAllWindows(): WebviewWindow[] {
    return Array.from(this.windows.values());
  }

  async closeWindow(windowId: string): Promise<void> {
    const window = this.windows.get(windowId);
    if (window) {
      await window.close();
      this.windows.delete(windowId);
    }
  }

  async closeAllWindows(): Promise<void> {
    const windows = Array.from(this.windows.values());
    this.windows.clear();
    
    for (const window of windows) {
      try {
        await window.close();
      } catch (error) {
        logger.error('ui', 'Failed to close window:', error);
      }
    }
  }
}