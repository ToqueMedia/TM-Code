# Progresso — Auditoria Windows / Bottlenecks

Branch: `fix-windows` · Última atualização: 2026-04-18

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

### 6. Windows UI — audit + SettingsView back button ✅
Auditoria confirmou que a infra já está em grande parte no sítio:

- `WindowControls.tsx` já usa `data-no-drag` + `swallowMouseDown` + `<button>` reais para Win/Linux.
- `useWindowControls.ts:shouldStartDrag` percorre o DOM a saltar elementos interactivos e `[data-no-drag]`.
- Guard `depth < 3` presente nos 3 entrypoints do file watcher (`projectFileWatcher.ts:24`, `quickOpenService.ts:156`, `src-tauri/src/commands/project.rs:1185`).

**Fix entregue:**
- `src/components/views/SettingsView.tsx` — o botão "back" do sidebar era um `<Flex>` com `onClick`. Convertido para `<Box as="button">` com `data-no-drag` e `border="none"`, para garantir pointer handling consistente no WebView2 (Windows aceita `<button>` reais muito melhor do que divs clicáveis dentro de drag regions).

**Deferido (pede hardware real para validar):**
- Contenção IPC durante streaming SSE — já existe buffering de 50ms no `streamParser`; medir em Windows antes de introduzir flush interval platform-aware.
- ALT+F4 — sem bloqueios custom no `on_window_event`; precisa de teste em máquina Windows.

### 7. Network handling ✅

- `src/hooks/useNetworkStatus.ts` (novo) — status `online | offline | slow` via `navigator.onLine` + pings periódicos (30s) ao `WORKER_URL/v1/health` com timeout de 5s e limiar slow de 2.5s. Abort controller cancela pings em voo.
- `src/components/ui/NetworkStatusBanner.tsx` (novo) — banner glass não-bloqueante, `aria-live="polite"`, botão "Retry" que força um recheck.
- Integrado em `WelcomeScreen.tsx` (junto ao `StartupRequirementsBanner`) e `CodeEditorNew.tsx` (logo a seguir ao `TitleBar`).
- `src/services/mcp/remoteTransport.ts` — `sendRemoteMCPRequest` ganha retry com exponential backoff (`500ms → 1500ms → 4000ms`, máx 3 tentativas). Retentativa em `408/429/5xx` e em erros de rede/timeout; fail-fast em auth (`401/403`) e em `Remote MCP error:` (erro JSON-RPC semântico).
- `agentService.ts` já retentava `NETWORK_ERROR` (3 tentativas com delays `[3s, 5s, 10s]`, 20s em rate limits) — sem alteração.

### 8. Performance — prompt cache + file watcher audit ✅

- `src/services/agent/contextBuilder.ts` — `buildSystemPrompt` ganha TTL cache de 30s, chaveado por `projectPath|projectType|coreToolCount|plan|mcpSig`. Cobre ambos os paths (prompt completo e `buildMinimalPrompt`). Método `invalidatePromptCache(projectPath?)` exposto para invalidação dirigida.
- `src/services/agent/toolExecutor.ts:updateReadStateAfterWrite` invalida o prompt cache sempre que o agent escreve `README.md`, `TMS.md`, `PLAN.md`, `TODO.md`, `package.json` ou `.toquemedia-template` (os únicos ficheiros que o prompt incorpora).

**Confirmado já estava bem:**
- File watcher `depth < 3`: presente nos 3 entrypoints (ver #6).
- `MessageBubble.memo` faz short-circuit correcto para mensagens não-streaming.
- Token buffering de 50ms já existe no `scheduleFlush` do `agentService`.
- Autosave 2s/5s/30s é uma stack intencional (debounced save / streaming save / session sync), não duplicação.

**Deferido:**
- Flush interval platform-aware (50ms macOS vs ~80ms Windows) — medir em hardware real antes de tocar.
- Virtualização da lista de mensagens — só vale a pena se o memo do `MessageBubble` continuar a mostrar jank em conversas muito longas (>200 turns).

---

## Estado do repositório

- Typecheck: `npx tsc --noEmit` passa limpo.
- Branch: `fix-windows`.
- Itens em aberto (deferidos) precisam de bancada Windows para validação — ver notas em #6 e #8.
