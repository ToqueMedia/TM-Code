# Svelte Patterns

You are working in a Svelte project. Check `package.json` for the Svelte version BEFORE writing reactive code — Svelte 5 (runes) and Svelte 4 (`let` + `$:`) have incompatible syntaxes.

## Svelte 5 (runes — preferred for new code)

- `$state()` — reactive state declarations.
- `$derived()` — computed values from other state.
- `$effect()` — side effects that react to state changes.
- `$props()` — declare component props.
- `$bindable()` — opt-in to two-way binding from parent.

Cross-component shared state goes in a `.svelte.ts` file using `$state` runes. Stores (`writable`, `readable`) still work but are legacy for new Svelte 5 code.

## SvelteKit conventions (when applicable)

- `+page.svelte` is the route component, `+page.ts` runs in browser AND server (universal load), `+page.server.ts` runs server-only (use for secrets, DB).
- Form actions in `+page.server.ts` for mutations; use `<form method="POST">` + progressive enhancement.
- `$app/stores` for `page`, `navigating`, `updated` — these are SvelteKit-provided, not user code.

## Patterns to Avoid

- **Don't mix Svelte 4 and Svelte 5 syntax in the same file.** A file using `$state()` cannot also use `$:` reactive declarations — pick one mode based on the project's Svelte version.
- **Don't use `writable()` from `svelte/store` in new Svelte 5 code** when a `$state` rune in a `.svelte.ts` file does the same job with simpler ergonomics. Stores are still valid for cross-package sharing or `subscribe()` interop.
- **Don't load secrets in `+page.ts`** — that file runs in the browser. Server-only logic goes in `+page.server.ts`.
- **Don't iterate without a key**: `{#each items as item}` re-creates components on mutation. Use `{#each items as item (item.id)}`.
- **Don't use `bind:` for read-only data.** `bind:` implies parent owns mutation. Use `{value}` prop + `on:change` event instead.
- **Don't mutate props inside a child component.** Use `$bindable` if mutation must propagate; otherwise emit an event.
- **Don't put expensive computations in `$:` or `$derived` without memoization checks.** Reactive blocks re-run on every dependency change. Cache when work is heavy.
- **Don't access `window` / `document` at module top-level.** SvelteKit SSR will crash. Guard with `import { browser } from '$app/environment'` or move to `onMount`.
- **Don't reach for `goto()` from `$app/navigation` for external URLs.** It's for SvelteKit internal routes only — use `<a href>` with `target="_blank"`.

## Routing — `/` MUST resolve to a real page

SvelteKit routes that only define `src/routes/login/+page.svelte` and `src/routes/dashboard/+page.svelte` render a blank page at `/`. Add `src/routes/+page.svelte` (the root) — it can simply redirect:

```svelte
<script>
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  onMount(() => goto('/login', { replaceState: true }));
</script>
```
