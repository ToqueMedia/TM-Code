# Project Management System

This document outlines the implementation plan for the project management system in the Diamond IDE.

## Overview

The project management system provides core functionality for creating, opening, and managing projects within the IDE. It includes both backend (Rust) and frontend (TypeScript/React) components.

## Architecture

### Backend (Rust)

The backend is implemented as Tauri commands in the `src-tauri/src/commands/project.rs` file. It provides the following functionality:

1. **Project Operations**:
   - `open_project(path: String)` - Opens an existing project
   - `create_project(path: String, template: ProjectTemplate)` - Creates a new project
   - `get_recent_projects()` - Retrieves recently opened projects
   - `save_project_state(project_id: String, state: ProjectState)` - Saves project state
   - `load_project_state(project_id: String)` - Loads project state

2. **Data Structures**:
   - `ProjectInfo` - Contains project metadata
   - `RecentProject` - Simplified project info for recent projects list
   - `ProjectState` - Editor and UI state for a project
   - `ProjectTemplate` - Available project templates
   - `GlobalSettings` - Application-wide settings

3. **Persistence**:
   - Project metadata is stored in `~/.config/toquemedia-studio/projects/{project-id}/meta.json`
   - Global settings are stored in `~/.config/toquemedia-studio/settings.json`
   - Project ID is stored in `.toquemedia-id` within each project directory

### Frontend (TypeScript/React)

The frontend is implemented using React components and Zustand for state management:

1. **State Management**:
   - `useProjectStore` - Zustand store for project state
   - Persists recent projects and window state to localStorage

2. **Components**:
   - `WelcomeScreen` - Initial screen with project actions
   - `CodeEditor` - Main editor interface
   - `NewProjectDialog` - Dialog for creating new projects
   - `OpenProjectDialog` - Dialog for opening existing projects

3. **Utilities**:
   - `FileWatcher` - Monitors file system changes
   - `UnsavedChangesManager` - Handles unsaved changes prompts
   - `WindowStateManager` - Manages window state persistence
   - `ProjectValidator` - Validates project paths and names
   - `FileTreeManager` - Manages file tree display
   - `EditorManager` - Manages editor state
   - `WindowManager` - Manages multiple windows

## Implementation Phases

### Phase 1: Backend Commands and Persistence

1. ✅ Implement Tauri commands for project operations
2. ✅ Create data structures for project info and state
3. ✅ Implement JSON persistence for project metadata
4. ✅ Implement global settings persistence
5. ✅ Add validation for project paths and names
6. ✅ Handle error cases (permissions, missing files, etc.)

### Phase 2: State Management and UI Components

1. ✅ Create Zustand store for project state
2. ✅ Implement WelcomeScreen component
3. ✅ Create dialog components for new/open projects
4. ✅ Add keyboard shortcuts
5. ✅ Implement window title updates
6. ✅ Add form validation to dialogs

### Phase 3: Integration with Existing Components

1. ✅ Integrate with file tree (placeholder)
2. ✅ Integrate with editor (placeholder)
3. ✅ Implement state persistence for open files
4. ✅ Add cursor position tracking
5. ✅ Implement window state management
6. ✅ Add unsaved changes handling

### Phase 4: Testing and Validation

1. ⬜ Test project creation with all templates
2. ⬜ Test opening existing projects
3. ⬜ Verify recent projects list updates correctly
4. ⬜ Test state persistence between sessions
5. ⬜ Validate error handling for edge cases
6. ⬜ Test performance with large projects

## Edge Cases Handled

1. **Project Deleted Externally**: Detected and removed from recent projects list
2. **Permission Changes**: Re-validated when opening projects
3. **Network Drives**: Timeout handling for slow network drives
4. **Large Projects**: Lazy loading for file tree (planned)
5. **Multiple Windows**: State synchronization via IPC (planned)

## Data Structures

### ProjectInfo
```typescript
interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  projectType: string;
  lastOpened: string;
  createdAt: string;
  metadata: Record<string, any>;
}
```

### RecentProject
```typescript
interface RecentProject {
  id: string;
  name: string;
  path: string;
  lastOpened: string;
}
```

### ProjectState
```typescript
interface ProjectState {
  openFiles: string[];
  activeFile: string | null;
  cursorPositions: Record<string, [number, number]>;
  editorStates: Record<string, any>;
  windowState: WindowState;
}
```

### WindowState
```typescript
interface WindowState {
  width: number;
  height: number;
  x: number;
  y: number;
  maximized: boolean;
}
```

## Validation Rules

### Open Project
- ✅ Folder exists
- ✅ Read permissions
- ✅ Valid project (package.json or .git)
- ❌ Reject if system folder

### Create Project
- ✅ Parent folder writable
- ✅ Project name valid (npm naming)
- ❌ Folder already exists
- ✅ Sufficient disk space

### State Persistence
- Auto-save every 5 seconds
- Graceful shutdown save
- Corrupt state recovery

## Performance Considerations

1. **Debounced Saving**: Project state is saved periodically rather than on every change
2. **Lazy Loading**: File tree will be implemented with lazy loading for large projects
3. **Efficient State**: Only necessary state is persisted to disk
4. **Memory Management**: Editors are cleaned up when files are closed

## Security Considerations

1. **Path Validation**: All file paths are validated to prevent directory traversal
2. **Permission Checks**: File system permissions are checked before operations
3. **Input Sanitization**: User inputs are validated and sanitized
4. **Secure Storage**: Project metadata is stored in user config directory

## Future Enhancements

1. **Git Integration**: Clone repositories directly from the IDE
2. **Template Management**: Custom project templates
3. **Cloud Sync**: Sync projects and settings across devices
4. **Plugin System**: Extend functionality with plugins
5. **Advanced Search**: Search across all project files
6. **Refactoring Tools**: Language-specific refactoring tools