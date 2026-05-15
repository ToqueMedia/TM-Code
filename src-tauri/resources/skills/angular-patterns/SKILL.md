# Angular Patterns

You are working in an Angular 17+ project. Standalone components, signals, `inject()`, typed reactive forms, `HttpClient`, async pipe — these are the modern defaults. The rules below cover non-obvious decisions and footguns.

## Decision points (non-obvious)

- **Signals vs RxJS for component state**: signals first, RxJS second. RxJS is for streams (HTTP cold observables, WebSockets, debounced inputs). For "current value" state, `signal()` is simpler and integrates with change detection without the unsubscribe ceremony.
- **`OnPush` everywhere**: set `changeDetection: ChangeDetectionStrategy.OnPush` on every component. Default change detection scans the whole tree on every event — `OnPush` only re-renders when inputs change, signals fire, or async pipe emits. Performance gap is huge on real apps.
- **`inject()` over constructor injection**: `inject()` works in functions (guards, resolvers, factories), composes better, and reads cleaner. Constructor DI still works but is legacy for new code.
- **Standalone over NgModules**: every new component standalone. NgModules add boilerplate without benefit at this point.

## Patterns to Avoid

- **Don't write new code with NgModules.** They're being deprecated. New components are `standalone: true`.
- **Don't use raw `fetch()` in Angular code.** Use `HttpClient` — gives you interceptors, request cancellation, testing utilities, automatic JSON parsing. `fetch` works but defeats the framework's HTTP layer.
- **Don't subscribe manually in components without `takeUntilDestroyed()`** (Angular 16+). Memory leak otherwise — subscriptions outlive the component.
- **Don't use `effect()` for state synchronization.** Use `computed()` for derived values. `effect()` is for side effects (DOM, fetch, persist) — using it to keep one signal in sync with another creates render loops.
- **Don't use `[(ngModel)]` in reactive forms.** Pick one approach per form. Mixing causes circular update bugs.
- **Don't put `async` calls in templates with `{{ getValue() }}`.** Function calls in templates run on every change-detection cycle. Bind to a signal or async pipe instead.
- **Don't use `any` to silence type errors.** With `strictTemplates`, `any` propagates and disables template checking. Type the model properly.
- **Don't bypass `HttpClient` interceptors with `XMLHttpRequest`.** Auth tokens, retry logic, error handling all live in interceptors — `XMLHttpRequest` skips them.
- **Don't lazy-load every route.** Lazy loading has overhead on first navigation. Eager-load critical paths (login, dashboard); lazy-load admin sections, settings, rare flows.
- **Don't write providers in component metadata when they belong in `providedIn: 'root'`.** Per-component providers create per-instance services — surprising for things meant to be singletons.

## Routing — `/` MUST resolve to a real page

Same footgun as React/Vue. Routes file with only `/login`, `/dashboard` and no `/` redirect renders blank. Always:

```ts
export const routes: Routes = [
  { path: '', redirectTo: 'login', pathMatch: 'full' },
  { path: 'login', component: LoginComponent },
  // ...
  { path: '**', redirectTo: 'login' },
]
```
