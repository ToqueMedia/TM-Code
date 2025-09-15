# Developer Guide: Project Management System

This document provides a comprehensive guide for developers working on the project management system.

## Project Structure

```
src-tauri/
├── src/
│   ├── commands/
│   │   ├── mod.rs
│   │   └── project.rs          # Backend commands implementation
│   ├── lib.rs                  # Tauri application entry point
│   └── main.rs                 # Platform-specific entry point
├── Cargo.toml                 # Rust dependencies

src/
├── components/
│   ├── dialogs/
│   │   ├── NewProjectDialog.tsx
│   │   └── OpenProjectDialog.tsx
│   ├── CodeEditor.tsx
│   ├── WelcomeScreen.tsx
│   └── index.ts
├── stores/
│   ├── projectStore.ts         # Zustand store for project state
│   └── __tests__/
│       └── projectStore.test.ts
├── types/
│   ├── project.ts              # TypeScript interfaces and enums
│   └── index.ts
├── utils/
│   ├── editorManager.ts
│   ├── fileTreeManager.ts
│   ├── fileWatcher.ts
│   ├── projectValidator.ts
│   ├── unsavedChangesManager.ts
│   ├── windowManager.ts
│   ├── windowStateManager.ts
│   └── index.ts
├── App.tsx
├── main.tsx
├── App.css
└── theme.ts

documentation/
├── PROJECT_MANAGEMENT_README.md
└── TECHNICAL_IMPLEMENTATION_PLAN.md
```

## Getting Started

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Run the development server**:
   ```bash
   npm run tauri dev
   ```

3. **Build for production**:
   ```bash
   npm run tauri build
   ```

## Backend (Rust)

### Key Files
- `src-tauri/src/commands/project.rs` - Contains all project management commands
- `src-tauri/src/lib.rs` - Registers the commands with Tauri

### Available Commands
1. `open_project(path: String) -> Result<ProjectInfo>`
2. `create_project(path: String, template: ProjectTemplate) -> Result<ProjectInfo>`
3. `get_recent_projects() -> Result<Vec<RecentProject>>`
4. `save_project_state(project_id: String, state: ProjectState) -> Result<()>`
5. `load_project_state(project_id: String) -> Result<ProjectState>`

### Data Persistence
- Project metadata: `~/.config/toquemedia-studio/projects/{project-id}/meta.json`
- Global settings: `~/.config/toquemedia-studio/settings.json`
- Project ID: `.toquemedia-id` in project directory

## Frontend (TypeScript/React)

### State Management
The `useProjectStore` hook manages all project-related state:
```typescript
import { useProjectStore } from '../stores/projectStore';

const MyComponent = () => {
  const { currentProject, openProject, createProject } = useProjectStore();
  // ...
};
```

### Components
1. **WelcomeScreen** - Initial screen with project actions
2. **CodeEditor** - Main editor interface
3. **NewProjectDialog** - Dialog for creating new projects
4. **OpenProjectDialog** - Dialog for opening existing projects

### Utilities
Several utility classes help manage different aspects of the application:
- `EditorManager` - Manages editor state
- `FileTreeManager` - Manages file tree display
- `WindowManager` - Manages multiple windows
- `ProjectValidator` - Validates project paths and names

## Testing

### Running Tests
```bash
# Run the implementation verification script
./test-implementation.sh

# TODO: Add unit tests with Jest
```

### Manual Testing Checklist
- [ ] Create new project with each template
- [ ] Open existing project
- [ ] Verify recent projects list updates
- [ ] Test state persistence between sessions
- [ ] Verify window title updates
- [ ] Test keyboard shortcuts
- [ ] Validate error handling for edge cases

## Extending the System

### Adding New Project Templates
1. Add new variant to `ProjectTemplate` enum in both Rust and TypeScript
2. Update `create_project` command to handle the new template
3. Update UI components to display the new template

### Adding New State to Persistence
1. Update `ProjectState` interface in TypeScript
2. Update `ProjectState` struct in Rust
3. Modify `save_project_state` and `load_project_state` to handle new fields

### Adding New Validation Rules
1. Update `ProjectValidator` utility class
2. Apply validation in relevant UI components

## Troubleshooting

### Common Issues
1. **Commands not found**: Ensure commands are registered in `lib.rs`
2. **Persistence issues**: Check file permissions for config directory
3. **UI not updating**: Verify Zustand store is properly connected to components

### Debugging Tips
1. Use browser dev tools to inspect Zustand state
2. Check Tauri console logs for backend errors
3. Verify file paths and permissions

## Performance Considerations

1. **State Updates**: Use selective destructuring to avoid unnecessary re-renders
2. **File Operations**: All file operations are asynchronous to prevent UI blocking
3. **Persistence**: State is saved periodically rather than on every change

## Security Considerations

1. **Path Validation**: All file paths are validated to prevent directory traversal
2. **Permission Checks**: File system permissions are verified before operations
3. **Input Sanitization**: User inputs are validated and sanitized

## Future Enhancements

1. **Git Integration**: Clone repositories directly from the IDE
2. **Template Management**: Custom project templates
3. **Cloud Sync**: Sync projects and settings across devices
4. **Plugin System**: Extend functionality with plugins