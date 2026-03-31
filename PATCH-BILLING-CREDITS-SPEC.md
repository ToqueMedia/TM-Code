# Patch: Billing — Sistema de Créditos no Worker

> **Destino:** Claude Code  
> **Projecto:** `toquemedia-studio-api/` (Worker) + Firestore  
> **Pré-requisito:** Fase 6 (Worker + Auth) implementada  
> **Objectivo:** Implementar sistema de créditos por mensagem + excedente por tokens. Toda a contabilidade server-side no Worker. O client nunca controla billing. Planos e modelos lidos do Firestore — zero hardcode.

---

## Modelo de Billing

```
1 mensagem do user = 1 crédito base
Cada 10K tokens consumidos (input + output, todos os turns da conversa) = +1 crédito

Exemplo:
  "O que é um hook?" → 1 turn, 800 tokens → 1 crédito
  "Cria login com validação" → 15 turns, 45K tokens → 1 + 4 = 5 créditos
  "Refactora o módulo inteiro" → 30 turns, 120K tokens → 1 + 12 = 13 créditos
```

---

## Modelo de Routing

O TM Code funciona como o Claude Code — **o user não escolhe modelo**. Existe exactamente um modelo por tier:

```
Free tier  → modelo X  (barato, ex: Step 3.5 Flash, Qwen3 Coder Next, DeepSeek V3.2)
Paid tier  → modelo Y  (melhor, ex: Kimi K2.5, GLM-5)
```

Os modelos concretos, providers, e preços não estão definidos ainda. A lógica deve ser 100% dinâmica — configurada no Firestore e lida pelo Worker a cada request.

O Worker resolve o modelo com base no plano activo do user. O client NUNCA envia o campo `model` — o Worker injeta-o antes de forward ao provider.

---

## Arquitectura

```
IDE                                Worker                              Firestore
 │                                  │                                    │
 │  POST /v1/chat/completions       │                                    │
 │  + X-Conversation-Id             │                                    │
 │  (sem campo "model" no body)     │                                    │
 │ ────────────────────────────▶    │                                    │
 │                                  │  1. Auth (JWT)                     │
 │                                  │  2. Ler user subscription ─────▶   │
 │                                  │     ◀── plan, credits, billing ─   │
 │                                  │  3. Ler plan config ───────────▶   │
 │                                  │     ◀── model, provider, limits ─  │
 │                                  │  4. credits > 0 ?                  │
 │                                  │     Se não → 402                   │
 │                                  │  5. Injectar model + route provider│
 │                                  │  6. Forward (streaming passthrough)│
 │                                  │  7. Parsear usage do último chunk  │
 │                                  │  8. Calcular + deduzir créditos    │
 │  ◀────────────────────────────   │  9. Headers de billing na response │
 │  X-Credits-Used: 5               │                                    │
 │  X-Credits-Remaining: 245        │                                    │
 │  X-Tokens-Used: 45230            │                                    │
```

---

## 1. Firestore — Collections

### 1.1 subscription_plans (config dos planos)

**Colecção:** `subscription_plans/{planId}`

```
subscription_plans/free
  ├── name: "Free"
  ├── creditsPerMonth: 30
  ├── requestsPerMinute: 5
  ├── tokenThreshold: 10000           # tokens por crédito extra
  ├── model: "step-3.5-flash"         # modelo único do plano (muda sem deploy)
  ├── provider: "stepfun"             # provider key (resolve base_url + api_key)
  ├── providerModel: "step-3.5-flash" # model ID que o provider espera
  └── isActive: true

subscription_plans/dev
  ├── name: "Dev"
  ├── creditsPerMonth: 500
  ├── requestsPerMinute: 15
  ├── tokenThreshold: 10000
  ├── model: "glm-5"
  ├── provider: "fireworks"
  ├── providerModel: "accounts/fireworks/models/glm-5"
  └── isActive: true

subscription_plans/pro
  ├── name: "Pro"
  ├── creditsPerMonth: 1500
  ├── requestsPerMinute: 30
  ├── tokenThreshold: 10000
  ├── model: "glm-5"
  ├── provider: "fireworks"
  ├── providerModel: "accounts/fireworks/models/glm-5"
  └── isActive: true

subscription_plans/team
  ├── name: "Team"
  ├── creditsPerMonth: 3000
  ├── requestsPerMinute: 60
  ├── tokenThreshold: 10000
  ├── model: "glm-5"
  ├── provider: "fireworks"
  ├── providerModel: "accounts/fireworks/models/glm-5"
  └── isActive: true
```

