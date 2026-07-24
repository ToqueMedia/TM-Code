# TM Code — Canonical Architecture

> **Authoritative system map.** This is the single source of truth for *who owns what* across the
> four TM Code components. Any code or AI agent working in **any** of the repos below should read
> this before reasoning about **models, billing, or streaming**. When this document and a repo's
> CLAUDE.md disagree, this document wins — fix the CLAUDE.md.
>
> Last reconciled: 2026-06-17.

## The four components

| # | Component | Repo | Runtime |
|---|-----------|------|---------|
| 1 | **IDE** | `~/dev/deskotp/exodus-ide` | Tauri 2 + React 18 desktop app |
| 2 | **Data-Plane** (AI pass-through) | `~/dev/deskotp/exodus-ide/workers/ai-pass-through` | Cloudflare Worker |
| 3 | **Control-Plane** | `~/dev/deskotp/toquemedia-studio-api` | Cloudflare Worker |
| 4 | **Web** | `~/dev/web/toquemedia-studio` | Web app / site |

The IDE reaches the Data-Plane over **native browser `fetch` (streaming SSE, CORS)** and the
Control-Plane over **`tauriFetch` (Rust reqwest proxy, CORS-free, non-streaming)**. The two are
resolved by `resolveAIWorkerUrl()` and `resolveWorkerUrl()` respectively (`src/utils/devUrls.ts`).

---

## 1. IDE (`exodus-ide`)

The chat-first desktop client. Runs the agent loop **client-side** (`src/services/agent/`),
renders chat/terminal/editor, and persists per-project sessions/permissions/tasks to disk.

**Does NOT** choose or configure models, do billing accounting, or own provider keys.

- **Model identity** comes from the Data-Plane response header `X-TM-Model`; **context window**
  from `X-Model-Context-Window`. The IDE keeps a small local *capability fallback* table
  (`src/services/agent/modelProfiles.ts`) indexed by model name, used **only** to fill what those
  headers don't carry: `supportsAttachments` (native vision), `supportsThinking`/`thinkingMode`,
  `maxOutputTokens`, `supportsSearch`, and a pre-handshake context-window fallback. Unknown model
  → `getProfileForPlan()` default. **It does not send sampling or thinking params** —
  `agentService.buildThinkingConfig()` returns `undefined`; the Data-Plane injects those.
- **Billing** is *read* from Control-Plane `/v1/me` into `billingStore` for **display only**.

## 2. Data-Plane — AI pass-through (`workers/ai-pass-through`)

The AI plane. Single route: `POST /v1/chat/completions` (everything else → `tm_not_found` 404).
**Provider-agnostic and config-driven** — it hardcodes **no** model names.

Owns:
- **Runtime model routing.** Reads the active config from KV (`ACTIVE_AI_CONFIG` namespace, key
  `active`; local fallback env `ACTIVE_AI_CONFIG_JSON`). Overrides the request `model` with
  `config.model` (or `config.speedModel` on `X-TM-Speed`), injects the provider key, and merges
  `config.extraBody` (e.g. `thinking:{type}` for z.AI, `enable_thinking` for DashScope,
  `reasoning_effort`, `enable_search`) into the request body. Emits `X-TM-Model`,
  `X-Model-Context-Window`, `X-TM-Provider`, `X-TM-Config-Key`.
