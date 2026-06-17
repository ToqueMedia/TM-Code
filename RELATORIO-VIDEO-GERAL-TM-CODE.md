# Relatório de Produto para Vídeo Geral — TM Code

> Auditoria read-only do código-fonte (Tauri 2 + React 18 + TypeScript + Zustand + Chakra UI) para preparar um **prompt final de Remotion** de um vídeo de apresentação geral.
> Data: 2026-06-17 · Versão da app: **0.7.7** · Nenhum ficheiro de produto foi alterado.

> **Nota de nomenclatura:** a pasta do repositório chama-se `exodus-ide` (codinome), mas o **produto chama-se `TM Code`** (package `toquemedia-studio`, by Toque Media). Usar sempre **TM Code** no vídeo.

> **Contexto importante:** já existe um projeto Remotion em `remotion-video/` com um vídeo renderizado (`out/tmcode-promo.mp4`, 1920×1080 · 30fps · 42s) — mas é **focado exclusivamente no comando `/te2e`/Terminal Mode**. Este relatório serve para criar um **segundo vídeo, geral**, reaproveitando a biblioteca de componentes Remotion já existente.

---

## Resumo Executivo

**TM Code é uma IDE de desktop "chat-first" onde o agente de IA é a interface principal**, não um plugin lateral. O programador descreve o que quer; o agente planeia, lê e escreve ficheiros, corre comandos no terminal, mostra diffs inline para aprovação, abre um preview ao vivo e faz deploy para produção — tudo sem sair da conversa.

A app tem **dois modos** que partilham o mesmo motor (`chatStore` + agent loop):

- **Chat Mode** (recomendado, rosa) — experiência guiada "do zero ao live": agente planeia, escreve código, preview e deploy num clique. Pensado para criar produtos.
- **Terminal Mode** (power users, roxo) — terminal agêntico de liberdade total: qualquer stack, qualquer tarefa, DevOps, tool calls inline, painel PTY nativo ao lado.

O produto é **production-grade e bilingue (EN + PT-PT)**, com editor Monaco completo, git nativo com mensagens de commit por IA, integração MCP, BYOK (chaves próprias), debugger, data viewer, HTTP client integrado, sistema de permissões para operações perigosas, e deploy one-click para `*.toquemedia.net` com domínios personalizados.

**Promessa central (real, das strings do produto):**
> *"The IDE where the agent writes code for you."* · *"Chat with AI. Watch it code. Ship faster."* · *"The developer drives. The agent builds."*

**Patrocínio/Modelo:** "Powered by MiMo" — Xiaomi MiMo V2.5 / MiMo V2.5 Pro (contexto nativo de 1M tokens), patrocinador oficial. Há ainda routing multi-modelo (Qwen, GLM, Gemini via Vertex) escondido por white-labeling nos planos cloud, e exposto apenas no BYOK.

---

## Proposta de Valor

| Eixo | O que é | Porque importa |
|---|---|---|
| **Chat-first paradigm** | A conversa É a IDE. O agente é o ponto de entrada, não a sidebar. | Diferencial de posicionamento vs. todas as IDEs tradicionais. |
| **Do zero ao live** | New Project → chat → preview → deploy num clique, com stack curada. | Vibe coders e founders tiram uma ideia para produção sem DevOps. |
| **Liberdade total (Terminal Mode)** | Terminal agêntico: shell real, qualquer stack, tarefas de DevOps. | Devs experientes mantêm controlo de baixo nível. |
| **Tudo numa janela** | Chat + editor Monaco + preview webview nativo + terminal PTY + git + data + HTTP client. | Zero troca de contexto, zero ferramentas externas (Postman, DBeaver). |
| **Controlo visível** | Diffs inline aprovados/rejeitados; permissões para comandos perigosos e ficheiros sensíveis. | Confiança: o utilizador vê e autoriza tudo o que o agente faz. |
| **Transparência do agente** | Blocos de "thinking", tool calls renderizados, status line ao vivo, % de contexto. | O utilizador "vê o agente a pensar e a trabalhar". |
| **Bilingue PT/EN, mercados lusófonos** | UI e agente em Português de primeira classe; pagamentos MoMenu (MCX, E-kwanza, Referência). | Foco claro em Angola/PT/BR — nicho não servido pela concorrência. |

---

## Públicos-Alvo

Para cada público: dor → como o TM Code resolve → feature mais relevante → mensagem comercial.

### 1. Programadores experientes
- **Dor:** trocar de contexto entre IDE, terminal, browser e ferramentas de API mata o flow.
- **Resolve:** Terminal Mode agêntico + editor Monaco + PTY nativo + git + diffs inline numa só janela.
- **Feature:** Terminal Mode (tool calls inline, painel PTY, status line, permissões).
- **Mensagem:** *"Liberdade total. Qualquer stack, qualquer tarefa. O terminal que pensa contigo."*

### 2. Vibe coders
- **Dor:** querem construir pela conversa, sem decorar comandos nem montar setup.
- **Resolve:** Chat Mode guiado com stack curada, `#auth-google`, `/payments`, preview e deploy.
- **Feature:** Chat Mode + slash/hashtag commands + live preview.
- **Mensagem:** *"Descreve. Vê acontecer. Publica."*

### 3. Founders / Startups
- **Dor:** precisam de um MVP no ar ontem, sem equipa nem orçamento de infra.
- **Resolve:** New Project → chat → preview → **deploy one-click** com domínio em `*.toquemedia.net` ou domínio próprio.
- **Feature:** Publish Modal + Deploys (custom domain, SSL).
- **Mensagem:** *"Da ideia ao link partilhável numa tarde."*

