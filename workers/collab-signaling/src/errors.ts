// Minimal HttpError mirror of the ai-pass-through worker's errors.ts — kept
// local so this worker bundles independently.

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export function jsonError(error: HttpError): Response {
  return new Response(
    JSON.stringify({ error: { code: error.code, message: error.message } }),
    { status: error.status, headers: { 'content-type': 'application/json' } },
  )
}
