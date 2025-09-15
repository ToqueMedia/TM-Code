import { useProjectStore } from '../stores/projectStore';

export class WindowStateManager {
  private resizeHandler: (() => void) | null = null;
  private moveHandler: (() => void) | null = null;

  enable(): void {
    if (this.resizeHandler || this.moveHandler) return;

    this.resizeHandler = () => {
      const { setWindowState } = useProjectStore.getState();
      setWindowState({
        width: window.innerWidth,
        height: window.innerHeight,
        x: window.screenX,
        y: window.screenY,
        maximized: false, // TODO: Detect if window is maximized
      });
    };

    this.moveHandler = () => {
      const { setWindowState } = useProjectStore.getState();
      setWindowState({
        width: window.innerWidth,
        height: window.innerHeight,
        x: window.screenX,
        y: window.screenY,
        maximized: false, // TODO: Detect if window is maximized
      });
    };

    window.addEventListener('resize', this.resizeHandler);
    window.addEventListener('move', this.moveHandler);
  }

  disable(): void {
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
    if (this.moveHandler) {
      window.removeEventListener('move', this.moveHandler);
      this.moveHandler = null;
    }
  }
}