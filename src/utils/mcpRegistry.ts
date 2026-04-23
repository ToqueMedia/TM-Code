/**
 * Curated registry of first-party / well-known remote MCP integrations.
 *
 * Adding an entry here makes the integration available via `/mcp-install <name>`.
 * Keep this list narrow and **verified against the vendor's own documentation** —
 * users with arbitrary MCPs can still hand-edit `~/.toquemedia-studio/mcp.json`.
 *
 * Currently EMPTY — every first-party remote MCP we had researched (Canva, Figma,
 * Notion, Linear) requires OAuth 2.1 + PKCE + Dynamic Client Registration, which
 * TM Code has not yet implemented. The `/v1/mcp-proxy` worker endpoint sends no
 * `Authorization` header, so every request 401s. Shipping entries that always
 * fail was a broken user experience, so the entries have been removed until
 * OAuth lands. See `docs/PLAN-MCP-REMOTE-OAUTH.md` for the implementation plan.
 *
 * Constraints that still apply when adding entries back:
 *   - Only remote-transport (URL-based) integrations are supported.
 *   - stdio / API-key based integrations (e.g. Gamma, which requires GAMMA_API_KEY
 *     via an npx wrapper) are out-of-scope until the registry + install flow
 *     handle `command / args / env` config shape.
 *   - URLs MUST be verified against the vendor's official docs before shipping
 *     — do NOT add URLs you have not read from the vendor's own site. A 404 from
 *     a fabricated URL looks like an install bug to users.
 */

export type McpCategory = 'design' | 'presentation' | 'docs' | 'data' | 'dev-tools'

/** Optional per-entry messages that override the generic /mcp-install output. */
export interface McpMessages {
  /** Shown after config is written, before addSingleServer runs. */
  installing?: string
  /** Shown when the server is running and tools were discovered. */
  installed?: string
  /** Shown when the server registered but tools couldn't be fully discovered (e.g. pending OAuth). */
  registered?: string
  /** Shown when the server is already in the connected state. */
  alreadyInstalled?: string
}

export interface McpRegistryEntry {
  /** Name written into mcp.json under mcpServers.<name>. */
  name: string
  /** Human-readable label shown in listings / install messages. */
  label: string
  /** Canonical remote URL — the definitive signal for detecting this MCP. */
  url: string
  /** Short description used in UI listings (<= ~120 chars). */
  description: string
  category: McpCategory
  /** Auth mechanism the user will encounter on first tool call. */
  auth: 'oauth-browser' | 'api-key-env' | 'none'
  /** Optional note displayed after the user runs /mcp-install. */
  postInstallNote?: string
  /** Home page for user-facing docs. */
  docsUrl?: string
  /** Optional i18n-key overrides for the install flow (richer phrasing than generic). */
  messageKeys?: {
    installing?: string
    installed?: string
    registered?: string
    alreadyInstalled?: string
  }
}

export const MCP_REGISTRY: McpRegistryEntry[] = []

/** Build the MCP config entry for a registry item. */
export function buildConfigEntry(entry: McpRegistryEntry): { url: string; transport: 'remote' } {
  return { url: entry.url, transport: 'remote' }
}

export function findRegistryEntry(name: string): McpRegistryEntry | undefined {
  const lower = name.toLowerCase()
  return MCP_REGISTRY.find(e => e.name.toLowerCase() === lower || e.label.toLowerCase() === lower)
}