- **Streaming** (SSE) to the IDE.
- **Billing metering** — per-request token *accounting*: atomic Firestore increments of
  `tokenBudget.tokensConsumed` / `overageConsumed` / `lifetimeTokensConsumed`, plus enforcement
  (`billing.ts`). **Single source of truth for consumption.** Never reintroduce client-side
  counting. (Cycle *lifecycle* — reset/carry-over/anchoring — is the Control-Plane's; see below.)
- **Sidecars** — `X-Request-Type` → KV `sidecar:*` configs (vision / web_search / utility / fim).

> **Adding / removing a model = a KV-data edit, not a code change.** Publish/edit the `active`
> config JSON (`{provider, model, baseUrl, chatCompletionsPath, authHeader, authScheme, apiKeyEnv,
> enabled, contextWindow, extraBody}`) and ensure the provider API-key secret exists
> (`wrangler secret put`). The worker source never needs touching. Locally, set
> `ACTIVE_AI_CONFIG_JSON` in `.dev.vars`.

## 3. Control-Plane (`toquemedia-studio-api`)

Everything that is **not** the AI request path:
- Auth (Firebase JWT verify), **App Check** minting (`/v1/appcheck-token`).
- Deploys / build orchestration, per-project DB & files (R2 / D1 / Turso), device registration.
- **Admin model *catalog*** — `/v1/admin/models` (the selectable list shown in the IDE admin),
  `/v1/admin/ai/active-config` (publishes the Data-Plane KV `active` config), sidecars, verify.
- BYOK validation (`/v1/byok/*`).
- **Billing — read + cycle lifecycle.** `/v1/me` (via `summarizeBilling`) returns state for the
  IDE/Web to display. The same read path (`getUserData`, `firestore.ts`) **also writes**: when it
  detects an expired cycle (`cycleExpired`) it lazily PATCHes a fresh `tokenBudget`
  (cycle reset + `billingAnchorDay` + carry-over of unpaid overshoot + plan-change budget). It uses
  per-field `updateMask` (never whole-map replace) so it never clobbers the Data-Plane's metering
  fields.

**Does NOT** (by design) do: per-request token **metering** (Data-Plane), streaming, or **runtime**
model routing. So billing is *split*: Data-Plane meters consumption; Control-Plane manages the
cycle and serves the read. The Control-Plane's own `commitTokenConsumption` is the runtime-dead
metering leftover (see below).

> **Nuance (clarified 2026-06-17).** "Control-plane should not handle models" means **runtime
> routing + streaming** (Data-Plane). The admin model **catalog CRUD** legitimately stays in the
> Control-Plane — it's the source of `/v1/admin/models`. Two GLM-5.2 entries (one per provider,
> z.AI + DashScope) would be added there, each with its own `activeConfig`.
>
> The metering functions `checkCostBudget` and `commitTokenConsumption` in the Control-Plane
> `billing.ts` are **runtime-dead** (no callers; superseded by the Data-Plane). They are slated for
> removal but were left in place because the repo was mid-refactor (branch
> `chore/deploy-v2-phase0-remove-worker`) with uncommitted work on them. `summarizeBilling` / `/v1/me`
> remain **live**.

## 4. Web (`toquemedia-studio`)

