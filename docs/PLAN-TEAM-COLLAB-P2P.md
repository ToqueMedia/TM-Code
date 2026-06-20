# PLAN — Colaboração P2P de Equipa (Git-like Changeset Sharing + Chat Efémero)

> **Status:** Proposta / **Diferida** — implementar *depois* do Plano de Equipas (billing).
> **Pertence ao Plano de Equipas:** **SIM.** A partilha de código (changesets + "merge to validate") é uma feature **DA EQUIPA**, gated à **pertença à equipa** (`teamMemberOf`) — NÃO a Pro/Max. Acontece entre **membros da mesma equipa**.
> **O que é separado e gated Pro/Max:** **apenas o host-and-guest / estilo Live Share** (sessão partilhada em tempo real, ad-hoc por código/link) — ver §4. ESSE não depende do Plano de Equipas.
> **Última atualização:** 2026-06-18 — *corrigido o enquadramento*: a versão anterior dizia (erradamente) que a partilha de código era independente/gated Pro/Max. É team-gated; só o Live Share é Pro/Max.

---

## 1. Resumo

Colaboração entre membros **sem agente partilhado e sem espetadores**. Cada membro tem a **sua própria cópia** do projeto, aberta no TM Code, e trabalha com o **seu próprio agente** numa feature separada. A colaboração acontece ao nível de **changesets** (apenas os ficheiros modificados), partilhados **P2P** entre instâncias do TM Code, com um **sandbox de validação** ("Merge to validate") antes de o destinatário aceitar (commit local com autoria do autor original) ou descartar. Existe ainda um **chat de equipa efémero, P2P, sem armazenamento em servidor**.

É, na prática, **git sem remoto**: `format-patch` / `apply` mediado pelo TM Code, sobre um transporte P2P.

---

## 2. Motivação (exemplo concreto)

**Projeto "Vendas" — 3 membros, cada um com a sua cópia local aberta no TM Code:**

| Membro | Trabalha (com o seu agente) em |
|---|---|
| A | Auth flow |
| B | User profile |
| C | Faturação |

Cada feature é escrita **localmente** na máquina de cada um. Quando o **Membro B** termina, testa e valida a sua tarefa:

1. B clica em **"Partilhar com equipa"** (ou "Partilhar com membro da equipa") → o TM Code empacota **só os ficheiros modificados** por B e fá-los chegar P2P aos destinatários.
2. Cada destinatário recebe uma **notificação de partilha** e clica em **"Merge to validate"** → o TM Code aplica **uma cópia temporária** dos ficheiros de B sobre a cópia local do destinatário, para ele **testar localmente como se já fizesse parte do projeto**.
3. No fim, o destinatário escolhe:
   - **a) Descartar** → a cópia volta ao estado anterior, **sem** os ficheiros de B.
   - **b) Concluir Merge** → a cópia torna-se efetiva; por baixo, faz-se *stage* + *commit local* com **autoria do Membro B** + *co-author* **TM Code**.

---

## 3. Não-objetivos (DESTE doc — a partilha de código team-gated)

- ❌ **Sem co-edição de ficheiros ao vivo** (sem Monaco CRDT / Yjs / OT).
- ❌ **Sem espetadores** — ninguém assiste passivamente ao prompt de outro.
- ❌ **Sem armazenamento de mensagens de chat** em base de dados ou servidor.

> **NOTA (corrigida 2026-06-18):** o **host-and-guest / agente-partilhado em tempo real (estilo Live Share)** NÃO é um "não-objetivo rejeitado" — é uma **feature SEPARADA**, gated a **Pro/Max** e independente do Plano de Equipas (§4). Esta partilha de código (changesets) é a feature **da EQUIPA**; o Live Share é o produto distinto.

---

## 4. As DUAS colaborações (e o que pertence ao Plano de Equipas)

| Eixo | **Partilha de código (ESTE doc)** | **Host-and-guest / Live Share** |
|---|---|---|
| Natureza | Changesets P2P + "merge to validate" + chat efémero | Sessão partilhada em tempo real (estilo Live Share) |
| Pertence ao Plano de Equipas? | **SIM** — feature da equipa | **NÃO** — independente |
| Gating | **Pertença à equipa** (`teamMemberOf`) | Planos **Pro** e **Max** |
| Com quem | Entre **membros da mesma equipa** | Qualquer grupo ad-hoc (código/link de adesão) |
| Onde vive | IDE (Rust git + frontend) + sinalização efémera | IDE + Durable Object de sinalização |

