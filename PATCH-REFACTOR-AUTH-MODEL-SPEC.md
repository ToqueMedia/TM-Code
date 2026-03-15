# Patch: Refactor Auth Flow + Remover Model Selector + Identificar User

> **Destino:** Claude Code  
> **Projectos:** `exodus-ide/` (IDE) + `toquemedia-studio-api/` (Worker)  
> **Pré-requisito:** Fase 6 completa (Firebase Auth + Worker proxy implementados)  
> **Objectivo:** 
> 1. Remover flow de API key e selector de modelo da IDE — a IDE nunca escolhe modelo
> 2. O Worker decide o modelo com base no plano do user
> 3. Em dev (Ollama via `wrangler dev`), o Worker usa modelo local automaticamente
> 4. Mostrar identidade do user logado na IDE

---

## Contexto — Estado actual (pós-Fase 6)

A IDE actualmente tem:
- `ApiKeyDialog.tsx` — pede API key ao user (dev mode)
- `apiKeyManager.ts` — guarda API keys no localStorage por provider
- Model selector no `PromptBar.tsx` ou `agentStore.ts` — dropdown para o user escolher modelo
- `agentService.ts` — dual-mode (`VITE_USE_PROXY` true/false), constrói request com model ID escolhido pelo user
- `authStore.ts` + `LoginScreen.tsx` — Firebase Auth funcional
- `firebaseAuth.ts` — signIn, signUp, getIdToken

O Worker tem:
- `proxy.ts` — `MODEL_TO_PROVIDER` map + `handleChatRequest` que lê `body.model` do request
- `firestore.ts` — `getUserPlan()` que lê `userPlan` do Firestore
- `auth.ts` — verifica Firebase JWT
- `rateLimit.ts` — rate limiting por plano

---

## Parte 1 — IDE: Remover o que não faz sentido

### 1.1 APAGAR ficheiros

| Ficheiro | Razão |
|----------|-------|
| `src/services/agent/apiKeyManager.ts` | Não há API keys no client |
| `src/components/chat/ApiKeyDialog.tsx` | Não há dialog de API key |

### 1.2 REMOVER do agentStore.ts

**Ficheiro:** `src/stores/agentStore.ts`

**Remover:**
- Array de `models` / `ModelConfig[]` — a IDE não conhece modelos
- `currentModel` / `selectedModel` state
- `setModel()` action
- Qualquer `availableModels` ou `modelConfigs`

**Manter:**
- `status` (idle/thinking/generating/applying/error)
- `error`
- Actions de status (`setStatus`, `setError`, `reset`)

### 1.3 REMOVER do PromptBar.tsx

**Ficheiro:** `src/components/PromptBar.tsx` (ou `PromptInput.tsx`)

**Remover:**
- Dropdown/selector de modelo — não existe mais
- Qualquer lógica que verifica API key antes de enviar
- Qualquer referência ao `apiKeyManager`
- Qualquer referência a `ApiKeyDialog`

**O comportamento do Send passa a ser:**
1. User escreve prompt
2. User clica Send (ou Cmd+Enter)
3. IDE verifica se user está autenticado (`authStore.isAuthenticated`)
4. Se sim → envia ao Worker. Se não → redireciona para login
5. Acabou. Sem dialogs intermédios.

### 1.4 SIMPLIFICAR agentService.ts

**Ficheiro:** `src/services/agent/agentService.ts`

**Estado actual:** Dual-mode com branching (`useProxy` / `directApiKey` / etc.)

**Novo estado:** Um único caminho. A IDE fala SEMPRE com o Worker. O Worker é que decide tudo.

