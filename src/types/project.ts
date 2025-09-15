export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  projectType: string;
  lastOpened: string;
  createdAt: string;
  metadata: Record<string, any>;
}

export interface RecentProject {
  id: string;
  name: string;
  path: string;
  lastOpened: string;
}

export interface ProjectState {
  openFiles: string[];
  activeFile: string | null;
  cursorPositions: Record<string, [number, number]>; // line, column
  editorStates: Record<string, any>;
  windowState: WindowState;
}

export interface WindowState {
  width: number;
  height: number;
  x: number;
  y: number;
  maximized: boolean;
}

export enum ProjectTemplate {
  Blank = "blank",
  React = "react",
  Node = "node",
  TypeScript = "typescript",
}

export interface GlobalSettings {
  recentProjects: RecentProject[];
  maxRecentProjects: number;
  editorSettings: Record<string, any>;
}