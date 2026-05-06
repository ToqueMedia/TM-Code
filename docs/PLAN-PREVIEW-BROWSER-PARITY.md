# Preview com Paridade de Navegador — Plano

## Contexto

A preview da TM Code corre numa `wry::WebView` filha. No macOS, em vez de carregar
o URL do dev server directamente, a IDE regista um custom protocol
`tmpreview://localhost/` (ver `src-tauri/src/lib.rs:279-327`) que faz proxy de
cada request via `raw_http_get` (linha 405).

A justificação histórica era contornar o ATS (App Transport Security) que
bloqueia `http://` no WKWebView. O proxy serve o initial page load (HTML, JS,
CSS, imagens — todos GET) e nada mais.

### Problemas conhecidos (em produção)

| # | Sintoma | Causa |
|---|---|---|
| 1 | Signup falha com 401 dentro da preview, funciona no browser | `raw_http_get` só envia `GET` literal — descarta método (POST), body, headers. |
| 2 | `Unhandled Promise rejection: WebSocket@[native code]` no console | Custom protocols não fazem upgrade WebSocket. Vite HMR client tenta `ws://` e falha. |
| 3 | `Script error. (:0)` cross-origin sanitization | Iframe a `tmpreview://` ≠ parent a `tauri://` → todos os erros são sanitizados. |
| 4 | Set-Cookie do dev server não persiste correctamente | Proxy só forwarda `Content-Type` na resposta — todos os outros response headers são descartados. |
| 5 | Ollama (`http://localhost:11434`), Postgres REST, etc. inacessíveis | ATS bloqueia http:// para hosts diferentes do proxy target. |

Para uma IDE Agent-First que compete com Cursor/Bolt/v0/Replit, estes são bugs
de gravidade alta — qualquer app moderna usa pelo menos POST + cookies + WebSocket.

## Objectivo

Preview da TM Code comporta-se **identicamente a um navegador**:

- ✅ Todos os métodos HTTP (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS).
- ✅ Request body, request headers (Auth, Cookie, Content-Type, etc.).
- ✅ Response headers completos (Set-Cookie, ETag, Location, Cache-Control…).
- ✅ Streaming (SSE, fetch streaming, long-polling — crítico para AI apps).
- ✅ WebSocket (HMR + WebSockets do app).
- ✅ Cookies persistentes per-origin.
- ✅ Service Workers, Web Crypto secure-context, Geolocation, MediaDevices.
- ✅ Acesso a múltiplos hosts loopback (Ollama, postgres, redis, etc.).
- ✅ OAuth com providers reais.
- ✅ Stack traces preservadas (sem `Script error. (:0)`).

## Decisão arquitectural

**Eliminar o proxy. Deixar o WKWebView ser navegador.**

A análise crítica do plano "extender o proxy" revelou que:

1. WebSocket upgrade é estruturalmente impossível em custom protocols do wry —
   não há forma de fazer phase-2 funcionar sem outra camada.
2. Service Workers não registam em custom schemes.
3. Web Crypto `subtle.*` falha porque `tmpreview://` não é "secure context".
4. OAuth providers rejeitam `redirect_uri=tmpreview://...`.
5. Cookies com `Secure` flag (norma em auth moderna) não persistem em scheme não-HTTPS.
6. Multi-host loopback (Ollama etc.) é single-target no proxy.

Cada um destes seria um patch dedicado contra a fundação errada. A fundação
correcta é a do próprio WebKit — exactamente como Cursor, Replit, Bolt e
qualquer browser real fazem.

ATS no macOS tem exceção explícita para isto: `NSAllowsLocalNetworking=YES`
permite `http://` e `ws://` para loopback (`localhost`, `127.0.0.1`, `::1`,
`*.local`). Activá-la é uma linha em `tauri.conf.json` e elimina ~160 linhas
de Rust no proxy.

### Por que não foi feito assim antes

