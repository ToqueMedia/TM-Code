export class HttpError extends Error {
  readonly status: number
  readonly type: string

  constructor(status: number, type: string, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.type = type
  }
}

export function jsonError(status: number, type: string, message: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        type,
        message,
      },
    }),
    {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
    },
  )
}

export function methodNotAllowed(): Response {
  return jsonError(405, 'tm_method_not_allowed', 'Method not allowed.')
}
