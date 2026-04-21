import type { McpServerState } from '../stores/mcpStore'

/**
 * Canonical Canva MCP config — remote transport, OAuth handled by Canva on first use.
 * Pre-registered in CMD mode so the user can enable it via `/canva-connect`.
 */
export const CANVA_MCP_NAME = 'canva'
export const CANVA_MCP_URL = 'https://mcp.canva.com/mcp'

export const CANVA_MCP_CONFIG = {
  url: CANVA_MCP_URL,
  transport: 'remote' as const,
}

/**
 * Optional URL-lookup function, typically `MCPService.getServerUrl.bind(...)`.
 * Passed in by the caller so this helper stays pure and testable. When omitted,
 * detection falls back to name-only matching.
 */
export type UrlLookup = (name: string) => string | undefined

/**
 * True when a running MCP server is the official Canva MCP. Matching rules:
 *   1. If a URL lookup is provided, the definitive signal is the server URL —
 *      this avoids false positives from user-renamed "canva-helper" entries or
 *      unrelated MCPs that happen to ship a tool with "canva" in the name.
 *   2. Without a URL lookup, fall back to exact name match on the canonical server name.
 */
export function isCanvaConnected(
  servers: McpServerState[],
  urlLookup?: UrlLookup,
): boolean {
  return servers.some(s => {
    if (s.status !== 'running') return false
    if (urlLookup) {
      const url = urlLookup(s.name)
      return url === CANVA_MCP_URL
    }
    return s.name.toLowerCase() === CANVA_MCP_NAME
  })
}