A **partilha de código é parte do Plano de Equipas** (membros da equipa terminam o seu lado → partilham o changeset → os outros decidem merge/descartar). O **Live Share (host-and-guest)** é o produto **separado** e gated a Pro/Max — é ESTE que é ortogonal ao billing de equipa, não a partilha de código. *(Doc do Live Share: a criar/separar deste se/quando for priorizado.)*

---

## 5. Fluxos de utilizador

### 5.1 Partilhar changeset
- Entrada: botão **"Partilhar com equipa" / "Partilhar com membro"** no painel de git/diff.
- O TM Code calcula os ficheiros modificados (vs base — ver §6.1), empacota num **Changeset** assinado e envia P2P aos pares-alvo online.
- Feedback: estado por par (entregue / a aguardar / par offline).

### 5.2 Merge to validate (sandbox)
- O destinatário vê a notificação + um **preview do diff** (reutiliza o render de diffs existente).
- Clica **"Merge to validate"** → cria-se um **restore point** da cópia atual do destinatário (incluindo trabalho não-commitado dele) e aplica-se o changeset à *working tree* viva, para testar com o dev server a correr.

### 5.3 Descartar / Concluir Merge
- **Descartar** → reverte para o restore point; o trabalho próprio do destinatário fica intacto; ficheiros novos trazidos pelo changeset são removidos.
- **Concluir Merge** → `stage` dos ficheiros do changeset + `commit` local com `--author="<Membro B>"` e trailer `Co-authored-by: TM Code`.

### 5.4 Chat de equipa
- Painel de chat P2P. Mensagens viajam diretamente entre IDEs (encriptadas), **nunca tocam num servidor**.
- Histórico (opcional) persistido **localmente** em cada IDE sob `.toquemedia/collab/` (mesmo padrão das sessões em disco). Sem histórico no servidor.

---

## 6. Arquitetura

### 6.1 Modelo de Changeset

Envelope (assinado para autenticidade):

```ts
interface Changeset {
  id: string
  sessionId: string
  author: { uid: string; name: string; email: string }  // do perfil Firebase
  baseCommit: string        // SHA contra o qual o diff foi calculado
  branch: string            // ramo do autor (informativo)
  createdAt: number
  files: string[]           // caminhos modificados (a UI mostra "só ficheiros modificados")
  patch: string             // unified diff (git diff base..worktree), --binary safe
  message?: string          // nota opcional do autor
  signature: string         // assinatura derivada do ID token do autor
}
```

- **Base do diff:** recomenda-se aplicar com `git apply --3way`, robusto a bases divergentes (B e o destinatário podem ter partido de commits diferentes). A `baseCommit` ajuda o 3-way a encontrar contexto.
- **Novo comando Rust** (`src-tauri/src/commands/git.rs`): `git_export_changeset(project_path, base_ref) -> patch`. Inclui ficheiros *tracked* alterados e, opcionalmente, ficheiros novos como *added*.
- Reutiliza os primitivos existentes: `git_status_files`, `git_diff_lines`, `git_show_file`.

### 6.2 Sandbox "Merge to validate"

Novos comandos Rust (construir sobre `checkpoint.rs` / `sandbox.rs`, que já fazem *snapshots* do projeto):

- `collab_apply_changeset(project_path, patch)`:
  1. **Restore point** do estado atual do destinatário, **incluindo trabalho não-commitado** (snapshot via `checkpoint.rs`, ou `git stash create` → SHA pendente sem mexer na *tree*).
  2. `git apply --3way --index <patch>` → traz as alterações de B para a *working tree* (com marcadores de conflito se houver sobreposição).
  3. Devolve `{ restorePoint, conflicts: string[], addedFiles: string[] }`.
- `collab_discard_changeset(project_path, restorePoint, addedFiles)` → repõe a *tree* no restore point e remove os ficheiros novos trazidos; o WIP do destinatário sobrevive.
- `collab_finalize_changeset(project_path, files, author, message)` → `git add <files>` + `git commit --author="Name <email>" -m "<message>"` com trailer `Co-authored-by: TM Code <noreply@toquemedia.net>`.

