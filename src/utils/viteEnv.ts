/**
 * Jest-safe accessors for Vite's `import.meta.env`.
 *
 * Rationale: ts-jest with the default CJS transform cannot parse `import.meta`
 * expressions — any file that references them blows up the suite at load time
 * (see the "SyntaxError: Cannot use 'import.meta' outside a module" error that
 * previously prevented chatStore.test.ts from running, which in turn blocked
 * stateful tests for everything that transitively imports settingsStore).
 *
 * By funneling Vite env reads through this single module we can mock it in
 * tests via `jest.mock('../../utils/viteEnv')` or the __mocks__ convention —
 * see src/utils/__mocks__/viteEnv.ts. In production, Vite replaces the reads
 * statically at build time; the module export carries the resolved value.
 */

/** Default Ollama endpoint when no override is set (dev, prod, or test). */
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434'

/** Default Worker endpoint when no override is set. */
export const DEFAULT_WORKER_URL = 'http://localhost:8787'

/** User-provided Ollama URL override (Vite env); undefined in Jest. */
export const VITE_OLLAMA_URL: string | undefined = import.meta.env.VITE_OLLAMA_URL as string | undefined

/** User-provided Worker URL override (Vite env); undefined in Jest. */
export const VITE_WORKER_URL: string | undefined = import.meta.env.VITE_WORKER_URL as string | undefined

/** Whether the app is running under a Vite dev server (false in tests, prod build, SSR). */
export const IS_VITE_DEV: boolean = import.meta.env.DEV === true
