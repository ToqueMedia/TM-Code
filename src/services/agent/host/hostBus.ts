/**
 * Host bus — o primeiro pedaço da costura AgentHost (P1 do
 * docs/DESIGN-HEADLESS-RUNNER.md, 2026-08-03).
 *
 * O núcleo do agente NÃO pode falar com o DOM nem com serviços que assumem
 * janela (window.dispatchEvent, notificações de SO): num hospedeiro headless
 * nada disso existe. Este módulo é o canal neutro — o núcleo emite; quem
 * hospeda (janela OU runner) decide o que fazer. Sem handler registado tudo é
 * no-op, que é exactamente a semântica headless desejada (`notify?` é OPCIONAL
 * no contrato AgentHost).
 *
 * Zero dependências, zero React, zero Tauri — importável de qualquer contexto.
 */

export interface HostNotification {
  title: string
  body: string
  /** Mostrar mesmo com a janela focada (só relevante no hospedeiro janela). */
  evenWhenFocused?: boolean
  /** Chave de deduplicação de notificações repetidas (passa ao handler). */
  dedupKey?: string
}

type StopHandler = () => void
const stopHandlers = new Set<StopHandler>()

/** Emite "o run principal foi parado/cancelado" aos subscritores do host. */
export function emitAgentStopRequested(): void {
  // Cópia antes de iterar: um handler `once` remove-se durante o fire.
  for (const handler of Array.from(stopHandlers)) {
    try {
      handler()
    } catch {
      /* um subscritor partido nunca pode travar o cancel dos restantes */
    }
  }
}

/** Subscreve o stop; devolve o unsubscribe. `once` auto-remove no 1º fire. */
export function onAgentStopRequested(
  handler: StopHandler,
  opts?: { once?: boolean },
): () => void {
  const wrapped: StopHandler = opts?.once
    ? () => {
        stopHandlers.delete(wrapped)
        handler()
      }
    : handler
  stopHandlers.add(wrapped)
  return () => {
    stopHandlers.delete(wrapped)
  }
}

type NotificationHandler = (n: HostNotification) => void
let notificationHandler: NotificationHandler | null = null

/** O hospedeiro regista aqui o caminho real das notificações de SO
 *  (janela: notificationService; headless: nada). */
export function setHostNotificationHandler(handler: NotificationHandler | null): void {
  notificationHandler = handler
}

/** Notificação para o hospedeiro. Sem handler (headless/testes) é no-op. */
export function notifyHost(n: HostNotification): void {
  try {
    notificationHandler?.(n)
  } catch {
    /* notificar é melhor-esforço — nunca parte o run */
  }
}

// ── Progresso de tool calls (P3 — portão duro nº4 do inventário) ──────────
// O canal de progresso de uma tool em execução ERA o próprio transcript
// (chatStore.updateToolCallProgress/appendToolCallCommandLogs chamados de
// dentro do executor). Passa a evento de host: a janela alimenta o
// transcript; um runner headless reencaminha para o stream de saída.

export type ToolProgressEvent =
  | { kind: 'progress'; toolCallId: string; text: string }
  | { kind: 'command_logs'; toolCallId: string; chunks: string[] }

type ToolProgressHandler = (e: ToolProgressEvent) => void
let toolProgressHandler: ToolProgressHandler | null = null

export function setToolProgressHandler(handler: ToolProgressHandler | null): void {
  toolProgressHandler = handler
}

/** Progresso/logs de uma tool em execução. Sem handler é no-op. */
export function emitToolProgress(e: ToolProgressEvent): void {
  try {
    toolProgressHandler?.(e)
  } catch {
    /* progresso é melhor-esforço — nunca parte o run */
  }
}

// ── Logs do dev server (P3.3 — portão duro nº5) ───────────────────────────
// O read_dev_logs esperava por um CustomEvent do DOM disparado pelo
// layoutStore (pipeline WebView do preview → IPC → addDevServerLog). O canal
// passa pelo bus: o emissor continua a ser quem adiciona logs; o executor
// subscreve sem tocar em window.

type DevServerLogHandler = (level: string) => void
const devServerLogHandlers = new Set<DevServerLogHandler>()

/** Emitido sempre que uma entrada de log do dev server é adicionada. */
export function emitDevServerLogAdded(level: string): void {
  for (const handler of Array.from(devServerLogHandlers)) {
    try {
      handler(level)
    } catch {
      /* um subscritor partido não trava os restantes */
    }
  }
}

/** Subscreve novas entradas de log do dev server. Devolve o unsubscribe. */
export function onDevServerLogAdded(handler: DevServerLogHandler): () => void {
  devServerLogHandlers.add(handler)
  return () => {
    devServerLogHandlers.delete(handler)
  }
}

// ── Gates de espera humana (P4 — portão nº7) ──────────────────────────────
// O permissionAwareTimeout subtraía o tempo-de-humano subscrevendo TRÊS
// stores do renderer. Depois da P2, TODA a espera humana passa pelo
// AgentHost — o host-janela abre um span à volta de cada await
// (beginHumanGate/end) e quem precisa de saber "há um humano a decidir?"
// pergunta ao bus. Um host headless nunca abre gates → nada pausa, que é a
// semântica certa (não há diálogo nenhum aberto).

let openHumanGates = 0
type HumanGateListener = () => void
const humanGateListeners = new Set<HumanGateListener>()

function notifyHumanGates(): void {
  for (const listener of Array.from(humanGateListeners)) {
    try {
      listener()
    } catch {
      /* um subscritor partido não trava os restantes */
    }
  }
}

/** Abre um span de espera humana; devolve o fecho (idempotente). */
export function beginHumanGate(): () => void {
  openHumanGates += 1
  notifyHumanGates()
  let ended = false
  return () => {
    if (ended) return
    ended = true
    openHumanGates -= 1
    notifyHumanGates()
  }
}

/** Há alguma decisão humana em curso (qualquer via do AgentHost)? */
export function hasOpenHumanGates(): boolean {
  return openHumanGates > 0
}

/** Subscreve transições de abertura/fecho de gates. Devolve o unsubscribe. */
export function onHumanGatesChange(listener: HumanGateListener): () => void {
  humanGateListeners.add(listener)
  return () => {
    humanGateListeners.delete(listener)
  }
}
