# Diamond IDE

The ultimate development environment designed for modern developers.

## Project Structure

```
src/
├── app/
│   ├── database/          # DAOs - Abstração da base de dados
│   ├── hooks/             # Repositórios (Zustand) - Lógica de negócio
│   ├── services/          # Abstração de APIs externas e serviços internos
│   ├── types/             # Types do projeto (um arquivo por type)
│   ├── ui/                # Views e componentes específicos
│   │   ├── components/    # Componentes compartilhados
│   │   └── [feature]/     # Cada feature em sua pasta
│   ├── configs/           # Configurações singleton
│   └── utils/             # Utilitários
```

## Design System

### Color Palette

- Primary Colors:
  - Blue: `#58a6ff`
  - Purple: `#a371f7`
  - Green: `#2ea043`
  - Orange: `#f77f00`
  
- Backgrounds:
  - Welcome Screen: `#0a0e13`
  - Editor: `#0d1117`
  - Glassmorphism: `rgba(13, 17, 23, 0.8)`
  
- Text:
  - Primary: `#e6edf3`
  - Secondary: `#8b949e`
  - Muted: `#7d8590`
  
- Borders: `rgba(48, 54, 61, 0.8)`

### Typography

- Font Family: `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif`
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

## Project Management System

For details on the project management system implementation, see [project-management-prompt.md](./project-management-prompt.md).

## Development Guidelines

1. Follow the established project structure
2. Use TypeScript for all frontend code
3. Implement proper error handling
4. Write tests for critical functionality
5. Follow accessibility best practices (WCAG AA)
6. Maintain consistent design language
7. Use Chakra UI v3 for UI components
8. Implement proper state management with Zustand# exodus-ide
