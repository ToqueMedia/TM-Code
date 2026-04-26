# App Check — Configuração End-to-End

Guia passo-a-passo para activar o Firebase App Check (Custom Provider) no TM Code.
Aplica-se a **dev** (emulador) e **produção** (Cloudflare Worker + Firebase).

## Como funciona aqui

Tauri desktop não tem provider de attestation oficial — DeviceCheck é iOS-only,
Play Integrity é Android-only, reCAPTCHA Enterprise é browser. A única opção
suportada é **Custom Provider**:

```
Cliente Tauri ─┐                        ┌─ Firebase
               │                        │
               ▼                        ▲
   /v1/appcheck-token (worker)          │
   - verifica idToken                   │
   - rate-limit 12/uid/h                │
   - assina JWT custom (RS256)          │
   - troca por App Check token ────────►│
                                        │
   ◄── X-Firebase-AppCheck (1h TTL) ────┘

Cliente envia token em endpoints gated (register-device, etc.)
   - worker chama verifyAppCheckToken (JWKS)
   - rejeita se ausente/inválido em produção
```

**Defesa real:** força um round-trip extra para a tua infra. Combinado com
rate limit por IP (5 signups/IP/h) e por uid (12 mints/uid/h), abuso scriptado
torna-se ordens de magnitude mais caro do que o cap simples de fingerprint.

---

## 1. Firebase Console — uma vez por projecto

### 1.1 Registar a App Web (se ainda não existe)

1. Firebase Console → **Project Settings** → tab **General** → secção **Your apps**
2. Clicar no ícone Web (`</>`) → "Add app"
3. App nickname: `TM Code Desktop`
4. **NÃO** marcar Firebase Hosting
5. Copiar o `appId` (formato `1:113004896685:web:abc123def456`) — vamos precisar

### 1.2 Registar a app no App Check

1. Firebase Console → **App Check** (sidebar esquerda, secção "Build") → tab **Apps**
2. Localizar a app web; se não aparece, clicar **Register**
3. Como provider, o Firebase Console **só oferece reCAPTCHA Enterprise / reCAPTCHA v3** para apps web. **Escolher reCAPTCHA Enterprise** (não vamos usá-lo — apenas para registar a app no sistema App Check)
4. Confirmar `Enforcement` em **Unenforced** durante todo o teste
5. **Importante:** o Custom Provider não é configurado no Console. Funciona só por o servidor (worker) chamar a API REST `:exchangeCustomToken` com a app já registada acima

> **Porquê:** Custom Provider é um padrão server-side. O cliente desktop chama
> o nosso `/v1/appcheck-token` que devolve um token App Check válido — bypassando
> o reCAPTCHA. O Firebase aceita estes tokens automaticamente desde que a app
> esteja registada no App Check, qualquer que seja o "provider" escolhido no Console.

### 1.3 Activar Phone Auth

1. Firebase Console → **Authentication** → tab **Sign-in method**
2. Activar **Phone**
3. Em **Settings** → **Authorized domains** adicionar:
   - `tauri.localhost`
   - `localhost`

### 1.4 Service Account — usar o Firebase Admin SDK existente

Não criar uma service account nova. Usar a auto-criada pelo Firebase com as
permissões já completas (`roles/firebase.sdkAdminServiceAgent`, que inclui
`firebaseappcheck.appCheckTokens.create`):

1. Firebase Console → **Project Settings** → tab **Service accounts**
2. Painel "Firebase Admin SDK" → **Generate new private key** → confirmar download
3. Guardar o JSON em local seguro (NÃO commitar). Email da SA segue o padrão
   `firebase-adminsdk-xxxxx@<project-id>.iam.gserviceaccount.com`
4. Vamos extrair 2 campos do JSON:
   - `client_email` → `FIREBASE_CLIENT_EMAIL`
   - `private_key` → `FIREBASE_PRIVATE_KEY` (manter os `\n` literais)