### 4. Equipas pequenas
- **Dor:** rever mudanças e manter git limpo consome tempo.
- **Resolve:** Source Control com staging visual, **mensagem de commit por IA**, diffs aprovados, `/review` por sub-agente.
- **Feature:** SourceControlPanel + `/review`.
- **Mensagem:** *"Code review e commits com IA. A equipa avança mais depressa."*

### 5. Agências / Software houses
- **Dor:** muitos projetos pequenos, deadlines apertados, stacks variadas.
- **Resolve:** templates, deploy multi-projeto gerido em Settings → Deploys, BYOK para clientes.
- **Feature:** Templates + gestão de deploys + BYOK.
- **Mensagem:** *"Entrega mais projetos com a mesma equipa."*

### 6. Estudantes
- **Dor:** setup de ambiente (Node/Python/Git) e curva de ferramentas.
- **Resolve:** onboarding com **deteção e instalação one-click** de ferramentas; aprende vendo o agente.
- **Feature:** OnboardingFlow + ToolsStep.
- **Mensagem:** *"Começa a programar sem montar nada. Aprende vendo o agente trabalhar."*

### 7. Pessoas não técnicas que querem criar apps
- **Dor:** não sabem código mas têm ideias.
- **Resolve:** Chat Mode em linguagem natural (PT/EN), preview visual, deploy num clique.
- **Feature:** Chat Mode + Preview + Publish.
- **Mensagem:** *"Tens a ideia. O agente escreve o código."*

### 8. Empresas que querem acelerar desenvolvimento
- **Dor:** velocidade de entrega + governança/segurança.
- **Resolve:** permissões para comandos perigosos/ficheiros sensíveis, BYOK (chaves próprias), MCP para integrar sistemas internos, planos com limites.
- **Feature:** Permission system + BYOK + MCP.
- **Mensagem:** *"Velocidade de IA, com controlo e as tuas próprias chaves."*

---

## Inventário Completo de Features

### Welcome / Onboarding
- **Welcome screen** com dois cartões de modo: **Chat Mode** (rosa, "RECOMMENDED") e **Terminal Mode** (roxo, "POWER USERS").
- **Sidebar de projetos recentes** separados por **Terminal** vs **IDE**, com timestamps (today/yesterday/days ago), abrir, e "Clear recent".
- **New Project** (templates: React+TS, Node+Express, Python+FastAPI, Vue, Rust, Empty) — atalho ⌘N.
- **Open Project** (folder picker) — atalho ⌘O.
- **Clone Repository** (GitHub/GitLab/Bitbucket/git genérico, branch opcional, validação ao vivo) — atalho ⌘⇧C.
- **Onboarding 6 passos:** Welcome → Paradigm ("Chat-first. Not sidebar-first.") → Config (idioma UI + idioma do agente) → Tools (Python/Node/Git, instalação one-click no Windows) → Features → Ready (criar conta).
- **StartupRequirementsBanner** (ferramentas em falta), **PromoBanner** (contagem decrescente de promoções).

### Chat Mode
- Interface conversacional como surface principal; renderiza o mesmo `chatStore` que o Terminal.
- **Prompt bar** com overlay de syntax-highlight: `/` comandos, `@` ficheiros, `#` opt-ins.
- **Slash commands:** `/init`, `/plan`, `/debug`, `/payments`, `/te2e` (Pro/Max), `/review`, `/compact`, `/speed` (Pro/Max).
- **@-mentions** de ficheiros (snapshot do conteúdo no envio, reconciliação de staleness).
- **#-hashtags** (vocabulário fechado): `#auth-google`, `#auth-email-password`, `#design`.
- **Anexos multimodais:** colar/arrastar imagens (até 10), aviso de plano text-only no Free.
- **Streaming:** blocos de `text`, `reasoning` (thinking com shimmer), `tool_call` (cards expansíveis).
- **Cards interativos:** PlanApprovalCard (aprovar/pedir alterações), TodoListCard, CredentialRequestCard, AskUserQuestionCard, SubAgentCard, CompactSummary.
- **Diffs inline** com aprovar/rejeitar; **AgentStatusBar** (Ready/Thinking/Generating/Applying/Compressing); **ContextWindowIndicator** (pill de %); **ModelIndicator** (só em BYOK).
- **Fila de mensagens** (escrever enquanto o agente trabalha).

### Terminal Mode
- **Greeting** com banner ASCII "TM CODE", branch git, último commit, tips rotativos.
- **Agentic loop** com ~23+ tools (ver lista abaixo), tool calls renderizados inline.
- **Diffs estruturados** mostrados ANTES da escrita (aprovar/rejeitar).
- **Painel PTY nativo** (xterm.js + WebGL), multi-tab (até 5), divisor arrastável, suporta TUIs (vim/fzf/htop).
- **Permissões:** prompt para comandos destrutivos e ficheiros sensíveis, sem "Approve All" nesses casos; teclas y/a/n/d/r.
- **Status line:** estado do agente (cores pulsantes), `ctx X/Y (%)`, modelo (+ "TM Speed ×3"), MCP, dev server, bg jobs, tempo decorrido, botão stop.
- **Reasoning/thinking** inline com duração.
- **Sub-agents** via `delegate`/`collect_results` (usados por `/review`, `/te2e`, `/debug`).
- **Sessões:** `/new`, `/clear`, `/save <name>`, `/resume` (picker por teclado), `/exit`.
- **Compactação** de contexto (auto e `/compact`), **memória** persistente (save/read/forget/distill).
- **Comandos de servidor:** `/start-server`, `/stop-server`, `/terminal`, `/settings`.