**Nota:** `model` é o nome human-readable. `provider` + `providerModel` são usados pelo Worker para routing. Mudar de GLM-5 para Kimi K2.5 é actualizar 3 campos no Firestore — zero deploy.

### 1.2 subscriptions (subscrição activa do user)

**Colecção:** `subscriptions/{userId}`

```
subscriptions/{userId}
  ├── planId: "dev"                    # referência a subscription_plans/{planId}
  ├── status: "active"                 # "active" | "cancelled" | "expired" | "trial"
  ├── startDate: timestamp
  ├── endDate: timestamp               # fim do período actual
  │
  ├── billing: {                       # sub-documento de billing
  │   ├── credits: 245                 # créditos restantes no ciclo
  │   ├── creditsUsed: 255             # créditos usados no ciclo
  │   ├── cycleStart: timestamp        # início do ciclo de billing
  │   ├── cycleEnd: timestamp          # fim do ciclo de billing
  │   ├── totalTokensUsed: 1823400     # tokens totais (analytics)
  │   └── totalMessagesUsed: 187       # mensagens totais (analytics)
  │ }
  │
  └── createdAt: timestamp
```

**Nota:** `subscriptions` é separada de `users` propositalmente. O user doc (`users/{userId}`) mantém dados de perfil. O `subscriptions` doc mantém dados de billing. Isto permite queries independentes e eventual migração para billing externo.

### 1.3 providers (config dos providers LLM)

Para o MVP, os providers ficam no Worker como config estática (API keys são secrets). Não faz sentido ter API keys no Firestore.

---

## 2. Provider config — src/providers.ts

**Criar:** `toquemedia-studio-api/src/providers.ts`

```typescript
export interface ProviderConfig {
  baseUrl: string
  apiKeyEnvVar: string
}

// Mapa de providers. Adicionar novos aqui quando decididos.
// As API keys são secrets no wrangler (wrangler secret put FIREWORKS_API_KEY)
export const PROVIDERS: Record<string, ProviderConfig> = {
  fireworks: {
    baseUrl: 'https://api.fireworks.ai/inference/v1/chat/completions',
    apiKeyEnvVar: 'FIREWORKS_API_KEY'
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY'
  },
  stepfun: {
    baseUrl: 'https://api.stepfun.ai/v1/chat/completions',
    apiKeyEnvVar: 'STEPFUN_API_KEY'
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    apiKeyEnvVar: 'OPENROUTER_API_KEY'
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiKeyEnvVar: 'GEMINI_API_KEY'
  },
  azure: {
    baseUrl: '', // Dinâmico — set via AZURE_BASE_URL env var
    apiKeyEnvVar: 'AZURE_API_KEY'
  },
  deepinfra: {
    baseUrl: 'https://api.deepinfra.com/v1/openai/chat/completions',
    apiKeyEnvVar: 'DEEPINFRA_API_KEY'
  },
  ollama: {
    baseUrl: 'http://localhost:11434/v1/chat/completions',
    apiKeyEnvVar: ''
  }
}

export function getProvider(providerId: string): ProviderConfig | null {
  return PROVIDERS[providerId] || null
}
```

---

## 3. Plan resolver — src/planResolver.ts

**Criar:** `toquemedia-studio-api/src/planResolver.ts`

