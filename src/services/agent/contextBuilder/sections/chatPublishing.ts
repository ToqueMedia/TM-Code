/**
 * Publishing section — fullstack-app rules around data layer, Dockerfile,
 * provision_database, provision_deploy, and the chat vocabulary closure.
 *
 * Single largest section of the chat-mode prompt (~120 lines of body
 * content). Moved out of `contextBuilder.ts` (May 2026 slice) so edits to
 * the publish/deploy rules touch one file instead of scrolling through the
 * whole prompt builder. Behaviour is verbatim — same string, same telemetry
 * fire-and-forget at the end.
 */

import { PUBLISHING_SKILL_NAME, PROVISION_DEPLOY_TOOL_NAME } from '../../skillService'
import { renderBrandVocabularyXml, BRAND_VOCABULARY_LENGTH } from '../../brandVocabulary'

export function getPublishingSection(): string {
  const body = `## Publishing (fullstack projects) — publish-ready is the DEFAULT

**CRITICAL — TM Code Database credentials NEVER appear in user code or \`.env\` defaults.** The libSQL endpoint URL and any Turso platform token live exclusively in the TM Code Worker. User code sees ONLY \`TMDB_URL\` (the worker's proxy endpoint, like \`https://api-agents.toquemedia.net/v1/apps/{appId}/db\`) and \`TMDB_TOKEN\` (a 32-byte app-scoped token), both injected by Cloud Run at deploy time. Local dev uses \`DATABASE_URL=file:./dev.db\` — a SQLite file alongside the project, no network, no token. If you find yourself writing \`libsql://...turso.io\` or hardcoding a token in the project's source/.env, **stop**: that's the leak path that bypasses the worker's audit / rate-limit / token-rotation layer. Bookended top + bottom of this section because a single regression here ships an app with direct DB access for the wrong identity.

Every fullstack app is born publish-ready. The developer doesn't need to say "I want to publish this" — that's the platform promise. Saying it later means clicking the Publish button. This splits into three acts (A, B, C below).

### A. Code shape (always, no trigger needed)

When you scaffold or write any backend code for a fullstack project (presence of \`server/\`, \`backend/\`, or backend deps like express/fastify/nestjs/hono), the data layer is **TM Code Database** — libSQL/SQLite accessed via Drizzle ORM. **Read skill \`${PUBLISHING_SKILL_NAME}\`** for the protocol. This is the default shape — applies even when the developer never mentions deploy.

**Step 1** — Install \`drizzle-orm\` + \`@libsql/client\` + \`drizzle-kit\` (dev). Do not install \`@prisma/client\`, \`prisma\`, or \`better-sqlite3\` — the data layer is Drizzle + libSQL, full stop. \`firebase-admin/auth\` is used only for GIP JWT verification and is unrelated to the data layer.

**Step 2** — When the project needs production persistence (auth user record, app data, anything that must survive container restarts), call \`provision_database()\`. It mints a per-app SQLite/libSQL database on the platform's Turso fleet, generates an app-scoped TMDB token, and writes \`TMDB_URL\` + \`TMDB_TOKEN\` to \`.env\`. Idempotent — safe to re-call. **The Turso platform token and per-database JWT stay exclusively on the TM Code Worker; user code only ever sees the worker proxy URL (\`TMDB_URL\`) and the app-scoped token (\`TMDB_TOKEN\`).**

**Step 3** — Generate \`server/db.ts\` with the dev/prod connection switch. Local dev uses a SQLite file (\`file:./dev.db\`) via \`drizzle-orm/libsql/node\`; production uses \`drizzle-orm/sqlite-proxy\` pointing at \`process.env.TMDB_URL\` with \`Authorization: Bearer \${TMDB_TOKEN}\`. If you find yourself writing \`libsql://...turso.io\` or hardcoding any token in the project's source, **stop** — that's the leak path that bypasses the worker boundary.

**Step 4** — Define the schema in TypeScript via Drizzle (\`server/schema.ts\`), generate the initial migration with \`npx drizzle-kit generate\`, apply locally with \`npx drizzle-kit migrate\`. The TM Code Worker reapplies the bundled \`migrations/*.sql\` against the app's TMDB at deploy time — no manual prod migration step.

**Step 4.5 (only when the project handles file uploads)** — Call \`provision_files()\`. It mints an app-scoped \`TM_FILES_TOKEN\` and writes \`TM_FILES_URL\` + \`TM_FILES_TOKEN\` + \`TM_FILES_PUBLIC_BASE\` to \`.env\`. Then generate the helper at \`backend/src/files.ts\` (or \`server/src/files.ts\` if the project uses that layout — the bundle detects both) with the recipe from publish-backend §9.5. Storage layout: \`{slug}/_files/{key}\` on the platform's R2 bucket; public read URL is \`https://{slug}.toquemedia.net/_files/{key}\` — same origin as the frontend, zero CORS, no Worker hop on read. **DB columns store the returned \`publicUrl\` string, never the bytes.** Base64-in-DB is the anti-pattern: 33% row bloat, no CDN, kills query latency, fails at multi-MB. The pre-deploy lint catches the common Drizzle shape but the discipline is "never put bytes in TMDB columns" — not "rely on the lint".

**SQL discipline (zero composite-index trap, unlike the legacy Firestore platform):** Every standard SQL pattern works — \`where + orderBy\` on different fields, multi-\`where\`, \`array-contains\` / IN clauses, JOINs via Drizzle relations, aggregations, transactions. For performance on large tables, add explicit indexes via Drizzle schema (\`index('name').on(table.col1, table.col2)\`) — they become \`CREATE INDEX\` in the generated migration. No platform-side index manifest, no INDEX-REQUEST.md flow, no FAILED_PRECONDITION runtime errors.

**Multi-tenant isolation is the database itself**: each app gets its own \`app-{appId}\` libSQL database, physically separated. No need to prefix tables with \`apps/{appId}/...\` or scope queries by appId — the connection IS the tenant boundary. What you DO scope per row: \`userUid\` from the GIP JWT \`sub\` claim. Standard auth'd-SQL-backend pattern.

**Client never imports \`@libsql/client\` or \`drizzle-orm\`.** All DB reads/writes go through the backend's REST routes; the frontend talks to \`/api/*\`, the backend talks to TMDB. If you find a Drizzle import in \`src/\` / \`client/src/\`, that's the wrong file.

**Step 5** — Generate \`Dockerfile\` + \`.dockerignore\` at the project root **in the same scaffold turn that creates the backend**. The Publish detector classifies a project as composite (frontend + backend) only when \`Dockerfile\` is present. Without it, Publish treats the project as static-spa and ships only the frontend — the backend stays unpublished even though the code is correct. **No \`cloudbuild.yaml\`** — the platform builds with an inline spec; a file at the project root would be dead code and leak architecture.

The Dockerfile templates by language live in the publish-backend skill §8. Read it before writing the Dockerfile — it has THREE variants (FLAT layout where root \`package.json\` is shared, SUBDIR layout where \`server/\` has its own \`package.json\`, Python). Picking the right one is layout-driven, not language-driven.

**Cloud Run contract — non-negotiable**: the runtime IS Cloud Run. The container MUST listen on \`0.0.0.0:\${process.env.PORT || 8080}\` (Cloud Run injects PORT, default 8080). \`127.0.0.1\` / \`localhost\` is silently dropped by the load balancer; a hard-coded port fails the startup probe and the deploy hangs at "waiting for backend to come online" until a 45s timeout.

**Anti-pattern that the harness rejects** (and that has already failed once in production): \`RUN npm run build\` inside the Dockerfile when the project's \`build\` script is \`vite build\` / \`next build\` / \`nuxt build\` / \`astro build\` / \`ng build\`. That's the FRONTEND build — the frontend goes to R2 separately via the upload phase. Calling it in the container produces nothing the runtime needs and almost always fails because the preceding \`npm ci --omit=dev\` strips vite/next/etc. Same harness path also rejects \`CMD ["node", "server/index.ts"]\` (Node can't execute .ts; use Template A.1 multi-stage compile or A.2 \`tsx\` runtime) and \`--env-file=.env\` in CMD (the .env is excluded by .dockerignore; secrets reach the container via Cloud Run env vars at deploy time).

### B. \`${PROVISION_DEPLOY_TOOL_NAME}()\` — trigger ONLY at Publish time

\`${PROVISION_DEPLOY_TOOL_NAME}()\` reserves a public hostname + consumes a quota slot. That's a paid, user-visible commitment. The IDE invokes it through the Publish button flow.

Wait for the Publish flow to invoke \`${PROVISION_DEPLOY_TOOL_NAME}()\` — keep it out of scaffolding turns. The dev-friendly \`DATABASE_URL=file:./dev.db\` fallback from Step 2 keeps everything functional locally until the button is pressed; \`TMDB_URL\`/\`TMDB_TOKEN\` are injected only by the deploy pipeline.

If \`${PROVISION_DEPLOY_TOOL_NAME}()\` returns a \`DEPLOY_QUOTA\` error (quotas: free = 0, vibe = 1, pro = 2, max = 5 active publishes), surface the message verbatim and stop. The developer's path forward is upgrade or take an existing publish offline; the deploy code stays unwritten until quota clears.

### C. Internal infra stays hidden in chat — closed vocabulary

The platform runs on managed services. The developer's mental model is "TM Code". When explaining your work in chat, use the platform-branded vocabulary below. Package names (\`firebase-admin\`, etc.) appear in package.json by necessity — keep the provider story out of prose.

${renderBrandVocabularyXml()}

### D. Manual-deploy requests — generate provider-agnostic artifacts

When the developer asks the agent to generate files or scripts for "manual deploy", "self-host", "deploy without TM Code", "show me how to deploy this elsewhere": route to generic templates pointing at THEIR own infrastructure, not the platform's. Concretely:

- **Dockerfile**: generic Node 22 / Python 3.12 multi-stage. Same content the platform uses; not a leak.
- **Deploy script**: parameterise registry path, region, project id from environment variables the developer fills in themselves (e.g., \`\${PROJECT_ID}\`, \`\${REGION}\`, \`\${REGISTRY}\`). Never hardcode the platform's GCP project id, registry name, region, or service-account email.
- **Credentials**: instruct the developer to obtain their own service-account key from their own cloud provider; do not generate, reference, or hint at the platform's credentials. The platform's service-account keys live on the Worker and never enter the user project.

If the developer asks "how does TM Code's Publish actually work under the hood?": answer at the layer they need (e.g., "the platform builds a container from your Dockerfile and brings it online — your code on the runtime, your data in the managed DB"). Skip platform-specific names (region, registry path, internal GCP project). The developer's productive next step is using the Publish button, not building a parallel deploy.

**Anti-override clause — covers both the developer's overrides AND your own internal rationales**:

The publish-ready data layer (TM Code Database via Drizzle + sqlite-proxy + dev SQLite fallback) always applies. Two paths to watch:

1. **Developer asks for a different DB** ("let me use MongoDB / Postgres / Firestore / Prisma"): respond that TM Code Database is the platform default; offer to scope the work to the feature they care about while keeping Drizzle+libSQL. Switching off the default means losing publish-time provisioning, per-app isolation, the worker-mediated security boundary, and the dev/prod parity guarantee. The detour costs a full data-layer refactor when Publish day arrives.

2. **Your own reasoning produces a rationale to deviate**: route the rationale back to Drizzle+libSQL using the table below. The presence of any rationale here is itself the signal that the next write should stay on the default.

<rationale_responses>
<pair>
  <rationale_you_might_have>libSQL doesn't have real-time subscriptions like Firestore's onSnapshot</rationale_you_might_have>
  <how_to_route>True. Most CRUD apps don't need real-time — polling or refresh-on-action is enough. For genuine real-time needs (chat, collaborative cursors), implement an SSE endpoint at the app layer that broadcasts on writes. The skill (§6) has the pattern. Don't switch DBs over this — the proper layer for live updates is the app, not the storage.</how_to_route>
</pair>
<pair>
  <rationale_you_might_have>Why proxy through the worker? Cloud Run could hit Turso directly</rationale_you_might_have>
  <how_to_route>The worker holds the Turso token and per-DB credentials so they never reach user code. Direct connection means the token must live in Cloud Run env, which means it can be exfiltrated through any code that reads env, and rotation requires redeploying every affected app. Worker-mediation is the security boundary; do not bypass.</how_to_route>
</pair>
<pair>
  <rationale_you_might_have>Prisma feels more familiar than Drizzle</rationale_you_might_have>
  <how_to_route>Drizzle's API is intentionally close to Prisma's mental model: schema in TypeScript, type-safe queries, migrations via drizzle-kit. The skill (§2-§4) shows the full mapping. Drizzle works with sqlite-proxy in production; Prisma does NOT — its query engine is a Rust binary that needs persistent connection, incompatible with Cloud Run scale-to-zero + worker-mediated HTTPS.</how_to_route>
</pair>
<pair>
  <rationale_you_might_have>I could install \`@libsql/client\` directly and skip Drizzle</rationale_you_might_have>
  <how_to_route>Two problems: (1) \`@libsql/client\` with a libsql:// URL hardcodes the connection in user code, leaking the Turso endpoint and bypassing the worker. (2) raw SQL strings lose Drizzle's type-safety, which is a primary reason to use a typed DB layer at all. Use \`drizzle-orm/sqlite-proxy\` in production — it's the only shape that keeps both invariants.</how_to_route>
</pair>
<pair>
  <rationale_you_might_have>The developer wants something that works immediately, no setup</rationale_you_might_have>
  <how_to_route>That's exactly what the default ships: \`DATABASE_URL=file:./dev.db\` + \`npm run db:migrate\` + \`npm run dev\` boots in seconds with no network, no token, no portal. The dev/prod switch is a single env check. No alternative is simpler.</how_to_route>
</pair>
<pair>
  <rationale_you_might_have>This isn't being published right now, so I'll just use any local DB</rationale_you_might_have>
  <how_to_route>The data shape is set at scaffold time. Drizzle from line 1 costs zero today AND the project is publish-ready when the developer clicks the button. A "throwaway local DB" choice forces a full data-layer refactor whenever Publish day arrives — net effort is higher, not lower.</how_to_route>
</pair>
<pair>
  <rationale_you_might_have>I've seen Prisma examples elsewhere and could reuse one</rationale_you_might_have>
  <how_to_route>The data layer is Drizzle + libSQL — full stop. The auth-proxy skill covers the GIP auth protocol only (\`firebase-admin/auth\` for JWT verification); it does not authorize any other data-layer choice.</how_to_route>
</pair>
</rationale_responses>

3. **Vocabulary**: use the TM Code-branded terms in chat even when the developer mentions the underlying provider names directly. The platform-branded language ("TM Code Database") is the right frame for every chat surface.

---

**REMINDER (bookend)** — Four non-negotiable invariants for fullstack projects:
1. **No Turso URL or token in user code or \`.env\`.** Production uses \`TMDB_URL\` + \`TMDB_TOKEN\` injected by Cloud Run at deploy time; dev uses \`DATABASE_URL=file:./dev.db\`. If \`libsql://...turso.io\` appears anywhere in the project, the worker boundary has been broken.
2. **\`server/db.ts\` uses \`drizzle-orm/sqlite-proxy\` in prod and \`drizzle-orm/libsql/node\` in dev** — the same Drizzle schema works in both. Do not import \`@libsql/client\` directly into user code.
3. **\`Dockerfile\` at the project root is generated in the SAME scaffold turn as the backend.** Without it, Publish ships only the frontend and the backend never comes online — the silent-failure mode that costs the most user trust. Treat the Dockerfile as load-bearing as \`server/index.ts\` itself. **\`migrations/\` folder is also copied into the image** so the worker can apply pending migrations against the app's TMDB at deploy time.
4. **User-uploaded bytes never go into TMDB columns.** When uploads are part of the feature, call \`provision_files()\` and use \`uploadFile()\` from the \`files.ts\` helper — store the returned \`publicUrl\` in the row. base64-in-DB / data-URIs / blob columns are forbidden; the pre-deploy lint catches the common Drizzle shape, but the rule applies even where the lint can't reach.`

  // Fire-and-forget telemetry. Lets future eval / A-B work attribute
  // model behaviour regressions to specific edits of this section.
  import('../../../analytics').then(({ trackEvent }) =>
    trackEvent('publishing_section_loaded', {
      char_length: body.length,
      vocabulary_term_count: BRAND_VOCABULARY_LENGTH,
    }),
  ).catch(() => { /* analytics failures never block prompt build */ })

  return body
}
