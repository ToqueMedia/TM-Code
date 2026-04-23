# Plan — Remote MCP OAuth

**Status:** Not started. Blocks re-enabling Canva, Figma, Notion, Linear in `/mcp-install`.

## The gap

Remote MCP servers published by major vendors (Canva, Figma, Notion, Linear) require
OAuth 2.1 + PKCE + Dynamic Client Registration. TM Code's remote MCP plumbing ships
a plain JSON-RPC proxy that sends no `Authorization` header — every request to the
vendor's `/mcp` endpoint returns `401 invalid_token`.

Observed for each of the four:

```
POST https://mcp.canva.com/mcp
→ HTTP 401
  WWW-Authenticate: Bearer realm="OAuth", error="invalid_token"
```

The same shape from `mcp.figma.com`, `mcp.notion.com`, `mcp.linear.app`.

The previous `/canva-connect` flow surfaced a `postInstallNote` promising that "the
first Canva tool call will open canva.com in your browser to complete authentication"
— but no code exists to honor that promise. The slash command and the four registry
entries have been **removed** until OAuth is built, to avoid shipping a false promise.

## What the MCP spec expects

Auth flow per [MCP Authorization spec (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization):

1. Client sends an initial MCP request (usually `initialize`).
2. Server responds `401` with `WWW-Authenticate: Bearer resource_metadata=<url>` (or `realm`).
3. Client fetches the Protected Resource Metadata at the advertised URL to discover the authorization server.
4. Client fetches `/.well-known/oauth-authorization-server` from the authorization server to discover the `authorization_endpoint`, `token_endpoint`, and `registration_endpoint`.
5. Client registers itself via Dynamic Client Registration (RFC 7591) — or uses a pre-registered `client_id`.
6. Client drives an Authorization Code + PKCE flow in a system browser, captures the callback, exchanges the code for `access_token` + `refresh_token`.
7. Client retries the MCP request with `Authorization: Bearer <access_token>`.
8. Subsequent tool calls pass the bearer token. On `401`, client refreshes the token (or re-runs the full flow if the refresh fails) transparently.

MCP uses **Streamable HTTP** as its transport layer, which additionally needs:

- `initialize` → `notifications/initialized` handshake before `tools/list` or `tools/call`
- `Mcp-Session-Id` header captured from the `initialize` response and re-sent on every subsequent request

The current `/v1/mcp-proxy` worker endpoint does none of this. It fires `tools/list` as the first call with no session header and no auth header.

## Implementation plan

### 1. Detect and parse the `WWW-Authenticate` challenge
- `src/services/mcp/remoteTransport.ts`: on `401`, extract the header, parse `resource_metadata` (or `realm`) URI.
- If parsing fails, surface a clear "MCP server requires OAuth but did not advertise metadata" error instead of the current generic 401.

### 2. OAuth discovery module
- New file `src/services/mcp/oauthDiscovery.ts`.
- `fetchResourceMetadata(url)` → `{ authorization_servers: string[] }`
- `fetchAuthServerMetadata(issuer)` → `{ authorization_endpoint, token_endpoint, registration_endpoint, scopes_supported }`
- Cache per-issuer in-memory + Tauri key-value store (invalidate on 404).

### 3. Dynamic Client Registration (RFC 7591)
- New file `src/services/mcp/dynamicClientRegistration.ts`.
- `registerClient(registration_endpoint, redirect_uri)` → `{ client_id, client_secret? }`.
- Persist the `client_id` + metadata per-issuer in `~/.toquemedia-studio/mcp-oauth.json` so we don't re-register on every run.
- Fallback: allow per-vendor static `client_id` for vendors that don't support DCR.

### 4. Browser OAuth flow + callback capture
- New file `src/services/mcp/browserAuthFlow.ts`.
- Two callback strategies:
  - **Deep link:** `tm-code://oauth/callback?code=…&state=…` via `tauri-plugin-deep-link`. Tauri v2 supports this on macOS/Windows/Linux. Requires `Info.plist` / registry entries at build time.
  - **Local loopback server:** temporary HTTP listener on `127.0.0.1:<random-port>` via `tauri-plugin-http` or a small Rust-side listener. Callback URL is dynamic per flow. Works without OS deep-link registration, but adds firewall prompts on Windows.
- Pick one strategy after validating which vendors accept dynamic loopback (Notion tends to; Canva may require static registered URI).
- PKCE: generate `code_verifier` (43-128 chars, URL-safe random) + `code_challenge = BASE64URL(SHA256(code_verifier))`. Send `code_challenge_method=S256`.
- Open the `authorization_endpoint` URL via `@tauri-apps/plugin-opener`.
- Wait for callback, validate `state` (CSRF guard), return `{ code, state }`.

### 5. Token exchange + refresh
- `exchangeCodeForToken(token_endpoint, code, code_verifier, redirect_uri, client_id)` → `{ access_token, refresh_token, expires_in }`.
- `refreshAccessToken(token_endpoint, refresh_token, client_id)` → same shape.
- Handle `invalid_grant` by clearing the refresh token and falling back to full re-auth.

### 6. Secure token storage
- Use the OS keyring (macOS Keychain / Windows Credential Manager / Linux Secret Service) via `tauri-plugin-stronghold` (Tauri first-party) or `tauri-plugin-keyring`.
- Keys shaped as `mcp-oauth::<issuer>::<scope>`. Never persist in plain JSON.
- Per-user scoping happens naturally via OS keyring (one user = one keychain).

### 7. Wire into the proxy path
- `src/services/mcp/remoteTransport.ts::sendRemoteMCPRequest`:
  - Look up token for the target issuer.
  - Attach `Authorization: Bearer <access_token>` to the outbound request.
  - On `401`, attempt refresh. If refresh fails, trigger the full flow (#4), retry once.
- Worker `/v1/mcp-proxy` (`toquemedia-studio-api/src/index.ts`): accept and forward the `Authorization` header through to the remote MCP server (currently it only sets `Content-Type`).

### 8. MCP session management
- Capture `Mcp-Session-Id` from the `initialize` response and send it on every subsequent request to the same server.
- Emit `initialize` + `notifications/initialized` before `tools/list` in `startRemoteServer`.
- Per-session lifecycle: one session per running MCP server, re-established if the worker restart invalidates it.

### 9. Restore registry + slash commands
Once the flow is proven for one vendor, re-add entries to `MCP_REGISTRY` and restore `/canva-connect` as a user-friendly alias for `/mcp-install canva`.

Suggested order: **Linear** first (simplest OAuth, widely-documented), then Notion, then Canva, then Figma (Figma's MCP is newer, their flow may change).

## Non-goals

- stdio-transport MCPs with `GAMMA_API_KEY`-style env vars — out of scope, tracked separately.
- Supporting user-defined OAuth clients (for self-hosted MCP servers) — possible later; start with Dynamic Client Registration.

## Effort estimate

- #1 + #2 + #8: 1 day (discovery + session plumbing, no crypto)
- #3 + #4 + #5: 2-3 days (PKCE, callback capture, token handling)
- #6: 0.5 day (keyring integration)
- #7: 0.5 day (plumbing into existing transport)
- #9: 0.5 day (registry entries + testing per vendor)

**Total: ~5 days** for a polished implementation covering all four vendors.

## References

- [MCP Authorization spec (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization)
- [RFC 7591 — Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591)
- [RFC 7636 — PKCE](https://datatracker.ietf.org/doc/html/rfc7636)
- [Canva MCP docs](https://www.canva.dev/docs/mcp/)
- [Figma MCP docs](https://developers.figma.com/docs/figma-mcp-server/)
- [Notion MCP docs](https://developers.notion.com/docs/mcp)
- [Linear MCP docs](https://linear.app/docs/mcp)
- `docs/PLAN-GOOGLE-OAUTH-BROWSER.md` — precedent for browser-based OAuth in this codebase (different vendor but similar Tauri plumbing)