#### Lista de tools do agente (de `toolExecutor.ts`)
`read_file`, `write_file`, `edit_file`, `create_file`, `delete_file`, `rename_file`, `create_directory`, `list_directory`, `glob`, `search_files`, `web_search`, `web_fetch`, `start_dev_server`, `read_dev_server_logs`, `execute_command`, `execute_command_background`, `check_background_commands`, `agent_shell_start/write/read/stop`, `delegate`, `collect_results`, `verify`, + memória (`save_memory`/`read_memory`/`forget_memory`/`distill_memory`) e `update_tasks`.

### Project / File Management
- **File explorer** virtualizado (`@tanstack/react-virtual`), context menu (new/rename/delete/copy/reveal/find in folder), exclui node_modules/.git/dist.
- **Editor Monaco** completo (tabs, split, breadcrumbs, format on save via Prettier, gutter de diffs git).
- **Search** full-text com toggles (Match Case/Whole Word/Regex), agrupado por ficheiro.
- **Command Palette** (⌘P / ⌘⇧P), **Activity Bar** lateral.

### Preview / Browser / Deploy
- **Preview** com webview nativo (wry) montado de forma persistente; **Screenshot → chat** (planos pagos); consola de dev server; fullscreen; back/forward/refresh.
- **HTTP Client** integrado (REST, métodos coloridos, auth Bearer/Basic, body JSON validado, histórico, multi-tab) para projetos backend/fullstack.
- **Data Viewer** (tabelas paginadas, toggle DEV `dev.db` ↔ PROD via worker).
- **Deploy one-click** (PublishModal): build → bundle → init → upload R2 (lotes) → [container build] → finalize → probe. URL ao vivo + copiar.
- **Settings → Deploys:** lista de deploys (Live/Offline/Archived), suspender/retomar/eliminar, **domínio personalizado** (validação DNS, registos CNAME/SSL).
- Deteção automática de stack (static SPA, SSR, container, composite).

### Git / Version Control
- **SourceControlPanel:** branch + divergência (↑/↓), staged/changes com estados A/M/D/R/U coloridos, stage/unstage/discard (por ficheiro e all).
- **Botão de ação contextual:** "Commit" / "Stage All & Commit" / "Pull & Push".
- **Mensagem de commit por IA** (botão sparkle): lê o diff staged, gera conventional commit; **strip de blocos `<think>`** (fix para Gemini não-streaming) e remoção do trailer de co-autor.
- Commits assinados com `Co-Authored-By: TM Code <tm.code@toquemedia.net>`.
- Polling de status com file watcher do `.git/`, divergência de upstream, diffs linha-a-linha no gutter.
- Clone de repositório no Welcome.

### Segurança / Permissões
- **Permission prompts** para tool calls; tiers: auto-aprovado (reads), card próprio (write/edit/create), prompt (execute/delete/etc.).
- **Ficheiros sensíveis** (`.env*`, `.pem`, `.key`, `secrets.json`, `config.json`) e **comandos destrutivos** (`rm`, `dd`, `git push --force`...) — sempre prompt, sem "Approve All".
- **Deny with reason** (dizer ao agente o que fazer em alternativa).
- **Sandbox** (toggle experimental em Settings) e clamp de diretórios permitidos (frontend + Rust cwd).

### MCP / Automação
- Servidores **stdio e remote**; configurados em `~/.toquemedia-studio/mcp.json` (global) ou por projeto.
- Descoberta de tools (`tools/list`), permissão antes de executar, indicador no status line ("2 MCP: …").
- Comandos `/mcp-install <name>`, `/mcp-browse`; secção Settings → MCP Servers (form + paste JSON).
- **Valor comercial:** ligar APIs e sistemas internos ao agente; extensibilidade tipo "app store de capacidades".

### Billing / Plans / Limits
- **Planos in-app (código, `billingStore.ts`):** `explorer` ("Free", cinza), `vibe` ("Vibe", verde), `pro` ("Pro", roxo), `max` ("Max", azul); especiais `welcome` (trial Vibe) e `byok-only` ("BYOK", laranja).
- **README marketing** mostra outra grelha: Free / Pro / Business (4x/8x) — ⚠️ **discrepância a resolver antes do vídeo** (ver Limitações).
- **CreditIndicator** (pill ao vivo): % de consumo + barras, cores verde→amarelo→laranja→vermelho, dropdown com data de reset e link de upgrade.
- **Overage / "Extra Credits" (TMS)** com banner; **TM Speed** (`/speed`): routing mais rápido, **3× tokens**, só Pro/Max + família MiMo V2.5 Pro.
- Contabilização **exclusiva no worker** (server-side); IDE só exibe. Upgrade abre `https://code.toquemedia.net`.

### Settings / Modelos / Provider / Auth
- **Modelos** (`modelProfiles.ts`): MiMo V2.5 Pro 1M (default), MiMo V2.5 1M, Qwen 3.7 Max (1M, visão+search nativos), GLM-5.1, Gemini 3.5 Flash / 3.1 Pro (Vertex). Identidade do modelo **escondida nos planos cloud** (white-labeling), visível só em BYOK.
- **BYOK** (Settings → API Keys): catálogo curado, chaves em keychain do OS, providers cloud/local (Ollama/LM Studio)/custom OpenAI-compatible.
- **Auth:** Firebase Auth (email/password, PT-first) + App Check obrigatório; limite de contas por dispositivo; login em `LoginScreen.tsx`.
- **Idiomas:** UI (en/pt) + agente (en/pt/zh/es/fr/de/ja).
- **Settings sections:** Profile & Plan, Editor, Deploys, Sandbox, Shortcuts, Skills, MCP, BYOK, Admin (model routing por plano).

