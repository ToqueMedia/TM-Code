# Technical Implementation Plan: Project Management System

## 1. Backend Implementation (Rust)

### Project Commands Module
Location: `src-tauri/src/commands/project.rs`

The backend implements all project management functionality as Tauri commands:

1. **open_project(path: String) -> Result<ProjectInfo>**
   - Validates project path exists and is accessible
   - Checks for required files (package.json or .git)
   - Verifies permissions
   - Loads or generates project ID
   - Detects project type
   - Updates recent projects list
   - Saves project metadata

2. **create_project(path: String, template: ProjectTemplate) -> Result<ProjectInfo>**
   - Validates parent directory exists and is writable
   - Ensures project directory doesn't already exist
   - Creates project directory
   - Applies selected template (Blank, React, Node, TypeScript)
   - Generates project ID
   - Updates recent projects list
   - Saves project metadata

3. **get_recent_projects() -> Result<Vec<RecentProject>>**
   - Loads global settings
   - Filters out projects that no longer exist
   - Returns recent projects list

4. **save_project_state(project_id: String, state: ProjectState) -> Result<()>**
   - Loads existing project metadata
   - Updates last opened time
   - Saves updated metadata with state information
   - Updates recent projects list

5. **load_project_state(project_id: String) -> Result<ProjectState>**
   - Loads project metadata
   - Extracts state information
   - Returns project state

### Data Structures
```rust
struct ProjectInfo {
    id: String,
    name: String,
    path: String,
    project_type: String,
    last_opened: String,
    created_at: String,
    metadata: HashMap<String, serde_json::Value>,
}

struct RecentProject {
    id: String,
    name: String,
    path: String,
    last_opened: String,
}

struct ProjectState {
    open_files: Vec<String>,
    active_file: Option<String>,
    cursor_positions: HashMap<String, (u32, u32)>,
    editor_states: HashMap<String, serde_json::Value>,
    window_state: WindowState,
}

struct WindowState {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    maximized: bool,
}

enum ProjectTemplate {
    Blank,
    React,
    Node,
    TypeScript,
}
```

### File System Utilities
- Path validation and permission checking
- Project ID generation and storage
- Project type detection
- Template application
- Metadata persistence

### JSON Persistence
- Project metadata stored in `~/.config/toquemedia-studio/projects/{project-id}/meta.json`
- Global settings stored in `~/.config/toquemedia-studio/settings.json`
- Project ID stored in `.toquemedia-id` within each project directory

### State Management
- Recent projects list management
- Error handling with custom error types
- Graceful degradation for missing or corrupted data

## 2. Frontend Implementation (TypeScript/React)

### Zustand Store
Location: `src/stores/projectStore.ts`

The project store manages all project-related state:

1. **State**:
   - Current project information
   - Recent projects list
   - Open files
   - Active file
   - Unsaved changes tracking
   - Window state
   - Loading and error states

2. **Actions**:
   - Project operations (open, create, close)
   - File management (add/remove open files, set active file)
   - State management (unsaved changes, cursor positions)
   - Persistence (save/load project state)
   - UI state (loading, errors)

### Welcome Screen Component
Location: `src/components/WelcomeScreen.tsx`

Features:
- Project creation actions
- Recent projects list
- Quick template access
- Animated background with particles
- Responsive design
- Glassmorphism UI elements

### Dialog Components
Location: `src/components/dialogs/`

1. **NewProjectDialog**:
   - Project name validation
   - Template selection
   - Location picker with directory browser
   - Form validation

2. **OpenProjectDialog**:
   - Folder picker with directory browser
   - Path validation

### Integration Components
Location: `src/components/CodeEditor.tsx`

Features:
- Window controls
- Activity bar
- File explorer placeholder
- Editor area placeholder
- Terminal
- Window state management

### Menu Items and Keyboard Shortcuts
- Ctrl+Shift+N: New project
- Ctrl+O: Open project
- Window title updates based on current project

## 3. Data Structures (TypeScript)

Location: `src/types/project.ts`

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

interface RecentProject {
  id: string;
  name: string;
  path: string;
  lastOpened: string;
}

interface ProjectState {
  openFiles: string[];
  activeFile: string | null;
  cursorPositions: Record<string, [number, number]>;
  editorStates: Record<string, any>;
  windowState: WindowState;
}

interface WindowState {
  width: number;
  height: number;
  x: number;
  y: number;
  maximized: boolean;
}

enum ProjectTemplate {
  Blank = "blank",
  React = "react",
  Node = "node",
  TypeScript = "typescript",
}
```

## 4. Integration Points

### File Tree Updates
- Root path based on current project
- Reload when switching projects
- File system watching (planned)

### Editor State Management
- Save/restore tabs
- Cursor positions per file
- Undo/redo history persistence (planned)

### Window Title Updates
- Format: "ProjectName - FileName - IDE Name"
- Unsaved changes indicator (•)

### File System Watching
- Monitor external changes to project files
- Update file tree automatically
- Handle file deletions/creations

## 5. Implementation Phases

### Phase 1: Backend Commands and Persistence
✅ Completed:
- Tauri commands implementation
- Data structures definition
- File system utilities
- JSON persistence layer
- State management with error handling

### Phase 2: State Management and UI Components
✅ Completed:
- Zustand store with persistence middleware
- Welcome screen component
- Dialog components with validation
- Keyboard shortcuts
- Window title updates

### Phase 3: Integration with Existing Components
✅ Completed:
- File tree manager (placeholder)
- Editor state management (placeholder)
- Window state management
- Unsaved changes handling

### Phase 4: Testing and Validation
⬜ Pending:
- Project creation testing
- Project opening testing
- Recent projects validation
- State persistence testing
- Edge case handling
- Performance validation

## 6. Edge Case Handling

### Project Deleted Externally
- Detected during recent projects loading
- Automatically removed from list
- Graceful handling in UI

### Permission Changes
- Re-validated when opening projects
- Clear error messages for permission issues
- Read-only mode when write permissions denied

### Network Drives
- Timeout handling for slow network operations
- Asynchronous operations to prevent UI blocking
- Error recovery for disconnected drives

### Large Projects
- Lazy loading for file tree (planned)
- Virtualized lists for performance
- Memory management for open files

### Multiple Windows
- State synchronization via IPC (planned)
- Window manager utility
- Cross-window communication

## 7. Security Considerations

- Path validation to prevent directory traversal
- Permission checks before file operations
- Input sanitization for user-provided data
- Secure storage of project metadata
- Proper error handling to avoid information leakage

## 8. Performance Optimization

- Debounced saving (5 seconds)
- Efficient state persistence (only necessary data)
- Memory management for closed files
- Asynchronous operations to prevent UI blocking
- Lazy loading for large components (planned)

## 9. Testing Strategy

- Unit tests for backend commands
- Integration tests for frontend components
- End-to-end tests for user workflows
- Performance benchmarks for large projects
- Cross-platform testing (Windows, macOS, Linux)