O comentário em `lib.rs:80-89` indica duas razões:
1. ATS — resolvido com `NSAllowsLocalNetworking`. Não foi tentado.
2. Vite IPv6-only com WKWebView sem fallback Happy Eyeballs — já mitigado em
   2026-04 com `--host 0.0.0.0` injectado nos comandos do dev server (ver
   CLAUDE.md, secção "Host injection (Windows IPv6 workaround)").

Ambas as razões já não são bloqueadores. A janela para retirar o proxy abriu
e ainda não foi capitalizada.

### Comparação com Windows e Linux

`lib.rs:84-89` já carrega o URL **directamente** em Windows (WebView2) e Linux
(WebKitGTK). Estas plataformas não têm ATS. A preview funciona como navegador
nestes OS — POST funciona, WebSocket funciona, cookies funcionam.

**O macOS é o outlier** que tem feature parity degradada. Este plano alinha o
macOS com o comportamento que já temos noutras plataformas — não introduz
risco novo, alinha-o.

## Trabalho

### Fase 0 — Spike de validação (½ dia)

**Antes** de tocar em código de produção, validar que a abordagem funciona.

1. Criar branch `spike/macos-direct-http-preview`.
2. Adicionar `NSAllowsLocalNetworking=YES` em `tauri.conf.json` →
   `bundle.macOS.entitlements` ou `infoPlist`.
3. Mudar `lib.rs:95` de `let use_proxy = cfg!(target_os = "macos")` para
   `let use_proxy = false` temporariamente.
4. Build + run em macOS local.
5. Abrir um projecto Vite simples e verificar:
   - Page carrega.
   - HMR conecta (`@vite/client` faz WebSocket sem erros).
   - Console limpo (sem `[runtime]` proxy errors).
6. Abrir M27 (caso real do utilizador) e tentar signup → POST tem de retornar
   201/200, não 401.

**Critério de Go/No-Go:** se ambos os testes passarem, avançar para Fase 1.
Se algum falhar, capturar exactamente onde e considerar fallbacks (ver
secção "Riscos").

### Fase 1 — Cutover (½ dia)

1. Aplicar `NSAllowsLocalNetworking` no `tauri.conf.json` (permanente).
2. Em `lib.rs`:
   - Remover `with_asynchronous_custom_protocol("tmpreview", …)` (linhas
     279-327).
   - Remover `proxy_target_for_protocol`, `proxy_target` (linhas 90-95).
   - Remover funções `raw_http_get` e `raw_http_get_with_stream` (~80 linhas).
   - Mudar `with_url(...)` para usar `direct_url` em todas as plataformas.
   - Apagar a constante `use_proxy`.
3. Apagar a anotação CSS `oauth_csp_domains` se referenciar `tmpreview://`.
4. Apagar referências `tmpreview` em código TS/TSX (excepto em filtros de
   noise históricos — manter durante 1-2 releases para retro-compat).
5. Verificar que nenhum teste mocka `tmpreview://`.

Net diff esperado: **−170 linhas Rust, +1 linha plist**.

### Fase 2 — Hardening (1 dia)

1. Re-activar o filtro de "preview protocol noise" em `App.tsx` mas para o
   conjunto actualizado (ver Fase 1, ponto 4) — alguns padrões antigos
   (`tmpreview://`) tornam-se irrelevantes; outros (Vite WS connection
   warnings em modo offline) podem aparecer.
2. Verificar que `closePreviewWebview()` continua a fazer cleanup correcto
   (sem o protocolo registado, alguma lógica de teardown pode ser inútil).
3. Re-validar a integração com `staticPreviewBuilder` — preview de HTML
   estático passa por outro caminho (`html` em vez de `url`). Tem de
   continuar a funcionar.
4. Confirmar que `gis-detected` (probe de Google Identity Services em iframe
   bloqueado por FedCM) continua a disparar — depende do init script
   injectado em todas as páginas, deve estar OK.

### Fase 3 — Cobertura de teste (1-2 dias)