### Extra / Sazonal
- **Goal Celebration** (World Cup 2026): confetti + "GOOAAL!" no fim de runs bem-sucedidos (kill switch `FOOTBALL_MODE_ENABLED`).
- **IssueReporter** (screenshot + bug report), **ShellCommandBlock** com reveal progressivo de output.

---

## Ficheiros e Componentes por Feature

> Caminhos relativos a `/Users/ithustle/dev/deskotp/exodus-ide/`. Stores em `src/stores/`, serviços em `src/services/`, comandos Tauri em `src-tauri/src/commands/`.

### Welcome / Onboarding
- `src/components/WelcomeScreen.tsx`, `src/components/welcome/WelcomeSidebar.tsx`, `WelcomeHero.tsx`, `CloneDialog.tsx`, `NewProjectDialog.tsx`, `StartupRequirementsBanner.tsx`, `PromoBanner.tsx`
- `src/components/onboarding/OnboardingFlow.tsx`, `src/components/onboarding/steps/ToolsStep.tsx`
- Stores: `projectStore`, `settingsStore`, `requiredToolsStore`, `promotionsStore`
- Tauri: `git_clone_repository`, `install_dev_tool`, dialog plugin (open folder)

### Chat Mode
- `src/components/views/ChatView.tsx`, `src/components/chat/MessageBubble.tsx`, `ToolCallDisplay.tsx`, `ReasoningBlock.tsx`, `AgentStatusBar.tsx`, `ContextWindowIndicator.tsx`, `ModelIndicator.tsx`, `PlanViewerPanel.tsx`, `PermissionDialog.tsx`, `CredentialRequestCard.tsx`, `AskUserQuestionCard.tsx`, `SlashCommandMenu.tsx`
- `src/components/PromptBar.tsx`, `src/components/prompt/usePromptBar.ts`, `PromptTextarea.tsx`, `MentionMenu.tsx`, `AttachmentChips.tsx`
- Stores: `chatStore`, `agentStore`; Serviços: `attachmentService`, `agent/atMentions.ts`, `agent/slashCommandRegistry.ts`, `agent/hashtagRegistry.ts`

### Terminal Mode + Agent loop
- `src/components/cmd-mode/TerminalView.tsx`, `TerminalMessageRenderer.tsx`, `TerminalStatusLine.tsx`, `TerminalPermissionPrompt.tsx`, `TerminalToolCall.tsx`, `TerminalStructuredDiff.tsx`, `TerminalSessionPicker.tsx`, `TerminalGreeting.tsx`, `TerminalPanel.tsx`, `BillingOverageBanner.tsx`
- `src/services/agent/query.ts`, `agentService.ts`, `queryEngine.ts`, `toolExecutor.ts`, `cmdModeCommands.ts`, `contextBuilder/`, `compact/`, `memdir.ts`, `memoryDistiller.ts`, `permissionPersistence.ts`
- Stores: `terminalPanelStore`, `permissionStore`, `agentStore`, `chatStore`
- Tauri: `src-tauri/src/commands/terminal.rs` (PTY), `filesystem.rs`, `git.rs`, `container.rs` (sandbox/allowed dirs)

### Project / File / Editor / Search
- `src/components/ui/FileTree.tsx`, `ExplorerPanel.tsx`, `MonacoEditor.tsx`, `MonacoDiffEditor.tsx`, `CommandPalette.tsx`, `ActivityBar.tsx`
- `src/components/views/SearchPanel.tsx`, `EditorView.tsx`, `EditorSidebar.tsx`, `EditorToolbar.tsx`
- Stores: `fileTreeStore`/`fileTreeRepository`, `editorStore`, `layoutStore`
- Tauri: `build_file_tree`, `read_file`, `write_file`, `create/rename/delete_file_or_directory`, `search_in_files`

### Preview / HTTP / Data / Deploy
- `src/components/views/PreviewView.tsx`, `src/components/http-client/HttpClientPanel.tsx` (+ `KeyValueEditor`, `JsonBodyEditor`, `ResponseViewer`), `src/components/data-viewer/TableView.tsx` (+ `TablesSidebar`, `SourceToggle`, `Pagination`)
- `src/components/dialogs/PublishModal.tsx`, `src/components/views/settings/DeploysSection.tsx`
- Serviços: `deployService.ts`, `deploy/runtimeDetector.ts`, `deploy/deployPlan.ts`, `previewActivation.ts`; Store: `deployStore`
- Tauri: `collect_deploy_bundle`, `http_client_send_request`, `read_database`/`query_table`
- Worker (control-plane `api-agents.toquemedia.net`): `/v1/projects/deploy/{init,upload,finalize,cleanup,container/*}`

### Git
- `src/components/views/SourceControlPanel.tsx`; Serviços: `gitService.ts`, `gitStatusPoller.ts`; Store: `gitStatusStore`
- Tauri (`git.rs`): `git_status_files`, `git_stage_file/all`, `git_unstage_file/all`, `git_discard_file/all`, `git_commit`, `git_current_branch`, `git_upstream_divergence`, `git_push`, `git_pull`, `git_clone_repository`, `git_show_file`, `git_diff_lines`
- Mensagem de commit IA: chama AI data-plane (`/v1/chat/completions`) via `resolveAIWorkerUrl()`

