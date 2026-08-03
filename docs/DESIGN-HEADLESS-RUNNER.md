# Design — Headless Runner (task F1-6)

**Estado:** desenho aprovável · 2026-08-03 · origem: inventário duplo (acoplamentos do renderer no exodus-ide × costuras do modo headless no cli-vaz)
**Objectivo:** o motor do agente (queryEngine/query/toolExecutor/contextBuilder) hospedável em dois sítios — a janela (hoje) e um runner sem UI (`tm-code --run "<tarefa>" --project <dir> --json`) — sem bifurcar o motor.

## A lição da referência (cli-vaz)

O Claude Code corre o MESMO motor no REPL interactivo e no print mode porque a costura entre motor e hospedeiro é **um único struct de ~8 callbacks** — e nada mais. Princípios a replicar (ver `~/dev/cli-vaz`, `cli/print.ts` + `cli/structuredIO.ts`):

1. **O protocolo de mensagens é o único contrato** — o mesmo union tipado viaja como NDJSON no headless e como eventos internos na janela. `StructuredIO` → `RemoteIO` deles: uma classe, três transportes, zero mudanças no motor.
2. **Permissões = política primeiro, callback depois**: allow/deny por regras/modo curto-circuita; só o "ask" escala ao hospedeiro, como request/response com correlation ids, cancelamento e recuperação de pedidos órfãos.
3. **Store agnóstica de framework** com o React a subscrever — nunca o React como fonte de verdade.
4. **Servidor streaming primeiro** (`runHeadlessStreaming`); o one-shot é um wrapper fino.
5. **Relatório terminal estruturado**: uma mensagem `result` (custo/usage/turns/negações) → exit code. Nunca o último texto impresso.
6. Enumerar **cada hook React com efeito visível ao motor** e dar-lhe implementação não-React (a lição explícita do print.ts deles).

## Decisão de arquitectura: hospedeiro de janela oculta primeiro

Dois caminhos possíveis:

- **(A) Janela oculta** — `--run` arranca a app Tauri com webview invisível; o motor corre onde sempre correu; stdout NDJSON via comando Rust. **Todos os ~30 comandos IPC continuam a funcionar sem tocar em nada.** CI: macOS runners directo; Linux via xvfb.
- **(B) Core Node puro** — extrair o motor para correr sem Tauri, com camada FS/shell própria. Paridade total com o print.ts, mas obriga a reimplementar/abstrair todo o IPC.

**Decisão: (A) primeiro.** Reduz o trabalho ao que é realmente o problema — os acoplamentos de STORE/UI — e deixa (B) como evolução se a CI o exigir. Com (A), o IPC Tauri **não é acoplamento a quebrar**: é infra-estrutura partilhada pelos dois hospedeiros.

## O contrato `AgentHost`

```ts
interface AgentHost {
  // decisões humanas (request/response, correlation id, cancelável)
  canUseTool(req: PermissionRequest): Promise<PermissionDecision>   // política já avaliada; só chega o "ask"
  approveDiff(req: DiffApprovalRequest): Promise<boolean>
  elicit(req: CredentialRequest | UserQuestion): Promise<ElicitResult>
  // fluxo
  emit(msg: EngineMessage): void            // transcript, progresso de tools, status — o ÚNICO sink
  nextCommand(): Promise<QueuedCommand|null> // steering/fila
  abortSignal: AbortSignal
  // ambiente
  runId: string                              // substitui chatStore.activeSessionId no motor
  onBudgetExhausted(): void                  // substitui billingStore.setNoCredits() dentro do loop
  setStatus(s: EngineStatus): void
  notify?(n: Notification): void             // opcional; ausente no headless
}
```

Hospedeiro de janela = as stores actuais atrás desta interface (o React subscreve ao `emit`). Hospedeiro headless = política-só nas permissões (modos: readonly / acceptEdits / yolo via flag), NDJSON no `emit`, `notify` ausente.

## Estado de partida (inventário 2026-08-03)

**Já limpo:** `queryEngine.ts` (zero stores/IPC/DOM — é a costura-modelo que já existe no repo), `auxiliaryRegistry.ts`, `sharedSections.ts`, quase todo o `toolExecutor/` auxiliar. `query.ts` quase limpo (4 toques dinâmicos de store + 1 import transitivo). `contextBuilder.ts` só leituras dinâmicas.

**O trabalho real:** `toolExecutor.ts` (11 stores, 4 costuras de espera humana, eventos DOM) e `agentService.ts` (fan-out de stores + a espera do diff-approval).

