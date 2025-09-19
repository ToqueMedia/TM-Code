import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { PhysicalSize, PhysicalPosition } from '@tauri-apps/api/window';
import type { WindowState } from '../types/project';
import { logger } from '../utils/logger';

class WindowService {
  private static instance: WindowService;
  private mainWindow: WebviewWindow | null = null;
  private resizeTimeout: number | null = null;
  private readonly RESIZE_DEBOUNCE = 500; // 500ms debounce for resize events

  private constructor() {}

  static getInstance(): WindowService {
    if (!WindowService.instance) {
      WindowService.instance = new WindowService();
    }
    return WindowService.instance;
  }

  async initialize() {
    try {
      // Get the main window
      this.mainWindow = WebviewWindow.getCurrent();
      
      // Set up event listeners for window state changes
      this.setupEventListeners();
      
      logger.window('Window service initialized');
    } catch (error) {
      logger.error('window', 'Failed to initialize window service', error);
    }
  }

  private setupEventListeners() {
    if (!this.mainWindow) return;
    
    // Listen for resize events
    window.addEventListener('resize', () => {
      // Debounce resize events
      if (this.resizeTimeout) {
        clearTimeout(this.resizeTimeout);
      }
      
      this.resizeTimeout = window.setTimeout(() => {
        this.handleWindowResize();
      }, this.RESIZE_DEBOUNCE);
    });
    
    // Listen for move events
    // Note: There's no direct move event in web, but we can poll for position changes
    // or use Tauri's window events if available
  }

  private async handleWindowResize() {
    if (!this.mainWindow) return;
    
    try {
      // Get current window state
      const windowState = await this.getCurrentWindowState();
      
      // Emit event or call callback to update store
      window.dispatchEvent(new CustomEvent('windowStateChange', { detail: windowState }));
    } catch (error) {
      logger.error('window', 'Failed to handle window resize', error);
    }
  }

  async getCurrentWindowState(): Promise<WindowState> {
    try {
      if (!this.mainWindow) {
        // Fallback to browser window if Tauri window is not available
        return {
          width: window.innerWidth,
          height: window.innerHeight,
          x: window.screenX,
          y: window.screenY,
          maximized: false // We can't easily determine this in browser
        };
      }
      
      // Get window state from Tauri
      const size = await this.mainWindow.innerSize();
      const position = await this.mainWindow.outerPosition();
      const isMaximized = await this.mainWindow.isMaximized();
      
      return {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
        maximized: isMaximized
      };
    } catch (error: unknown) {
      logger.error('window', 'Failed to get current window state', error);
      
      // Fallback to browser window
      return {
        width: window.innerWidth,
        height: window.innerHeight,
        x: window.screenX,
        y: window.screenY,
        maximized: false
      };
    }
  }

  async setWindowState(state: WindowState): Promise<void> {
    try {
      if (!this.mainWindow) return;
      
      // Set window size
      await this.mainWindow.setSize(new PhysicalSize(state.width, state.height));
      
      // Set window position
      await this.mainWindow.setPosition(new PhysicalPosition(state.x, state.y));
      
      // Handle maximized state
      if (state.maximized) {
        await this.mainWindow.maximize();
      } else {
        await this.mainWindow.unmaximize();
      }
      
      logger.window('Window state set', state);
    } catch (error: unknown) {
      logger.error('window', 'Failed to set window state', error);
    }
  }

  async restoreWindowState(state: WindowState): Promise<void> {
    try {
      // Apply the saved window state
      await this.setWindowState(state);
      logger.window('Window state restored', state);
    } catch (error: unknown) {
      logger.error('window', 'Failed to restore window state', error);
    }
  }

  async saveWindowState(): Promise<WindowState> {
    try {
      const windowState = await this.getCurrentWindowState();
      
      // Save to localStorage for persistence across sessions
      localStorage.setItem('windowState', JSON.stringify(windowState));
      
      logger.window('Window state saved', windowState);
      return windowState;
    } catch (error: unknown) {
      logger.error('window', 'Failed to save window state', error);
      throw error;
    }
  }

  async loadWindowState(): Promise<WindowState | null> {
    try {
      const savedState = localStorage.getItem('windowState');
      if (savedState) {
        const windowState = JSON.parse(savedState) as WindowState;
        logger.window('Window state loaded', windowState);
        return windowState;
      }
      return null;
    } catch (error: unknown) {
      logger.error('window', 'Failed to load window state', error);
      return null;
    }
  }

  async reset() {
    // Clear any timeouts
    if (this.resizeTimeout) {
      clearTimeout(this.resizeTimeout);
      this.resizeTimeout = null;
    }
    
    // Nullify window reference
    this.mainWindow = null;
    
    logger.window('Window service reset');
  }
}

export default WindowService;