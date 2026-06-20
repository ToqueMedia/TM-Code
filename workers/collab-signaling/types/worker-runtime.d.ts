// Minimal ambient declarations for the Cloudflare Workers runtime globals this
// signaling worker uses. We deliberately avoid depending on the full
// `@cloudflare/workers-types` package so the worker stays typecheckable with
// just the repo-root TypeScript install (no per-worker `node_modules`). Only
// the surface actually used by the Durable Object is declared here.

export {}

declare global {
  /** Cloudflare WebSocket (superset of the DOM WebSocket used at runtime). */
  interface WebSocket {
    accept(): void
    send(message: string | ArrayBuffer | ArrayBufferView): void
    close(code?: number, reason?: string): void
    addEventListener(
      type: 'message',
      listener: (event: { data: string | ArrayBuffer }) => void,
    ): void
    addEventListener(type: 'close', listener: (event: unknown) => void): void
    addEventListener(type: 'error', listener: (event: unknown) => void): void
  }

  /** `new WebSocketPair()` yields `[client, server]` via numeric indices. */
  class WebSocketPair {
    0: WebSocket
    1: WebSocket
  }

  interface ResponseInit {
    webSocket?: WebSocket
  }

  interface DurableObjectId {
    toString(): string
  }

  interface DurableObjectStub {
    fetch(request: Request): Promise<Response>
  }

  interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId
    get(id: DurableObjectId): DurableObjectStub
  }

  interface DurableObjectState {
    readonly id: DurableObjectId
    waitUntil(promise: Promise<unknown>): void
  }
}