### Os 10 acoplamentos duros (do inventário, com localização)

1. `waitForUserGates()` — busy-wait de 120ms sobre 4 stores (toolExecutor.ts:1091-1150)
2. `pendingDiffApprovals` Map no chatStore, resolvido por 3 superfícies React (chatStore.ts:632; await em agentService.ts:1727)
3. `permissionStore.requestPermission()` — política + prompt fundidos numa store (toolExecutor.ts:944, 1438, 1479, 2676)
4. Output de shell despejado directamente em `chatStore.updateToolCallProgress` (toolExecutor.ts:2273-2498)
5. `read_dev_logs` à espera de CustomEvent do DOM (toolExecutor.ts:5347-5363)
6. Agente escreve `layoutStore` (dev server) e o prompt lê-a de volta (toolExecutor.ts:2552; chatSections.ts:726)
7. `permissionAwareTimeout` com 3 `.subscribe()` a stores (permissionAwareTimeout.ts:63-65)
8. `backgroundCommandStore` como registry de processos (toolExecutor.ts:5941-6136)
9. Identidade de sessão via `chatStore.activeSessionId` re-derivada no meio do run (agentService.ts:442, 1863, …)
10. `billingStore.setNoCredits()` escrito de dentro do loop — terminação por orçamento foge pelo renderer (query.ts:2087)

**Bugs encontrados de borla:** `window.dispatchEvent('git:refreshGutter')` SEM guarda (toolExecutor.ts:1535 — rebenta em Node); guarda incompleta de `localStorage` em invokeMetrics.ts:75.

## Fases

- **P1 — mecânica, risco baixo:** runId explícito no motor (#9); `onBudgetExhausted` (#10); todos os `window.dispatchEvent` → `host.emit` (+fix do unguarded); `notificationService` → `host.notify`. Critério: suite verde, zero mudança de comportamento na janela.
  **✅ FEITA (2026-08-03, branch feat/agent-host-seam).** Nota de execução: o #9 revelou-se largamente resolvido por trabalho anterior — taskOps (`getTaskOrigin ?? streaming ?? activa`), memoryOps (`getRunSession()`) e o arquivo pré-compact já eram run-aware; as leituras de `activeSessionId` no arranque do run DEFINEM a sessão do run (semântica correcta) e as dos caminhos de compactação manual são operações de UI onde "sessão activa" é o contrato certo (`assertSameSession` é guarda deliberada). Resíduo real corrigido: o extractor de memórias pós-run (agentService) passou a streaming-primeiro. #10 e os eventos/notify saíram todos pela costura hostBus/windowHost.
- **P2 — as 4 esperas humanas viram request/response:** separar a POLÍTICA de permissões da store (módulo puro; a store fica com o prompt) → `host.canUseTool` (#3); diff approval → `host.approveDiff` (#2); credenciais/perguntas (já têm forma de promise — as mais fáceis); matar o polling do `waitForUserGates` → espera por promise do host (#1). Critério: a janela comporta-se igual; um host de teste responde às 4 vias sem React.
- **P3 — estado de runtime sai das stores de UI:** ProcessRegistry do motor (a store vira espelho para a UI) (#8); progresso de tools → eventos no `emit` (chatStore subscreve) (#4); dev-server logs/estado → módulo do motor, layoutStore espelha (#5, #6). Critério: transcript da janela idêntico ao de hoje.
- **P4 — restos:** timeout permission-aware por sinais pause/resume do host (#7); isolar o fan-out transitivo (firebaseAuth 8 stores, byokRouting 3, subAgentRunner 4) por lazy-import.
- **P5 — a entrada:** flag `--run` no Rust → janela oculta → modo runner (job spec JSON: tarefa, projecto, modo de permissões, budget, formato de saída) → `result` estruturado + exit code. Saltar o window-lock/agent-status com flag de runner (ou owner marcado "headless") para não disparar avisos de double-open.
- **P6 — smoke e2e:** `tm-code --run` completa uma tarefa real num repo de teste. (Desbloqueia a task F1-7, se aprovada.)

## Riscos conhecidos

- O `window-lock.json`/`agent-status.json` são escritos por qualquer instância — o runner precisa de identidade própria no bus de disco (P5).
- WKWebView oculta em CI Linux exige xvfb; macOS ok.
- A árvore de trabalho actual carrega mudanças não commitadas (full-delivery + Fase 0) — **começar P1 só depois de as fechar/commitar**, idealmente em branch próprio.