Matriz de validação contra apps reais antes de release:

| App / fluxo | O que valida |
|---|---|
| **Vite + React** novo, `npm create vite` | Carregar page, HMR, console limpo |
| **Next.js 15 dev** | App Router, Server Actions (POST), streaming RSC |
| **M27** (signup user-tested) | POST /signup, cookies de sessão, redirect pós-auth |
| **Express + axios POST** | Auth header forward, JSON body |
| **App com Server-Sent Events** (`/api/chat` stream) | Tokens chegam à medida, não em bloco |
| **App com `new WebSocket(...)` directo** | Custom WS funciona |
| **Ollama frontend** (chama `localhost:11434`) | Multi-host loopback, sem ATS block |
| **OAuth Google sign-in** | redirect_uri match, cookie de sessão persiste |
| **App com Service Worker** (PWA) | SW regista, cache funciona |
| **App que usa `crypto.subtle.encrypt`** | Web Crypto disponível (secure context implícito do http://localhost) |
| **Upload de ficheiro grande** (> 10 MB) | POST multipart streaming, sem OOM |
| **WebRTC getUserMedia** | Permissions prompt do macOS aparece |

Critério de release: **todas têm de passar** sem regressão visível vs. browser
do sistema.

### Fase 4 — Limpeza posterior (qualquer altura)

1. Apagar comments stale em `lib.rs` que referenciam o proxy.
2. Actualizar `docs/PLAN-NATIVE-PREVIEW.md` — esta abordagem torna-o obsoleto
   (era plano-B se o WKWebView nunca colaborasse).
3. Apagar `useByokStore.testKey` workaround se tiver sido escrito assumindo
   o proxy (verificar — provavelmente não tem).
4. Migrar logs anteriormente filtrados (Phase 5 do filtro) para deixarem de
   ser silenciados, agora que a causa raiz desapareceu.

## Riscos e mitigações

### R1 — `NSAllowsLocalNetworking` recusa por algum motivo desconhecido

**Probabilidade:** baixa. Documentado pela Apple, usado por milhares de apps.

**Detecção:** Spike na Fase 0. Se WKWebView ainda recusar `http://localhost`,
captar erro exacto.

**Mitigação:**
- Tentar `NSAppTransportSecurity.NSExceptionDomains.localhost.NSExceptionAllowsInsecureHTTPLoads=YES` (alternativa mais granular).
- Se também falhar, fallback é o "PLAN-NATIVE-PREVIEW" (Swift WKWebView com
  config sem restrições). Esse plano já existe e era a saída prevista para
  estes cenários.

### R2 — Vite IPv6 stalls voltam

**Probabilidade:** baixa. Mitigado em 2026-04 (`--host 0.0.0.0` injectado).

**Detecção:** Page não carrega. `lsof -iTCP:5173` mostra binding só `::1`.

**Mitigação:** Revisitar a injecção de `--host 0.0.0.0` no `devServerManager`,
expandir para mais frameworks se necessário. Não voltar ao proxy só por isto.

### R3 — Apps que dependiam acidentalmente do `Access-Control-Allow-Origin: *` que o proxy injectava

**Probabilidade:** muito baixa. Para ser afectado, o app teria de ter código
que assumisse mesma-origem mas fizesse cross-origin checks redundantes.

**Detecção:** Fluxo do app falha no novo build mas funcionava antes.

**Mitigação:** O comportamento correcto é não injectar — o browser deveria
ver os response headers reais do dev server. Se o app não estava preparado
para isso, é bug do app, não da IDE.

### R4 — Service Workers, Web Crypto, etc. ainda falham por algum motivo do WKWebView

**Probabilidade:** baixa. http://localhost é "secure context" no WebKit por
[especificação](https://w3c.github.io/webappsec-secure-contexts/#localhost).

**Detecção:** Apps que usam estas APIs falham silenciosamente.

**Mitigação:** Maioria dos casos é bug do app, não da IDE — confirmar com
DevTools. Se for limitação real do WKWebView, usar `WKWebViewConfiguration.preferences.fraudulentWebsiteWarningEnabled = false` e relacionados (precisa de FFI Swift, mais trabalho).

### R5 — Segurança: NSAllowsLocalNetworking abre acesso a qualquer http loopback

**Probabilidade:** sempre presente.

**Threat model:** o utilizador clona um projecto malicioso e abre na IDE. O
projecto consegue chamar `http://localhost:11434`, `http://localhost:5432`,
etc. no PC do utilizador.

**Análise:** o IDE já confia no projecto local — qualquer file watcher,
script de scaffold, ou comando bash pode fazer pior. O modelo de threat não
muda materialmente. Tauri permite para apps que abrem qualquer URL local; a
IDE faz parte dessa categoria.

**Mitigação:** documentar no User Guide que a preview executa código do
projecto com privilégios de rede locais. Considerar um "preview sandbox"
toggle no futuro (Phase posterior, fora deste plano).

## Trade-offs vs. plano original ("estender o proxy")

| Critério | Plano original | Este plano |
|---|---|---|
| Linhas de código | +200 (reqwest forward + streaming + WS attempt) | −170 |
| Tempo de implementação | 1-2 semanas | 2-3 dias |
| Cobertura de features | ~70% (WS estruturalmente impossível, SW idem) | 100% |
| Reversibilidade | Sim (revert a um commit) | Sim (revert a um commit) |
| Manutenção contínua | Alta (cada feature nova é forward custom) | Zero (delegado ao WebKit) |
| Risco de regressão | Médio (código novo) | Baixo (alinha com path Windows/Linux) |
| Surface de ataque | Maior (cliente HTTP custom) | Menor (sem proxy) |

## Métricas de sucesso

Antes de fechar o ticket, validar:

1. ✅ Todas as apps da matriz na Fase 3 passam.
2. ✅ Bug original (M27 signup) reproduz em commit pré-cutover, não reproduz no commit pós-cutover.
3. ✅ Console da preview limpo de `[runtime] Unhandled Promise rejection: WebSocket@[native code]` em apps Vite normais.
4. ✅ Console limpo de `Script error. (:0)`.
5. ✅ TypeScript + cargo check + `cargo clippy` sem warnings novos.
6. ✅ `npm run tauri build` produz bundle assinado em macOS sem erros.
7. ✅ Manual smoke test em Windows e Linux: `npm run tauri dev` funciona, preview
   carrega — confirmar que a remoção do `use_proxy` toggle não regrediu nada.

## Follow-ups

- **Sandbox por projecto.** Permission scopes para a preview (qual host loopback
  é alcançável). Phase ulterior, requer UI nova e provavelmente cooperação com
  WebKit content controllers.
- **DevTools attached** à preview para experiência tipo "Inspect Element"
  inline (já existe via right-click → Inspect, mas pode ser embebido como
  panel da IDE). Plano separado.
- **Recording de network** da preview para o agente analisar (intercept e
  log de requests). Útil para "debug this auth flow" prompts. Requer
  intercept layer — seria reintroduzir um proxy *opcional*, não o substrato.

## Sumário

Mudar uma flag de plist e apagar 170 linhas de Rust dá-nos:

- POST/PUT/DELETE.
- Streaming, SSE, WebSocket.
- Cookies, Set-Cookie completos.
- Service Workers, Web Crypto, Geolocation.
- Multi-host loopback.
- OAuth.
- Stack traces sem sanitização.

E tudo isto sem manutenção contínua — porque é o próprio WebKit a fazer
o trabalho, exactamente como faz num browser real.

A escolha histórica de proxy era razoável dada a documentação que existia
na altura. As condições mudaram, e a feature gap em macOS face ao browser do
sistema está a custar-nos credibilidade contra Cursor/Bolt/Replit. Este plano
fecha-a com risco controlado.
