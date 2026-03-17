# React Patterns

You are working in a React project. Follow these conventions:

## Component Structure
- Use functional components with hooks. Never use class components.
- One component per file. File name matches component name (PascalCase).
- Keep components small (< 200 lines). Extract sub-components when complexity grows.
- Co-locate related files: `Button.tsx`, `Button.test.tsx`, `Button.module.css`.

## State Management
- Local state: `useState` for simple values, `useReducer` for complex state logic.
- Shared state: prefer context + hooks or Zustand over prop drilling.
- Derive state from existing state instead of duplicating it.
- Avoid `useEffect` for state synchronization — compute during render instead.

## Hooks
- Custom hooks start with `use` prefix and encapsulate reusable logic.
- Keep dependency arrays accurate — never suppress ESLint warnings with `// eslint-disable`.
- Use `useCallback` and `useMemo` only when there's a measurable performance benefit.
- Prefer `useRef` for mutable values that don't trigger re-renders.

## Performance
- Lazy load heavy components with `React.lazy()` + `Suspense`.
- Use `React.memo()` for components that re-render with the same props frequently.
- Avoid inline object/array literals in JSX props (causes unnecessary re-renders).
- Key lists with stable, unique IDs — never use array index as key for dynamic lists.

## Patterns to Avoid
- Don't use `dangerouslySetInnerHTML` unless explicitly required.
- Don't mutate state directly — always create new objects/arrays.
- Don't use `useEffect` as an event handler — call functions directly from event handlers.
- Don't store derived data in state (e.g., filtered list when you have the full list + filter).

## TypeScript
- Type props with interfaces, not `type` aliases (interfaces are extendable).
- Use `React.FC` sparingly — prefer explicit return types.
- Generic components use `<T>` syntax: `function List<T>(props: ListProps<T>)`.
