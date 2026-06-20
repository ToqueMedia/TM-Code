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
  /** 'Bearer'/'none': `apiKeyEnv` aponta para uma API key estática.
   *  'google_oauth': `apiKeyEnv` aponta para o JSON COMPLETO de uma service
   *  account Google (client_email + private_key) — o worker minta um access
   *  token OAuth2 (scope cloud-platform) por pedido, com cache de ~55 min.
   *  É o esquema exigido pela Vertex AI, que não aceita API keys estáticas. */
  authScheme: 'Bearer' | 'none' | 'google_oauth'
  apiKeyEnv: string
  enabled: boolean
  /**
   * Janela de contexto real do modelo ativo, em tokens. Publicada na config
   * KV pelo admin. Quando presente, o worker emite-a no header
   * `X-Model-Context-Window` para a IDE — é a ÚNICA forma de o cliente saber
   * a janela real de um modelo que a tabela `MODEL_PROFILES` local não conhece
   * (BYOK, snapshot novo/renomeado). Sem isto, a decisão de auto-compactação
   * cai no fallback de perfil e, para modelos desconhecidos, assume ~1M — o
   * que faz um modelo de janela pequena rebentar antes de compactar.
   */
  contextWindow?: number
  /**
   * Campos extra de request específicos do provider, merged no corpo de
   * CADA pedido (depois do model, antes do stream_options). Config-driven
   * para o worker continuar provider-agnóstico — ex.: DashScope
   * `{"enable_search": true}` ativa a pesquisa web NATIVA do Qwen sem
   * nenhuma tool client-side. Campos já presentes no corpo do cliente
   * NÃO são sobrepostos.
   */
  extraBody?: Record<string, unknown>
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
  /** Service account para reads/commits de billing ao Firestore (bypass de
   *  Security Rules + App Check). Ausentes → degrada para o ID token do
   *  utilizador (self-read/write permitido pelas rules atuais). */
  FIREBASE_CLIENT_EMAIL?: string
  FIREBASE_PRIVATE_KEY?: string
  /** 'off' | 'shadow' (default) | 'enforce' — ver billing.ts. */
  BUDGET_ENFORCEMENT?: string
  /** Override JSON dos budgets por plano (ver billing.ts resolvePlanBudgets). */
  PLAN_BUDGETS_JSON?: string
  /** Multiplicador de cobrança do TM Speed (default 3). */
  TM_SPEED_BILLING_MULTIPLIER?: string
  /** Timeout (ms) até aos HEADERS do upstream em pedidos STREAMING — default
   *  120000. Só cobre o tempo até ao primeiro byte; o stream em si não tem
   *  limite. */
  UPSTREAM_HEADER_TIMEOUT_MS?: string
  /** Timeout (ms) até aos HEADERS em pedidos NÃO-streaming — default 300000.
   *  Mais folgado: sem stream, os headers só chegam quando a geração inteira
   *  termina (ex.: compactação da IDE com transcript completo). */
  UPSTREAM_NONSTREAM_HEADER_TIMEOUT_MS?: string
  /** Timeout (ms) de INATIVIDADE do stream DEPOIS dos headers — default 90000.
   *  O header-timeout só cobre até ao primeiro byte; este re-arma a cada chunk
   *  e aborta o upstream se não fluírem bytes durante este intervalo (provider
   *  que estola a meio da geração). Sem ele, a Response ficava aberta até o
   *  runtime a matar com "code had hung". 0/negativo desliga o watchdog. */
  UPSTREAM_STREAM_IDLE_TIMEOUT_MS?: string
  [key: string]: unknown
}

/** Subconjunto do ExecutionContext do Workers runtime usado pelo handler. */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void
}

export interface AuthenticatedUser {
  userId: string
}

export interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}
