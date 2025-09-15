# Prompt 1: Sistema de Gestão de Projetos

## Contexto
IDE com Monaco Editor + File Tree + TypeScript LSP por implementar. Falta sistema crítico de gestão de projetos antes de Git integration.

## Objetivo
Implementar sistema completo de gestão de projetos com:
1. Criar novo projeto
2. Abrir projeto existente  
3. Projetos recentes
4. Project workspace state persistence

## Requisitos Técnicos

### 1. Backend (Tauri)
```rust
// src-tauri/src/commands/project.rs
- open_project(path: String) -> Result<ProjectInfo>
- create_project(path: String, template: ProjectTemplate) -> Result<ProjectInfo>
- get_recent_projects() -> Result<Vec<RecentProject>>
- save_project_state(state: ProjectState) -> Result<()>
- load_project_state(project_id: String) -> Result<ProjectState>
```

### 2. Frontend Components

#### A. Welcome Screen (sem projeto aberto)
```typescript
// src/components/WelcomeScreen.tsx
- Lista projetos recentes com preview
- Botões: "Open Project" | "Create New" | "Clone from Git"
- Quick actions: templates TypeScript/JavaScript
```

#### B. Project Dialog System
```typescript
// src/components/dialogs/OpenProjectDialog.tsx
- Native folder picker via Tauri
- Validação: package.json existe
- Auto-detect project type

// src/components/dialogs/NewProjectDialog.tsx
- Templates: Blank | React | Node | TypeScript
- Project name validation
- Location picker
- Auto npm/yarn init
```

#### C. Project State Management
```typescript
// src/stores/projectStore.ts (Zustand)
interface ProjectState {
  currentProject: ProjectInfo | null
  openFiles: OpenFile[]
  activeFile: string | null
  unsavedChanges: Map<string, boolean>
  recentProjects: RecentProject[]
}
```

### 3. Integrações Necessárias

#### File Tree Update
- Root path baseado em currentProject
- Reload ao trocar projeto
- Watch file system changes

#### Editor State
- Salvar/restaurar tabs abertos
- Cursor positions por arquivo
- Undo/redo history persistence

#### Window Title
- Mostrar: "ProjectName - FileName - IDE Name"
- Indicador unsaved changes (•)

### 4. Persistence Layer

#### Project Metadata
```json
// ~/.config/ide/projects/{project-id}/meta.json
{
  "id": "uuid",
  "name": "project-name",
  "path": "/absolute/path",
  "type": "react|node|typescript",
  "lastOpened": "2024-01-20T10:00:00Z",
  "openFiles": ["src/index.ts", "README.md"],
  "activeFile": "src/index.ts"
}
```

#### Global Settings
```json
// ~/.config/ide/settings.json
{
  "recentProjects": [
    {"id": "uuid", "name": "Project", "path": "/path", "lastOpened": "..."}
  ],
  "maxRecentProjects": 10
}
```

## Fluxo de Implementação

### Fase 1: Backend Commands
1. Implementar commands Rust para project operations
2. File system utilities (create, validate, watch)
3. JSON persistence para metadata

### Fase 2: State Management
1. Zustand store com persist middleware
2. Auto-save project state (debounced 1s)
3. Migration system para state updates

### Fase 3: UI Components
1. WelcomeScreen quando `currentProject === null`
2. Dialogs com Chakra Modal + Tauri file picker
3. Menu items: File > Open Project/New Project/Recent

### Fase 4: Integration
1. FileTree subscribe to projectStore
2. Editor restore state on project open
3. Shortcuts: Ctrl+O (open), Ctrl+Shift+N (new)

## Validações Críticas

### Open Project
- ✅ Folder exists
- ✅ Read permissions
- ✅ Valid project (package.json ou .git)
- ❌ Reject if system folder

### Create Project
- ✅ Parent folder writable
- ✅ Project name valid (npm naming)
- ❌ Folder already exists
- ✅ Sufficient disk space

### State Persistence
- Auto-save cada 1 segundo (debounced)
- Graceful shutdown save
- Corrupt state recovery

## Edge Cases

1. **Project deleted externally**: Detectar e remover de recentes
2. **Permission changes**: Re-validar ao abrir
3. **Network drives**: Timeout handling
4. **Large projects**: Lazy load file tree
5. **Multiple windows**: State sync via IPC

## Testing Checklist

- [ ] Criar projeto vazio funciona
- [ ] Abrir projeto existente carrega files
- [ ] Recent projects atualiza corretamente
- [ ] State persiste entre sessões
- [ ] Trocar projeto limpa estado anterior
- [ ] Unsaved changes prompt ao fechar
- [ ] File watcher detecta mudanças externas
- [ ] Templates geram estrutura correta

## Métricas de Sucesso

- Project switch < 500ms
- State save < 50ms
- Recent projects load instantâneo
- Zero data loss em crash
- File tree sync em tempo real

## Design System

### Color Palette
- Primary Colors: 
  - Blue: #58a6ff
  - Purple: #a371f7
  - Green: #2ea043
  - Orange: #f77f00
- Backgrounds:
  - Welcome Screen: #0a0e13
  - Editor: #0d1117
  - Glassmorphism: rgba(13, 17, 23, 0.8)
- Text:
  - Primary: #e6edf3
  - Secondary: #8b949e
  - Muted: #7d8590
- Borders: rgba(48, 54, 61, 0.8)

### Typography
- Font Family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif
- Font Sizes:
  - Welcome Title: 48px (800 weight)
  - Card Titles: 20px (600 weight)
  - Body Text: 14px
  - Labels: 12px

### UI Components

#### Welcome Screen
- Animated background with particle effects
- Glassmorphism sidebar with gradient accents
- Gradient text for headings
- Project action cards with hover animations
- Recent projects list with path information

#### Modals
- Backdrop blur effect (8px)
- Glassmorphism content panels
- Gradient buttons with hover effects
- Consistent input styling with focus states

#### Editor Interface
- Project-specific top bar with name display
- Activity bar with project-related icons
- File tree with project root
- Status bar showing project information

### Responsive Design
- Mobile-first approach
- Flexible grid layouts
- Adaptive component sizing
- Touch-friendly interactions

### Animations and Transitions
- Smooth hover effects on cards and buttons
- Animated background particles
- Transition effects for modal displays
- Loading states for async operations

## Implementation Guidelines

### Tauri Backend
1. Commands should follow Tauri v2 security best practices
2. File system operations should be properly sandboxed
3. JSON persistence should handle errors gracefully
4. All operations should be async to prevent UI blocking

### Frontend Components
1. Use Chakra UI v3 for consistent styling
2. Implement proper TypeScript typing for all components
3. Follow React best practices for state management
4. Ensure accessibility compliance (WCAG AA)

### State Management
1. Zustand store with persistence middleware
2. Proper debouncing for auto-save operations
3. Error handling for state serialization/deserialization
4. Migration system for state structure changes

### UI/UX Considerations
1. Maintain consistent design language across all components
2. Implement proper loading states for async operations
3. Provide clear feedback for user actions
4. Ensure keyboard navigation support
5. Implement proper error messaging