> **Se preferires uma SA dedicada** (boa prática de least-privilege), cria uma
> nova em Cloud Console → IAM e atribui o role `roles/firebase.admin` (ou role
> custom só com `firebaseappcheck.appCheckTokens.create`). É opcional — a SA
> auto-criada funciona sem ajuste.

---

## 2. Backend — Cloudflare Worker

### 2.1 Secrets em produção

```bash
cd toquemedia-studio-api

# Já configurados (skip se já feitos)
wrangler secret put FIREBASE_PROJECT_ID --env production

# Novos para App Check
wrangler secret put FIREBASE_APP_ID --env production
# Cola: 1:113004896685:web:xxxxxxxxx

wrangler secret put FIREBASE_CLIENT_EMAIL --env production
# Cola: tm-code-appcheck-minter@<project-id>.iam.gserviceaccount.com

wrangler secret put FIREBASE_PRIVATE_KEY --env production
# Cola o valor INTEIRO do campo private_key do JSON, INCLUINDO os \n literais.
# Exemplo: -----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN...\n-----END PRIVATE KEY-----\n
```

### 2.2 Secrets em dev (.dev.vars) — opcional

Em `ENVIRONMENT=development` o worker **bypassa toda a verificação App Check**:
- `verifyAppCheckToken` devolve `dev-app` sem chamar JWKS
- `/v1/appcheck-token` devolve `{ token: 'dev', expireTimeMillis: now+1h }` sem assinar nada

**Resultado:** não precisas dos secrets de service account no `.dev.vars` para
correr o emulator. Só os configura se quiseres testar o fluxo real de mint
contra produção a partir do dev.

`.dev.vars` mínimo (suficiente):
```bash
ENVIRONMENT=development
FIREBASE_PROJECT_ID=<teu-project-id>
FIREBASE_PROJECT_NUMBER=113004896685
# API keys que já tinhas...
```

`.dev.vars` para testar o fluxo App Check real localmente (opcional):
```bash
ENVIRONMENT=production    # 👈 muda para production
FIREBASE_PROJECT_ID=<teu-project-id>
FIREBASE_PROJECT_NUMBER=113004896685
FIREBASE_APP_ID=1:113004896685:web:xxxxxxxxx
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@<project-id>.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
# API keys...
```

### 2.3 Deploy

```bash
wrangler deploy --env production
wrangler tail --env production    # confirma logs de [appcheck-token]
```

---

## 3. Frontend — TM Code

### 3.1 Variáveis de ambiente

Em `exodus-ide/.env.local` (dev) e `.env.production`:

```bash
# Já existentes (devem estar)
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_APP_ID=1:113004896685:web:xxxxxxxxx

# NOVO — activa o CustomProvider
VITE_APPCHECK_ENABLED=true
```

### 3.2 Debug token em desenvolvimento — quando é preciso

**Caso A — emulator + worker dev (default, recomendado):**
Mantém `VITE_APPCHECK_ENABLED=false`. A SDK do Firebase não inicializa
App Check, o worker bypassa, tudo funciona.

**Caso B — testar o fluxo real de App Check em produção a partir do dev:**
Se queres reproduzir o comportamento de produção localmente (ex: validar que
o token App Check chega correctamente ao worker production):

1. Define `VITE_APPCHECK_ENABLED=true` no `.env.local`
2. A linha `self.FIREBASE_APPCHECK_DEBUG_TOKEN = true` em `firebaseAuth.ts`
   activa o modo debug do SDK em qualquer build com `import.meta.env.DEV`
3. Arranca o app (`npm run tauri dev`) e abre DevTools → Console
4. Procura linha do tipo: `App Check debug token: aaaaaaaa-bbbb-cccc-dddd-...`
5. Copiar o token
6. Firebase Console → **App Check** → tab da app → menu (⋮) → **Manage debug tokens**
7. Adicionar o token com nome descritivo (ex: `Mac do Célio - dev`)

Cada máquina/perfil de browser gera um debug token diferente. Adicionar tantos
quantos necessário; remover quando deixarem de ser usados.

