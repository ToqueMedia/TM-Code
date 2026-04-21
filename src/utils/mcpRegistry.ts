import { CANVA_MCP_NAME, CANVA_MCP_URL, CANVA_MCP_CONFIG } from './canvaMcp'

/**
 * Curated registry of first-party / well-known remote MCP integrations.
 *
 * Adding an entry here makes the integration available via `/mcp-install <name>`.
 * Keep this list narrow and **verified against the vendor's own documentation** —
 * users with arbitrary MCPs can still hand-edit `~/.toquemedia-studio/mcp.json`.
 *
 * Current constraints:
 *   - Only remote-transport (URL-based) integrations are supported.
 *   - stdio / API-key based integrations (e.g. Gamma, which requires GAMMA_API_KEY
 *     via an npx wrapper) are out-of-scope until the registry + install flow
 *     handle `command / args / env` config shape.
 *
 * Each URL below was verified against the vendor's official docs before shipping
 * — do NOT add URLs you have not read from the vendor's own site. A 404 from a
 * fabricated URL looks like an install bug to users.
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

export const MCP_REGISTRY: McpRegistryEntry[] = [
  {
    name: CANVA_MCP_NAME,
    label: 'Canva',
    url: CANVA_MCP_URL,
    description: 'Designs, branded decks, PDF/PPT export. Free tier available; Pro unlocks brand kits and premium assets.',
    category: 'design',
    auth: 'oauth-browser',
    postInstallNote: 'First Canva tool call will open canva.com in your browser to complete authentication.',
    docsUrl: 'https://www.canva.dev/docs/mcp/',
    // Canva keeps richer, OAuth-upfront phrasing for its historical /canva-connect flow.
    messageKeys: {
      installing: 'cmd.canva.connecting',
      installed: 'cmd.canva.connected',
      registered: 'cmd.canva.registered',
      alreadyInstalled: 'cmd.canva.alreadyConnected',
    },
  },
  {
    name: 'figma',
    label: 'Figma',
    url: 'https://mcp.figma.com/mcp',
    description: 'Read Figma files, extract design tokens, inspect components. Pairs with the frontend-design skill.',
    category: 'design',
    auth: 'oauth-browser',
    postInstallNote: 'First Figma tool call opens figma.com for authentication. Available on all seats and plans.',
    docsUrl: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/',
  },
  {
    name: 'notion',
    label: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    description: 'Query and update Notion pages and databases. OAuth per workspace.',
    category: 'docs',
    auth: 'oauth-browser',
    postInstallNote: 'First Notion tool call opens notion.so to authorize workspace access.',
    docsUrl: 'https://developers.notion.com/docs/mcp',
  },
  {
    name: 'linear',
    label: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    description: 'Create and query Linear issues, cycles, and projects. Streamable HTTP transport.',
    category: 'dev-tools',
    auth: 'oauth-browser',
    postInstallNote: 'First Linear tool call opens linear.app for OAuth 2.1 authentication.',
    docsUrl: 'https://linear.app/docs/mcp',
  },
]

/** Build the MCP config entry for a registry item. */
export function buildConfigEntry(entry: McpRegistryEntry): { url: string; transport: 'remote' } {
  if (entry.name === CANVA_MCP_NAME) return CANVA_MCP_CONFIG
  return { url: entry.url, transport: 'remote' }
}

export function findRegistryEntry(name: string): McpRegistryEntry | undefined {
  const lower = name.toLowerCase()
  return MCP_REGISTRY.find(e => e.name.toLowerCase() === lower || e.label.toLowerCase() === lower)
}
