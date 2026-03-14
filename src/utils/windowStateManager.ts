import { useProjectStore } from '../stores/projectStore';

export class WindowStateManager {
  private resizeHandler: (() => void) | null = null;

  enable(): void {
    if (this.resizeHandler) return;

    this.resizeHandler = () => {
      const { setWindowState } = useProjectStore.getState();
      setWindowState({
        width: window.innerWidth,
        height: window.innerHeight,
        x: window.screenX,
        y: window.screenY,
        maximized: false,
      });
    };

    window.addEventListener('resize', this.resizeHandler);
  }

  disable(): void {
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
  }
}