```typescript
import { getProvider, ProviderConfig } from './providers'

export interface ResolvedPlan {
  planId: string
  planName: string
  creditsPerMonth: number
  requestsPerMinute: number
  tokenThreshold: number
  model: string
  provider: string
  providerModel: string
  providerConfig: ProviderConfig
}

export interface SubscriptionData {
  planId: string
  status: string
  billing: BillingState
}

export interface BillingState {
  credits: number
  creditsUsed: number
  cycleStart: string
  cycleEnd: string
  totalTokensUsed: number
  totalMessagesUsed: number
}

// Cache do plan config — TTL 5min, evita ler Firestore em cada request
const planCache = new Map<string, { data: ResolvedPlan; expiry: number }>()
const PLAN_CACHE_TTL = 5 * 60 * 1000

export async function getSubscription(
  userId: string,
  projectId: string,
  authToken: string
): Promise<SubscriptionData> {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/subscriptions/${userId}`

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${authToken}` }
  })

  if (!response.ok) {
    // Sem subscrição — free
    return {
      planId: 'free',
      status: 'active',
      billing: createEmptyBilling()
    }
  }

  const doc = await response.json()
  const fields = doc.fields

  const planId = fields.planId?.stringValue || 'free'
  const status = fields.status?.stringValue || 'expired'

  if (status !== 'active' && status !== 'trial') {
    return { planId: 'free', status, billing: createEmptyBilling() }
  }

  const billingMap = fields.billing?.mapValue?.fields
  let billing: BillingState

  if (billingMap) {
    billing = {
      credits: parseInt(billingMap.credits?.integerValue || '0'),
      creditsUsed: parseInt(billingMap.creditsUsed?.integerValue || '0'),
      cycleStart: billingMap.cycleStart?.stringValue || '',
      cycleEnd: billingMap.cycleEnd?.stringValue || '',
      totalTokensUsed: parseInt(billingMap.totalTokensUsed?.integerValue || '0'),
      totalMessagesUsed: parseInt(billingMap.totalMessagesUsed?.integerValue || '0')
    }
  } else {
    billing = createEmptyBilling()
  }

  return { planId, status, billing }
}

export async function getPlanConfig(
  planId: string,
  projectId: string,
  authToken: string
): Promise<ResolvedPlan | null> {
  const cached = planCache.get(planId)
  if (cached && Date.now() < cached.expiry) {
    return cached.data
  }

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/subscription_plans/${planId}`

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${authToken}` }
  })

  if (!response.ok) return null

  const doc = await response.json()
  const fields = doc.fields

  const providerKey = fields.provider?.stringValue || ''
  const providerConfig = getProvider(providerKey)
  if (!providerConfig) {
    console.error(`Unknown provider: ${providerKey} for plan: ${planId}`)
    return null
  }

  const resolved: ResolvedPlan = {
    planId,
    planName: fields.name?.stringValue || planId,
    creditsPerMonth: parseInt(fields.creditsPerMonth?.integerValue || '30'),
    requestsPerMinute: parseInt(fields.requestsPerMinute?.integerValue || '5'),
    tokenThreshold: parseInt(fields.tokenThreshold?.integerValue || '10000'),
    model: fields.model?.stringValue || '',
    provider: providerKey,
    providerModel: fields.providerModel?.stringValue || '',
    providerConfig
  }

  planCache.set(planId, { data: resolved, expiry: Date.now() + PLAN_CACHE_TTL })
  return resolved
}

// Billing vazio — será preenchido pelo initBillingCycle
function createEmptyBilling(): BillingState {
  return {
    credits: 0, creditsUsed: 0,
    cycleStart: '', cycleEnd: '',
    totalTokensUsed: 0, totalMessagesUsed: 0
  }
}

// Criar novo ciclo
export function createNewBillingCycle(creditsPerMonth: number): BillingState {
  const now = new Date()
  const cycleEnd = new Date(now)
  cycleEnd.setMonth(cycleEnd.getMonth() + 1)

  return {
    credits: creditsPerMonth,
    creditsUsed: 0,
    cycleStart: now.toISOString(),
    cycleEnd: cycleEnd.toISOString(),
    totalTokensUsed: 0,
    totalMessagesUsed: 0
  }
}
```

---

## 4. Billing service — src/billing.ts

**Criar:** `toquemedia-studio-api/src/billing.ts`

```typescript
import type { BillingState } from './planResolver'

export interface CreditCalculation {
  baseCredits: number
  tokenCredits: number
  totalCredits: number
  totalTokens: number
}

export function calculateCredits(
  totalTokens: number,
  tokenThreshold: number
): CreditCalculation {
  const baseCredits = 1
  const tokenCredits = Math.floor(totalTokens / tokenThreshold)
  return {
    baseCredits,
    tokenCredits,
    totalCredits: baseCredits + tokenCredits,
    totalTokens
  }
}

export function hasCredits(billing: BillingState): boolean {
  const now = new Date()
  const cycleEnd = new Date(billing.cycleEnd)
  if (now > cycleEnd) return false
  return billing.credits > 0
}
```

---

## 5. Firestore operations — src/firestoreOps.ts

**Criar:** `toquemedia-studio-api/src/firestoreOps.ts`

