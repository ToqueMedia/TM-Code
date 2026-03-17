# Svelte Patterns

You are working in a Svelte project. Follow these conventions:

## Svelte 5 Runes (preferred)
- Use `$state()` for reactive state declarations.
- Use `$derived()` for computed values.
- Use `$effect()` for side effects.
- Use `$props()` for component props.
- Use `$bindable()` for two-way binding props.

## Svelte 4 Fallback
- If project uses Svelte 4: use `let` for reactive state, `$:` for derived/effects.
- Check `package.json` for Svelte version before choosing syntax.

## Component Structure
- One component per `.svelte` file.
- Script at top, markup in middle, styles at bottom.
- Use `<script lang="ts">` for TypeScript.
- Keep components under 200 lines.

## State Management
- Local state: runes (`$state`) in components.
- Shared state: Svelte stores (`writable`, `readable`, `derived`).
- For complex state: use a store file in `lib/stores/`.
- Svelte 5: prefer `$state` in `.svelte.ts` files for shared state.

## Styling
- Use `<style>` block — styles are scoped by default.
- Use CSS custom properties for theming.
- Use `:global()` sparingly — only for third-party component overrides.

## Best Practices
- Use `{#each items as item (item.id)}` — always key iterations.
- Use `{#await promise}` for async data in templates.
- Prefer `bind:value` over manual event handlers for form inputs.
- Use `<svelte:component>` for dynamic components.
- Use `onMount` for DOM-dependent initialization.
- Use `onDestroy` for cleanup (timers, subscriptions).

## SvelteKit
- Use `+page.svelte`, `+layout.svelte`, `+page.server.ts` conventions.
- Load data in `+page.ts` / `+page.server.ts` with `load` functions.
- Use form actions for mutations (`+page.server.ts` actions).
- Use `$app/stores` for page, navigating, updated stores.

## Performance
- Svelte compiles away the framework — focus on algorithmic efficiency.
- Use `{#key expression}` to force re-creation of components.
- Lazy load with dynamic `import()` for heavy components.
