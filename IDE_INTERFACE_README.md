# ToqueMedia Studio IDE Interface

This document describes the professional IDE interface design for ToqueMedia Studio, inspired by modern IDEs like Cursor, VS Code, and other professional development environments.

## Design Principles

1. **Professional Layout**: Clean, organized interface with clear visual hierarchy
2. **Dark Theme**: Eye-friendly dark color scheme with appropriate contrast
3. **Intuitive Navigation**: Easy file and project management
4. **Modern UI Patterns**: Contemporary design elements and interactions
5. **Performance Optimized**: Smooth interactions and responsive design

## Interface Components

### 1. Menu Bar
- Standard application menu (File, Edit, View, Run)
- Quick action buttons (Search, Notifications, Settings, User)
- Clean, minimal design with appropriate spacing

### 2. Sidebar (File Explorer)
- Collapsible file tree with clear visual hierarchy
- File/folder icons with syntax-based coloring
- Context menus for file operations
- Refresh and new file/folder actions

### 3. Editor Area
- Multi-tab interface for open files
- Visual indicators for unsaved changes
- Clean tab design with proper spacing
- Monaco editor with enhanced configuration

### 4. Terminal Panel
- Multiple terminal tabs (Terminal, Output, Debug Console)
- Scrollable terminal output with syntax coloring
- Terminal input area
- Collapsible design

### 5. Status Bar
- Contextual information (Git branch, language mode, cursor position)
- Project information and status indicators
- Error/warning counters
- Package information

## Color Scheme

The IDE uses a professional dark theme with the following key colors:

- **Editor Background**: `#1e1e1e` (deep dark gray)
- **Sidebar Background**: `#252526` (slightly lighter for contrast)
- **Active Tab**: `#1e1e1e` (matches editor)
- **Inactive Tab**: `#2d2d30` (distinct but subtle)
- **Syntax Colors**: 
  - Blue: `#58a6ff` (TypeScript/JavaScript)
  - Orange: `#f77f00` (JavaScript)
  - Green: `#2ea043` (CSS)
  - Purple: `#a371f7` (Special elements)
  - Red: `#ff5555` (Errors)
  - Yellow: `#f1fa8c` (JSON/Warnings)

## Responsive Design

The interface is designed to work across different screen sizes:
- Sidebar and terminal can be collapsed on smaller screens
- Tab bar scrolls horizontally when needed
- Appropriate padding and spacing for all elements
- Font sizes optimized for readability

## Accessibility Features

- Proper contrast ratios for all text elements
- Keyboard navigation support
- ARIA labels for interactive elements
- Focus states for all interactive components
- Semantic HTML structure

## Performance Considerations

- Virtualized file tree for large projects
- Efficient re-rendering of components
- Proper cleanup of event listeners
- Optimized Monaco editor configuration