```typescript
import type { BillingState } from './planResolver'

export async function writeBilling(
  userId: string,
  projectId: string,
  authToken: string,
  billing: BillingState
): Promise<void> {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/subscriptions/${userId}`

  await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fields: {
        billing: {
          mapValue: {
            fields: {
              credits: { integerValue: String(billing.credits) },
              creditsUsed: { integerValue: String(billing.creditsUsed) },
              cycleStart: { stringValue: billing.cycleStart },
              cycleEnd: { stringValue: billing.cycleEnd },
              totalTokensUsed: { integerValue: String(billing.totalTokensUsed) },
              totalMessagesUsed: { integerValue: String(billing.totalMessagesUsed) }
            }
          }
        }
      }
    })
  })
}

export async function deductCredits(
  userId: string,
  projectId: string,
  authToken: string,
  currentBilling: BillingState,
  creditsToDeduct: number,
  tokensUsed: number
): Promise<BillingState> {
  const updated: BillingState = {
    ...currentBilling,
    credits: Math.max(0, currentBilling.credits - creditsToDeduct),
    creditsUsed: currentBilling.creditsUsed + creditsToDeduct,
    totalTokensUsed: currentBilling.totalTokensUsed + tokensUsed,
    totalMessagesUsed: currentBilling.totalMessagesUsed + 1
  }
  await writeBilling(userId, projectId, authToken, updated)
  return updated
}
```

---

## 6. Token counting com streaming — src/billingMiddleware.ts

**Criar:** `toquemedia-studio-api/src/billingMiddleware.ts`

```typescript
import { calculateCredits } from './billing'
import { deductCredits } from './firestoreOps'
import type { BillingState, ResolvedPlan } from './planResolver'

interface BillingContext {
  userId: string
  billing: BillingState
  plan: ResolvedPlan
  projectId: string
  authToken: string
  conversationId: string | null
  kvNamespace: KVNamespace
}

export function createBillingStream(
  providerStream: ReadableStream<Uint8Array>,
  context: BillingContext
): ReadableStream<Uint8Array> {

  let usageData: { prompt_tokens: number; completion_tokens: number } | null = null
  let buffer = ''

  const transformStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)

      const text = new TextDecoder().decode(chunk)
      buffer += text

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
        try {
          const json = JSON.parse(line.slice(6))
          if (json.usage) {
            usageData = {
              prompt_tokens: json.usage.prompt_tokens || 0,
              completion_tokens: json.usage.completion_tokens || 0
            }
          }
        } catch { /* skip */ }
      }
    },

    async flush() {
      const totalTokens = usageData
        ? usageData.prompt_tokens + usageData.completion_tokens
        : 0

      await processBilling(context, totalTokens)
    }
  })

  return providerStream.pipeThrough(transformStream)
}

async function processBilling(
  ctx: BillingContext,
  totalTokens: number
): Promise<void> {
  try {
    const convId = ctx.conversationId

    if (convId) {
      // Agrupar por conversa — 1 crédito base por conversa, não por turn
      const convKey = `conv:${ctx.userId}:${convId}`
      const existing = await ctx.kvNamespace.get(convKey)

      if (existing) {
        // Continuação — sem crédito base, apenas token credits incrementais
        const convData = JSON.parse(existing)
        convData.totalTokens += totalTokens
        convData.turns += 1

        const newTokenCredits = Math.floor(convData.totalTokens / ctx.plan.tokenThreshold)
        const additionalCredits = newTokenCredits - convData.lastTokenCredits
        convData.lastTokenCredits = newTokenCredits

        if (additionalCredits > 0) {
          await deductCredits(
            ctx.userId, ctx.projectId, ctx.authToken,
            ctx.billing, additionalCredits, totalTokens
          )
        }

        await ctx.kvNamespace.put(convKey, JSON.stringify(convData), { expirationTtl: 3600 })

      } else {
        // Nova conversa
        const credits = calculateCredits(totalTokens, ctx.plan.tokenThreshold)
        await deductCredits(
          ctx.userId, ctx.projectId, ctx.authToken,
          ctx.billing, credits.totalCredits, totalTokens
        )

        await ctx.kvNamespace.put(convKey, JSON.stringify({
          totalTokens,
          turns: 1,
          lastTokenCredits: credits.tokenCredits,
          startedAt: Date.now()
        }), { expirationTtl: 3600 })
      }

    } else {
      // Sem conversation ID — cobrar normalmente
      const credits = calculateCredits(totalTokens, ctx.plan.tokenThreshold)
      await deductCredits(
        ctx.userId, ctx.projectId, ctx.authToken,
        ctx.billing, credits.totalCredits, totalTokens
      )
    }
  } catch (err) {
    console.error('Billing error:', err)
    await deductCredits(
      ctx.userId, ctx.projectId, ctx.authToken,
      ctx.billing, 1, 0
    ).catch(() => {})
  }
}
```

---

## 7. Actualizar index.ts — flow completo

**Ficheiro:** `toquemedia-studio-api/src/index.ts`

```typescript
import { getSubscription, getPlanConfig, createNewBillingCycle } from './planResolver'
import { calculateCredits, hasCredits } from './billing'
import { deductCredits, writeBilling } from './firestoreOps'
import { getProvider } from './providers'
import { createBillingStream } from './billingMiddleware'

