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
  /** Inline provider key — ONLY for Team BYOK configs (`team:{teamId}`), whose
   *  key is per-team and dynamic and so cannot be a static worker env secret
   *  like the managed `active`/`sidecar:*` configs (those always use
   *  `apiKeyEnv`). When present, buildUpstreamHeaders uses it over `apiKeyEnv`.
   *  The managed-config parser never populates this — only parseTeamByokConfig. */
  apiKey?: string
  /** Team BYOK ONLY (`team:{teamId}`): the owner's virtual shared budget in
   *  tokens — an ESTIMATE of what they prepaid the provider, NOT the real
   *  provider balance. 0/absent → pass-through (no metering). When > 0 the
   *  data-plane meters raw (1x) usage against it + the per-member
   *  percentAllocation slices. Managed parser never sets it. */
  pool?: number
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
   * Teto de tokens de SAÍDA do modelo ativo. Publicado na config KV pelo admin
   * e emitido em `X-Model-Max-Output-Tokens`.
   *
   * Irmão do contextWindow e pela mesma razão (auditoria 2026-07-28): a janela
   * já tinha header, o output NÃO — portanto um modelo novo publicado só no KV
   * herdava o teto do perfil de fallback da IDE (MiMo, 32K) e ficava calado
   * nesse limite, mesmo sendo capaz de gerar 128K+. Esse valor é também o teto
   * da escalada anti-truncagem no loop, por isso o efeito era duplo.
   */
  maxOutputTokens?: number
  /**
   * Capacidades do modelo ativo, emitidas em `X-Model-Capabilities` como
   * `vision=1;search=0;thinking=toggleable`.
   *
   * Terceiro irmão do contextWindow/maxOutputTokens, e pela mesma razão levada
   * até ao fim (auditoria 2026-07-29): a IDE tem uma tabela `MODEL_PROFILES`
   * cozida e, para um modelo que ela não conhece, herdava as flags de OUTRO
   * modelo — o perfil do plano. Num desenho onde "adicionar um modelo é editar
   * a KV, não o código", publicar um modelo novo dava-lhe silenciosamente a
   * visão, o pensamento e a pesquisa do anterior: imagens enviadas a quem não
   * as lê, `thinking` imposto a quem não o suporta.
   *
   * Campos publicados na KV: `supportsVision`, `supportsSearch`, `thinkingMode`.
   * Ausentes → header omitido → a IDE fica com o perfil local (comportamento
   * anterior, agora por escolha e não por falta de informação).
   */
  capabilities?: {
    vision?: boolean
    search?: boolean
    thinking?: 'toggleable' | 'mandatory' | 'none'
  }
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
  /** Fração a que os tokens de prompt CACHEADOS são faturados (0..1; default
   *  0.5). Ver resolveCacheBillingFactor. */
  TM_CACHE_BILLING_FACTOR?: string
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
  /** Tecto para LER o corpo que o CLIENTE envia (`await request.json()`).
   *  Um upload estolado (TCP vivo, bytes parados) não dispara `request.signal`
   *  — o cliente não abortou — e pendurava o pedido até o runtime o matar com
   *  "code had hung". Default 60s (folgado para prompts de centenas de KB);
   *  0/negativo desliga. */
  CLIENT_BODY_TIMEOUT_MS?: string
  /** Re-tentativas do pedido ao provedor em falhas transitórias de gateway
   *  (HTML 400 do Tengine/DashScope, 502/503/504, timeout/transporte). Default
   *  2 (3 tentativas no total); "0" desliga. */
  UPSTREAM_MAX_RETRIES?: string
  /** Shared AES-256 secret (base64 of 32 bytes) for decrypting Team BYOK keys
   *  stored in `team:{teamId}` KV values. Same value as the control-plane's
   *  TEAM_BYOK_ENC_KEY (which encrypts on publish). Absent → Team BYOK is
   *  inert (configs ignored, degrade to managed). Provision via wrangler secret. */
  TEAM_BYOK_ENC_KEY?: string
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
