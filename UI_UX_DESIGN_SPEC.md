# Diamond IDE - UI/UX Design Specification

## 1. Overview

This document outlines the comprehensive UI/UX design specification for the Diamond IDE project management system, incorporating elements from the welcome screen and code editor designs. The system features a dark theme with blue/purple gradients, glassmorphism effects, and modern UI components.

## 2. Color Palette

### Primary Colors
| Color Name | Hex Code | Usage |
|------------|----------|-------|
| Blue | `#58a6ff` | Primary actions, links, active states |
| Purple | `#a371f7` | Secondary actions, accents |
| Green | `#2ea043` | Success states, confirmations |
| Orange | `#f77f00` | Warnings, highlights |

### Background Colors
| Color Name | Hex Code | Usage |
|------------|----------|-------|
| Welcome Background | `#0a0e13` | Welcome screen background |
| Editor Background | `#0d1117` | Code editor and main UI background |
| Sidebar/Panel | `#161b22` | Sidebars, panels, headers |
| Content Area | `#0d1117` | Main content areas |
| Overlay | `#21262d` | Modals, dropdowns, overlays |

### Text Colors
| Color Name | Hex Code | Usage |
|------------|----------|-------|
| Primary Text | `#e6edf3` | Main text content |
| Secondary Text | `#8b949e` | Descriptive text, labels |
| Muted Text | `#7d8590` | Subtle text, placeholders |
| Link Text | `#58a6ff` | Hyperlinks |
| Success Text | `#56d364` | Success messages |
| Error Text | `#f85149` | Error messages |

### Glassmorphism Effect
- Background: `rgba(13, 17, 23, 0.8)`
- Border: `rgba(48, 54, 61, 0.8)`
- Backdrop Filter: `blur(20px)`

## 3. Typography

### Font Stack
```
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
```

