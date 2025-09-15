# Diamond IDE - Design System

This document explains how to use the UI/UX design specification and Chakra UI theme for the Diamond IDE project.

## Design Specification

The complete UI/UX design specification is available in [UI_UX_DESIGN_SPEC.md](./UI_UX_DESIGN_SPEC.md). This document includes:

- Color palette with hex values and usage guidelines
- Typography system with font sizes and weights
- Component designs and specifications
- Layout guidelines
- Animation and transition standards
- Accessibility requirements

## Chakra UI Theme

The Chakra UI theme implementation is available in [src/theme.ts](./src/theme.ts). This theme file includes:

- Color tokens for all design colors
- Typography settings
- Component style overrides
- Spacing and sizing scales

### Using the Theme

To use the theme in your Chakra UI components:

1. Import the theme in your main application file:

```tsx
import { theme } from './theme'
import { ChakraProvider } from '@chakra-ui/react'

function App() {
  return (
    <ChakraProvider theme={theme}>
      {/* Your app components */}
    </ChakraProvider>
  )
}
```

2. Use semantic tokens in your components:

```tsx
import { Box, Button, Card } from '@chakra-ui/react'

function WelcomeScreen() {
  return (
    <Box bg="bg.welcome" color="text.primary">
      <Card bg="glass.bg" border="1px solid" borderColor="glass.border">
        <Button variant="primary">New Project</Button>
        <Button variant="secondary">Open Folder</Button>
      </Card>
    </Box>
  )
}
```

### Available Tokens

#### Colors
- `primary.blue` - Primary blue color (#58a6ff)
- `primary.purple` - Primary purple color (#a371f7)
- `primary.green` - Success green color (#2ea043)
- `primary.orange` - Warning orange color (#f77f00)
- `bg.welcome` - Welcome screen background (#0a0e13)
- `bg.editor` - Editor background (#0d1117)
- `bg.sidebar` - Sidebar background (#161b22)
- `text.primary` - Primary text color (#e6edf3)
- `text.secondary` - Secondary text color (#8b949e)
- `glass.bg` - Glassmorphism background (rgba(13, 17, 23, 0.8))
- `glass.border` - Glassmorphism border (rgba(48, 54, 61, 0.8))

#### Typography
- Fonts: `heading`, `body`, `mono`
- Font sizes: `xs` (12px) to `5xl` (48px)
- Font weights: `normal` (400) to `extrabold` (800)

#### Components
- Button variants: `primary`, `secondary`
- Card with glassmorphism effect
- Input fields with custom styling
- Modal with backdrop blur

## Implementation Guidelines

1. Always use design tokens instead of hardcoded values
2. Follow the responsive design breakpoints
3. Ensure proper accessibility (color contrast, focus states)
4. Use semantic HTML elements
5. Implement consistent spacing using the spacing scale
6. Follow the animation guidelines for transitions

For any questions about the design system, please refer to the [UI_UX_DESIGN_SPEC.md](./UI_UX_DESIGN_SPEC.md) document or contact the design team.