```typescript
class AgentService {
  private workerUrl: string
  private abortController: AbortController | null = null

  constructor() {
    // URL do Worker — vem de env var
    // Dev: http://localhost:8787 (wrangler dev)
    // Prod: https://toquemedia-studio-api.SUBDOMAIN.workers.dev
    this.workerUrl = import.meta.env.VITE_WORKER_URL || 'http://localhost:8787'
  }

  async callAPI(messages: any[], tools: any[]): Promise<any> {
    // Obter Firebase ID token
    const firebaseAuth = FirebaseAuthService.getInstance()
    const idToken = await firebaseAuth.getIdToken()

    if (!idToken) {
      throw new Error('Not authenticated')
    }

    const response = await fetch(`${this.workerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        // SEM campo "model" — o Worker decide
        messages,
        tools,
        temperature: 0.3,
        max_tokens: 4096
      }),
      signal: this.abortController?.signal
    })

    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`API error ${response.status}: ${errorBody}`)
    }

    return response.json()
  }

  // ... resto do agentic loop mantém-se igual
}
```

**Mudanças chave:**
- `VITE_USE_PROXY` desaparece — é sempre proxy
- `VITE_PROXY_URL` renomeado para `VITE_WORKER_URL`
- Sem campo `model` no body do request
- Sem `directApiKey`, `directApiUrl`, `useProxy`, `isLocal`
- Sem `ModelConfig`, `getModelConfig()`, `baseUrl` por modelo
- Um único endpoint: `${workerUrl}/v1/chat/completions`

### 1.5 Actualizar .env / .env.local

**Antes:**
```
VITE_USE_PROXY=true
VITE_PROXY_URL=https://toquemedia-studio-api.SUBDOMAIN.workers.dev
```

**Depois:**
```
# Dev (wrangler dev local):
VITE_WORKER_URL=http://localhost:8787

# Prod:
VITE_WORKER_URL=https://toquemedia-studio-api.SUBDOMAIN.workers.dev
```

### 1.6 Remover referências mortas

Após as remoções acima, fazer grep e limpar qualquer import/referência a:
- `apiKeyManager`
- `ApiKeyDialog`
- `ModelConfig`
- `availableModels`
- `currentModel` / `selectedModel`
- `VITE_USE_PROXY`
- `VITE_PROXY_URL`
- `USE_MOCK`
- `mockServer`
- `isLocal`

---

## Parte 2 — IDE: Identificar o user logado

### 2.1 Mostrar identidade do user no MinimalTitleBar

**Ficheiro:** `src/components/MinimalTitleBar.tsx`

**Onde:** No canto direito da title bar.

**Adicionar:** Avatar/iniciais + email do user logado + botão de logout.

```
┌──────────────────────────────────────────────────────────────┐
│  ToqueMedia Studio               [C.S] celio@email.com [⏻]  │
└──────────────────────────────────────────────────────────────┘
```

**Implementação:**
```typescript
const { user } = useAuthStore()

// Mostrar:
// - Iniciais do email (ex: "CS" para celio.silva@...)
// - Email completo ou truncado
// - Botão/ícone de logout
```

**Ao clicar no avatar/email:** Mostrar mini-dropdown com:
- Email completo
- Plano actual (free/pro/team) — se disponível
- Botão "Sign Out"

### 2.2 Guardar info do user no authStore

**Ficheiro:** `src/stores/authStore.ts`

**Verificar** que o `AuthUser` já tem os campos necessários. Se não, adicionar:

```typescript
interface AuthUser {
  uid: string
  email: string | null
  displayName: string | null  // adicionar se não existe
  photoURL: string | null     // adicionar se não existe
}
```

### 2.3 Actualizar firebaseAuth.ts

**Ficheiro:** `src/services/auth/firebaseAuth.ts`

**No listener `onAuthStateChanged`**, garantir que `displayName` e `photoURL` são passados ao authStore:

```typescript
onAuthStateChanged(auth, (user) => {
  if (user) {
    useAuthStore.getState().setUser({
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL
    })
  } else {
    useAuthStore.getState().clear()
  }
})
```

---

## Parte 3 — Worker: Decidir o modelo

### 3.1 Actualizar proxy.ts — modelo decidido pelo Worker

**Ficheiro:** `toquemedia-studio-api/src/proxy.ts`

**Mudar:** O `handleChatRequest` deixa de ler `body.model` do request. Em vez disso, determina o modelo com base no plano do user e no ambiente.

```typescript
export async function handleChatRequest(
  request: Request,
  env: Env,
  userId: string,
  userPlan: UserPlan  // passado pelo index.ts após getUserPlan()
): Promise<Response> {
  const body = await request.json() as any

  // Worker decide o modelo
  const model = resolveModelForPlan(userPlan, env)

  // Resolve o provider a partir do modelo
  const provider = MODEL_TO_PROVIDER[model]
  if (!provider) {
    return Response.json({ error: `Model not configured: ${model}` }, { status: 500 })
  }

  const providerConfig = PROVIDERS[provider]

  // Construir request para o provider
  const forwardBody = {
    ...body,
    model  // Worker injeta o modelo
  }

  // Headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }

  if (providerConfig.apiKeyEnvVar) {
    const apiKey = env[providerConfig.apiKeyEnvVar] as string
    if (!apiKey) {
      return Response.json({ error: `API key not configured` }, { status: 500 })
    }
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const providerResponse = await fetch(providerConfig.apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(forwardBody)
  })

  return providerResponse
}
```

### 3.2 Nova função — resolveModelForPlan

**Ficheiro:** `toquemedia-studio-api/src/proxy.ts` (ou novo `src/modelResolver.ts`)

```typescript
function resolveModelForPlan(userPlan: UserPlan, env: Env): string {
  // Em dev (wrangler dev), usar Ollama
  if (env.ENVIRONMENT === 'development') {
    return 'devstral-small-2'  // Ollama local
  }

  // Em produção, basear no plano
  switch (userPlan.plan) {
    case 'free':
      return 'devstral-small-2'    // Modelo mais barato
    case 'pro':
      return 'devstral-small-2'    // Pode ser upgraded depois
    case 'team':
      return 'devstral-small-2'    // Pode ser upgraded depois
    default:
      return 'devstral-small-2'
  }
}
```

**Nota:** Por agora, todos os planos usam o mesmo modelo. A diferenciação virá depois quando definirmos a estratégia de modelos por plano. O importante é que a **lógica está no Worker**, não no client.

### 3.3 Actualizar index.ts — passar userPlan ao proxy

**Ficheiro:** `toquemedia-studio-api/src/index.ts`

**Onde:** No handler de `/v1/chat/completions`, o `userPlan` já é obtido para rate limiting. Passar ao `handleChatRequest`:

```typescript
// Actualmente:
const response = await handleChatRequest(request, env, userId)