### Billing / Settings / Models / Auth / MCP
- `src/components/ui/CreditIndicator.tsx`, `src/components/views/SettingsView.tsx`, `src/components/views/settings/ApiKeysSection.tsx`, `src/components/auth/LoginScreen.tsx`
- Stores: `billingStore`, `tmSpeedStore`, `promotionsStore`, `featuresStore`, `byokStore`, `authStore`, `settingsStore`
- Serviços: `auth/firebaseAuth.ts`, `agent/modelProfiles.ts`, `mcp/mcpService.ts`, `mcp/remoteTransport.ts`; Store: `mcpStore`; Tauri: `mcp.rs`
- Worker control-plane: `/v1/me` (billing), `/v1/appcheck-token`, `/v1/byok/providers`

### Tema / i18n
- `src/theme/tokens.ts` (single source of truth de cores/fontes/gradientes), `src/i18n/translations.ts` (EN + PT-PT)

---

## Telas Reais Recomendadas

> Para o vídeo geral, priorizar telas que "vendem" o paradigma chat-first e o ciclo completo idea→live.

| # | Tela | Componente | O que mostra | Importância comercial | Texto real visível | Animação Remotion sugerida |
|---|---|---|---|---|---|---|
| 1 | **Welcome / Dois Modos** | `WelcomeHero.tsx` | Cartões Chat Mode (rosa "RECOMMENDED") e Terminal Mode (roxo "POWER USERS") | Posicionamento: guiado vs. liberdade | "Welcome to TM Code", "From zero to live — the agent plans, writes code, and deploys for you." | Stagger fade-up dos cartões, glow rosa/roxo pulsante |
| 2 | **Projetos Recentes** | `WelcomeSidebar.tsx` | Lista Terminal/IDE com timestamps | Continuidade, uso real | "RECENT", "Terminal", "IDE" | Slide-in da sidebar, hover "Open in IDE" |
| 3 | **Chat Mode em ação** | `ChatView.tsx` + `MessageBubble.tsx` | Prompt → thinking → tool calls → texto | Coração do produto | "Ask anything... (/ commands, @ files, # opt-ins)" | Typing no prompt, shimmer no reasoning, reveal de tool calls |
| 4 | **Reasoning / Thinking** | `ReasoningBlock.tsx` | Bloco "A pensar" com shimmer e duração | "Vê o agente a pensar" | "Thinking" / "A pensar · 2.3s" | Shimmer header + expand on done |
| 5 | **Tool calls / leitura** | `ToolCallDisplay.tsx` | "Reading", "Editing", "Running" + ficheiros | Mostra o agente a trabalhar | "Reading output", "Running npm test" | Cascade de linhas, ícones ✓ verde |
| 6 | **Diff inline** | `StructuredDiff`/`TerminalStructuredDiff.tsx` | -/+ linhas, aprovar/rejeitar | Controlo do utilizador | "✓ Approve · ⊘ Reject" | Zoom à hunk, highlight box, clique Approve |
| 7 | **Permission Prompt** | `PermissionDialog`/`TerminalPermissionPrompt.tsx` | Comando destrutivo / ficheiro sensível | Confiança & segurança | "Authorization needed", "destructive command" | Modal entra, tecla `d`/Deny |
| 8 | **Preview ao vivo** | `PreviewView.tsx` | Webview a renderizar a app + screenshot→chat | "Vê a tua app a correr" | "Screenshot the visible preview and attach to chat" | Split chat|preview, refresh ao aplicar diff |
| 9 | **Source Control + commit IA** | `SourceControlPanel.tsx` | Staging + botão sparkle a gerar commit | Velocidade da equipa | "Commit message (⌘+Enter)", "Pull & Push" | Sparkle → texto a "escrever" sozinho |
| 10 | **Publish / Deploy** | `PublishModal.tsx` | Build→upload→finalize + URL ao vivo | Idea→live, founders | "Publish project", "Make your project live with a one-click deploy.", "Live!" | Barra de progresso por fase, reveal do URL + "Copied!" |
| 11 | **Settings → Deploys** | `DeploysSection.tsx` | Lista Live/Offline, domínio próprio | Power/agências | "Live", "Take offline", "app.yourdomain.com" | Pan pela lista, badge de estado |
| 12 | **Terminal Mode greeting** | `TerminalGreeting.tsx` | Banner ASCII "TM CODE" + branch | Estética terminal | "Welcome to Terminal Mode", "tip: type / to browse all commands" | Banner a desenhar-se linha a linha |
| 13 | **Status line** | `TerminalStatusLine.tsx` | ctx %, modelo, MCP, dev server, stop | Sofisticação técnica | "ctx 4,250/4,096 (104%)", "auto-compact next turn" | Highlight sequencial de cada segmento |
| 14 | **CreditIndicator / Planos** | `CreditIndicator.tsx` | Pill de consumo + dropdown | Billing/upgrade | "Free", "Vibe", "Pro", "Max", "Upgrade" | Barra a encher, cor verde→laranja |
| 15 | **MCP / Settings** | Settings → MCP | Servidores + tools | Extensibilidade enterprise | "MCP Servers", "2 server(s) running" | Toggle de servidor, contagem de tools sobe |
| 16 | **Onboarding Tools** | `ToolsStep.tsx` | Deteção Python/Node/Git + install | Frictionless para iniciantes | "Required Developer Tools", "Detected on your system" | Checks a ficarem verdes um a um |
| 17 | **Goal Celebration** | `GoalCelebration.tsx` | Confetti + "GOOAAL!" | Momento emocional/memorável | "GOOAAL!" | Burst de confetti físico (opcional/sazonal) |

---

## Jornadas de Uso para o Vídeo

> 8 mini-histórias (uma por público), cada uma com público → problema → ação → feature → resultado → texto curto.

