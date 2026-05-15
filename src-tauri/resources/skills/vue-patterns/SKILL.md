# Vue Patterns

You are working in a Vue 3+ project. Composition API + `<script setup>`, Pinia for shared state, TypeScript strict — these are the defaults assumed throughout. The rules below cover non-obvious decisions and footguns.

## Decision points (non-obvious)

- **`ref()` vs `reactive()`**: prefer `ref()` for everything by default — primitives AND objects. `reactive()` loses reactivity when destructured (`const { user } = useUserStore()` breaks); `ref()` doesn't. Only reach for `reactive()` when you specifically need a single root object that won't be destructured.
- **`v-if` vs `v-show`**: `v-if` is cheaper per render but expensive per toggle. `v-show` is the inverse. For a tab/menu that toggles often, `v-show`. For an admin panel that may never render, `v-if`. The default-everywhere of `v-if` produces stutter on toggle-heavy UIs.
- **Pinia setup syntax over options syntax**: `defineStore('id', () => { ... })` is the modern path. The options syntax (`defineStore('id', { state, actions, getters })`) is being phased out — don't generate it for new code.

## Patterns to Avoid

- **Don't put `v-if` and `v-for` on the same element.** Vue's compiler warns; behaviour is also unintuitive (v-if evaluates per item). Wrap one in a `<template>` instead.
- **Don't destructure a `reactive()` object** — destructuring breaks reactivity. Either use `ref()` (which preserves reactivity through `.value`), or use `toRefs()` if you must destructure a reactive.
- **Don't `watch` to keep two pieces of state in sync.** Use `computed()`. Watchers are for side effects (fetch, persist, scroll) — sync via watch creates render cascades.
- **Don't `watch` deep on large objects without scoping** — `{ deep: true }` on a 1000-key store is a perf cliff. Watch specific properties.
- **Don't use `key` of array index in `v-for`.** Same hazard as React: breaks reorder/insert/delete and causes input focus loss. Use stable id.
- **Don't use Vuex in new code.** Pinia is the official recommendation since Vue 3 launched. Vuex is in maintenance mode.
- **Don't put non-prop attributes on the root element of a component that uses `inheritAttrs: false` without explicit `v-bind="$attrs"`** — the attrs disappear silently.
- **Don't leak `<style>` without `scoped`** unless you're writing a global stylesheet on purpose. Cross-component bleed is the biggest CSS bug in Vue projects.

## Routing — `/` MUST resolve to a real page

Same footgun as React Router. Vue Router with only `/login`, `/dashboard` and no `/` route renders blank at `/`. Add a redirect:

```ts
const routes = [
  { path: '/', redirect: '/login' },
  { path: '/login', component: Login },
  { path: '/:pathMatch(.*)*', redirect: '/login' },  // 404 → known page
]
```
