# Vue Patterns

You are working in a Vue project. Follow these conventions:

## Composition API
- Use `<script setup>` syntax for all new components.
- Use `ref()` for primitives, `reactive()` for objects.
- Use `computed()` for derived state — never duplicate state.
- Use `watch` / `watchEffect` only for side effects, not state sync.

## Component Structure
- Single-file components (.vue): `<script setup>`, `<template>`, `<style scoped>`.
- Component names in PascalCase, file names match component names.
- Keep components under 200 lines. Extract composables for reusable logic.
- Props: define with `defineProps<T>()` using TypeScript interface.
- Emits: define with `defineEmits<T>()`.

## Composables
- Prefix with `use`: `useAuth()`, `useCounter()`.
- Return reactive refs/computed, not raw values.
- Accept refs as arguments for reactivity: `function useFetch(url: Ref<string>)`.
- Place in `composables/` directory.

## State Management
- Local state: `ref()` / `reactive()` in components.
- Shared state: Pinia stores with `defineStore()`.
- Pinia: use setup syntax (`defineStore('id', () => { ... })`).
- Avoid Vuex — Pinia is the official recommendation.

## Template Best Practices
- Use `v-for` with `:key` always — use stable unique IDs, not index.
- Prefer `v-if` over `v-show` for conditional rendering (unless toggling frequently).
- Don't use `v-if` and `v-for` on the same element.
- Use `<Teleport>` for modals/popovers that need to render at document root.

## Performance
- Lazy load routes with `defineAsyncComponent` or dynamic `import()`.
- Use `<KeepAlive>` for cached route components.
- Avoid deep watchers on large objects — watch specific properties.

## TypeScript
- Enable strict mode. Type all props, emits, and composable return types.
- Use `PropType` for complex prop types when not using `<script setup>`.