---

## 4. Testar o fluxo

### 4.1 Smoke test do mint endpoint

Com o app aberto e autenticado, abre DevTools → Network → procura
`appcheck-token`. Deves ver:

- Status 200
- Response: `{ "token": "eyJhbGciOi...", "expireTimeMillis": 1735689600000 }`
- O token tem ~600 chars

Se vires 500: provavelmente private key mal formatado (faltam `\n`) ou
service account sem o role correcto.

Se vires 401: o ID token expirou — recarrega a página.

### 4.2 Smoke test do register-device

Faz signup completo (form → SMS → confirmar). Em DevTools → Network:
- `register-device` deve ter header `X-Firebase-AppCheck` com o token
- Status 200 → device registado

Se 403 com `reason: "appcheck_failed"`:
- Confirmar que o `appId` no `.env` bate com o registado no Firebase Console
- Confirmar que App Check tem a app marcada como Custom Provider
- Em dev: confirmar que o debug token foi adicionado ao Firebase Console

### 4.3 Testar enforcement (script vs app)

Tentar chamar register-device com `curl` (sem App Check token):

```bash
curl -X POST https://api-agents.toquemedia.net/v1/auth/register-device \
  -H "Authorization: Bearer <id-token-válido>" \
  -H "Content-Type: application/json" \
  -d '{"fingerprint":"abcdef0123456789abcdef0123456789"}'
```

Resposta esperada em produção: `403 { "ok": false, "reason": "appcheck_failed" }`.

---

## 5. Activar enforcement (último passo, irreversível-mole)

Depois de confirmar que o app real funciona em produção:

1. Firebase Console → **App Check** → tab **APIs**
2. Cada serviço (Authentication, Firestore, etc.) tem um toggle de enforcement
3. **Authentication** → enforce → bloqueia chamadas sem App Check token
4. **Cloud Firestore** → enforce
5. (Opcional) Workers backend: já está a forçar em `register-device`

> **Reverter:** desligar o enforcement no Console é instantâneo. O backend
> continua a verificar mas se desactivares também `VITE_APPCHECK_ENABLED=false`
> e fizeres redeploy, volta ao estado anterior.

---

## 6. Troubleshooting

| Sintoma | Causa provável | Fix |
|---|---|---|
| Console dev: `[appCheck] init failed` | `VITE_FIREBASE_APP_ID` ausente | Adicionar ao `.env.local` |
| `[appcheck-token] mint failed: FIREBASE_PRIVATE_KEY not configured` | Secret não foi colocado ou foi colocado com aspas a mais | Re-correr `wrangler secret put` colando sem aspas externas |
| `OAuth2 token exchange failed (401): invalid_grant` | Private key corrupto | Re-gerar key na Cloud Console + re-colocar |
| `App Check exchange failed (403): The caller does not have permission` | Service account sem role | Adicionar `Firebase App Check Admin` |
| `App Check exchange failed (404)` | App ID errado ou não registado em App Check | Confirmar console secção App Check → Apps |
| reCAPTCHA loop infinito no SMS step | `tauri.localhost` não está em Authorized domains | Auth → Settings → Authorized domains |
| `auth/captcha-check-failed` | reCAPTCHA Enterprise não activado para Phone | Auth → Sign-in method → Phone → activar |

---

## 7. Operação contínua

- **Rotação do service account key:** Google recomenda 90 dias. Gerar nova
  key, fazer `wrangler secret put` da nova, validar, depois revogar a antiga
  na Cloud Console.
- **Monitorização:** o dashboard de App Check mostra % de pedidos verificados.
  Se cair abruptamente → users com app desactualizado, debug token expirou,
  ou bug de wiring.
- **Cleanup de orphans:** a Cloud Function `cleanupOrphanSignups` corre de
  hora a hora e apaga contas Firebase Auth com `signupComplete=false` mais
  antigas que 1h. Verificar logs no Firebase Console → Functions ocasionalmente.