// Mudar para:
const response = await handleChatRequest(request, env, userId, userPlan)
```

### 3.4 Manter PROVIDERS e MODEL_TO_PROVIDER

O mapa de providers e modelos no Worker mantém-se. Apenas a origem do model ID muda — em vez de vir do client, vem do `resolveModelForPlan`.

---

## Parte 4 — Ambiente Dev

O flow em dev fica:

```
IDE (cargo tauri dev)
  ↓ request (Bearer Firebase token)
Worker (wrangler dev, localhost:8787)
  ↓ env.ENVIRONMENT === 'development'
  ↓ resolveModelForPlan → 'devstral-small-2'
  ↓ PROVIDERS['localhost:11434']
Ollama (localhost:11434)
  ↓ modelo: devstral-small-2
  ↓ response
Worker → IDE
```

**Pré-requisitos dev:**
```bash
# Terminal 1: Ollama
ollama serve
# (modelo já pulled: ollama pull devstral-small-2)

# Terminal 2: Worker local
cd toquemedia-studio-api
npx wrangler dev

# Terminal 3: IDE
cd exodus-ide
cargo tauri dev
```

**O user ainda precisa de fazer login** (Firebase Auth) mesmo em dev. O Worker local valida o JWT normalmente. Se isto for inconveniente para dev, pode-se adicionar bypass de auth no Worker quando `ENVIRONMENT=development` — mas é decisão tua, não implementar sem confirmar.

---

## Critérios de Done

### IDE:
- [ ] `apiKeyManager.ts` apagado
- [ ] `ApiKeyDialog.tsx` apagado
- [ ] Model selector removido do PromptBar/UI
- [ ] `agentService.ts` simplificado — um caminho, sem branching
- [ ] `agentStore.ts` sem ModelConfig, sem models array, sem selectedModel
- [ ] `VITE_WORKER_URL` como única env var de configuração
- [ ] User logado visível na MinimalTitleBar (iniciais + email + logout)
- [ ] `authStore` tem `displayName` e `photoURL`
- [ ] Zero referências a apiKeyManager, ApiKeyDialog, ModelConfig, VITE_USE_PROXY
- [ ] `npm run build` sem erros

### Worker:
- [ ] `handleChatRequest` recebe `userPlan` e chama `resolveModelForPlan`
- [ ] Request do client sem campo `model` funciona — Worker injeta
- [ ] Em dev (`ENVIRONMENT=development`), modelo resolve para Ollama
- [ ] Em prod, modelo resolve baseado no plano
- [ ] Request sem `model` + sem token → 401
- [ ] Request sem `model` + com token válido → forward com modelo correcto

---

## O que NÃO fazer

- Não implementar lógica complexa de modelo por plano (por agora todos usam o mesmo)
- Não implementar UI de settings/preferências de modelo
- Não modificar o agentic loop, tools, diffService, contextBuilder
- Não modificar sessionService ou chatStore
- Não modificar LoginScreen (auth flow mantém-se igual)
- Não implementar streaming diferente — o formato de response mantém-se OpenAI-compatible
