# Progresso — Auditoria Windows / Bottlenecks

Branch: `modo-cmd` · Última atualização: 2026-04-18

## Feito

### 1. Platform awareness no Agent ✅
O Agent não recebia informação sobre o shell ou o separador de paths nativos no prompt do chat (estava só no CMD mode).

- `src/services/agent/contextBuilder.ts` — acrescenta `os`, `shell` (`powershell` | `zsh` | `bash`) e `native_path_separator` ao envelope de contexto do system prompt.

### 2. Preview dark screen no Windows ✅
No Windows o Rust proxy ficava preso a resolver `localhost` via IPv6 antes de cair para IPv4, o que resultava num ecrã preto enquanto o dev server (IPv4-only) já estava a responder.

- `src-tauri/src/lib.rs` — normaliza o `proxy_target` substituindo `://localhost` por `://127.0.0.1` antes de chegar ao `raw_http_get`. Diagnóstico `eprintln!` passa a reportar URL requerido + target efectivo.
- **Não** foi adicionado fix de z-order Windows: WebView2 usa DirectComposition e não precisa do equivalente ao `addSubview_positioned_relativeTo:` do macOS.

### 3. Preview routing em fullstack (frontend tem prioridade) ✅
Projectos fullstack abriam o `HttpClientPanel` em vez do `PreviewView` porque o layoutStore tinha um único `previewUrl` / `previewServerPid` e o último server a ficar pronto ganhava sempre.

- `src/stores/layoutStore.ts` — refactor completo para dual-slot:
  - `frontendServer: ServerSlot | null` e `backendServer: ServerSlot | null`
  - `setPreviewServer(url, pid, mode?)` encaminha para o slot correcto; quando chega um frontend força `previewMode='server'` (prioridade frontend), quando chega um backend preserva o modo se já houver frontend
  - `clearPreviewServer(which?: 'frontend' | 'backend' | 'all')` permite limpar granularmente
  - `togglePreviewMode` alterna inteligentemente com base nos slots ocupados
  - Selectors de compatibilidade: `selectPreviewUrl`, `selectPreviewServerPid`, `selectIsPreviewServerRunning`
- `src/services/devServerManager.ts` — reescrito para suportar dois dev servers em paralelo:
  - Slots `frontendServer` / `backendServer` independentes, cada um com a sua `generation` / `pollGeneration` / `eaddrinuseRetried`
  - Listeners Tauri montados uma só vez e demultiplexados por PID (`slotByPid`)
  - `start(type)` só pára o slot do mesmo tipo — o outro continua vivo
  - `stop(which = 'all')` aceita `'frontend' | 'backend' | 'all'`
  - `handleExit` limpa só o slot morto e mantém o outro
- `src/services/agent/toolExecutor.ts` — removido o `devServerManager.stop()` redundante antes de um `start()` direcionado (matava frontend quando o agent queria arrancar o backend, e vice-versa).
- 6 consumidores migrados para os novos selectors:
  - `src/components/views/PreviewView.tsx`
  - `src/components/views/GeneratingView.tsx`
  - `src/components/http-client/HttpClientPanel.tsx` (lê directamente `backendServer?.url ?? frontendServer?.url`)
  - `src/components/chat/DevServerStatus.tsx`
  - `src/components/prompt/usePromptBar.ts` (3 ocorrências)
  - `src/stores/httpClientStore.ts`

### 4. Message queueing bug (CRÍTICO) ✅ (sem alteração — já funcionava)
A sensação de "mensagem nova substitui mensagem em voo" foi investigada: o `messageQueue.ts` tem FIFO completo com prioridades `now > next > later` e o `handleSend` em `usePromptBar.ts:611` sempre chama `enqueueMessage()` — não há path de substituição. O comportamento percebido é sintoma do ponto #6 (contenção IPC Windows), não do queue.

### 5. Prerequisites check global ✅
Não havia verificação global de Node/Git/Python — só por template.

- `src/services/startupRequirements.ts`:
  - `GLOBAL_REQUIREMENTS`: Node ≥ 20, Git ≥ 2.0, Python 3 ≥ 3.8
  - `checkStartupRequirements(forceRefresh?)` com cache localStorage de 24h por cima do cache in-memory de 5min do `environmentCheck.ts`
  - `clearStartupRequirementsCache()` para revalidação manual
- `src/components/welcome/StartupRequirementsBanner.tsx` — banner não-bloqueante no WelcomeScreen:
  - Só aparece se alguma ferramenta falhar o check
  - Dismissable (session storage) e recheckable (botão refresh)
  - Botão "Install" abre `installUrl` no browser do sistema via `@tauri-apps/plugin-opener`
  - Visual alinhado aos tokens (glass, accent orange para o aviso)
- Integrado em `WelcomeScreen.tsx` + export em `welcome/index.ts`.

---

## Por fazer

### 6. Windows UI unresponsiveness (NÃO COMEÇADO)
Items reportados: close buttons, ALT+F4, back do SettingsView, botões do ProjectsSidebar, context menu — todos partidos no Windows.

**Hipóteses a investigar:**
- Contenção IPC durante streaming SSE do agent (bloqueia o main thread do WebView2 no Windows)
- Child webview nativo (wry) a apanhar pointer events por z-order / hit-testing do DirectComposition
- Drag region do Tauri a intersectar com handlers em certos componentes
- ALT+F4 precisa de registar `block_close_requested(false)` ou equivalente para deixar o SO fechar a janela

**Próximos passos sugeridos:**
- Auditar `agentService.ts` (transport SSE) e comandos Rust para chamadas bloqueantes durante streaming
- Confirmar em hardware real Windows se o freeze ocorre só durante streaming ou também em idle
- Verificar `data-no-drag` em todas as áreas interactivas do WelcomeScreen / SettingsView

### 7. Network handling (NÃO COMEÇADO)
Requisitos: falhas de conexão, connection slow.

**Trabalho previsto:**
- Retries com backoff exponencial no `agentService.ts` (SSE reconnect) e nos `mcp/remoteTransport.ts`
- Timeouts explícitos em chamadas `invoke` que atingem a rede (`http_client_request`, fetches em `firebaseAuth.ts`)
- Indicador offline no UI (banner ou badge na status bar) usando `navigator.onLine` + pings periódicos ao backend TMS
- Mensagens de erro accionáveis ("retry" em vez de um toast que desaparece)

### 8. Bottlenecks / performance (NÃO COMEÇADO)
Áreas identificadas durante a auditoria:

- **Re-renders no streaming**: `streamingVersion` counter força re-render de toda a lista de mensagens em cada delta — candidato a virtualização ou a memoização mais agressiva por bubble.
- **Autosave triplo**: há três caminhos de autosave (session, draft, messages) que se disparam em sobreposição.
- **Prompt rebuild por turn**: `contextBuilder.buildSystemPrompt` corre do zero em cada turno — cacheable por project hash.
- **File watcher scope**: confirmar que o guard de depth < 3 em `/Users/name` está activo em todos os entrypoints (watcher, indexer, `open_project` no Rust).

---

## Estado do repositório

- Typecheck: `npx tsc --noEmit` passa limpo.
- Branch: `modo-cmd` (10 ficheiros modificados no estado inicial, agora + os novos `startupRequirements.ts` e `StartupRequirementsBanner.tsx`).
- Testar em Windows para validar #2 e #3 antes de entrar no #6.