### Font Sizes
| Element | Size | Weight | Color |
|---------|------|--------|-------|
| Display Title | 48px | 800 | Gradient (#e6edf3 → #58a6ff → #a371f7) |
| Section Title | 24px | 600 | `#e6edf3` |
| Card Title | 20px | 600 | `#e6edf3` |
| Body Text | 14px | 400 | `#c9d1d9` |
| Label Text | 13px | 400 | `#c9d1d9` |
| Caption | 12px | 400 | `#7d8590` |
| Code Text | 13px | 400 | `#c9d1d9` |

## 4. Welcome Screen Design

### Layout Structure
```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Background Particles                                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│  Sidebar (320px)      │  Main Content (Flexible)                            │
│                       │                                                     │
│  ┌─────────────────┐  │  ┌───────────────────────────────────────────────┐  │
│  │ Logo            │  │  │ Welcome Header                                │  │
│  │                 │  │  │                                               │  │
│  │ Navigation      │  │  │                                               │  │
│  │                 │  │  │                                               │  │
│  │ Recent Projects │  │  │                                               │  │
│  └─────────────────┘  │  │  ┌───────────────────────────────────────────┐  │
│                       │  │  │ Action Card │ Action Card │ Action Card │  │
│                       │  │  │             │             │             │  │
│                       │  │  └───────────────────────────────────────────┘  │
└───────────────────────┴──┴─────────────────────────────────────────────────┘
```

### Background
- Base: `#0a0e13`
- Particle Animation: Floating particles with `rgba(88, 166, 255, 0.6)` color
- Gradient Overlay:
  ```css
  background: radial-gradient(ellipse at top, rgba(88, 166, 255, 0.05) 0%, transparent 50%),
              radial-gradient(ellipse at bottom, rgba(163, 108, 255, 0.03) 0%, transparent 50%);
  ```

### Sidebar Components

#### Logo Section
- Logo: 48px×48px rounded square with gradient (`#58a6ff` → `#a371f7`)
- Text: Gradient text (`#58a6ff` → `#a371f7`)
- Shadow: `0 8px 32px rgba(88, 166, 255, 0.3)`

#### Navigation Items
- Background: `rgba(13, 17, 23, 0.8)` with `blur(20px)`
- Border: `1px solid rgba(48, 54, 61, 0.5)`
- Hover Effect: 
  - Background: `rgba(88, 166, 255, 0.1)`
  - Border: `rgba(88, 166, 255, 0.3)`
  - Transform: `translateX(4px)`
- Active State:
  - Background: `rgba(88, 166, 255, 0.15)`
  - Border: `rgba(88, 166, 255, 0.5)`
  - Text: `#58a6ff`

#### Recent Projects
- Item Hover: `rgba(139, 148, 158, 0.1)` background

### Main Content

#### Welcome Header
- Title: 48px font with gradient text (`#e6edf3` → `#58a6ff` → `#a371f7`)
- Subtitle: 18px `#8b949e` text

#### Action Cards (Grid)
- Grid: Auto-fit with min 280px columns
- Background: `rgba(21, 32, 43, 0.6)` with `blur(20px)`
- Border: `1px solid rgba(48, 54, 61, 0.8)`
- Border Radius: 16px
- Padding: 32px 24px

##### Card Hover Effects
- Transform: `translateY(-8px) scale(1.02)`
- Border: `rgba(88, 166, 255, 0.6)`
- Box Shadow: `0 20px 40px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(88, 166, 255, 0.1)`
- Top Border Animation: Gradient line sliding across top

##### Card Icons
- Size: 64px×64px
- Border Radius: 12px
- Shadow: Varies by card type

##### New Project Card
- Background: `linear-gradient(135deg, #56d364 0%, #2ea043 100%)`
- Shadow: `0 8px 24px rgba(86, 211, 100, 0.3)`

##### Open Folder Card
- Background: `linear-gradient(135deg, #58a6ff 0%, #0969da 100%)`
- Shadow: `0 8px 24px rgba(88, 166, 255, 0.3)`

##### Clone Repository Card
- Background: `linear-gradient(135deg, #a371f7 0%, #8250df 100%)`
- Shadow: `0 8px 24px rgba(163, 113, 247, 0.3)`

##### Import Project Card
- Background: `linear-gradient(135deg, #fb8500 0%, #f77f00 100%)`
- Shadow: `0 8px 24px rgba(251, 133, 0, 0.3)`

### Modals

#### Modal Backdrop
- Background: `rgba(0, 0, 0, 0.8)`
- Backdrop Filter: `blur(8px)`

#### Modal Content
- Background: `rgba(13, 17, 23, 0.95)`
- Border: `1px solid rgba(48, 54, 61, 0.8)`
- Border Radius: 16px
- Max Width: 500px
- Padding: 32px

#### Form Elements
- Input Fields:
  - Background: `rgba(21, 32, 43, 0.8)`
  - Border: `1px solid rgba(48, 54, 61, 0.8)`
  - Border Radius: 8px
  - Focus Border: `#58a6ff`
  - Focus Shadow: `0 0 0 3px rgba(88, 166, 255, 0.1)`

- Buttons:
  - Primary:
    - Background: `linear-gradient(135deg, #58a6ff 0%, #0969da 100%)`
    - Hover Transform: `translateY(-2px)`
    - Hover Shadow: `0 8px 16px rgba(88, 166, 255, 0.3)`
  - Secondary:
    - Background: transparent
    - Border: `1px solid rgba(48, 54, 61, 0.8)`
    - Hover: `rgba(139, 148, 158, 0.1)` background

## 5. Code Editor Design

### Layout Structure
```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Top Bar                                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  Activity Bar (60px)  │  Sidebar (280px)  │  Editor Area (Flexible)         │
├─────────────────────────────────────────────────────────────────────────────┤
│  Terminal (200px)                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Color Scheme
- Background: `#0d1117`
- Panel Headers: `#161b22`
- Borders: `#21262d`
- Panel Separators: `#30363d`

### Top Bar
- Gradient Background: `linear-gradient(135deg, #161b22 0%, #21262d 100%)`
- Border: `1px solid #30363d`
- Window Controls:
  - Close: `#ff5f56`
  - Minimize: `#ffbd2e`
  - Maximize: `#27ca3f`

### Activity Bar
- Background: `#161b22`
- Icons: 40px×40px with 6px border radius
- Hover/Active: `#21262d` background with `#58a6ff` text

### Sidebar
- Background: `#0d1117`
- Header: `#161b22` with `#21262d` border
- File Items:
  - Hover: `rgba(88, 166, 255, 0.1)` background
  - Selected: `rgba(88, 166, 255, 0.2)` background with `#58a6ff` text

### Editor Area
- Background: `#0d1117`
- Tab Bar: `#161b22` with `#21262d` border
- Tabs:
  - Active: `#0d1117` with `2px solid #58a6ff` bottom border
  - Hover: `#21262d` background

#### Code Display
- Line Numbers: `#484f58` color
- Font: `'Fira Code', 'Consolas', monospace`
- Syntax Highlighting:
  - Keywords: `#ff7b72`
  - Strings: `#a5d6ff`
  - Comments: `#8b949e` (italic)
  - Functions: `#d2a8ff`
  - Variables: `#79c0ff`
  - Imports: `#ff7b72`
  - Decorators: `#ffa657`

### Terminal
- Background: `#010409`
- Header: `#161b22` with `#21262d` border
- Tabs:
  - Active: `#010409` with `#58a6ff` text
  - Inactive: `#21262d`
- Content: `#c9d1d9` text

## 6. Components

### Buttons
| Type | Background | Text | Border | Hover Effect |
|------|------------|------|--------|--------------|
| Primary | `linear-gradient(135deg, #58a6ff 0%, #0969da 100%)` | White | None | `translateY(-2px)` + shadow |
| Secondary | Transparent | `#8b949e` | `1px solid rgba(48, 54, 61, 0.8)` | `rgba(139, 148, 158, 0.1)` bg |
| Danger | `#f85149` | White | None | Darken + shadow |

### Cards
- Border Radius: 16px
- Background: `rgba(21, 32, 43, 0.6)` with `blur(20px)`
- Border: `1px solid rgba(48, 54, 61, 0.8)`
- Shadow: `0 20px 40px rgba(0, 0, 0, 0.3)`

### Inputs
- Height: 38px
- Padding: 12px 16px
- Background: `rgba(21, 32, 43, 0.8)`
- Border: `1px solid rgba(48, 54, 61, 0.8)`
- Border Radius: 8px
- Focus: `#58a6ff` border + `0 0 0 3px rgba(88, 166, 255, 0.1)` shadow

### Modals
- Width: 90% (max 500px)
- Background: `rgba(13, 17, 23, 0.95)`
- Border: `1px solid rgba(48, 54, 61, 0.8)`
- Border Radius: 16px
- Backdrop: `rgba(0, 0, 0, 0.8)` with `blur(8px)`

### Tabs
- Height: 35px
- Background: `#161b22`
- Active: `#0d1117` with `2px solid #58a6ff` bottom border
- Hover: `#21262d` background

### File Tree
- Item Height: 28px
- Padding: 4px 8px
- Border Radius: 4px
- Hover: `rgba(88, 166, 255, 0.1)` background
- Selected: `rgba(88, 166, 255, 0.2)` background with `#58a6ff` text

## 7. Animations and Transitions

### Standard Transitions
- Duration: 0.2s for quick interactions
- Duration: 0.3s for larger UI elements
- Easing: `cubic-bezier(0.4, 0, 0.2, 1)` for smoothness

### Special Effects
- Glassmorphism: `backdrop-filter: blur(20px)`
- Gradient Animations: Sliding borders on cards
- Particle Background: Floating animation with random timing

## 8. Responsive Design

### Breakpoints
- Mobile: < 768px
- Tablet: 768px - 1024px
- Desktop: > 1024px

### Mobile Adaptations
- Single column layout for welcome screen
- Reduced sidebar to bottom navigation
- Full-width action cards
- Adjusted font sizes for readability

## 9. Accessibility

### Color Contrast
- All text meets WCAG AA standards (4.5:1 contrast ratio)
- Interactive elements have sufficient contrast ratios

### Focus States
- Visible focus rings for keyboard navigation
- Focus indicators use primary blue (`#58a6ff`)

### ARIA Labels
- All interactive elements have descriptive labels
- Modal dialogs properly trap focus
- Screen reader announcements for state changes

## 10. Implementation Guidelines

### CSS Custom Properties
```css
:root {
  /* Colors */
  --color-blue: #58a6ff;
  --color-purple: #a371f7;
  --color-green: #2ea043;
  --color-orange: #f77f00;
  
  /* Backgrounds */
  --bg-welcome: #0a0e13;
  --bg-editor: #0d1117;
  --bg-sidebar: #161b22;
  --bg-overlay: #21262d;
  
  /* Text */
  --text-primary: #e6edf3;
  --text-secondary: #8b949e;
  --text-muted: #7d8590;
  
  /* Glassmorphism */
  --glass-bg: rgba(13, 17, 23, 0.8);
  --glass-border: rgba(48, 54, 61, 0.8);
  
  /* Typography */
  --font-primary: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
  --font-mono: 'Fira Code', 'Consolas', monospace;
}
```

### Component Structure
1. Use semantic HTML elements
2. Implement proper focus management
3. Follow consistent spacing (multiples of 4px)
4. Use CSS Grid and Flexbox for layouts
5. Implement proper responsive behavior
6. Ensure all interactive elements are keyboard accessible

This design specification provides a comprehensive guide for implementing the Diamond IDE UI with a consistent dark theme, modern aesthetics, and professional user experience.