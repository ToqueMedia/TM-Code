import FirebaseAuthService from '../auth/firebaseAuth'
import { tauriFetch } from '../tauriFetch'
import { t } from '@/i18n'

/**
 * Remote MCP transport — proxies JSON-RPC requests through the Worker API
 * to reach remote MCP servers. Includes SSRF protection on the server side.
 */

const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'http://localhost:8787'

export interface RemoteMCPRequest {
  serverUrl: string
  method: string
  params: unknown
}

export interface RemoteMCPResponse {
  result?: unknown
  error?: { code: number; message: string }
}

const MAX_RETRIES = 3
const BACKOFF_MS = [500, 1500, 4000]

function isRetryableStatus(status: number): boolean {
  // 408 Request Timeout, 429 Too Many Requests, 5xx — worth another try.
  return status === 408 || status === 429 || status >= 500
}

/**
 * Send a JSON-RPC request to a remote MCP server via the Worker proxy.
 * The Worker validates the URL (blocks private IPs) and forwards the request.
 *
 * Retries on network errors and retryable HTTP statuses with exponential backoff.
 * Auth errors (401/403), bad requests (400), and JSON-RPC errors fail fast.
 */
export async function sendRemoteMCPRequest(request: RemoteMCPRequest): Promise<unknown> {
  const firebaseAuth = FirebaseAuthService.getInstance()
  const idToken = await firebaseAuth.getIdToken()

  if (!idToken) {
    throw new Error(t('mcp.notAuthenticated'))
  }

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await tauriFetch(`${WORKER_URL}/v1/mcp-proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          serverUrl: request.serverUrl,
          method: request.method,
          params: request.params,
        }),
        timeoutSecs: 30,
      })

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        const err = new Error(t('mcp.proxyError').replace('{status}', String(response.status)).replace('{body}', errorBody))
        if (isRetryableStatus(response.status) && attempt < MAX_RETRIES) {
          lastError = err
          await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]))
          continue
        }
        throw err
      }

      const data = (await response.json()) as RemoteMCPResponse

      if (data.error) {
        const err = new Error(t('mcp.remoteError').replace('{message}', data.error.message).replace('{code}', String(data.error.code)))
        ;(err as any).__mcpRemote = true
        throw err
      }

      return data.result ?? data
    } catch (e) {
      // Network/timeout errors from tauriFetch surface as thrown Errors — retry.
      if (attempt < MAX_RETRIES && !(e instanceof Error && (e as any).__mcpRemote)) {
        lastError = e instanceof Error ? e : new Error(String(e))
        await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]))
        continue
      }
      throw e
    }
  }

  throw lastError ?? new Error(t('mcp.proxyExhausted'))
}

/**
 * Discover tools from a remote MCP server.
 *
 * MCP spec: each tool may carry an optional `annotations.readOnlyHint` flag
 * indicating the tool does not modify its environment. We surface this so the
 * agent's concurrency-safe tool pool can run multiple read-only MCP tools in
 * parallel.
 */
export async function discoverRemoteTools(
  serverUrl: string
): Promise<Array<{
  name: string
  description: string
  inputSchema: Record<string, unknown>
  readOnlyHint?: boolean
}>> {
  const result = (await sendRemoteMCPRequest({
    serverUrl,
    method: 'tools/list',
    params: {},
  })) as {
    tools?: Array<{
      name: string
      description: string
      inputSchema: Record<string, unknown>
      annotations?: { readOnlyHint?: boolean }
    }>
  }

  return (result?.tools || []).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    readOnlyHint: t.annotations?.readOnlyHint === true ? true : undefined,
  }))
}

/**
 * Call a tool on a remote MCP server.
 */
export async function callRemoteTool(
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const result = await sendRemoteMCPRequest({
    serverUrl,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  })

  // Extract text content from MCP response format
  const content = result as { content?: Array<{ type: string; text?: string }> }
  if (content?.content) {
    return content.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('\n')
  }

  return JSON.stringify(result)
}