**Garantias a respeitar:**
- O trabalho não-commitado do destinatário **nunca** é perdido (capturado no restore point).
- A aplicação é **totalmente reversível** (incl. limpeza de ficheiros novos).
- A autoria do commit final é **Membro B + TM Code**, exatamente como na spec.

> ⚠️ Plumbing exato de git (untracked files, index, conflitos) é subtil — reutilizar `checkpoint.rs` como mecanismo de snapshot/restauro em vez de reinventar.

### 6.3 Transporte P2P (sem armazenamento)

**Recomendação: WebRTC DataChannels no webview** (`RTCPeerConnection` está disponível em WKWebView/WebView2 — o mesmo webview onde o Firebase Auth já corre).

- Dois canais: `control` (presença, notificações de partilha, **chat**) e `bulk` (payloads de changeset, em *chunks*).
- **Encriptação:** DataChannel é DTLS por omissão → chat e changesets viajam **encriptados ponto-a-ponto**; nenhum intermediário vê texto-limpo. Honra "nenhuma mensagem armazenada em servidor".
- **Sinalização (só setup de ligação, zero conteúdo):** um **Durable Object por sessão** via WebSocket que faz *broker* de SDP offer/answer + ICE e mantém **presença**. Nunca persiste mensagens nem changesets — é efémero por design. (Alternativa: docs efémeros no Firestore, já integrado, mas o DO é mais limpo para presença + ICE *trickle*.)
- **NAT traversal:** STUN (grátis) + **TURN** para NATs simétricos → **requer infra/custo de TURN** (coturn ou gerido). *Flag.*
- **Entrega offline:** P2P exige ambos online. **v1 = só-online** (partilha falha com mensagem clara se o par estiver offline). *Opção futura documentada:* payload encriptado parqueado em **R2 com TTL curto + auto-delete** (opt-in) para entrega assíncrona sem "armazenamento permanente".

### 6.4 Sessão de colaboração / descoberta de pares

- **Sala = a equipa.** A descoberta é o **roster da equipa**, não um código ad-hoc: o DO de sinalização tem **uma instância por equipa** (`idFromName(teamId)`). Todos os membros online da mesma equipa entram na mesma sala e formam a *mesh*. Não há "iniciar sessão" nem link de adesão para a partilha de código.
- **A sala (`teamId`) é a equipa a que o utilizador pertence** (`billingStore.teamMemberOf`). A IDE liga-se enquanto for membro (`useCollabSession`).
- ⚠️ O **código/link ad-hoc estilo Live Share** referido em versões anteriores é a **outra feature** (host-and-guest, gated Pro/Max — ver §4) e está **fora deste doc**. Não confundir a descoberta da partilha de código (roster de equipa) com a do Live Share (ad-hoc).

### 6.5 Identidade, segurança e confiança

- **Autenticidade = identidade autenticada no transporte (não assinatura crypto).** Um ID token Firebase é um JWT — não serve para assinar payloads de forma verificável pelo destinatário sem infra de chaves. Em vez disso, o **DO de sinalização verifica o ID token de cada par** (JWKS RS256, igual ao data-plane) e a autoria do changeset fica ligada à identidade autenticada do par; o DataChannel é DTLS. Não há campo de assinatura por-mensagem no envelope.
- **Gate de membership autoritativo:** antes de admitir um par, o DO lê **`teams/{teamId}.members[uid]`** (mapa escrito **só** server-side; regras Firestore só deixam membro ler) com o ID token do próprio user — **falha fechada**. Não se confia em `teamMemberOf` do *user doc* (o user pode escrever o próprio doc).
- **Execução de código de terceiros:** aplicar + testar um changeset **corre código do colega**. Mesmo modelo de confiança que um `git pull` de um colega — tornado **explícito na UI** ("estás prestes a correr código de \<autor\>", já implementado no `MergeToValidatePanel`). Opcional/futuro: correr os testes do changeset sob `sandbox.rs` (contenção de processo) para isolamento — *nota:* `sandbox.rs` NÃO é uma cópia de ficheiros; a reversibilidade do "merge to validate" vem do restore point (estilo `checkpoint.rs`), não do sandbox.
- **Chat:** efémero, P2P, encriptado; persistência só local (opcional).

### 6.6 Gating de plano

