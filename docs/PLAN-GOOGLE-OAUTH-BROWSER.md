# Google OAuth via System Browser — Plano de Implementação

## Problema Actual
`signInWithPopup` usa `window.open()` que não funciona em Tauri WebViews (nem macOS nem Windows). O workaround actual com bridge de `postMessage` é frágil.

## Solução: OAuth via Browser + Local Callback Server
Abordagem standard para desktop apps (VS Code, Slack, Discord, Figma usam isto):

1. User clica "Sign in with Google"
2. App abre o browser do sistema com a URL do Google OAuth
3. User faz login no browser
4. Google redireciona para `http://127.0.0.1:{port}/callback`
5. Um servidor HTTP temporário no Rust captura o callback
6. App recebe o auth code via Tauri event
7. Frontend troca o code por credential e faz `signInWithCredential`

## Pré-requisitos (Firebase Console)
- Em Authentication → Settings → Authorized domains: adicionar `127.0.0.1`
- Em Authentication → Sign-in method → Google: obter o **Web Client ID** (não confundir com API Key)
- Na Google Cloud Console → Credentials: adicionar `http://127.0.0.1` como Authorized redirect URI no OAuth Client ID

## Implementação

### Fase 1: Backend Rust — Servidor de callback local

**Ficheiro:** `src-tauri/src/commands/auth.rs` (novo)

```rust
use std::io::{Read, Write};
use std::net::TcpListener;
use tauri::{AppHandle, Emitter};

#[derive(serde::Serialize, Clone)]
struct OAuthCallback {
    code: String,
    state: String,
}

/// Start a one-shot HTTP server on a random port.
/// Returns the port number. When the callback arrives,
/// emits 'oauth-callback' event with the auth code.
#[tauri::command]
pub async fn start_oauth_server(app: AppHandle) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind: {}", e))?;
    let port = listener.local_addr()
        .map_err(|e| format!("{}", e))?.port();

    std::thread::spawn(move || {
        // Timeout: auto-close after 5 minutes
        listener.set_nonblocking(false).ok();
        // Accept ONE connection
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 4096];
            if let Ok(n) = stream.read(&mut buf) {
                let request = String::from_utf8_lossy(&buf[..n]);
                // Parse "GET /callback?code=XXX&state=YYY HTTP/1.1"
                if let Some(path) = request.lines().next() {
                    if let Some(query_start) = path.find('?') {
                        let query_end = path.find(" HTTP").unwrap_or(path.len());
                        let query = &path[query_start+1..query_end];
                        let mut code = String::new();
                        let mut state = String::new();
                        for param in query.split('&') {
                            let mut kv = param.splitn(2, '=');
                            match (kv.next(), kv.next()) {
                                (Some("code"), Some(v)) => code = v.to_string(),
                                (Some("state"), Some(v)) => state = v.to_string(),
                                _ => {}
                            }
                        }
                        if !code.is_empty() {
                            let _ = app.emit("oauth-callback", OAuthCallback { code, state });
                        }
                    }
                }
                // Send success page
                let html = "<html><body style='font-family:system-ui;text-align:center;padding:60px'>\
                    <h2>Login concluido!</h2>\
                    <p>Pode fechar esta janela e voltar ao TM Code.</p>\
                    <script>setTimeout(function(){window.close()},2000)</script>\
                    </body></html>";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    html.len(), html
                );
                let _ = stream.write_all(response.as_bytes());
            }
        }
    });

    Ok(port)
}
```

**Registar em `lib.rs`:**
```rust
mod commands;
// ... existing
use commands::auth::*;

// No invoke_handler, adicionar:
start_oauth_server,
```

### Fase 2: Frontend — Fluxo de autenticação

**Ficheiro:** `src/services/auth/firebaseAuth.ts`

Substituir `signInWithGoogle()`:

```typescript
async signInWithGoogle(): Promise<User> {
    const { invoke } = await import('@tauri-apps/api/core')
    const { listen } = await import('@tauri-apps/api/event')
    const { openUrl } = await import('@tauri-apps/plugin-opener')

    // 1. Start local callback server
    const port = await invoke<number>('start_oauth_server')

    // 2. Build Google OAuth URL
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
    const redirectUri = encodeURIComponent(`http://127.0.0.1:${port}/callback`)
    const state = crypto.randomUUID()
    const scope = encodeURIComponent('openid email profile')
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&state=${state}&access_type=offline&prompt=consent`

    // 3. Open system browser
    await openUrl(authUrl)

    // 4. Wait for callback (with 5min timeout)
    const { code } = await new Promise<{ code: string; state: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('OAuth timeout')), 5 * 60 * 1000)
        listen<{ code: string; state: string }>('oauth-callback', (event) => {
            clearTimeout(timeout)
            resolve(event.payload)
        })
    })

    // 5. Exchange code for tokens via backend worker
    const workerUrl = import.meta.env.VITE_WORKER_URL
    const tokenRes = await fetch(`${workerUrl}/v1/oauth/google/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            code,
            redirectUri: `http://127.0.0.1:${port}/callback`,
        }),
    })
    const { idToken, accessToken } = await tokenRes.json()

    // 6. Sign in with Firebase credential
    const credential = GoogleAuthProvider.credential(idToken, accessToken)
    const result = await signInWithCredential(getFirebaseAuth(), credential)
    return result.user
}
```

### Fase 3: Backend Worker — Token exchange

**Endpoint:** `POST /v1/oauth/google/exchange`

```typescript
// No Cloudflare Worker (toquemedia-studio-api)
async function handleGoogleTokenExchange(request: Request, env: Env) {
    const { code, redirectUri } = await request.json()

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET, // Seguro no server
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
        }),
    })

    const tokens = await tokenRes.json()
    return Response.json({
        idToken: tokens.id_token,
        accessToken: tokens.access_token,
    })
}
```

### Fase 4: Env vars necessárias

```env
# .env (frontend)
VITE_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com

# Worker secrets (backend)
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxx
```

### Fase 5: Remover código temporário

- Remover `on_new_window` OAuth popup bridge do `lib.rs`
- Remover `window.open` monkey-patch do `index.html`
- Remover imports `CustomProvider`/`AppCheckToken` do `firebaseAuth.ts`
- Adicionar `signInWithCredential` aos imports do Firebase

## Sequência de tarefas

1. [ ] Firebase Console: adicionar `127.0.0.1` aos authorized domains
2. [ ] Google Cloud Console: adicionar redirect URI ao OAuth Client ID
3. [ ] Criar `src-tauri/src/commands/auth.rs` com `start_oauth_server`
4. [ ] Registar comando no `lib.rs`
5. [ ] Adicionar endpoint `/v1/oauth/google/exchange` no worker
6. [ ] Actualizar `signInWithGoogle()` no `firebaseAuth.ts`
7. [ ] Adicionar `VITE_GOOGLE_CLIENT_ID` ao `.env` e `.env.example`
8. [ ] Remover bridge temporário (`on_new_window`, `window.open` patch)
9. [ ] Testar em macOS, Windows e Linux
