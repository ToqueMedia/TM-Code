# TM Code — Documentação

> Esta documentação cobre tudo o que precisas para usar o TM Code, do primeiro arranque às utilizações avançadas. Não assume conhecimento prévio do produto.

---

## Índice

1. [O que é o TM Code](#1-o-que-é-o-tm-code)
2. [Instalação e requisitos](#2-instalação-e-requisitos)
3. [Primeiros passos](#3-primeiros-passos)
4. [Conceitos fundamentais](#4-conceitos-fundamentais)
5. [O ecrã principal](#5-o-ecrã-principal)
6. [Conversar com o agente](#6-conversar-com-o-agente)
7. [Comandos do agente (slash commands)](#7-comandos-do-agente-slash-commands)
8. [Capacidades do agente (tools)](#8-capacidades-do-agente-tools)
9. [Skills e hashtags](#9-skills-e-hashtags)
10. [Permissões e segurança](#10-permissões-e-segurança)
11. [Checkpoints e desfazer](#11-checkpoints-e-desfazer)
12. [Editor manual](#12-editor-manual)
13. [Preview e dev server](#13-preview-e-dev-server)
14. [HTTP Client](#14-http-client)
15. [Source control (Git)](#15-source-control-git)
16. [Debugger](#16-debugger)
17. [Terminal integrado](#17-terminal-integrado)
18. [CMD mode](#18-cmd-mode)
19. [MCP — extensões do agente](#19-mcp--extensões-do-agente)
20. [Settings](#20-settings)
21. [Planos e créditos](#21-planos-e-créditos)
22. [Publicar (deploy)](#22-publicar-deploy)
23. [Atalhos de teclado](#23-atalhos-de-teclado)
24. [Boas práticas](#24-boas-práticas)
25. [Resolução de problemas](#25-resolução-de-problemas)
26. [Glossário](#26-glossário)

---

## 1. O que é o TM Code

O TM Code é um **IDE Agent-First** — um ambiente de desenvolvimento onde a forma natural de trabalhar é **conversar com um agente de IA** que escreve código por ti, mostra-te o que mudou em tempo real, e abre uma pré-visualização da app à medida que vai construindo.

### Como é diferente do VS Code ou do Cursor

Editores tradicionais colocam o código no centro e a IA numa barra lateral. O TM Code inverte: a **conversa** é o centro, o código é o resultado. Quando abres um projecto:

- O ecrã principal mostra **o chat com o agente**
- À direita, podes ver **o preview da app a correr** ao mesmo tempo
- O **editor de código** está disponível como modo secundário, para quando quiseres mexer manualmente
- Tudo acontece num só ecrã: pedes, o agente edita, vês o resultado

Isto reduz o "context switching" (saltar entre browser, editor, terminal). Se preferes editar manualmente, o editor Monaco está a uma tecla de distância — mas a forma natural é descrever o que queres.

### Para quem é

- Programadores que preferem iterar por linguagem natural em vez de escrever boilerplate
- Equipas que querem prototipar rápido sem montar todo o ambiente manualmente
- Designers e product owners que querem mexer no produto sem dependerem 100% de um dev

### Tecnologias por baixo

- **Tauri 2** (Rust) — motor nativo, leve, seguro
- **React 19 + TypeScript** — interface
- **Monaco Editor** — o mesmo editor do VS Code para o modo manual
- **xterm.js** — terminal integrado
- **Modelos de IA** geridos no backend (DashScope, Anthropic) consoante o teu plano

---

## 2. Instalação e requisitos

### Plataformas suportadas

- **macOS** 10.15+ (universal: Intel + Apple Silicon)
- **Windows** 10/11 (x64)
- **Linux** (Ubuntu 20.04+, Fedora 36+, distribuições baseadas em Debian/RHEL)

### Pré-requisitos no teu sistema

O TM Code verifica estas ferramentas no arranque:

| Ferramenta | Versão mínima | Estado |
|---|---|---|
| **Node.js** | 20.0.0 | Obrigatório |
| **Python 3** | 3.8.0 | Obrigatório |
| **Git** | 2.0.0 | Recomendado |

Adicionalmente, são detectadas (não obrigatórias):
- `pandoc` — para gerar PDFs/DOCX a partir de markdown
- `npx` — para correr ferramentas one-shot
- `venv` — para skills com Python

Se algo estiver em falta ou desactualizado, o TM Code mostra um diálogo com links de instalação.

### Onde os dados são guardados

- **Configurações globais**: `~/.config/toquemedia-studio/settings.json`
- **Metadados de projectos**: `~/.config/toquemedia-studio/projects/`
- **Sessões de chat**: `~/.toquemedia-studio/sessions/{projectHash}/`
- **Browser profile** (para `/te2e`): `~/.toquemedia-studio/browser-profile/`

> Os identificadores internos usam ainda o nome antigo `toquemedia-studio` por compatibilidade. O nome visível em todo o lado é "TM Code".

---

## 3. Primeiros passos

### Autenticação

Ao abrires o TM Code pela primeira vez vês o ecrã de login. Podes entrar com:

- **Email + password**
- **Google**

Após o registo, é-te enviado um email de verificação (em português). Tens de verificar antes de criar projectos.

### Criar o teu primeiro projecto

1. Clica em **"Novo projecto"** no Welcome Screen
2. Escolhe um **template** (lista completa abaixo)
3. Escolhe a **pasta** onde o projecto vai viver
4. Define um **nome**
5. O TM Code:
   - Copia o template para a pasta
   - Inicializa Git (se disponível)
   - Cria `.prettierrc`, `.gitignore` e o ficheiro de identificação `.toquemedia-id`
   - Instala dependências (`npm install`)
   - Arranca o dev server
   - Abre a vista de chat com o preview ao lado

### Templates disponíveis

**Frontend (7):**
- `react-ts-vite` — React 19 + Vite + TypeScript
- `nextjs-ts` — Next.js + TypeScript
- `vue-ts-vite` — Vue 3 + Vite + TypeScript
- `nuxt-ts` — Nuxt 3 + TypeScript
- `svelte-ts-vite` — Svelte + Vite + TypeScript
- `astro` — Astro + TypeScript
- `angular-ts` — Angular + TypeScript

**Backend (3):**
- `express-ts` — Express + TypeScript + SQLite
- `fastify-ts` — Fastify + TypeScript
- `nestjs-ts` — NestJS + TypeScript

**Fullstack (1):**
- `react-express-ts` — Vite (frontend) + Express (backend) + auth via GIP

Cada template declara as suas próprias dependências adicionais. O TM Code valida-as antes de fazer scaffold.

### Abrir um projecto existente

1. Welcome Screen → **"Abrir projecto"**
2. Selecciona a pasta
3. Se houver `.toquemedia-id` o TM Code reconhece-o como projecto seu; caso contrário, importa (cria o id).

Os teus projectos recentes ficam guardados — basta clicar para reabrir.

---

## 4. Conceitos fundamentais

### Vistas (view modes)

O TM Code tem **5 vistas** principais. Mudas entre elas pela activity bar (esquerda) ou por atalhos:

| Vista | O que vês | Quando usar |
|---|---|---|
| **Chat** | Conversa com o agente | Pedidos, iteração, debugging |
| **Generating** | Streaming live do agente a trabalhar (raciocínio + ferramentas + diffs) | Acompanhar o que o agente está a fazer agora |
| **Preview** | A tua app a correr (iframe ou HTTP Client) | Verificar o resultado |
| **Editor** | Monaco editor com tabs e splits | Edição manual |
| **Settings** | Configurações | Ajustar o IDE, gerir plano |

A vista **Chat** é a default — sempre que abres um projecto, é onde aterras.

### Tipos de projecto (project kind)

O dev server detecta automaticamente o tipo do teu projecto:

- **`frontend`** → app web pura (React, Vue, etc.). Preview = iframe.
- **`backend`** → API sem UI. Preview = HTTP Client (Postman embutido).
- **`fullstack`** → ambos. Preview = iframe + drawer com HTTP Client (toggle Cmd/Ctrl+Shift+H).
- **`static`** → ficheiro HTML standalone. Preview = iframe inline.

### O agente

O "agente" é o modelo de IA que:
- Lê o teu código
- Executa comandos
- Edita ficheiros
- Pede permissão antes de acções sensíveis
- Mostra diffs inline para tu aprovares
- Acompanha o seu próprio progresso com checkpoints e task lists

Não é um chatbot que sugere — é um colaborador que age. Quando lhe pedes "adiciona login com Google", ele vai ler o teu código, decidir onde inserir, escrever as alterações, mostrar-te os diffs, e correr o dev server para tu validares.

---

## 5. O ecrã principal

```
┌─ Title bar ────────────────────────────────────────────────┐
│  [⌘TM Code] | nome-do-projecto | [Publish] [⚙]            │
├──┬───────────┬────────────────────────────┬───────────────┤
│  │           │                            │               │
│  │  Sidebar  │        Main content        │   Chat /      │
│ A│  (file    │  (Editor / Preview /       │   Preview     │
│ c│   tree,   │   Settings)                │   sidebar     │
│ t│   search, │                            │               │
│ i│   git,    │                            │               │
│ v│   debug)  │                            │               │
│ B│           │                            │               │
│ a│           │                            │               │
│ r│           │                            │               │
│  ├───────────┴────────────────────────────┴───────────────┤
│  │  Terminal / dev server logs (toggleable)               │
├──┴────────────────────────────────────────────────────────┤
│  Status bar: linguagem | linha:col | tokens | thinking | MCP│
└────────────────────────────────────────────────────────────┘
```

### Activity bar (esquerda)

- **Explorer** — file tree do projecto
- **Search** — pesquisa global no projecto
- **Source Control** — Git (staging, commit, diff)
- **Run/Debug** — debugger DAP (breakpoints, call stack, variáveis)
- **Containers** — ambientes isolados (Docker)
- **Settings** — configurações

### Sidebar redimensionável

Arrastas o handle entre a sidebar e o conteúdo principal para ajustar (mínimo 200px, máximo 600px). Toggle on/off com `Cmd/Ctrl+B`.

### Title bar

A barra do topo tem:
- **Logo TM Code** — clicar abre o menu da app
- **Nome do projecto** — abre o switcher de projectos
- **Publish** — abre o modal de deploy
- **Status do agente** — pulse quando está a trabalhar
- **Avatar** — perfil do user / logout

### Status bar (em baixo)

Mostra (consoante a vista):
- Linguagem do ficheiro activo (TypeScript, JSON, etc.)
- Posição do cursor (linha:coluna)
- **Indicador de créditos** — % do plano consumida
- **Toggle de "thinking"** — quando o modelo suporta (paid plans)
- **Estado do MCP** — quantos servers a correr, quantas tools
- Indicador de toolkit (pandoc, etc.) — verde/âmbar
- Skills carregadas

---

## 6. Conversar com o agente

A barra de prompt (PromptBar) é onde compões a tua mensagem. Suporta:

### Texto natural

```
adiciona um botão "Continuar" no fim do formulário de signup
```

### Anexos por drag-and-drop

Arrasta para a PromptBar:
- **Ficheiros de texto** — incluídos inline no contexto (até 20K chars)
- **Pastas** — referenciadas; o agente abre os ficheiros à medida que precisar
- **Imagens** — usadas como mockups (apenas em planos pagos; backend processa via Qwen 3.6 Plus)

### Mentions com `@`

Refere ficheiros específicos por nome:

```
@LoginScreen.tsx adiciona "esqueci-me da password"
```

O autocomplete mostra ficheiros relevantes à medida que escreves.

### Hashtags com `#`

Carrega skills predefinidos:

```
#auth-google adiciona sign-in com Google ao /login
```

Hashtags conhecidos:
- `#auth-email-password` — recipe de auth com email + password (usa GIP proxy)
- `#auth-google` — recipe de Google Sign-In
- `#design` — força o skill `frontend-design` (UIs polidas)

Hashtags desconhecidos passam como texto normal — útil para refs como `#bug-1234`.

### Modelo do agente

O modelo é decidido pelo **plano** — tu não escolhes:

- **Explorer** (free) — DeepSeek V4-Flash
- **Vibe / Pro / Max** — GLM-5.1

Imagens em mensagens são pré-processadas por Qwen 3.6 Plus no backend (planos pagos).

### Reasoning (raciocínio)

Alguns modelos suportam "thinking mode" — o modelo escreve um bloco de raciocínio antes de responder. Activas/desactivas no toggle do status bar (apenas planos pagos). Os comandos `/plan`, `/debug` e `/te2e` forçam reasoning ON automaticamente.

### Fluxo de uma mensagem

1. **Compõe** o prompt
2. **Envia** (Enter, ou Cmd/Ctrl+Enter se quiseres newline normal)
3. Se o agente está ocupado, a mensagem **fica em queue** com badge "queued" — visível tanto no chat como acima do textarea
4. Quando o turno termina, o agente processa a tua mensagem
5. O agente chama tools, mostra diffs, pede permissão quando necessário
6. Vês o resultado streaming em tempo real

### Vista persistente de tarefas

Acima da PromptBar (quando o agente está a usar `update_tasks`) aparece uma lista de tarefas com:
- ✓ verde — completada
- ⟳ rosa (animado) — em curso
- · cinza — pendente

Riscadas à medida que o agente avança. Colapsável.

---

## 7. Comandos do agente (slash commands)

Escreves `/` no início da mensagem para abrir o menu de comandos. Tab/Enter para seleccionar.

| Comando | Descrição | Plano |
|---|---|---|
| `/init` | Analisa o projecto, detecta framework, gera `TMS.md` | Todos |
| `/plan` | Arquitecta uma feature: gera spec + TODO, pede aprovação | Todos |
| `/debug` | Investiga um erro de forma hipótese-driven | Todos |
| `/review` | Code review crítico por sub-agente fresh, ranked por severidade | Todos |
| `/payments` | Integra MoMenu Payments (MCX, E-kwanza, Referência) | Todos |
| `/te2e` | Valida a app fazendo o agente conduzir um browser real | **Pago** |

### `/init <opcional: descrição>`

Mapeia o teu projecto. Lê estrutura, package.json, git history, e gera um `TMS.md` na raiz. O `TMS.md` é a "memória do projecto" — o agente lê-o em cada sessão para saber:

- O stack do projecto
- Convenções (naming, estrutura de pastas)
- Decisões arquitecturais já tomadas
- Patterns específicos da equipa

Corre uma vez por projecto. Quando há mudanças estruturais grandes, podes correr de novo.

### `/plan <descrição da feature>`

Para features não-triviais. O agente:

1. Lê código relevante
2. Propõe uma arquitectura (componentes, ficheiros, fluxo)
3. Apresenta uma **plan card** com a proposta
4. Tu **aprovas / rejeitas / ajustas** antes de qualquer código mexer
5. Após aprovação, gera `PLAN.md` + `TODO.md` na raiz
6. Executa as tarefas uma a uma, atualizando o TODO

Reasoning ON (forçado).

**Quando usar**: features novas, refactors significativos, integrações complexas.

### `/debug <sintoma ou stack trace>`

Para erros. O agente:

1. Lê stack trace
2. Localiza o código relevante
3. Forma 2-3 hipóteses sobre a causa
4. Verifica cada uma (logs, testes pontuais, queries)
5. Propõe o **fix mínimo** sobre a causa verificada
6. Verifica que o fix resolve sem introduzir regressões

Reasoning ON (forçado).

**Quando usar**: erros runtime, comportamento errado, falhas de testes, problemas de produção.

### `/review [scope]`

Code review crítico, **executado por um sub-agente fresh**. O sub-agente não vê o histórico do chat — só o código no disco — para evitar o viés de confirmação típico (o agente que escreveu o código tende a justificar as suas próprias decisões em vez de criticar).

**Scope** (em ordem de prioridade):

| Argumento | Significado |
|---|---|
| `/review` | Ficheiros tocados nesta sessão (via checkpoints) |
| `/review @path/to/file.ts` | Ficheiro específico |
| `/review last commit` | Ficheiros do último commit (`git diff HEAD~1`) |
| `/review login flow` | Free-form: o sub-agente decide o que está em scope |

**O sub-agente:**

1. Lê os ficheiros no scope completos (não skimm)
2. Lê `TMS.md` se existir, para honrar decisões arquitecturais documentadas
3. Para cada finding candidato, **verifica contra o código** antes de reportar (evita falsos positivos)
4. Classifica em uma de quatro severidades:
   - **Crítico** — bugs reais, security holes, data loss, race conditions
   - **Alto** — anti-patterns que vão morder, tech debt grave
   - **Médio** — workarounds frágeis, code smell, separação de responsabilidades
   - **Baixo** — naming, organização, micro-readability
5. Limita o output a **top-10** por severidade; resto fica em sumário agregado
6. Cada finding inclui: localização (`file:line`), porque importa, recomendação one-liner

Reasoning ON forçado em todos os turns (não só o primeiro).

**Read-only:** o `/review` não escreve, edita ou apaga código. Para implementar uma correção, fazes um pedido normal ao agente principal depois de leres o relatório.

**Quando usar:**
- Antes de abrir um PR
- Antes de um deploy
- Após uma feature grande, para apanhar bugs e anti-patterns que escaparam
- Quando suspeitas que há algum workaround acumulado num módulo

**Quando NÃO usar:**
- Logo a seguir a o agente principal acabar de escrever uma feature grande nesta sessão — fazer review do output recente do mesmo agente principal é teatro (mesmo com sub-agente fresh, há overlap de patterns recentes na cabeça do user). Espera um pouco, ou usa para code que não foi escrito agora.

**Custo:** reasoning ON em todos os turns + leitura de muitos ficheiros = consumo elevado de tokens (tipicamente 10-30K). Em planos com cycle apertado (Explorer 1.5M), uma sessão de review pode pesar.

### `/payments`

Integra MoMenu Payments. O agente:

1. Lê os skills de pagamento (MCX, E-kwanza, Referência)
2. Pergunta qual método queres
3. Implementa a integração
4. Adiciona endpoints, componentes UI, e testes manuais

### `/te2e <o que validar>` *(pago)*

Validação adversarial. O agente:

1. **Lê o código** da feature primeiro (sem inventar selectors)
2. **Deriva uma matriz de cenários** do código observado: happy path + edge cases + estados de erro + auth states + persistence + concorrência + autorização
3. **Conduz cada cenário** num browser real (Chrome do sistema)
4. **Reporta bugs** com severidade, repro mínima, e localização (file:line)

Cada acção do browser pede a tua permissão (Sim/Não). Reasoning ON em todos os turns.

**Quando usar**: antes de shipar uma feature; para validar regressões; quando suspeitas que há bugs escondidos.

**Antes da primeira utilização**: o TM Code abre Chrome (visível) — faz login na tua app uma vez, a sessão fica guardada no profile dedicado para sempre.

> O `/te2e` requer Chrome (ou Edge / Brave) instalado. Se nenhum for detectado, o TM Code mostra um diálogo a oferecer o link para instalar.

---

## 8. Capacidades do agente (tools)

O agente tem ferramentas para interagir com o teu projecto. Algumas são automáticas (read-only); outras pedem permissão antes de correr.

### Ficheiros

- `read_file(path)` — lê conteúdo (auto-aprovada para ficheiros não-sensíveis)
- `write_file(path, content)` — escreve novo ficheiro / sobrescreve (mostra diff)
- `edit_file(path, edits)` — edita ranges específicos num ficheiro (mostra diff)
- `create_file(path, content)` — cria ficheiro novo (mostra diff)
- `delete_file(path)` — apaga ficheiro (pede permissão)
- `rename_file(old, new)` — renomeia (pede permissão)
- `list_directory(path)` — lista pasta
- `glob(pattern)` — encontra ficheiros por padrão
- `search_files(query)` — pesquisa de conteúdo em ficheiros (ripgrep)

### Execução

- `execute_command(command, cwd?)` — corre comando shell (pede permissão; comandos perigosos têm prompt extra)
- `start_dev_server(command, projectKind)` — arranca o dev server
- `read_dev_server_logs(since?)` — lê logs do dev server (output + erros runtime do browser)

### Código

- `get_diagnostics(path)` — erros TypeScript no ficheiro
- `format_code(path)` — Prettier
- `update_tasks(tasks)` — atualiza a lista de tarefas visível

### Skills

- `read_skill(name)` — carrega skill completo
- `read_large_result(id)` — lê resultado grande de uma chamada anterior

### Sub-agentes (background research)

- `research(question, maxTurns)` — sub-agente que investiga em paralelo (web + codebase)
- `verify(assertion, maxTurns)` — sub-agente que verifica uma hipótese
- `spawn_background_agent(question)` — sub-agente assíncrono (continua a correr enquanto trabalhas)
- `check_background_agents()` — vê o estado dos sub-agentes activos

### Browser (paid, on-demand via `/te2e`)

- `mcp__browser__browser_navigate` — abre URL
- `mcp__browser__browser_snapshot` — lê accessibility tree (auto-aprovada)
- `mcp__browser__browser_click`, `browser_type`, `browser_press_key` — interage (pede permissão)
- `mcp__browser__browser_console_messages` — lê console errors
- `mcp__browser__browser_network_requests` — lê network log

### Ficheiros bloqueados

`.env`, `.env.*`, e ficheiros com nomes sensíveis (credentials, secrets) são **sempre bloqueados** — o agente nunca os lê nem escreve, mesmo que peças. Em vez disso, sugere criar `.env.example` com placeholders.

---

## 9. Skills e hashtags

Skills são **recipes em markdown** que o agente carrega para resolver problemas com qualidade conhecida. Há três níveis:

- **Bundled** — fornecidos pelo TM Code (auth-email-password, auth-google, frontend-design, etc.)
- **Global** — em `~/.toquemedia-studio/skills/` (a tua biblioteca pessoal)
- **Project-local** — em `.toquemedia/skills/` (específicos do projecto, vão para git)

### Como invocar

Hashtag dentro do prompt:

```
#auth-google
adiciona Google Sign-In ao /login redirecionando para /dashboard depois
```

O TM Code:
1. Detecta `#auth-google`
2. Carrega o skill no contexto
3. Remove a hashtag do texto
4. Envia o prompt limpo + skill ao agente

### Como criar um skill

Cria `.toquemedia/skills/meu-skill.md`:

```markdown
---
name: meu-skill
description: Recipe para X
---

## Quando usar
[Descreve quando este skill é apropriado]

## Recipe
[Passos concretos]

## Code patterns
[Exemplos]
```

O agente vai descobri-lo automaticamente. Para invocar: `#meu-skill` no prompt.

### Recovery pós-compaction

Quando o contexto fica grande, o TM Code comprime mensagens antigas. Skills carregados ficam em cache (até 100K chars) e são re-injectados após compaction — assim o modelo não esquece os patterns que pediste.

---

## 10. Permissões e segurança

### Três níveis de permissão

1. **Auto-aprovadas** — read_file, list_directory, search_files, glob, get_diagnostics, read_dev_server_logs, etc. Não interrompem o fluxo.

2. **Aprovação inline (diff)** — write_file, edit_file, create_file. Vês o diff inline e clicas Yes/No (ou aceitas tudo de uma só vez se ligares "Auto-approve diffs").

3. **Prompt forçado** — comandos perigosos (`rm -rf`, `git push --force`, `chmod`, etc.), ficheiros sensíveis, e acções do browser tool. Sempre pedem permissão, mesmo que tenhas "Approve all" ligado.

### Antigravity-style para browser

No `/te2e`, **cada acção do browser** (navigate, click, type) pede permissão Sim/Não. Não há "approve all" para estes — é decisão tua, acção a acção. Excepção: `browser_snapshot` é auto-aprovada (puramente read-only, equivalente a inspeccionar DOM no DevTools).

### Sandbox

A lista de comandos perigosos é gerível em **Settings → Sandbox**. Podes:
- **Bloquear** completamente (o agente não consegue correr)
- **Sempre pedir** (default)
- Ajustar conforme o teu nível de conforto

### Ficheiros sensíveis

`.env`, `.env.*`, `credentials.json`, `serviceAccountKey.json`, e ficheiros com nomes contendo "secret", "token", "key" — **bloqueados completamente**. O agente nunca os lê, escreve, edita ou apaga. Não há override possível: nem o user a aprovar manualmente, nem `Approve all`, nem nada.

### Como o agente pede credenciais (formulário seguro)

Como o agente não consegue ler o `.env`, foi desenhado um flow específico para quando precisa de **credenciais novas** (API keys, passwords, secrets) que o user tem de fornecer.

#### Tool `request_credentials`

Em vez de pedir "cola aqui a chave da Stripe" no chat (onde ficaria registada para sempre), o agente invoca a tool `request_credentials` que **renderiza um cartão com formulário no chat**.

O cartão tem:
- **Nome do serviço** (ex: "Stripe API")
- **Campos** (um por credencial):
  - `id` — nome da variável de ambiente (ex: `STRIPE_SECRET_KEY`). Validado: tem de match `^[A-Z_][A-Z0-9_]*$`
  - `label` — texto humano (ex: "Secret Key")
  - `type` — `password` (mascarado, default) ou `text`
  - `required` — boolean
  - `helperText` — instrução opcional (ex: "Encontra em Stripe Dashboard → Developers → API keys")

#### O fluxo

```
Agente: invoca request_credentials
   ↓
TM Code: renderiza form no chat com campos password
   ↓
User: preenche os valores (visíveis no form, nunca aparecem na transcript)
   ↓
User: clica "Submit"
   ↓
TM Code: chama write_env_vars (Rust) que grava no .env do projecto
   ↓
Agente: recebe APENAS confirmação "STRIPE_SECRET_KEY: written, STRIPE_PUBLISHABLE_KEY: written"
   ↓
Agente: continua a tarefa (referencia process.env.STRIPE_SECRET_KEY no código)
```

**O agente nunca vê os valores.** Só sabe:
- Que keys foram pedidas
- Confirmação que foram escritas
- Os nomes (não os values)

A transcript do chat **não regista os valores**. Mesmo se exportares a sessão ou enviares um issue report, os secrets ficam onde devem ficar: no `.env` local, fora do git.

#### Ferramentas afins

- **`provision_auth`** — caso especial para auth GIP/Firebase. O TM Code platform gere o tenant Firebase do lado dele; o agente invoca `provision_auth(provider: 'gip')` e o backend cria/devolve o tenant + escreve as credenciais públicas (`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_TENANT_ID`, `GIP_TENANT_ID`, `GCP_PROJECT_ID`) no `.env` do projecto. Service accounts privados (que dariam admin) ficam só no worker do TM Code — o user nunca os tem, o agente nunca os pede.

- **`write_env_vars`** — comando Rust low-level que grava chaves no `.env` (criando o ficheiro se não existir, preservando comentários e ordem das chaves existentes). Não é exposto directamente ao agente; é chamado pelo backend do TM Code via `request_credentials` e `provision_auth`.

#### Como funciona em prática

Quando pedes "adiciona pagamentos com Stripe":

1. Agente analisa o projecto, decide que precisa de duas keys
2. Invoca `request_credentials` com `serviceName: "Stripe"`, `fields: [STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY]`
3. Vês o cartão no chat — preenches as keys (geralmente copy-paste do dashboard do Stripe)
4. Clica em "Submit"
5. As keys são escritas em `.env`
6. O agente continua a implementar Stripe, referenciando `process.env.STRIPE_SECRET_KEY` no código que escreve

Em momento nenhum os valores aparecem em texto livre, no histórico do chat, ou são enviados ao modelo.

---

## 11. Checkpoints e desfazer

**Cada acção que escreve ou apaga ficheiros** dispara um checkpoint automático. Ficam guardados em `~/.toquemedia-studio/sessions/{projecto}/checkpoints/`.

### Como reverter

No chat, ao lado de cada chamada de tool, há um botão "Undo". Clicas e reverte:

- Restaura o conteúdo anterior
- Recria ficheiros apagados
- Apaga ficheiros criados
- Renomeia de volta

Granularidade: por **chamada de tool**, não por mensagem. Se uma mensagem do agente fez 5 edits, podes reverter individualmente cada um.

### Painel de checkpoints

`Cmd/Ctrl+Shift+H` (ou ícone na sidebar) abre o painel com todos os checkpoints da sessão. Vês um diff cumulativo do que mudou, podes reverter a um ponto qualquer.

### Limites

- Máximo 100 checkpoints por sessão
- Persistência debounced (500ms)
- Não fazem backup de `.env`, `node_modules`, ficheiros >5MB

---

## 12. Editor manual

Mesmo sendo agent-first, o editor manual está sempre acessível. Cmd/Ctrl+Shift+E abre a vista de editor.

### Funcionalidades

- **Tabs** — múltiplos ficheiros abertos, drag-and-drop para reordenar
- **Splits** — Cmd/Ctrl+\ para split vertical
- **Monaco** — o mesmo motor do VS Code, com syntax highlight para 50+ linguagens
- **Minimap** — navegação visual à direita
- **Breadcrumbs** — mostra o path do ficheiro + estrutura

### Autocomplete inteligente (Ollama FIM)

Se tiveres **Ollama** instalado localmente com `qwen2.5-coder:7b`, o TM Code usa Fill-In-Middle para autocomplete enquanto escreves. Configurável em Settings → Editor → AI Completion.

### Quick Open

`Cmd/Ctrl+P` → fuzzy file search com bias por recência. Ignora `node_modules`, `dist`, `build`, `.venv`, `target`.

### Search & Replace

`Cmd/Ctrl+Shift+F` → pesquisa em todo o projecto (ripgrep). Suporta:
- Regex
- Case-sensitive toggle
- Filtros de inclusão/exclusão (globs)
- Replace global

### Format on save

Ligado por defeito. Usa Prettier (respeita `.prettierrc` do projecto). Suporta JS/TS/JSON/HTML/CSS/Markdown/YAML. Toggle em Settings.

---

## 13. Preview e dev server

### Single-slot

O TM Code corre **um dev server por projecto**. Quando arranca:

1. O agente chama `start_dev_server` com o comando do template (ex: `npm run dev`)
2. O TM Code spawna o processo
3. Lê o output e detecta URLs (http://localhost:5173, etc.)
4. Faz HEAD request a cada URL para classificar:
   - HTML → `frontendUrl` (preview iframe)
   - JSON → `backendUrl` (HTTP Client)
5. A vista de preview activa-se automaticamente

### Toolbar do preview

```
[↻ Reload] [URL]  [✓ tests passing]  [⌘ chat] [⚙ console] [Publish] [Stop]
```

- **↻ Reload** — recarrega o webview
- **URL** — endereço atual; podes copiar
- **Console** — abre painel de logs do dev server (toggle)
- **Publish** — publica para web
- **Stop** — termina o dev server

### Console panel

Mostra:
- stdout / stderr do dev server
- Erros runtime do browser (uncaught exceptions, console.error)
- Filtros por nível (info, warn, error)
- Indicador de erros (ponto vermelho na toolbar)
- Botão para limpar
- Pesquisa

### IPv4/IPv6 no Windows

Para frameworks de frontend conhecidos (Vite, Next, Nuxt, Angular, SvelteKit), o TM Code injecta `--host 0.0.0.0` automaticamente — assim o servidor escuta em ambos `127.0.0.1` (IPv4) e `[::1]` (IPv6), evitando o problema clássico de `localhost` resolver para IPv6 mas o servidor estar só em IPv4.

---

## 14. HTTP Client

Para projectos backend e fullstack, o TM Code embute um cliente HTTP estilo Postman.

### Capacidades

- Request builder: método (GET, POST, PUT, DELETE, PATCH, etc.), URL, headers, body
- Body modes: JSON, form-data, x-www-form-urlencoded, raw text
- Key-value editors com check/uncheck para activar/desactivar entradas
- Editor JSON com pretty-print + syntax highlight
- Response viewer: status, headers, body (JSON formatted ou raw), tempo
- Histórico de requests (por sessão)
- Sem CORS — proxy via Rust backend

### Onde aparece

- **Projecto backend** → ocupa o main area (substitui o iframe)
- **Projecto fullstack** → drawer no fundo, toggle Cmd/Ctrl+Shift+H

---

## 15. Source control (Git)

A vista de Source Control (atalho na activity bar) mostra:

- **Changes** — ficheiros modificados (não staged)
- **Staged Changes** — ficheiros prontos para commit
- **Untracked** — ficheiros novos não rastreados

### Acções

- **Stage / unstage** — clicas no `+` ou `−`
- **Discard** — reverte mudanças locais (pede confirmação)
- **Commit** — escreves a mensagem, clicas Commit
- **Push / Pull** — botões na toolbar
- **Branch switcher** — no status bar (no canto inferior esquerdo)

### Diff inline

Clicas num ficheiro modificado para ver o diff. Por linha:
- Verde `+` — adicionada
- Vermelho `−` — removida
- Cinza — contexto

---

## 16. Debugger

DAP (Debug Adapter Protocol) integrado. Funciona com Node.js, Chrome (via CDP), Python (com `debugpy`).

### Setup

1. Cria `launch.json` em `.toquemedia/` ou `.vscode/`
2. Configura o tipo (`node`, `chrome`, `python`)
3. Define args, cwd, env

### Breakpoints

- Click na gutter (à esquerda do número de linha)
- Conditional breakpoints (right-click → "Add Conditional Breakpoint")
- Logpoints (não param, só fazem log de uma expressão)

### Vista de debug

- **Breakpoints** — lista de todos
- **Call stack** — onde estás na pilha
- **Variables** — locals e closures
- **Watch** — expressões personalizadas
- **Console** — REPL com acesso ao scope actual

Controles: Continue (F5), Step Over (F10), Step Into (F11), Step Out (Shift+F11), Restart, Stop.

---

## 17. Terminal integrado

`Cmd/Ctrl+\`` para mostrar/esconder. Baseado em **xterm.js v6**.

### Múltiplas sessões

Botão `+` na toolbar do terminal para abrir uma nova. Cada uma tem o seu shell independente.

### Shell por defeito

- **macOS**: `zsh`
- **Linux**: `bash`
- **Windows**: PowerShell

Mudas em Settings → Terminal.

### Dev server vs terminal

O dev server **não corre no terminal** — corre num processo separado gerido pelo `devServerManager`. O terminal é para tu correres comandos manuais (git, scripts, queries SQL, etc.).

---

## 18. CMD mode

Modo alternativo, estilo REPL terminal. Para users que preferem uma interface mais densa, sem GUI gráfica.

### Como entrar

A partir da Welcome Screen → "CMD mode". Ou via flag de arranque (em desenvolvimento).

### Diferenças vs Chat mode

- Output em mono-spaced font, no estilo de terminal
- Status line no fundo (parecido com vim status line)
- Lista de tasks renderizada em ASCII no terminal
- Permissões via prompts inline (y/n no terminal)
- Sem PreviewView nem split panes
- Mesmas capacidades do agente

Útil para SSH, ambientes restritos, ou simplesmente preferência pessoal.

---

## 19. MCP — extensões do agente

**MCP** (Model Context Protocol) é o standard para expor ferramentas a agentes IA. O TM Code suporta MCP servers locais (stdio) e remotos (HTTP).

### Configurar

Cria `~/.config/toquemedia-studio/mcp.json` (global) ou `.toquemedia/mcp.json` (project-local):

```json
{
  "mcpServers": {
    "github": {
      "command": "node",
      "args": ["/caminho/para/github-mcp-server.js"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    },
    "shopify": {
      "url": "https://shopify-mcp.example.com",
      "transport": "remote"
    }
  }
}
```

### Como o agente vê

Após o servidor arrancar, as tools aparecem com o prefixo `mcp__<servername>__<tool>`. O agente pode chamá-las como tools normais. Permissão por tool: read-only auto-aprovadas; resto pede prompt.

### Browser MCP (`/te2e`)

Caso especial: o TM Code tem o Playwright MCP server embutido, lazy-spawned quando fazes `/te2e`. Não precisas de configurar — apenas ter Chrome (ou Edge / Brave) instalado. Idle-timeout 5 minutos.

---

## 20. Settings

Atalho: `Cmd/Ctrl+,`

### Secções

- **Profile** — plano, créditos, billing cycle, logout
- **Editor** — tab size, spaces vs tabs, format on save, AI completion
- **Sandbox** — comandos bloqueados, comportamento por defeito de prompts
- **Shortcuts** — remap completo de keybindings
- **Skills** — gere skills bundled, global, project-local
- **MCP** — vê servers, status, refresh, logs
- **Deploys** — histórico de publicações, custom domains
- **Advanced** — logging level, telemetria, experimental flags

### Settings global vs project

- **Global**: aplicam-se a todos os projectos
- **Project**: override em `.toquemedia/settings.json`

---

## 21. Planos e créditos

### Tiers

| Plano | Preço | Tokens/ciclo | Modelo coder | Multimodal |
|---|---|---|---|---|
| **Explorer** | Free | 1.5M | DeepSeek V4-Flash | ❌ |
| **Vibe** | $X/mês | 5.88M | GLM-5.1 | ✅ |
| **Pro** | $Y/mês | 11.76M | GLM-5.1 | ✅ |
| **Max** | $Z/mês | 72.55M | GLM-5.1 | ✅ |

### Funcionalidades por plano

| Funcionalidade | Explorer | Vibe+ |
|---|---|---|
| Chat agent | ✓ | ✓ |
| `/init`, `/plan`, `/debug`, `/payments` | ✓ | ✓ |
| `/te2e` (browser-driven QA) | ✗ | ✓ |
| Imagens em prompts | ✗ | ✓ |
| Reasoning toggle | ✗ | ✓ |
| Auto-completion (Ollama) | ✓ | ✓ |
| Sub-agents (research/verify) | ✓ | ✓ |

### Como funciona o consumo

- Cada chamada ao modelo deduz tokens (input + output, com pesos diferentes)
- Tokens reset no início de cada ciclo (mensal)
- Quando ultrapassas o limite do plano, entras em **overage** (saldo extra cobrado avulso) se tiveres saldo
- O status bar mostra a % consumida

### Status indicators

- 🟢 Verde — < 70% consumido
- 🟡 Amarelo — 70-90%
- 🔴 Vermelho — > 90%
- ⚠️ Overage — usaste mais que o plano, a usar saldo extra

### Upgrade

Settings → Profile → "Upgrade plan". Abre o site web onde escolhes o plano e pagas.

---

## 22. Publicar (deploy)

O botão **Publish** na title bar (ou `Cmd/Ctrl+Shift+D`) abre o modal de deploy.

### Pipeline

1. **Init** — reserva o slug (subdomínio), cria tenant GIP se a app usa auth, faz migrations D1
2. **Upload** — empacota e envia ficheiros para R2 em chunks paralelos
3. **Worker** — bundle do backend (Hono Worker) se houver
4. **Finalize** — regista o deployment, activa o domínio

### Custom domain

Opcional. Adicionas o teu domínio, configuras CNAME / TXT records, o TM Code valida e emite SSL automaticamente.

### Falhas

Se uma fase falha, o modal mostra "Error" com retry. Limpeza automática (R2 cleanup) para não acumular ficheiros órfãos.

### Histórico

Settings → Deploys mostra todas as publicações com:
- URL final
- Data/hora
- Status
- Tamanho
- Botão "Open" para abrir no browser

---

## 23. Atalhos de teclado

Personalizáveis em Settings → Shortcuts. Defaults:

### Navegação

| Atalho | Acção |
|---|---|
| `Cmd/Ctrl+P` | Quick Open (ficheiros) |
| `Cmd/Ctrl+Shift+P` | Command palette |
| `Cmd/Ctrl+B` | Toggle sidebar |
| `Cmd/Ctrl+\`` | Toggle terminal |
| `Cmd/Ctrl+,` | Settings |
| `Cmd/Ctrl+Shift+E` | Vista Editor |
| `Cmd/Ctrl+Shift+F` | Search global |

### Editor

| Atalho | Acção |
|---|---|
| `Cmd/Ctrl+S` | Save |
| `Cmd/Ctrl+Shift+S` | Save As |
| `Cmd/Ctrl+W` | Close tab |
| `Cmd/Ctrl+\` | Split editor |
| `Cmd/Ctrl+/` | Toggle comment |
| `Cmd/Ctrl+D` | Multi-cursor (next match) |

### Chat

| Atalho | Acção |
|---|---|
| `Enter` | Enviar mensagem |
| `Shift+Enter` | Newline na mensagem |
| `Cmd/Ctrl+Enter` | Aprovar diff inline |
| `Esc` | Rejeitar diff / fechar dialog |
| `Y` | Aprovar permission prompt |
| `N` | Rejeitar permission prompt |
| `A` | "Approve all" para o scope (excepto dangerous/browser) |

### Preview

| Atalho | Acção |
|---|---|
| `Cmd/Ctrl+Shift+H` | Toggle HTTP Client (fullstack) |
| `Cmd/Ctrl+Shift+D` | Open Publish modal |

### Debugger

| Atalho | Acção |
|---|---|
| `F5` | Continue / Start debugging |
| `F10` | Step over |
| `F11` | Step into |
| `Shift+F11` | Step out |

---

## 24. Boas práticas

### Como dar bons prompts

❌ **Vago**:
```
fix auth
```

✅ **Específico**:
```
no /login, quando o user clica "Sign in" sem preencher email, não aparece erro nenhum.
deve aparecer "Email é obrigatório" debaixo do campo, em vermelho.
@LoginScreen.tsx
```

❌ **Múltiplos escopos misturados**:
```
arranja o bug do logout, refactoriza o useAuth, e adiciona testes
```

✅ **Um escopo de cada vez**:
```
arranja o bug do logout: ao clicar, o user fica em loop infinite redirect entre /login e /
```

(Depois pedes refactor, depois testes — cada um numa mensagem.)

> O agente está orientado para detectar pedidos com múltiplos escopos e propor split antes de avançar. Se vires uma resposta a propor "vou dividir isto em 3 tarefas", aprova ou ajusta.

### Quando usar cada comando

- **Pedido simples** ("muda esta cor", "adiciona um botão") → chat normal
- **Feature nova** com várias partes → `/plan`
- **Erro / bug** → `/debug`
- **Auditar código** (antes de PR / antes de shipar) → `/review`
- **Validar feature em runtime** (browser real) → `/te2e`
- **Primeiro contacto com o projecto** → `/init`
- **Adicionar pagamentos** → `/payments`

> **`/review` vs `/te2e`**: `/review` analisa **código estático** (bugs latentes, anti-patterns, workarounds frágeis); `/te2e` valida **comportamento runtime** (UI funciona, fluxos não partem). São complementares — antes de um deploy importante, faz ambos.

### Aproveitar checkpoints

- Não tenhas medo de pedir coisas ousadas — se o agente fizer algo que não querias, click em "Undo" ao lado da tool call
- Antes de mudanças grandes, faz `/plan` para teres um snapshot mental do que vai acontecer

### Skills + hashtags

- Usa `#auth-google` em vez de copiar instruções de auth a cada projecto
- Cria skills pessoais para patterns que repetes
- Para o teu projecto, cria skills em `.toquemedia/skills/` e versiona em git

### Token efficiency

- Não cubras o agente em ficheiros desnecessários — usa `@filename` para focar
- Skills > pasting de docs (skills são compactos, docs ocupam contexto)
- Se o agente repete trabalho, é sinal de que perdeu contexto após compaction — diz-lhe directamente o que precisa lembrar

### Permission fatigue

- Activa "Auto-approve diffs" quando confias na sessão (sempre podes desfazer com checkpoints)
- Para `/te2e`: o `browser_snapshot` é auto-aprovado; só os cliques/types pedem permissão
- Se queres pausa, diz "stop" — o agente pára na próxima oportunidade

---

## 25. Resolução de problemas

### "Dev server não arranca"

1. Vê o console (toggle no preview toolbar)
2. Verifica que as dependências estão instaladas (`node_modules` existe?)
3. O port pode estar ocupado — para o processo que o ocupa, ou muda em `vite.config.ts`
4. No Windows: confirma que o servidor escuta em `0.0.0.0` (o TM Code injecta automaticamente para frameworks conhecidos)

### "Browser não detectado" (ao usar `/te2e`)

- Instala Google Chrome (ou Edge / Brave)
- Reabre o TM Code
- Tenta `/te2e` de novo

### "Profile lock" (Chrome não abre no `/te2e`)

Se mataste o IDE forçadamente, o profile fica lockado. O TM Code limpa automaticamente locks órfãos no próximo arranque. Se persistir:

```bash
rm ~/.toquemedia-studio/browser-profile/Singleton*
```

### "Mensagens em queue não aparecem no chat"

Issue conhecido em versões antigas (corrigido). Se acontecer, atualiza o TM Code.

### "Agente repete trabalho após mensagens longas"

Context compaction perdeu informação. Soluções:
- Fecha a sessão e abre uma nova (mantém o projecto)
- Carrega skills relevantes via hashtag
- Resume manualmente o que o agente devia lembrar

### "Não consigo usar `/te2e`"

É feature paga. Vai a Settings → Profile → Upgrade.

### Logs e relatórios

- **Settings → Advanced → Logs** — abre a pasta de logs
- Para reportar bug: Settings → Help → Report Issue (envia logs anonimizados)

---

## 26. Glossário

- **Agente** — o modelo de IA que executa tools (não apenas chat)
- **Checkpoint** — snapshot automático de ficheiros antes de uma escrita
- **CMD mode** — interface estilo terminal (alternativa à GUI)
- **Compaction** — compressão de mensagens antigas quando o contexto enche
- **Diff inline** — visualização de mudança proposta pelo agente, accept/reject
- **Hashtag** — `#tag` que carrega um skill predefinido
- **HTTP Client** — painel Postman-like para projectos backend
- **MCP** — Model Context Protocol; standard para expor tools a agentes
- **Mention** — `@filename` para referenciar ficheiro no contexto
- **Overage** — uso para além do plano, cobrado por créditos extra
- **Permission** — autorização que o user dá a uma acção do agente
- **Plan card** — cartão no chat com proposta de arquitectura para aprovar
- **Preview** — vista da app a correr (iframe ou HTTP Client)
- **Project kind** — frontend / backend / fullstack / static
- **Reasoning** — bloco de pensamento explícito do modelo antes da resposta
- **Session** — conversação contínua com o agente, persistida em disco
- **Skill** — recipe markdown que ensina o agente um pattern
- **Sub-agente fresh** — instância secundária do agente sem histórico do chat (usada por `/review` para evitar viés de confirmação)
- **Slash command** — `/init`, `/plan`, `/debug`, `/review`, `/payments`, `/te2e`
- **TMS.md** — memória do projecto, gerada por `/init`
- **Tool** — capacidade do agente (read_file, execute_command, etc.)
- **TODO.md** — lista de tarefas gerada por `/plan`
- **Workaround** — código que funciona mas é frágil ou difícil de manter (categoria de finding "Médio" no `/review`)

---

## Suporte

- **Email**: support@tmcode.app
- **Discord**: [link da comunidade]
- **Documentação online**: https://tmcode.app/docs
- **Issues**: https://github.com/[org]/tm-code/issues

---

*TM Code — Agent-First IDE. Documentação versão 1.0, 2026.*
