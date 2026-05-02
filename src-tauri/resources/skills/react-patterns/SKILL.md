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

## Routing — `/` MUST resolve to a real page

The dev server opens at `/` by default. A `<Routes>` block that only registers specific paths (`/login`, `/dashboard`) renders a **blank page** at `/` because no route matches. The IDE preview iframe shows that blank page and the developer thinks the app is broken.

Always include BOTH:
- a `/` route — either renders the entry component directly OR `<Navigate>`s to it
- a `*` wildcard fallback — typos and back-button mistakes land on a known page, not blank

```tsx
<Routes>
  <Route path="/" element={<Navigate to="/login" replace />} />   {/* entry */}
  <Route path="/login" element={<Login />} />
  {/* ...other routes... */}
  <Route path="*" element={<Navigate to="/login" replace />} />   {/* fallback */}
</Routes>
```

Same principle for Next.js (`app/page.tsx` IS `/`), Nuxt (`pages/index.vue`), SvelteKit (`+page.svelte` at routes root) — the root path must render something. Verify on first load: address bar shows your entry route and a form/UI renders, NOT a blank page.
