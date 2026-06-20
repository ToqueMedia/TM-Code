// Collab signaling worker — entry point.
//
// Single responsibility: route a WebSocket upgrade at `/v1/collab/:teamId` to
// the team's SignalingRoom Durable Object (one instance per team). Everything
// else 404s. All auth + presence logic lives in the DO.

import { HttpError, jsonError } from './errors'
import type { Env } from './types'

export { SignalingRoom } from './signalingRoom'

const ROUTE = /^\/v1\/collab\/([^/]+)\/?$/

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    const match = ROUTE.exec(url.pathname)
    if (!match) {
      return jsonError(new HttpError(404, 'tm_not_found', 'Not found.'))
    }

    const room = decodeURIComponent(match[1])
    if (!room) {
      return jsonError(new HttpError(400, 'tm_bad_request', 'Missing team room.'))
    }

    // One DO per team. The room id is forwarded as a header so the DO doesn't
    // have to re-parse the path.
    const id = env.SIGNALING_ROOM.idFromName(room)
    const stub = env.SIGNALING_ROOM.get(id)

    const forwarded = new Request(request.url, request)
    forwarded.headers.set('x-collab-room', room)
    return stub.fetch(forwarded)
  },
}
