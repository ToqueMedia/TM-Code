/**
 * Jest mock for src/utils/viteEnv.ts — supplies static defaults that don't
 * require parsing `import.meta`. Picked up automatically by Jest when the
 * real module is referenced from a test run.
 */

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434'
export const DEFAULT_WORKER_URL = 'http://localhost:8787'
export const DEFAULT_AI_WORKER_URL = 'http://localhost:8788'
export const PRODUCTION_DEPLOY_URL = 'https://api-agents.toquemedia.net'
export const VITE_OLLAMA_URL: string | undefined = undefined
export const VITE_WORKER_URL: string | undefined = undefined
export const VITE_AI_WORKER_URL: string | undefined = undefined
export const VITE_DEPLOY_URL: string | undefined = undefined
export const IS_VITE_DEV = false
