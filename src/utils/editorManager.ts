// src/utils/editorManager.ts
import { ProjectState } from '../types/project';

// In a real implementation, this would manage the editor state
// For now, it's just a placeholder

export class EditorManager {
  private static instance: EditorManager;
  private editorStates: Map<string, any> = new Map();

  private constructor() {}

  static getInstance(): EditorManager {
    if (!EditorManager.instance) {
      EditorManager.instance = new EditorManager();
    }
    return EditorManager.instance;
  }

  setEditorState(filePath: string, state: any): void {
    this.editorStates.set(filePath, state);
  }

  getEditorState(filePath: string): any {
    return this.editorStates.get(filePath);
  }

  removeEditorState(filePath: string): void {
    this.editorStates.delete(filePath);
  }

  closeFile(filePath: string): void {
    this.removeEditorState(filePath);
  }

  updateEditorState(filePath: string, state: any): void {
    this.setEditorState(filePath, state);
  }

  getAllEditorStates(): Record<string, any> {
    const states: Record<string, any> = {};
    this.editorStates.forEach((value, key) => {
      states[key] = value;
    });
    return states;
  }

  restoreProjectState(projectState: ProjectState): void {
    // Restore editor states from project state
    if (projectState.editorStates) {
      Object.entries(projectState.editorStates).forEach(([filePath, state]) => {
        this.setEditorState(filePath, state);
      });
    }
  }

  getProjectState(): ProjectState {
    return {
      openFiles: Array.from(this.editorStates.keys()),
      activeFile: null, // This would be managed separately
      cursorPositions: {}, // This would be managed separately
      editorStates: this.getAllEditorStates(),
      windowState: {
        width: 1200,
        height: 800,
        x: 100,
        y: 100,
        maximized: false,
      }
    };
  }
}