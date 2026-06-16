# PLAN — Colaboração P2P de Equipa (Git-like Changeset Sharing + Chat Efémero)

> **Status:** Proposta / **Diferida** — implementar *depois* do Plano de Equipas (billing).
> **Gating:** Planos **Pro** e **Max** (não depende do Plano de Equipas).
> **Relação com o Plano de Equipas:** **INDEPENDENTE** — ver §4.
> **Última atualização:** 2026-06-16

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

## 3. Não-objetivos

- ❌ **Sem agente partilhado / host-and-guests.** Cada membro corre o seu agente, na sua máquina.
- ❌ **Sem co-edição de ficheiros ao vivo** (sem Monaco CRDT / Yjs / OT).
- ❌ **Sem espetadores** — ninguém assiste passivamente ao prompt de outro.
- ❌ **Sem armazenamento de mensagens de chat** em base de dados ou servidor.
- ❌ **Sem dependência do Plano de Equipas** (billing). Funciona para qualquer grupo de utilizadores Pro/Max.

---

## 4. Porquê separado do Plano de Equipas

| Eixo | Plano de Equipas | Colaboração P2P (este doc) |
|---|---|---|
| Natureza | Billing / contabilidade / dashboard | Partilha de código + comunicação |
| Onde vive | Data-plane (consumo) + control-plane (`/v1/me`) + web (dashboard) | IDE (Rust git + frontend) + sinalização efémera |
| Gating | Plano "team" | Planos **Pro** e **Max** |
| Pode existir sem o outro? | **Sim** | **Sim** |

São features **ortogonais**. Acoplá-las atrasaria ambas. Ponte opcional (nice-to-have): se o utilizador *também* estiver num Plano de Equipas, a lista de convite da sessão de colaboração pode ser pré-preenchida com o *roster* da equipa.

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

- **Sessão ad-hoc estilo Live Share:** um membro Pro/Max **inicia uma sessão** → recebe um **código/link de adesão** → os outros aderem → forma-se a *mesh* via o DO de sinalização. **Independente** de qualquer equipa persistida (é isto que desacopla do Plano de Equipas).
- Ponte opcional: se houver Plano de Equipas, pré-preencher convites do *roster*.

### 6.5 Identidade, segurança e confiança

- **Autenticidade:** o changeset é assinado a partir do ID token Firebase do autor → o destinatário verifica que a autoria reivindicada é genuína (impede *spoofing* de autoria que acabaria num commit local).
- **Execução de código de terceiros:** aplicar + testar um changeset **corre código do colega**. Mesmo modelo de confiança que um `git pull` de um colega — mas torná-lo **explícito na UI** ("estás prestes a executar código de \<Membro B\>"). Opcional: validar dentro de `sandbox.rs` / `container.rs` para isolamento.
- **Chat:** efémero, P2P, encriptado; persistência só local (opcional).

### 6.6 Gating de plano

- **Cliente (UX):** mostrar UI de colaboração só se `billingStore.plan ∈ {'pro','max'}`.
- **Servidor (enforcement):** o DO de sinalização **valida o JWT Firebase + o plano** (mesma resolução de plano do worker) antes de admitir um par na sessão. Gate real, não só cosmético.

---

## 7. Onde toca no código existente

| Camada | Mudança |
|---|---|
| Rust `commands/git.rs` | `git_export_changeset`; aplicar/finalizar changeset |
| Rust `commands/checkpoint.rs` / `sandbox.rs` | reutilizar para restore points do "merge to validate" |
| Rust (novo) `commands/collab.rs` | cola para sinalização/sessão (WebRTC vive no JS) |
| Frontend (novo) `stores/collabStore.ts` | sessão, pares, changesets recebidos, chat |
| Frontend UI | botão "Partilhar" no painel git/diff; notificação de partilha; painel "Merge to validate" (reutiliza render de diff existente, ex. `InlineDiff`); painel de chat |
| Frontend `stores/billingStore.ts` | gate Pro/Max |
| Infra (novo) | Durable Object de sinalização (efémero) + servidor TURN |

---

## 8. Casos extremos

- **Bases divergentes** entre autor e destinatário → `git apply --3way`; se falhar, mostrar conflitos no preview.
- **Sobreposição de ficheiros** (raro, dado que trabalham em features separadas) → conflito explícito no sandbox.
- **Destinatário com *tree* suja** ao validar → restore point captura o WIP; reconciliar no discard/finalize.
- **Par offline** → v1 falha com mensagem; futuro = relay R2-TTL.
- **Binários grandes** → *chunking* no DataChannel; considerar limite de tamanho de changeset.
- **Autoria** → garantir que o email/nome do envelope alimenta `--author` corretamente.

---

## 9. Faseamento desta feature (quando for a vez)

1. **Núcleo de changeset** (Rust export/apply/finalize + restore points) — funciona até por troca manual de ficheiro, sem rede. Testável isolado.
2. **Transporte P2P** (WebRTC + DO de sinalização + TURN) — presença + entrega de partilhas.
3. **UI de Merge-to-validate** + notificações.
4. **Chat de equipa** (P2P, persistência local).
5. **Hardening** — conflitos, offline, avisos de segurança, opção R2-TTL.

---

## 10. Decisões em aberto

1. **Transporte:** WebRTC puro (recomendado, P2P real + zero storage) vs DO-relay não-persistente (mais simples atrás de NAT, mas tráfego transita servidor).
2. **Entrega offline:** só-online (v1) vs relay R2-TTL.
3. **Descoberta:** código ad-hoc (recomendado) vs *roster* de equipa.
4. **Profundidade de conflitos** suportada na v1.
5. **Isolamento** ao testar código de terceiros: *tree* viva vs `sandbox.rs`/`container.rs`.
