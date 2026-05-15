# Next.js Patterns

You are working in a Next.js project. App Router (`app/`) is the default for new code. The `pages/` router still works but is legacy. The rules below cover non-obvious decisions and footguns.

## Decision points (non-obvious)

- **Server Component is the default**: do NOT add `'use client'` unless you need interactivity (`onClick`, `onChange`, hooks like `useState`/`useEffect`/`useRef`, browser APIs). Each `'use client'` boundary opts out of streaming + zero-JS rendering for everything below it.
- **Data fetching: in the Server Component, with `await`**. No SWR/React Query needed for server-rendered data. Reach for those only when you need client-side caching/revalidation.
- **Server Actions for mutations** (`'use server'` directive). Use them with `<form action={...}>` for progressive enhancement. Always call `revalidatePath()` / `revalidateTag()` after a mutation that changes displayed data.
- **`getServerSideProps` / `getStaticProps` are Pages Router only**. App Router has different mechanisms — never mix.

## Patterns to Avoid

- **Don't use `getServerSideProps` / `getStaticProps` in App Router projects.** Wrong router. Fetch in an `async` Server Component or use `fetch()` with `next: { revalidate: N }` for caching.
- **Don't add `'use client'` to a layout/page that doesn't need interactivity.** Each boundary opts out of server rendering for the subtree.
- **Don't import server-only modules from a Client Component.** Anything that touches DB, secrets, fs, or `process.env` (server-side env vars without `NEXT_PUBLIC_` prefix) leaks to the bundle. Use `import 'server-only'` as a guard.
- **Don't fetch the same data in both Server and Client Components for the same page.** Pick one; pass via props from server to client.
- **Don't use `'use server'` for read operations.** Server Actions are for mutations. For reads, fetch directly in a Server Component or use a Route Handler (`route.ts`).
- **Don't forget `revalidatePath()` / `revalidateTag()` after a mutation.** Without it, the user sees stale data after a successful Server Action — "save" succeeded but the list didn't update.
- **Don't use `<a href>` for internal navigation.** Triggers full page reload. Use `<Link href>` from `next/link`.
- **Don't read environment variables in client code without `NEXT_PUBLIC_` prefix.** They'll be `undefined` in the browser bundle. If a value must be public, prefix it explicitly — accept that "public" means visible to anyone.
- **Don't use `next/image` with arbitrary remote URLs without configuring `images.remotePatterns`.** Build will fail in production.
- **Don't put `<Image>` inside flex containers without explicit `width`/`height` or `fill` + a sized parent.** Layout shift or invisible image follows.
- **Don't skip the `loading.tsx` / `<Suspense>` boundary for slow data.** Without it, the route blocks until ALL data is fetched.
- **Don't manually handle CSS variable theme switching with `useEffect`.** Use the `class` attribute on `<html>` set during render — `useEffect` causes a flash of wrong theme on first paint.

## Route conventions reference

- `app/page.tsx` — the `/` route (this is your homepage; it MUST exist or `/` is blank)
- `app/[slug]/page.tsx` — dynamic routes
- `app/[...slug]/page.tsx` — catch-all
- `app/(group)/...` — route groups (organization, no URL impact)
- `app/@slot/...` — parallel routes
- `app/(.)/...` — intercepting routes (modal patterns)
