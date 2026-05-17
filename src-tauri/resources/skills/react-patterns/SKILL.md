# React Patterns

You are working in a React project. The following are non-obvious rules and footguns. Functional components, hooks, TypeScript, and basic dependency arrays are assumed knowledge — not repeated here.

## CRITICAL — Function components + hooks only; the model has class components and Redux boilerplate in training

Class components (`class extends Component`, `this.state`, `this.setState`, lifecycle methods `componentDidMount`/`componentDidUpdate`/`componentWillUnmount`) and Redux with `mapStateToProps`/`mapDispatchToProps`/`connect()` ruled React training data from 2015 to 2019. Hooks landed in React 16.8 (Feb 2019) and have been the canonical API ever since — but the class component idiom is still over-represented in training samples. The model occasionally collapses to class components, lifecycle methods, or boilerplate Redux even on modern projects.

**Defense — three checks before writing any React component**:

1. **Function components ALWAYS for new code**:
   ```tsx
   // ✅ modern — function + hooks
   export function Counter() {
     const [count, setCount] = useState(0)
     return <button onClick={() => setCount(c => c + 1)}>{count}</button>
   }

   // ❌ legacy — never write this for new code
   class Counter extends Component {
     state = { count: 0 }
     render() {
       return <button onClick={() => this.setState({ count: this.state.count + 1 })}>{this.state.count}</button>
     }
   }
   ```

2. **No lifecycle methods — use hooks**:
   - `componentDidMount` → `useEffect(() => { ... }, [])`
   - `componentDidUpdate` → `useEffect(() => { ... }, [deps])`
   - `componentWillUnmount` → `useEffect` cleanup return function
   - `shouldComponentUpdate` → wrap in `React.memo` (rarely needed; profile first)

3. **State management**: `useState` / `useReducer` for component state, Zustand or similar for global state. **Do NOT generate Redux boilerplate** (`mapStateToProps`, `connect(mapStateToProps)(Component)`, action types as constants, switch-statement reducers) for new projects unless the existing codebase is already on Redux Toolkit AND you can see RTK in `package.json`.

**Anti-pattern symptoms — these mean you defaulted to class-era React**:
- `class XXX extends React.Component` → use a function.
- `this.state` / `this.setState({})` → use `useState`.
- `componentDidMount() {...}` → use `useEffect(() => { ... }, [])`.
- `connect(mapStateToProps, mapDispatchToProps)(...)` → use `useSelector`/`useDispatch` (RTK) or replace with Zustand store.
- `propTypes` declarations → use TypeScript props interface.
- `createRef()` for refs → use `useRef`.
- `withRouter(Component)` HOCs → use `useNavigate`/`useLocation` hooks (react-router v6).

## Patterns to Avoid

- **Don't use `useEffect` for state synchronization.** Compute the value during render from existing state. `useEffect` is for side effects (subscribe, fetch, DOM measurement) — using it to keep one piece of state in sync with another doubles the renders and creates ordering bugs.
- **Don't use `useEffect` as an event handler.** If a value should update on click/submit/change, call the function from the event handler — not in an effect that watches the value change.
- **Don't store derived data in state.** A filtered list when you have the full list + a filter string is derivable in render. Storing it creates a stale-data bug waiting to happen.
- **Don't mutate state directly.** Always create new objects/arrays. `arr.push(x)` then `setState(arr)` does nothing — React compares by reference.
- **Don't use array index as key for dynamic lists.** Use a stable id. Index keys break reorder/insert/delete behaviour and cause input focus loss.
- **Don't suppress ESLint deps warnings.** If the linter says a dep is missing, the missing dep is real — adding `// eslint-disable-next-line` is silently breaking the hook contract.
- **Don't reach for `useCallback` / `useMemo` by default.** Both add overhead. Use them only when profiling shows a real re-render problem or when the value is a stable identity required by a downstream `React.memo` / hook deps.
- **Don't use `dangerouslySetInnerHTML` unless rendering trusted markdown/sanitized HTML.** Default to text or proper components.

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