- **A partilha de código é gated à PERTENÇA À EQUIPA (`teamMemberOf`), NÃO a Pro/Max.**
- **Cliente (UX):** mostrar UI de colaboração só se `billingStore.teamMemberOf` (helper `canShareCode()`).
- **Servidor (enforcement):** o DO de sinalização valida o **JWT Firebase + a membership autoritativa** (`teams/{teamId}.members[uid]`, §6.5) antes de admitir um par. Gate real, não só cosmético.
- (O gate **Pro/Max** aplica-se à feature **separada** Live Share — §4 — não a esta.)

---

## 7. Onde toca no código existente

| Camada | Mudança |
|---|---|
| Rust `commands/git.rs` | `git_export_changeset`; aplicar/finalizar changeset |
| Rust `commands/checkpoint.rs` | restore point do "merge to validate" reusa o pattern de snapshot (NÃO `sandbox.rs`, que é contenção de processo) |
| Rust (novo) `commands/collab.rs` | export/apply/discard/finalize do changeset + persistência do chat (WebRTC vive no JS) |
| Frontend (novo) `stores/collabStore.ts` | sessão, pares, changesets recebidos, chat |
| Frontend UI | botão "Partilhar" no painel git/diff; notificação de partilha; painel "Merge to validate" (reutiliza render de diff existente, ex. `InlineDiff`); painel de chat |
| Frontend `stores/billingStore.ts` | gate à pertença à equipa (`teamMemberOf`) — NÃO Pro/Max |
| Infra (novo) | Worker `workers/collab-signaling/` (Durable Object efémero) + TURN (diferido) |

---

## 8. Casos extremos

- **Bases divergentes** entre autor e destinatário → `git apply --3way`; se falhar, mostrar conflitos no preview.
- **Sobreposição de ficheiros** (raro, dado que trabalham em features separadas) → conflito explícito no sandbox.
- **Destinatário com *tree* suja** ao validar → restore point captura o WIP; reconciliar no discard/finalize.
- **Par offline** → v1 falha com mensagem; futuro = relay R2-TTL.
- **Binários grandes** → *chunking* no DataChannel; considerar limite de tamanho de changeset.
- **Autoria** → garantir que o email/nome do envelope alimenta `--author` corretamente.

---

## 9. Faseamento desta feature — ESTADO

> Implementado em 2026-06-18 na branch `feat/teams-plan-billing` (commits `feat(collab)` §9 Fase 1–4). **Por fazer:** deploy do DO (`wrangler deploy`) + validação E2E (gerida pelo user) + hardening residual.

1. ✅ **Núcleo de changeset** (`commands/collab.rs`: `git_export_changeset`/`collab_apply_changeset`/`collab_discard_changeset`/`collab_finalize_changeset`; restore point estilo `checkpoint.rs`). 6 testes Rust. Funciona sem rede.
2. ✅ **Transporte P2P** — worker `workers/collab-signaling/` (DO `SignalingRoom`, 1/equipa) + malha WebRTC (`collabMesh.ts`, DataChannels `control`+`bulk`, **STUN-only**). 14 testes worker + 7 frontend.
3. ✅ **UI de Merge-to-validate** + notificações (`MergeToValidatePanel`, `CollabShareControls`, `collabSessionService`).
4. ✅ **Chat de equipa** P2P + persistência local opcional (`.toquemedia/collab/chat.jsonl`).
5. ⏳ **Hardening** — aviso de código de terceiros ✅; offline com mensagem clara ✅; lista de ficheiros em conflito na UI; opção TURN/R2-TTL (diferida, decisão de custo).

---

## 10. Decisões em aberto — RESOLVIDAS (2026-06-18)

1. **Transporte:** ✅ **WebRTC puro** (P2P real + zero storage). Worker in-repo novo de sinalização.
2. **Entrega offline:** ✅ **só-online (v1)**, falha com mensagem clara. Relay R2-TTL diferido.
3. **Descoberta:** ✅ **roster de equipa** (sala = `teamId`, gated por `teamMemberOf`). O código ad-hoc é do Live Share, fora de âmbito.
4. **Profundidade de conflitos (v1):** `git apply --3way` com marcadores; a UI mostra contagem + lista de ficheiros em conflito e bloqueia "Concluir" até resolver.
5. **Isolamento ao testar código de terceiros:** ✅ **tree viva** (dev server a correr) com restore point reversível; `sandbox.rs` (contenção de processo) fica como opção futura para *correr* os testes, não para a reversibilidade.
