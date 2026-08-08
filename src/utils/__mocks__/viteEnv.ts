/**
 * Jest mock for src/utils/viteEnv.ts — supplies static defaults that don't
 * require parsing `import.meta`. Picked up automatically by Jest when the
 * real module is referenced from a test run.
 */

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434'
export const DEFAULT_WORKER_URL = 'http://localhost:8787'
export const DEFAULT_AI_WORKER_URL = 'http://localhost:8788'
export const DEFAULT_COLLAB_SIGNALING_URL = 'ws://localhost:8789'
export const PRODUCTION_DEPLOY_URL = 'https://api-agents.toquemedia.net'
export const PRODUCTION_AI_WORKER_URL = 'https://ai-pass-through-worker.geral-871.workers.dev'
export const PRODUCTION_COLLAB_SIGNALING_URL = 'wss://collab-signaling-worker.geral-871.workers.dev'
export const VITE_OLLAMA_URL: string | undefined = undefined
export const VITE_WORKER_URL: string | undefined = undefined
/** Override do limiar de compactação — os testes põem-no via jest.mock. */
export const VITE_AUTOCOMPACT_PCT: string | undefined = undefined
export const VITE_AI_WORKER_URL: string | undefined = undefined
export const VITE_COLLAB_SIGNALING_URL: string | undefined = undefined
export const IS_VITE_DEV = false
export const VITE_GITHUB_CLIENT_ID: string | undefined = undefined
