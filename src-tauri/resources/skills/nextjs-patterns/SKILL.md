# Next.js Patterns

You are working in a Next.js project. Follow these conventions:

## App Router (preferred)
- Use App Router (`app/` directory) for new projects.
- Server Components are the default — add `'use client'` only when needed.
- Use `layout.tsx` for shared layouts, `page.tsx` for routes, `loading.tsx` for suspense.
- Use `error.tsx` for error boundaries, `not-found.tsx` for 404.

## Server vs Client Components
- Server Components: data fetching, accessing backend resources, keeping secrets safe.
- Client Components: interactivity (onClick, onChange), hooks (useState, useEffect), browser APIs.
- Pass data from Server to Client via props — don't import server code in client.
- Wrap client-only libraries in a client component.

## Data Fetching
- Fetch data in Server Components with `async/await` directly.
- Use `fetch()` with caching: `fetch(url, { cache: 'force-cache' })` or `{ next: { revalidate: 60 } }`.
- Use Server Actions for mutations (`'use server'` functions).
- For client-side fetching: use SWR or React Query.

## Server Actions
- Define with `'use server'` directive at top of function or file.
- Use for form submissions, data mutations, revalidation.
- Call `revalidatePath()` / `revalidateTag()` after mutations.
- Validate input with Zod before processing.

## Routing
- Dynamic routes: `[slug]/page.tsx`, catch-all: `[...slug]/page.tsx`.
- Route groups: `(group)/` for organization without URL segments.
- Parallel routes: `@slot/` for simultaneous rendering.
- Intercepting routes: `(.)/` for modal patterns.

## Metadata & SEO
- Export `metadata` object or `generateMetadata()` function from `page.tsx` / `layout.tsx`.
- Use `generateStaticParams()` for static generation of dynamic routes.

## Performance
- Use `next/image` for optimized images.
- Use `next/font` for optimized font loading.
- Use `next/link` for client-side navigation.
- Use `dynamic()` from `next/dynamic` for code splitting.
- Implement streaming with `<Suspense>` boundaries.

## Pages Router Fallback
- If using Pages Router (`pages/`): use `getServerSideProps` / `getStaticProps`.
- Use `_app.tsx` for global layout, `_document.tsx` for HTML structure.

## TypeScript
- Type page props, searchParams, and params.
- Use `Metadata` type from `next` for metadata objects.