The public web app / marketing & account site. (Billing CFs / plan stamping interplay documented
in the IDE's billing memories.)

---

## Current parallel model (authoritative — 2026-07-24)

> **Single source of truth for runtime behaviour.** Historical phase logs below are archive.
> If a phase note contradicts this section, **this section wins**. Code contract:
> `src/services/agent/parallelTasks/policy.ts` (`ONE_AGENT_PER_PROJECT`).

### Topology

| Rule | Behaviour |
|------|-----------|
| **1 window = 1 OS process = 1 focused project** | `open_new_instance --open-project`; no shared runtime Zustand between windows |
| **Cross-window bus = disk only** | Under `~/.toquemedia-studio/projects/<id>/` |
| **`agent-status.json`** | Writer heartbeats while running (focused: ~3s; background: 30s); **reader** polls ~1.5s focused / 3s background (+ immediate on focus); readers treat `running` older than 90s as crashed |
| **`window-lock.json`** | Double-open **warning** (not a hard lock); staleness handles dead owners |
| **`task-stop-requests.json`** | Stop request from another window; owner aborts on turn boundary or heartbeat |
| **Switch project in-window** | Cancels the live run (confirm first) |

### Concurrency policy — **one agent per project** (F3)

| Allowed | Not allowed |
|---------|-------------|
| One live agent run per **project path** (main loop **or** session/project runner) | Concurrent fan-out tasks in the **same** project (`addParallelTask` always refuses) |
| **Steer** the live run (Enter / mid-run message) | Spawning a second agent on a busy project (redirects to steer when possible) |
| **Multi-window, multi-project**: window A on `/proj-a`, window B on `/proj-b` | Peer agent messaging (`send_agent_message` is **disabled**) |
| Sub-agents **read-only** under the owner (Explore / Research / Verify, cap shared) | Inter-agent “teams” board / peer chat |
| Sequential **queue** (park on Stop; resume) same session | Parallel worktrees **for concurrent agents on one project** (worktree machinery remains for future / isolated checkouts; **not** multi-agent fan-out while F3 is on) |

**Mental model today:** not “N agents on one tree”, but **N windows × N projects**, each with **at most one** agent, plus positional sessions (steer the run you are viewing). Coordinate humans via the developer, not `send_agent_message`.

**Code gates:**

- `parallelTaskManager.addParallelTask` → always `null` + i18n warn  
- `addSessionAgentRun` / project run → steer if project busy, else spawn  
- `send_agent_message` tool → hard error (deprecated under F3)  
- Status writer assumes a single live owner per project file  

### Session / UI invariants (still hold)

1. Streaming is **per-session** (`streamingSessionId`), not per visible tab.  
2. Interactive prompts (permission / question / credentials) carry **origin** and never stay invisible (Attention Inbox).  
3. Writes across agents that *could* share a tree use claims / write-lock (main claims registry).  
4. Auto-wake only with open work and a visible system message.  
5. Budget exhaustion: client stop-all + park queue; multi-window learns via `/v1/me` on focus (no server push).

### Still open (not 10/10 polish yet)

- Full loop fusion (main `runQueryEngineLoop` vs task `QueryEngine` driver)  
- **`/plan` on a live task session** remains blocked (slash uses main machinery; one agent per project) — use plan when the project’s agent is free, or steer with plain text  
- Shared multi-writer **item** board (optional product; out of F3)  
- Release matrix: see `docs/PARALLEL_RELEASE_CHECKLIST.md` (manual multi-window cases)

### Done recently (Pacote 3)

- **Hard lock optional**: Settings → Sandbox → “Block second window” (`hardBlockSecondProjectWindow`)  
- **Unified remote-stop message** in owner chat when Stop is requested from another window  
- **Badge tooltip** includes pid + owner hint

### Done recently (parity)

- **Attachments on task/session-agent steer** (2026-07-24): `ParallelSteerItem` + `resolveSteerItemsToContent` — same image pipeline as main (native vision / sidecar; BYOK via `byokVision.ts`)
- **First-turn multimodal on session-agent spawn**: `run.initialBlocks` + rebuild from last user `promptBlocks` so history-pop does not drop attachments

### Historical phases (archive)

The long phase log that follows (Fase 1–6, “trono”, worktrees default-on design, etc.) documents **how we got here**. Several notes describe multi-task worktrees and peer messaging as **built**; under the **Current** policy above those paths are **disabled or non-default**. Prefer `policy.ts` + this section when implementing.

## Parallel work (multi-window) — detail

**One window = one OS process = one project.** "Open in New Window" spawns a fresh instance
(`open_new_instance` → `--open-project <dir>`, lib.rs); instances share **nothing at runtime**
(each has its own Rust state, Zustand stores, MCP processes — only Firebase auth is shared via
the user-data dir). The only cross-window channel is **disk**, under the project's app-managed
state dir (`~/.toquemedia-studio/projects/<id>/`):

- **`agent-status.json`** — the window running the agent mirrors its run state
  (`running`/`done`/`error` + task label). Writer heartbeat: **~3s when the window is focused**,
  30s when backgrounded (`src/services/projectAgentStatusService.ts`; reader
  `useProjectAgentStatuses`). A `running` older than 90s = crashed writer, ignored. Writes are
  **serialized** (promise chain + unique temp files) and clears are **pid-owned** (`only_if_own`).
- **`window-lock.json`** — presence heartbeat for the **double-open guard**: opening a project
  whose lock is fresh and foreign warns the user (same state dir → session last-write-wins;
  same working tree → two agents writing). A warning, not a hard lock — staleness arbitrates
  crashed owners (`src/services/projectWindowLockService.ts`).

**Switching projects in-window cancels the run** (confirm first — `projectStore.openProject`/
`closeProject`); background work across projects is the multi-window model above, NOT in-window
multi-agent fan-out on one project (F3: one agent per project).

## Multi-agent foreground model (in-window) — historical design notes

**Design north star (still valid as product direction):** NÃO HÁ "DEUS". Positional main =
the session the developer is viewing. Sub-agents remain owner-scoped tools.

**Runtime as of 2026-07-24:** see **Current parallel model** — **one agent per project**;
intra-project concurrent tasks and `send_agent_message` are off. Worktree multi-task design
below is retained as archive of implementation investment.

**Invariantes (violá-las = regressão):**
1. **Uma tarefa nunca desaparece — só o developer apaga.** Cada tarefa paralela É uma sessão
   de chat persistida À NASCENÇA (`addParallelTask` → `persistSessionNow`; sem isto um
   reload/crash/abort-em-fila no 1º turno perdia o chat — bug real 2026-07-17)
   (`ChatSession.isParallelTask` + `parallelTaskStatus`); as rows na sidebar/ProjectMenu derivam
   das sessões (`useParallelTaskRows`: vivas ∪ persistidas), o chat fica consultável para sempre.
   Abort de tarefa ainda EM FILA stampa a sessão 'aborted' no próprio store (o runner nunca
   arranca, o finally dele nunca corre).
2. **Streaming é por-sessão, não por-vista.** Todos os writers de streaming do chatStore resolvem
   a sessão por `streamingSessionId` (captado em `startAssistantMessage`), nunca pela sessão
   visível — mudar de vista a meio de um run é sempre seguro.
3. **Nada interativo fica invisível.** Qualquer pedido ao developer (permissão, pergunta,
   credenciais) carrega `origin {taskId, label, sessionId}`; a row da tarefa sinaliza (badge
   âmbar Autorização/Pergunta/Credenciais), o diálogo/card identifica a tarefa, e o card
   interativo é escrito NA SESSÃO da tarefa (renderiza quando o user abre o chat dela).
4. **Escritas em disco serializadas** (`writeSerializer.withWriteLock`) entre TODOS os runs.
5. **Retomas automáticas só com trabalho aberto e sempre anunciadas** (backgroundCommands/
   autoWake: gate no task tracker + system message visível antes do run).

**Fases:**
- **Fase 1 — FEITA (2026-07-16):** tarefas têm sessão/chat próprio; `ask_user_question` +
  `request_credentials` disponíveis nas tarefas, roteadas por sessão com atribuição; permissões
  atribuídas; wall-clock re-arma enquanto a tarefa espera resposta humana.
- **Fase 2 — FEITA (2026-07-16): superfícies posicionais.** O estado por-run já existe nos dois
  registos (`agentStore.status` = run principal; `parallelTaskStore.runs` = mapa runId→status
  das tarefas); o que a fase entrega é a LEITURA posicional: o `AgentActivityIndicator` mostra
  o run da sessão visível (sessão de tarefa → strip da tarefa com último tool + Stop; a ver
  outra sessão → o indicador do main esconde-se), o **Stop do composer é posicional** (para o
  run desta vista), e o toggle "Nova tarefa" + o atalho da sidebar ficam disponíveis com o main
  idle enquanto houver tarefas vivas. Ciclos de vida separados: parar o main preserva os
  pedidos interativos das tarefas (clearAll/clearPending ignoram entries com `origin`); parar
  uma tarefa cancela SÓ os dela (`cancelByOrigin` nos 3 stores); pedidos de tarefas não
  congelam a exibição do streaming do main (`isAnyUserWaitStateActive` filtra por origin).
  A unificação dos dois registos num só fica para a Fase 4.
- **Fase 3 — FEITA (2026-07-16): composer roteado + delegate nas tarefas.** Com a sessão de uma
  tarefa viva em foco, enviar no composer **steera ESSA tarefa** (bolha escrita na sessão dela;
  `parallelTaskStore.steerQueue` drenado pelo `collectQueuedSteering` do runner a cada turn
  boundary — paridade com o steering do main; corre ANTES do un-pause da fila do main e o
  toggle "Nova tarefa" tem precedência; anexos ainda não seguem — aviso honesto na sessão).
  `delegate`/`collect_results` disponíveis nas tarefas com **entrega roteada por dono**:
  `SubAgentRun.ownerTaskId`, `pendingDeliveriesByOwner` no autoWake (resultados de uma tarefa
  drenam nos turn boundaries DELA; só donos 'main' recebem idle-wake), `collect_results` e a
  limpeza (`clearCompleted`) owner-scoped, SubAgentCard ancorado na sessão da tarefa,
  SubAgentStatusBar mostra só a equipa do main, cap de concorrência (4) global partilhado.
  Tarefa terminada/parada → `abortByOwner` + drop das entregas órfãs.
- **Fase 4a — FEITA (2026-07-16): transcript unificado por sessão.** O run de uma tarefa
  escreve o transcript COMPLETO na sua sessão — bolha assistant AO VIVO
  (`startAssistantMessageInSession`/`appendTextToMessageInSession`/`finalize…InSession`, sem
  tocar no streaming global do main) + tool calls pelos MESMOS updaters do main, que se
  tornaram **donos-cientes**: com `targetMessageId`, a sessão dona da mensagem manda
  (`findSessionByMessageId`) — isto também corrigiu o latente de updates de sub-agents em
  background perdidos quando o user trocava de sessão. Steering roda a bolha (fecha a atual,
  abre nova depois da mensagem do user — a dança de split do main). `MessageBubble` re-renderiza
  bolhas com `msg.isStreaming` (mutação in-place de sessões de fundo). Na superfície de chat,
  main e tarefa são agora o MESMO tipo de run.
- **Fase 4b — futura: fusão literal dos loops.** Um único módulo runner
  (hoje: agentService/agentRunner vs parallelTaskRunner) com capacidades ligadas por sessão —
  traz às tarefas compaction, contexto rico (TMS/mentions/attachments), plan mode e o
  ciclo de vida completo do main. Pré-requisito: extrair o core do agentService.
- **Fase 5 — FEITA (2026-07-16): worktrees por tarefa (DEFAULT ON por design).** Padrão Cursor/claude-vaz,
  validado por pesquisa externa: **ligado por defeito** (decisão do user — git é requisito da
  IDE; um projecto sem repo/commits ganha um **repositório local automático**: git init +
  .gitignore mínimo + commit inicial, com nota no chat da tarefa; o toggle nas Definições é
  o escape). Cada tarefa corre num **git worktree próprio** (`.toquemedia/worktrees/task-<n>-<ts>`,
  branch `worktree/…` off HEAD — reutiliza as convenções de `toolExecutor/worktrees.ts`; o
  clamp de paths continua a valer porque o worktree vive DENTRO do projecto). O executor da
  tarefa faz `enableCmdMode(worktree.path)` — toda a resolução de ficheiros/shell vive lá; o
  write-lock global é dispensado (árvore exclusiva). Fim de tarefa (qualquer terminal):
  **auto-commit** de trabalho solto + nota no chat com branch/nº de commits/como fundir
  (`git merge`/Source Control) — o worktree fica SEMPRE no disco (doutrina decideRemove:
  preservar trabalho; remover é decisão do developer). Sem git/commits → degrada para a
  árvore partilhada com aviso honesto. `enter_worktree`/`exit_worktree` excluídas das
  tarefas (nada de worktrees aninhados). Notas: `request_credentials` numa tarefa isolada
  escreve o `.env` do checkout PRINCIPAL (getProjectRoot prioriza currentProject sobre o
  cmd-cwd — comportamento desejado: credenciais sobrevivem ao merge); a equipa delegada
  (sub-agents) explora o WORKTREE da tarefa (workingPath = cmdModeCwd ?? root); o worktree
  parte do último COMMIT (HEAD) — alterações por commitar do developer não entram.
  **Regra de propriedade de ficheiros (imposta mecanicamente, não só por prompt):** o
  executeTool do runner BLOQUEIA escritas em (a) ficheiros com alterações por commitar do
  DEVELOPER no checkout principal e (b) ficheiros já modificados por OUTRA tarefa viva
  (`ParallelTaskRun.modifiedFiles` — quadro de claims, primeiro tijolo da Fase 6b); o
  resultado da tool instrui o agente a NÃO contornar e a explicar os ficheiros saltados no
  relatório final. **Tarefas só desaparecem quando o developer as FECHA** (X nas rows
  terminadas → confirmação → apaga o chat; worktree/branch ficam SEMPRE no disco).
- **Fase 4b — PARCIAL (2026-07-17): PARIDADE DE SYSTEM PROMPT (golpe no trono nº1).** As
  tarefas montam o MESMO system prompt do agente interativo: `ContextBuilder.createEphemeral
  ({taskSurface:true})` — instância por tarefa (estado próprio: promptCache +
  auxiliarySelection; o singleton fica exclusivo do main, que lê a seleção logo após o build
  dele) — com build COMPLETO (TMS com imports, árvore, git, skills, router de intenção sobre
  o prompt DA tarefa) e raiz no WORKTREE (cada developer vê a sua cópia: branch/status dela).
  `taskSurface` omite as 2 secções do tracker GLOBAL (task_tracker_live/task_list — uma
  tarefa não adota o backlog do main nem tem update_tasks). Secções omitidas pelo planner
  ficam alcançáveis: o meta-tool `request_context` é injetado e interceptado no executeTool
  da tarefa, resolvido no builder efémero dela; `request_tools` responde "toolset completo".
  Guarda pré-voo pós-build (paridade com o main: Stop durante router/planner não deixa o
  engine arrancar) e FALLBACK degradado (prompt artesanal + fatia TMS ≤8k) se o build falhar
  — uma tarefa nunca deixa de arrancar por causa do prompt. Compaction: `getContextLimits`
  reais desde 07-16. Telemetria de prompt continua module-level (partilhada com o main) —
  contaminação aceite, só telemetria. RESTANTE da 4b: mentions/attachments no dispatch de
  tarefas, plan-mode, e a fusão literal dos dois loops num runner único (extrair o core do
  agentService). Aprovação de diffs NÃO entra por doutrina: a tarefa escreve na branch DELA;
  o merge é a revisão.
- **Fase 6b — PARCIAL (2026-07-17): registry ÚNICO de claims (main incluído).** A regra de
  propriedade vive agora num só sítio — `services/agent/fileClaims.ts` + UMA verificação em
  `toolExecutor.execute` para TODOS os agentes: o run principal regista claims
  (`beginMainRunClaims`/`endMainRunClaims` no agentService) e é bloqueado em ficheiros de
  tarefas vivas (e vice-versa); claims de tarefas são espelhados em `run.modifiedFiles`
  (UI/persistência) e libertos no terminal. O baseline de WIP do developer continua
  task-only no runner (o main é o par interativo do developer — não é bloqueado pelo WIP
  dele). A cópia da guarda que vivia no runner foi REMOVIDA (menos um caminho gémeo).
  RESTANTE da 6b: task list partilhada com claim de ITENS de trabalho (padrão Claude Code
  Teams; exige update_tasks multi-escritor) + mensagens agente↔agente.
- **Superfície de MERGE + housekeeping (2026-07-17):** Source Control ganhou a secção
  "Branches de Tarefas" (`TaskBranchesSection.tsx`): lista `refs/heads/worktree/*` com
  commits-por-fundir, bloqueia ações em branches de tarefas VIVAS, **Merge --no-ff**
  (conflitos caem na secção "Conflitos de Merge" existente) e **Apagar branch+worktree**
  (confirmado; único caminho de remoção de worktrees — nunca automático). Fecha o ciclo
  "N developers → review → merge". Adjacentes fechados no mesmo dia: prune de 50 sessões
  NUNCA apaga chats de tarefa (doutrina); billing pré-voo no addParallelTask (recusa com
  nota, sem tarefa-fantasma a morrer no worker); TMS.md por commitar é COPIADO para o
  worktree na criação (memória viaja com cada developer); @-mentions (+imagens) no prompt
  de tarefa com a resolução do main (atMentions); X de rows de tarefas de OUTRAS janelas
  removido (fechar apagava o chat debaixo do runner do outro processo — agora só Stop
  local ou fecho de terminadas).
- **Trono nº3 DEMOLIDO + 6b mensagens (2026-07-17):** `web_search` devolvido às tarefas (é
  passive/provider-side — a rota da tarefa é a mesma do main; a exclusão assentava num
  comentário errado) e `capture_url_design` devolvido com **mutex GLOBAL do browser**
  (`withBrowserExclusive` em captureUrlDesign.ts — capturas de N agentes serializam na tab
  única em vez de excluir). **Stop cross-window**: `taskStopRequestService` — X numa row de
  tarefa de OUTRA janela escreve pedido em `task-stop-requests.json` (state dir); o runner
  dono consome no turn boundary (rápido) e no heartbeat 30s (teto) e aborta-se pelo caminho
  normal. **Mensagens agente↔agente** (`send_agent_message`, main+tarefas): alvo "main" entra
  na fila de entregas do autoWake (steering mid-run; idle → wake/announce — a MESMA dança dos
  sub-agents); alvo tarefa entra na steerQueue dela + nota 📨 no transcript; alvos mortos
  devolvem a lista de agentes vivos. Tracker global (`update_tasks`) continua main-only até
  haver tracker por-sessão.
- **AGENTES DE SESSÃO — trono nº2 substancialmente demolido (2026-07-17):** enviar numa
  sessão IDLE com o run interativo vivo NOUTRA sessão deixa de alimentar a fila (que drenava
  como steering do run da OUTRA sessão — o buraco posicional) e passa a lançar **o agente
  DESTA sessão**: um run de CONTINUAÇÃO no runner paralelo (`addSessionAgentRun` →
  `run.continuation`), com o HISTÓRICO completo da sessão (rebuildConversationHistory +
  exclusão da bolha recém-escrita), prompt/BYOK/claims/steering plenos. Política de árvore
  por tipo de sessão: chat NORMAL = par do developer (checkout principal, SEM worktree, sem
  WIP-guard; claims+write-lock protegem); chat de TAREFA = reutiliza o worktree do run
  anterior da sessão quando ainda existe no processo, senão cria novo. Fechar a row de uma
  continuação de chat normal remove só a entrada viva (a conversa fica). O steering
  continua posicional: mensagem na sessão do run vivo steera ESSE run.
- **Fusão dos runners — F1 e F2 FEITAS (2026-07-18):** o mesmo bloco vivia em DOIS corpos
  (`agentRunner.runAgentInternal` + `usePromptBar.runAgentForPrompt`) e divergiu com custo
  real. **F1** = montagem (system prompt + volátil + MCP) no núcleo único `mainDispatch.ts`.
  **F2** = os ~200 linhas de callbacks do loop (`AgentCallbacks`) unificadas em
  `mainDispatch.buildMainLoopCallbacks({surface, isBackgroundRun, bootstrapOnly, ...})` —
  união dos MELHORES comportamentos dos dois lados (o Chat ganhou onReasoningComplete,
  providerState multi-turno, guard de dupla-finalização, fecho automático do tracker,
  celebração e o `?? 0` defensivo do usage; o runner ganhou steering de imagens e a mensagem
  de erro recuperável). `RECOVERABLE_UPSTREAM_CODES` + estimador movidos para lá. Regra:
  mexer nos callbacks do loop = mexer AQUI. O `parallelTaskRunner` NÃO entra (dirige a
  `QueryEngine` diretamente com callbacks task-scoped: UI por-sessão, steering por-run,
  Stop cross-window, wall-clock) — isso é a F3.
- **Tracker POR-SESSÃO — FEITO (2026-07-18, sem-deus puro):** o tracker deixou de ser um
  array global do agente principal e passou a `agentStore.tasksBySession` (Record<sid,
  AgentTask[]>) — o "main" é apenas mais um sessionId, sem estatuto. `agentStore.tasks` é
  agora um ESPELHO só-leitura da sessão em FOCO (a que o user vê), mantido pelo
  `trackerFocusSync` (um subscribe ao activeSessionId → foca + hidrata `tasks-<sid>.json`);
  os leitores da UI (painel/statusbar) não mudaram. `update_tasks` roteia para a sessão que
  o executa (`getTaskOrigin().sessionId` nas tarefas; streaming/ativa no main) e persiste
  per-sid — foi RE-ADMITIDA às tarefas paralelas (cada agente planeia o seu, sem pisar o
  checklist do principal). Fecho automático de in_progress no fim do run é per-sessão (main
  em mainDispatch.onDone, tarefas no finally do parallelTaskRunner). O gate do auto-wake lê
  o espelho (sessão focada) — inalterado.
- **Fusão F3 — SETUP partilhado FEITO (2026-07-18):** `runClient.ts` extrai o núcleo
  genuinamente comum aos três runners — auth token → cliente SDK + closure de refresh
  (ramo BYOK direto vs. gerido, com a mesma dança `getIdToken(true) ?? refreshLogin() →
  getIdToken(true)`). Vivia copiado em `agentService.runQueryEngineLoop` E no
  `parallelTaskRunner`; divergir quebrava a recuperação de token de um sem o outro notar.
  Os wrappers ficam separados de PROPÓSITO — o resto é legitimamente diferente (principal:
  toolset selector + telemetria TMS; tarefa: worktree + steering por-run + wall-clock), e
  fundi-los num só seria um monstro de condicionais. +9 testes do contrato do cliente.
- **O trono por demolir (o que RESTA):** (1) **F3 (resto)** — o corpo do LOOP em si
  (runQueryEngineLoop vs. o driver de QueryEngine da tarefa) continua por unir; traria
  plan-mode e anexos do composer a todos os agentes. Não-trivial e talvez nem inteiramente
  desejável (os dois têm ciclos de vida diferentes); avaliar caso a caso. Até lá, o run
  interativo mantém o queryGuard único. (2) task list partilhada com claim de itens (resto
  da 6b — o board partilhado, distinto do tracker por-sessão já feito).
- **Fase 6a — FEITA (2026-07-16): inbox unificado de atenção.** Sino na titlebar
  (`components/ui/AttentionInbox.tsx` + `hooks/useAttentionInbox.ts`, padrão Antigravity):
  agrega pedidos interativos pendentes de TODOS os agentes (permissões atual+fila, perguntas,
  credenciais — atribuídos por origin) e tarefas terminadas com resultado por ver
  (`ParallelTaskRun.resultSeen`; visto = abrir o chat da tarefa, ou estar a vê-lo no fim).
  Só se renderiza com itens (a presença é o sinal); pedidos pulsam âmbar; clique navega ao
  chat da tarefa ou à vista de chat do main. Ordenação: interativos primeiro (bloqueiam
  agentes), resultados depois.


**Budget exhaustion stops everything, visibly.** Enforcement stays server-side (Data-Plane 402
`tm_budget_exhausted`/`tm_team_slice_exhausted`). Client-side, the `noCredits` flip (own 402,
`X-Budget-Status: rejected` header, or `/v1/me` on window focus — how a *parallel window* finds
out; there is no server push) triggers `budgetStopService`: aborts this window's main run +
sub-agents, adds a system message, badges the project `error` cross-window, and **parks** the
queue. `useQueueProcessor` also gates on billing, so parked work never burns 402s and survives
until credits return. (The Chat dispatch path has **no billing pre-flight of its own** — the
queue gate is what stands between an exhausted budget and a real request.)

**Task queue (same project).** While a run is live, Enter **steers** it (claude-vaz parity).
**F3 (current):** concurrent `asTask` / `addParallelTask` fan-out is **disabled** (one agent per
project); the UI surfaces the one-agent message instead of spawning a second run. Historical
queue-order / park-on-Stop behaviour still applies to any residual queued work and to
cross-project session agents. Stop (single implementation: `stopAgentRun`) drops steering and
**parks** residual tasks. Multi-window multi-**project** remains the supported parallel model.

---

## Cross-cutting rules

- **`curl` against the Data-Plane proves nothing about the browser path** (CORS + SSE differ).
  Login/billing can work while AI silently fails, and vice-versa.
- **Billing is split:** Data-Plane is the single source of truth for *metering* (per-request
  consumption); Control-Plane owns the *cycle lifecycle* (reset/carry-over/anchoring, written
  lazily on the `/v1/me` read path) and serves the read for IDE/Web display. Both patch the same
  Firestore `tokenBudget` map but **different fields**, via per-field `updateMask`.
- **Model add/remove never edits worker code** — it's KV config (Data-Plane) + catalog
  (Control-Plane admin).

## Adding / removing a managed model — end-to-end checklist

The recurring confusion: a model lives in **more than one place**. To add a managed model
(e.g. GLM-5.2 from two providers) so it both *appears* in the admin and *works*:

1. **Catalog (Control-Plane, `controlPlaneModels.ts`)** — add a `ControlPlaneModel` entry per
   provider (`{id, name, providerLabel, category:'coder', activeConfig:{provider, model, baseUrl,
   chatCompletionsPath, authHeader, authScheme, apiKeyEnv, enabled, contextWindow, extraBody}}`).
   This is what `/v1/admin/models` returns → the IDE admin dropdown. **Two entries with the same
   `name` but different `providerLabel`** render as "GLM-5.2 (Alibaba US)" / "GLM-5.2 (z.AI)".
   - Update the catalog-count assertion in `src/__tests__/admin.test.ts` (`body.models.length`).
2. **Provider secret (Data-Plane)** — the `apiKeyEnv` (e.g. `ZAI_API_KEY`) must exist as a worker
   secret (`wrangler secret put` in prod; `.dev.vars` locally). Without it the entry still *appears*
   but fails when selected.
3. **IDE capability profile (`modelProfiles.ts`)** — needed **only if** the model's capabilities
   (vision / thinking / maxOutput) differ from the plan fallback. Key it by the name the
   Data-Plane reports in `X-TM-Model`. (Until the header-driven refactor below, this is the one
   IDE touch-point.)
4. **Publish & verify** — selecting the model in the admin calls `/v1/admin/ai/active-config`,
   which writes the KV `active` config the Data-Plane reads. `thinking`/`reasoning_effort`/
   `enable_thinking` go in `activeConfig.extraBody` (the IDE never sends them).

**Local test → prod (the real workflow):** run the Control-Plane (`yarn dev` →
`wrangler dev --persist-to ../exodus-ide/.wrangler/shared-state`, port 8787) — it shares KV state
with the local Data-Plane (`yarn dev:ai-worker`, 8788). The IDE in `yarn tauri dev` reads the local
catalog. When verified, **deploy the Control-Plane** (`yarn deploy` → `wrangler deploy --env
production`) so production IDEs see the new catalog, and set any new provider secret in prod.

## Known improvement — header-driven IDE (deferred)

Today the IDE needs a `modelProfiles.ts` entry for a model **only** because the Data-Plane does not
emit model *capabilities*, just name + context window. If the Data-Plane also emitted
`X-Model-Supports-Vision`, `X-Model-Supports-Thinking`, and `X-Model-Max-Output-Tokens`, the IDE
capability table would collapse to a single default and **adding/removing a model would never touch
the IDE**. Until then, a new managed model needs a `modelProfiles.ts` entry **iff** its capabilities
differ from the plan fallback.