1. **Founder cria uma landing page**
   - Problema: tem uma ideia, não tem tempo nem DevOps.
   - Ação: New Project → "Cria uma landing para o meu SaaS com waitlist" → Approve plan → preview → Publish.
   - Feature: Chat Mode + Preview + PublishModal.
   - Resultado: site ao vivo em `*.toquemedia.net`.
   - Texto no vídeo: **"Da ideia ao link. Numa tarde."**

2. **Dev corrige um bug com o agente**
   - Problema: erro em produção, não sabe onde está.
   - Ação: `/debug "users can't logout"` → agente investiga, lê ficheiros, propõe diff.
   - Feature: `/debug` + reasoning + diff inline.
   - Resultado: fix aprovado e aplicado.
   - Texto: **"Descreve o sintoma. O agente encontra a causa."**

3. **Vibe coder cria uma app com stack guiada**
   - Problema: quer construir mas não domina o setup.
   - Ação: Chat Mode → `#auth-google` → "adiciona dashboard".
   - Feature: hashtags + stack curada.
   - Resultado: app funcional com login.
   - Texto: **"Programa pela conversa."**

4. **Equipa faz refactor com diffs controlados**
   - Problema: mudança grande, risco de partir tudo.
   - Ação: `/plan` → aprovar → agente aplica → cada diff revisto → `/review`.
   - Feature: PlanApprovalCard + diffs + `/review`.
   - Resultado: refactor seguro, revisto.
   - Texto: **"Aprovas cada mudança. Linha a linha."**

5. **Deploy com domínio personalizado**
   - Problema: precisa do site no domínio da marca.
   - Ação: Publish → Settings → Deploys → adiciona `app.minhamarca.com`.
   - Feature: PublishModal + custom domain (DNS/SSL).
   - Resultado: domínio próprio com SSL.
   - Texto: **"O teu domínio. Um clique. SSL incluído."**

6. **Dev corre testes em Terminal Mode**
   - Problema: validar antes de entregar.
   - Ação: Terminal Mode → "corre os testes" → `execute_command npm test` → output ao vivo.
   - Feature: Terminal Mode + PTY + tool calls.
   - Resultado: ✓ testes a passar.
   - Texto: **"Terminal agêntico. Liberdade total."**

7. **Validar UI com preview**
   - Problema: ver a UI real, não código.
   - Ação: agente altera componente → preview atualiza → screenshot→chat para feedback.
   - Feature: PreviewView + screenshot to chat.
   - Resultado: iteração visual rápida.
   - Texto: **"Vê. Ajusta. Repete."**

8. **Aprovar comandos sensíveis (segurança)**
   - Problema: medo de o agente fazer algo destrutivo.
   - Ação: agente tenta `rm -rf` / ler `.env` → prompt de permissão → "Deny with reason".
   - Feature: Permission system.
   - Resultado: controlo total e auditável.
   - Texto: **"Nada acontece sem a tua autorização."**

---

## Copywriting Recomendado

> Português como idioma principal. Frases curtas, vendáveis, legíveis em vídeo. (Versões reais EN entre parêntesis quando úteis.)

### Headline principal
- **"A IDE onde o agente escreve o código por ti."** *(real: "The IDE where the agent writes code for you.")*
- Alt: **"Conversa. Vê programar. Publica."** *(real: "Chat with AI. Watch it code. Ship faster.")*

### Subtítulos
- "Chat-first. Não sidebar-first."
- "Tu conduzes. O agente constrói." *(real: "The developer drives. The agent builds.")*
- "Da ideia ao live, sem sair da conversa."

### Mensagens por cena (genéricas)
- "Descreve o que queres."
- "O agente planeia."
- "Lê o teu código. Escreve. Mostra o diff."
- "Aprovas cada mudança."
- "Preview ao vivo. Na mesma janela."
- "Publica num clique."

### CTAs
- **"Descarrega o TM Code"** / "Get TM Code"
- "Grátis para começar."
- "code.toquemedia.net"

### Para devs
- "Terminal agêntico. Qualquer stack, qualquer tarefa."
- "Monaco, git, PTY nativo, MCP — tudo numa janela."
- "Vê o agente a pensar. Aprova linha a linha."

### Para vibe coders
- "Não sabes o comando? Diz por palavras."
- "`#auth-google`. E está feito."
- "Constrói a falar."

### Para founders
- "Do protótipo ao produção numa tarde."
- "Deploy num clique. Domínio próprio. SSL incluído."
- "Sem DevOps. Sem fricção."

### Para equipas
- "Commits e code review com IA."
- "Diffs aprovados. Git limpo."
- "Mais entregas, a mesma equipa."

---

## Plano de Vídeo Geral

> **60 segundos** (1800 frames @ 30fps), 1920×1080. Arco: o que é → para quem → features → fluxo real → diferencial → resultado → CTA. Reaproveitar componentes de `remotion-video/src/components/`.

