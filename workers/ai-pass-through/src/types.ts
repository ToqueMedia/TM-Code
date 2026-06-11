export interface KVNamespace {
  get(key: string): Promise<string | null>
}

export interface ActiveAIConfig {
  provider: string
  model: string
  /** Modelo alternativo usado quando o pedido chega com `X-TM-Speed: true`
   * (TM Speed / `/speed` na IDE). Ausente → o toggle é um no-op e o pedido
   * usa `model`; o worker nunca falha por o speed model não estar publicado. */
  speedModel?: string
  baseUrl: string
  chatCompletionsPath: string
  authHeader: string
  authScheme: 'Bearer' | 'none'
  apiKeyEnv: string
  enabled: boolean
  updatedAt?: string
}

export interface ResolvedActiveAIConfig {
  config: ActiveAIConfig
  source: 'kv' | 'env'
  key: string
}

export interface Env {
  ACTIVE_AI_CONFIG?: KVNamespace
  ACTIVE_AI_CONFIG_KEY?: string
  ACTIVE_AI_CONFIG_JSON?: string
  AUTH_MODE?: 'firebase_jwt' | 'firebase_emulator' | 'test_static'
  TEST_USER_TOKEN?: string
  FIREBASE_PROJECT_ID?: string
  /** Override da base do Firestore REST (testes/emulador). Default: produção. */
  FIRESTORE_REST_BASE?: string
  FIREBASE_ISSUER?: string
  FIREBASE_JWKS_URL?: string
  [key: string]: unknown
}

export interface AuthenticatedUser {
  userId: string
}

export interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}
