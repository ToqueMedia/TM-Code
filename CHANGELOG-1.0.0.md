# TM Code 1.0.0 — O IDE agent-first, agora paralelo e dev-only

Primeira versão estável. O 1.0.0 fecha o pivot para um IDE **dev-only** (a camada gerida sai do corpo do agente), abre o **trabalho em paralelo multi-janela** e reforça o loop do agente com gestão de contexto honesta, execução de tools em streaming e recuperação de erros transitórios.

---

## ⚠️ Breaking changes

- **IDE dev-only — camada gerida removida** (`97a6a5a`, `c5d1705`, `a9f90c5`). As superfícies de plataforma geridas (Publish, Data Viewer, Deploy embutido) e o provisioning saíram do IDE e do corpus do agente. O agente deixa de conhecer/polícia essas capacidades; a gestão de deploys vive agora na conta web (`code.toquemedia.net`). Projetos e fluxos que dependiam dessas superfícies dentro da app precisam de migrar para a web.
- **Superfície de chat CMD/Terminal removida** (`335b337`). O agente vive exclusivamente no Chat; o que resta de `cmd-mode` é apenas o drawer PTY (terminal embutido), que **não** é uma superfície de chat.
- **Botões de Home e toggle da sidebar de projetos removidos** (`dbec98d`).

---

## ✨ Novidades

### Trabalho em paralelo (multi-janela)
- Uma janela = um processo = um projeto. "Open in New Window" corre projetos em paralelo, com coordenação via disco (`3c8481b`, `8df11ca`).
- Badges de atividade do agente por projeto na sidebar Welcome — árvore projeto→tarefas com tempo decorrido e ações de hover (`8ad2f0c`, `17cc785`).
- Guarda de duplo-open cross-janela e `--open-project` pós-login (`8df11ca`).

### Fila de tarefas
- Enfileira uma segunda tarefa a meio de um run sem descarrilar a primeira; o toggle "Nova tarefa" no composer separa orientação (steer) de tarefa nova (`07468e8`).
- A fila sobrevive ao Stop e à exaustão de orçamento (pausa + Retomar); Stop unificado numa única implementação (`97c9b7e`).

### Loop do agente
- **Budget real de tool-results + registo de visibilidade** — fim da "dança do force:true": o dedup deixa de mentir sobre conteúdo que o pipeline despejou (`53b2ce9`).
- **Execução de tools em streaming** — tools read-only começam a correr durante a geração; **recuperação de output truncado** (finish_reason "length") e **withheld errors** para cortes de stream transitórios (`42e43e4`).
- **Toolset persistente por run** — ativações on-demand param de churnar o prompt cache; instrumentação de churn/request_tools (`9e3eba5`).
- Sub-agentes entregam resultados por push (nunca polling) + visibilidade de equipa (`36995fd`).
- Ferramenta **LSP** — inteligência de código à escala do compilador (`5a5d63c`).
- Sessões de **worktree** (`61b6db8`).

### Billing
- **Aviso de expiração de plano** (≤10 dias) no chat (`8fd7c91`).
- **Stop global** com UI clara quando o orçamento de tokens acaba (`99435e2`).

### Sessões & UI
- **Título estável da tarefa** (a primeira mensagem) + descrição editável, propagada entre janelas (`e8cc34e`).
- Download de sessão entrega o transcript limpo; o JSON cru fica admin-only (`a331fe1`).
- Redesign do chrome: header liso, branch switcher, avatar no rodapé (`17cc785`).
- Janela do file-viewer sem moldura, arrastável, com chrome profissional (`488efb7`).
- Runs de tools read-only colapsam numa linha de exploração (`2f4dc11`).
- Container queries — toolbar/prompt/diff adaptam-se à coluna, não à janela (`3133a62`).

### Colaboração
- Chamadas de voz P2P de equipa sobre a mesh + partilha de ecrã qualidade Meet (`6479003`, `ad31ac3`, `635619e`).
- Salas por projeto, teardown em fecho/crash, recuperação P2P, PiP, badges de caminho de ligação por-peer (`d5f50c0`, `308d7fb`).

### Editor & Source Control
- Resolução de conflitos de merge inline no editor, paridade VS Code (`b436d17`, `8f50b09`).

---

## 🛠️ Correções

- **O agente conhece a IDE** — guia o developer para a UI (ex.: botão Preview em vez de "corre yarn dev") em vez de ditar comandos (`be214fa`).
- **Branch switch pelo chat** pára o run vivo e reconcilia os buffers do editor — fecha dois vetores de perda de código do user (`3496c46`).
- **Guarda anti-spam** no `update_session_memory` (uso indevido como task ticker) (`370b2b3`).
- **CreditIndicator sempre visível** — fora do cluster responsivo e do gate de sidebar (`992b3aa`).
- Sub-agentes: stale-kill em tools longos, argPreview, feed vivo, resultado parcial no timeout (`ba5ce04`).
- Imagens voltam a chegar ao modelo (`34ba2bb`); paths fora do projeto são consent-gated, não bloqueados (`87d7324`).
- Stop cancela runs em pré-voo; Grep regex por default; shell no perfil read-only (`8507ab2`).
- Correções de colaboração: relay fallback, P2P direto em LANs Windows, reconciliação de badges de caminho (`4bf935c`, `31ea983`, `2ea76ba`).

---

_Para o histórico completo, ver `git log v0.9.1..v1.0.0`._