| Cena | Duração | Visual | Texto | Feature/Tela real | Movimento/zoom | Objetivo comercial |
|---|---|---|---|---|---|---|
| **1. Intro de marca** | 0–4s | Isologo + wordmark "TM Code" em gradiente rosa→roxo sobre #0a0a0a com glow radial | "A IDE onde o agente escreve o código por ti." | `isologo.svg`/`logo.svg`, splash style | Logo entra com spring, glow pulsa | Fixar marca + promessa |
| **2. Dois modos** | 4–10s | Welcome com cartões Chat (rosa) + Terminal (roxo) | "Guiado ou liberdade total. Tu escolhes." | `WelcomeHero.tsx` | Stagger fade-up, hover nos cartões | Posicionar paradigma chat-first |
| **3. O prompt** | 10–16s | Utilizador escreve um pedido no Chat Mode | "Descreve o que queres." | `ChatView` + `PromptBar` | Typing animado, cursor real | Mostrar simplicidade da entrada |
| **4. O agente pensa e age** | 16–26s | Reasoning shimmer → cascata de tool calls (read/edit/run) | "Planeia. Lê. Escreve." | `ReasoningBlock` + `ToolCallDisplay` | Reveal sequencial, ✓ verdes | "Vê o agente a trabalhar" |
| **5. Diff + aprovação** | 26–33s | Diff -/+ com zoom e highlight; clique Approve | "Aprovas cada mudança." | `StructuredDiff` | Zoom à hunk, clique Approve | Controlo & confiança |
| **6. Preview ao vivo** | 33–41s | Split chat|preview; app a renderizar e a atualizar | "Vê a tua app a correr. Na mesma janela." | `PreviewView` + `BrowserWindow` mock | Preview faz refresh ao aplicar | Feedback visual imediato |
| **7. Deploy one-click** | 41–49s | PublishModal: barra de progresso → "Live!" + URL | "Publica num clique." | `PublishModal.tsx` | Progress por fase, reveal do URL + "Copied!" | Idea→live, founders |
| **8. Poder & segurança** | 49–55s | Flash: Terminal Mode (status line, PTY), permission prompt, git commit IA | "Terminal agêntico. Git por IA. Tu autorizas tudo." | `TerminalStatusLine`, `PermissionDialog`, `SourceControlPanel` | Cortes rápidos com highlight | Cobrir devs/equipas/enterprise |
| **9. Branding + CTA** | 55–60s | Pull-back para logo + CTA | "TM Code. Descarrega já." · "code.toquemedia.net" | `FinalBranding.tsx` | Zoom-out, fade-to-black | Conversão |

> Música: reutilizar/regerar via `scripts/generate-music.mjs` (MiniMax) ou nova faixa; aplicar fades no Remotion (`<Audio>`).

---

## Assets Necessários

> Caminhos exatos. Os assets de marca já foram copiados para o projeto Remotion existente.

### Logos / marca
- `public/logo.svg` — wordmark completo "TM Code" (vetorial; cores `#900A6A #C10A69 #FE1063 #FF2D5A #FF624C` + branco; viewBox grande, 297×60mm)
- `public/isologo.svg` — isologo (ícone, 50×60mm)
- `src-tauri/icons/128x128@2x.png` — ícone da app (usado no README)
- Já em Remotion: `remotion-video/public/assets/{logo.svg, isologo.svg, icon.png, 128x128@2x.png}`

### Screenshots de referência (na raiz e em Remotion)
- Raiz: `ide.png`, `ide2.png`, `tm.png`, `tm2.png`, `tm3.png`, `tm4.png`, `br.png`
- Remotion: `remotion-video/public/assets/reference/{ide.png, ide2.png, tm.png, tm2.png, tm3.png, tm4.png, br.png}`
- ⚠️ Usar como **referência visual** para recriar UI fiel em React/CSS — não inserir screenshots crus (estética inconsistente).

### Áudio
- `remotion-video/public/assets/audio/tmcode-promo-track-raw.mp3` (faixa atual, 2m02s — cortar/fade no Remotion)
- Regerar: `remotion-video/scripts/generate-music.mjs` (MiniMax Music API)

### Ícones de ficheiros (file tree)
- `src/assets/icons/*.svg` (centenas de ícones por linguagem/framework — react, vue, python, rust, docker, etc.) — úteis para recriar o file explorer.

### Cores (de `src/theme/tokens.ts` — usar SEMPRE estas)
- **Fundo:** `#0a0a0a` (app), `#0f0f0f` (sidebar), `#111111` (painéis/code)
- **Accent primário (rosa/magenta):** `#FE1063` (escuro `#C10A69`)
- **Roxo (Terminal/power):** `#a371f7` (escuro `#8250df`)
- **Verde:** `#2ea043`/`#56d364` · **Laranja:** `#f77f00`/`#fb8500` · **Vermelho:** `#f85149`
- **Texto:** primário `#e6edf3`, secundário `#8b949e`
- **Gradientes-chave:**
  - `logoTitle`: `linear-gradient(135deg, #FE1063 0%, #a371f7 100%)`
  - `heroTitle`: `linear-gradient(135deg, #e6edf3 0%, #FE1063 50%, #a371f7 100%)`
  - `accentPrimary`: `linear-gradient(135deg, #FE1063 0%, #C10A69 100%)`
  - `welcomeBg`: radial rosa no topo + roxo em baixo sobre `#0a0a0a`
- **Diff:** added `#7ee787` / removed `#ffa198`
- **Terminal ANSI:** ver `tokens.colors.terminal.*` (cyan rail `rgba(17,168,205,0.28)`, userText `#f2ecff`)

### Fontes
- **UI:** `-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif`
- **Mono:** `SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace`

### Já reutilizável em Remotion (`remotion-video/src/`)
- `tokens.ts` (paleta fiel), `components/` (TMCodeTerminal, TerminalGreeting, ToolCallRow, StructuredDiff, StatusLine, ThinkingDots, MacWindowFrame, BrowserWindow, AnimatedCursor, ZoomFocus, HighlightBox, Toast, ConfirmModal, FinalBranding, StatusBadge, UserPrompt, AgentMessage), `scenes/`, `data/`.

---

## Diferenciais Competitivos