const EXPOSED_HEADERS = 'X-Credits-Used, X-Credits-Remaining, X-Tokens-Used, X-Plan, X-Cycle-End'

// Dentro do handler principal:

// 1. Auth (existente)
const decodedToken = await verifyFirebaseToken(idToken, env.FIREBASE_PROJECT_ID)
const userId = decodedToken.sub

// 2. Ler subscription
const subscription = await getSubscription(userId, env.FIREBASE_PROJECT_ID, idToken)

// 3. Ler plan config
const plan = await getPlanConfig(subscription.planId, env.FIREBASE_PROJECT_ID, idToken)
if (!plan) {
  return errorResponse(500, 'Plan configuration not found')
}

// 4. Inicializar billing se necessário (user novo ou ciclo expirado)
if (!subscription.billing.cycleEnd || new Date() > new Date(subscription.billing.cycleEnd)) {
  subscription.billing = createNewBillingCycle(plan.creditsPerMonth)
  await writeBilling(userId, env.FIREBASE_PROJECT_ID, idToken, subscription.billing)
}

// 5. Verificar créditos
if (!hasCredits(subscription.billing)) {
  return Response.json(
    {
      error: 'No credits remaining',
      credits_remaining: 0,
      cycle_end: subscription.billing.cycleEnd,
      plan: plan.planName
    },
    {
      status: 402,
      headers: {
        'X-Credits-Remaining': '0',
        'X-Cycle-End': subscription.billing.cycleEnd,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': EXPOSED_HEADERS
      }
    }
  )
}

// 6. Rate limit
const rateLimitResult = await checkRateLimit(userId, plan.requestsPerMinute, env.RATE_LIMIT)
if (!rateLimitResult.allowed) {
  return errorResponse(429, 'Rate limit exceeded', { retry_after: rateLimitResult.retryAfter })
}

// 7. Injectar modelo — client NÃO envia model
const requestBody = await request.json() as any
requestBody.model = plan.providerModel

// 8. Forward ao provider
const apiKey = (env as any)[plan.providerConfig.apiKeyEnvVar] || ''
const providerResponse = await fetch(plan.providerConfig.baseUrl, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(requestBody)
})

// 9. Response com billing
const conversationId = request.headers.get('X-Conversation-Id')
const contentType = providerResponse.headers.get('content-type') || ''

if (contentType.includes('text/event-stream')) {
  // STREAMING
  const stream = createBillingStream(providerResponse.body!, {
    userId,
    billing: subscription.billing,
    plan,
    projectId: env.FIREBASE_PROJECT_ID,
    authToken: idToken,
    conversationId,
    kvNamespace: env.RATE_LIMIT
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': EXPOSED_HEADERS,
      'X-Credits-Remaining': String(subscription.billing.credits),
      'X-Plan': plan.planName
    }
  })

} else {
  // NON-STREAMING
  const body = await providerResponse.json() as any
  const totalTokens = (body.usage?.prompt_tokens || 0) + (body.usage?.completion_tokens || 0)
  const credits = calculateCredits(totalTokens, plan.tokenThreshold)

  await deductCredits(userId, env.FIREBASE_PROJECT_ID, idToken,
    subscription.billing, credits.totalCredits, totalTokens)

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': EXPOSED_HEADERS,
      'X-Credits-Used': String(credits.totalCredits),
      'X-Credits-Remaining': String(Math.max(0, subscription.billing.credits - credits.totalCredits)),
      'X-Tokens-Used': String(totalTokens),
      'X-Plan': plan.planName
    }
  })
}
```

---

## 8. IDE — mostrar créditos

### 8.1 billingStore.ts

**Criar:** `exodus-ide/src/stores/billingStore.ts`

```typescript
interface BillingState {
  creditsRemaining: number
  plan: string
  noCredits: boolean
  cycleEnd: string | null
}

