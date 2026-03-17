# Angular Patterns

You are working in an Angular project. Follow these conventions:

## Component Architecture
- Use standalone components (`standalone: true`). Avoid NgModules for new code.
- One component per file. Follow Angular naming: `user-profile.component.ts`.
- Use signals for reactive state (`signal()`, `computed()`, `effect()`).
- Keep templates inline for small components, external for complex ones.

## Signals & Change Detection
- Prefer signals over RxJS for component state.
- Use `computed()` for derived state from signals.
- Use `effect()` for side effects that react to signal changes.
- Set `changeDetection: ChangeDetectionStrategy.OnPush` on all components.

## Services & Dependency Injection
- Services are `@Injectable({ providedIn: 'root' })` for singletons.
- Use `inject()` function instead of constructor injection.
- Services handle business logic and API calls — components handle presentation.
- Use `HttpClient` for HTTP requests, never raw `fetch`.

## RxJS
- Use `async` pipe in templates — avoid manual subscribe/unsubscribe.
- Use `takeUntilDestroyed()` when manual subscription is necessary.
- Prefer higher-order operators (`switchMap`, `mergeMap`) over nested subscriptions.
- Use `toSignal()` / `toObservable()` for signal-RxJS interop.

## Forms
- Use reactive forms (`FormGroup`, `FormControl`) for complex forms.
- Use typed forms with `FormControl<string>`.
- Validate with built-in validators + custom validator functions.

## Routing
- Lazy load routes with `loadComponent` / `loadChildren`.
- Use functional guards and resolvers.
- Use router signals: `input()` for route params.

## File Structure
```
feature/
  feature.component.ts
  feature.component.html
  feature.component.scss
  feature.service.ts
  feature.routes.ts
```

## TypeScript
- Strict mode always. No `any` types.
- Use interfaces for data models, classes for services.
- Enable `strictTemplates` in `tsconfig.json`.