| vs. | TM Code |
|---|---|
| **IDE tradicional (VS Code)** | Chat-first: o agente é a interface, não um plugin lateral. Inclui deploy, preview, data e HTTP client nativos. |
| **Cursor** | Não é editor-com-chat: é **chat-com-tudo**. Dois modos (guiado/terminal), deploy one-click integrado, billing por tokens com planos próprios, PT-first. |
| **Claude Code (CLI)** | App de desktop com **UI visual rica**: diffs cinematográficos, preview webview, painel git, data viewer — não só terminal. Mantém Terminal Mode para quem quer CLI. |
| **Qoder / outras IDEs IA** | Ciclo completo **idea→live** (preview + deploy + domínio próprio). Foco lusófono (PT/EN) e pagamentos locais (MoMenu: MCX, E-kwanza, Referência). BYOK + MCP. |

**Pontos únicos a martelar:** (1) o paradigma chat-first explícito; (2) deploy one-click com domínio; (3) controlo visível (diffs + permissões); (4) "Powered by MiMo" 1M de contexto; (5) bilingue PT/EN e mercado lusófono.

---

## Limitações e Riscos

### Discrepâncias a resolver ANTES de gravar copy
- **Nomes de planos divergem:** código in-app (`Free/Vibe/Pro/Max`) vs. README marketing (`Free/Pro/Business`). **Decidir uma narrativa única** antes de mostrar pricing. Recomendação: para um vídeo geral, evitar tabela de preços detalhada (preços ainda "Coming soon") — mostrar só "Grátis para começar".
- **Nome do produto:** garantir "TM Code" em todo o lado (a pasta é `exodus-ide`, codinome interno).

### Features que existem mas é melhor NÃO mostrar (complexas/confusas para público geral)
- BYOK / catálogo de providers, routing multi-modelo (white-labeling — a app esconde o modelo de propósito).
- `/compact`, gestão de contexto, memória do agente, sub-agents (`delegate`/`collect_results`).
- Sandbox, `agent_shell_*`, HTTP client / Data Viewer avançados (para público técnico, não geral).
- Status line detalhada (impressiona devs; confunde leigos — mostrar de relance).

### Features potencialmente incompletas / a verificar em runtime
- **Debugger** (`components/debugger/*`): estrutura presente, fluxo DAP não confirmado em runtime — **mostrar com cuidado ou omitir**.
- **TM Speed** (`/speed`): pode estar `enabled` mas não `applied` se o modelo não estiver publicado.
- Container build (composite deploy): pode demorar (timeout 5 min) — no vídeo, mostrar versão "static/SPA" rápida.
- `/te2e` é Pro/Max e exige Chromium — já coberto pelo vídeo existente; não repetir como herói no geral.

### O que deve ser mock / cinematic UI vs. fiel
- **Recriar fiel em React/CSS** (não screenshots): terminal, chat, diffs, status line, prompt — como já faz o `remotion-video` existente.
- **Mock cinematográfico** (app demo com accent **azul**, para não competir com o rosa da marca): a app que o agente constrói no preview (seguir o padrão "Katondo Queue" já usado).
- **Fiel aos textos reais:** usar strings de `src/i18n/translations.ts` e dos componentes (este relatório cita as principais).
- **Goal Celebration:** só se o vídeo for sazonal (Mundial 2026); caso contrário, omitir.

---

## Checklist para Criar o Prompt Remotion Final

- [ ] **Nome & marca:** "TM Code"; logo `logo.svg`/`isologo.svg`; gradiente `#FE1063→#a371f7`; fundo `#0a0a0a`.
- [ ] **Tokens:** importar de `remotion-video/src/tokens.ts` (fiel a `src/theme/tokens.ts`). App demo em accent **azul**.
- [ ] **Reaproveitar componentes:** `TMCodeTerminal`, `TerminalGreeting`, `ToolCallRow`, `StructuredDiff`, `StatusLine`, `ThinkingDots`, `MacWindowFrame`, `BrowserWindow`, `AnimatedCursor`, `ZoomFocus`, `HighlightBox`, `FinalBranding`.
- [ ] **Criar componentes em falta** para o vídeo geral: `ChatMessageBubble`, `WelcomeHeroMock` (dois cartões), `PublishModalMock` (barra de progresso + URL), `SourceControlMock` (commit IA), `PreviewSplitMock`, `CreditPillMock`.
- [ ] **Estrutura de cenas (9):** Intro → Dois Modos → Prompt → Agente pensa/age → Diff+Approve → Preview → Deploy → Poder&Segurança → CTA. Definir `SCENES`/`SceneTiming` para ~1800 frames (60s).
- [ ] **Guião de dados:** `agentScript` (conversa real), `diffData` (um diff curto e legível), `mockApp` (app demo azul), `publishSteps`.
- [ ] **Textos:** PT principal (ver secção Copywriting); usar strings reais onde possível. Headline: "A IDE onde o agente escreve o código por ti."
- [ ] **Motion:** frame-driven (`useCurrentFrame` + `interpolate`/`spring`), `interpolate` com clamp; sem CSS transitions, sem `Math.random()`/`Date.now()`.
- [ ] **Áudio:** reutilizar/regerar faixa; fades no `<Audio>` alinhados com fade-to-black final.
- [ ] **Render:** 1920×1080 @ 30fps, h264; `yarn dev` (studio) / `yarn render`.
- [ ] **QA:** stills nos pontos-chave (intro, diff, preview, deploy, CTA); validar legibilidade de texto em movimento.
- [ ] **Decisões pendentes:** confirmar narrativa de planos/preços; decidir se inclui Goal Celebration; decidir duração final (45–75s).

---

*Fim do relatório. Nenhum ficheiro de produto foi alterado; nenhum código Remotion foi criado.*
