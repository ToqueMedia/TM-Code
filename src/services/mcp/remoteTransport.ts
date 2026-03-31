import FirebaseAuthService from '../auth/firebaseAuth'

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

/**
 * Send a JSON-RPC request to a remote MCP server via the Worker proxy.
 * The Worker validates the URL (blocks private IPs) and forwards the request.
 */
export async function sendRemoteMCPRequest(request: RemoteMCPRequest): Promise<unknown> {
  const firebaseAuth = FirebaseAuthService.getInstance()
  const idToken = await firebaseAuth.getIdToken()

  if (!idToken) {
    throw new Error('Not authenticated — cannot proxy MCP request')
  }

  // 30s timeout to match stdio transport timeout in Rust backend
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)

  let response: Response
  try {
    response = await fetch(`${WORKER_URL}/v1/mcp-proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        serverUrl: request.serverUrl,
        method: request.method,
        params: request.params,
      }),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timeout)
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`MCP remote request timed out after 30s (method: ${request.method})`)
    }
    throw err
  }
  clearTimeout(timeout)

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(`MCP proxy error (${response.status}): ${errorBody || response.statusText}`)
  }

  const data = (await response.json()) as RemoteMCPResponse

  if (data.error) {
    throw new Error(`Remote MCP error: ${data.error.message} (code: ${data.error.code})`)
  }

  return data.result ?? data
}

/**
 * Discover tools from a remote MCP server.
 */
export async function discoverRemoteTools(
  serverUrl: string
): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> {
  const result = (await sendRemoteMCPRequest({
    serverUrl,
    method: 'tools/list',
    params: {},
  })) as { tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }

  return result?.tools || []
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