interface BillingActions {
  updateFromHeaders: (headers: Headers) => void
  setNoCredits: (cycleEnd: string) => void
  reset: () => void
}
```

### 8.2 agentService.ts

```typescript
// Enviar X-Conversation-Id em cada request:
headers: {
  'Authorization': `Bearer ${idToken}`,
  'Content-Type': 'application/json',
  'X-Conversation-Id': sessionId
}
// O body NÃO inclui "model"

// Ler headers de billing:
const creditsRemaining = response.headers.get('X-Credits-Remaining')
if (creditsRemaining !== null) {
  useBillingStore.getState().updateFromHeaders(response.headers)
}

// 402 — sem créditos
if (response.status === 402) {
  const body = await response.json()
  useBillingStore.getState().setNoCredits(body.cycle_end)
  throw new Error('No credits remaining.')
}
```

### 8.3 AgentStatusBar

```
🟢 Ready | Credits: 245/500 | Plan: Dev
```
```
🔴 No credits | Resets Apr 1 | [Upgrade]
```

---

## 9. CORS

```typescript
// Em OPTIONS e todas as responses:
headers.set('Access-Control-Expose-Headers', EXPOSED_HEADERS)
```

---

## 10. Ficheiros do Worker — resumo

```
toquemedia-studio-api/src/
  ├── index.ts              # Entry point — flow completo
  ├── auth.ts               # Firebase JWT verification (existente)
  ├── providers.ts          # Config estática de providers (base_url + api_key ref)
  ├── planResolver.ts       # Lê subscription + plan do Firestore, cache 5min
  ├── billing.ts            # calculateCredits, hasCredits (puro, sem IO)
  ├── billingMiddleware.ts  # TransformStream streaming + conversation grouping
  ├── firestoreOps.ts       # writeBilling, deductCredits (IO Firestore)
  ├── rateLimit.ts          # Rate limiting via KV (existente)
  └── types.ts              # Shared types
```

---

## Critérios de Done

### Worker:
- [ ] `src/providers.ts` criado — config de providers, extensível
- [ ] `src/planResolver.ts` criado — lê subscription + plan config do Firestore com cache 5min
- [ ] `src/billing.ts` criado — calculateCredits, hasCredits (sem IO)
- [ ] `src/billingMiddleware.ts` criado — TransformStream streaming + conversation grouping via KV
- [ ] `src/firestoreOps.ts` criado — writeBilling, deductCredits
- [ ] `src/index.ts` actualizado — flow completo com billing
- [ ] Worker injeta `model` no request body (client não envia)
- [ ] Worker resolve provider + model a partir do plan config do Firestore
- [ ] 402 quando créditos = 0
- [ ] Agrupamento por `X-Conversation-Id` — 1 base por conversa
- [ ] Renovação automática de ciclo quando expirado
- [ ] Billing streaming (TransformStream)
- [ ] Billing non-streaming
- [ ] Headers `X-Credits-*` em todas as respostas
- [ ] CORS expõe headers custom

### Firestore:
- [ ] Collection `subscription_plans` criada com: free, dev, pro, team
- [ ] Cada doc: name, creditsPerMonth, requestsPerMinute, tokenThreshold, model, provider, providerModel, isActive
- [ ] Collection `subscriptions` criada
- [ ] Cada doc: planId, status, billing (sub-doc), startDate, endDate, createdAt
- [ ] Billing sub-doc: credits, creditsUsed, cycleStart, cycleEnd, totalTokensUsed, totalMessagesUsed

### IDE:
- [ ] `billingStore.ts` criado
- [ ] `AgentStatusBar` mostra créditos e plano
- [ ] `agentService.ts` lê headers de billing
- [ ] `agentService.ts` envia `X-Conversation-Id`
- [ ] `agentService.ts` NÃO envia campo `model`
- [ ] Mensagem clara no 402

---

## O que NÃO fazer

- Não hardcodar modelos no Worker — tudo vem do Firestore (subscription_plans)
- Não hardcodar preços/créditos de planos — tudo vem do Firestore
- Não permitir o client enviar o campo `model` — o Worker injeta
- Não implementar pagamentos nesta spec
- Não implementar upgrade in-app
- Não implementar rollover de créditos
- Não implementar billing diferenciado por modelo
- Não confiar no client para contagem de tokens
- Não bloquear o stream para contar tokens
- Não guardar API keys no Firestore — ficam como secrets no wrangler
