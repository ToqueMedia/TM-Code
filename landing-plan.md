
# `landing-plan.md` — Refactoring Plan: toquemedia-studio web → Landing + Account

> **Critical correction up front:** the prompt says "Next.js web project". It is **not** Next.js. It is a Vite + React 19 + React Router v7 SPA inside a Yarn 4 monorepo (`packages/web`), deployed to **Firebase Hosting** (`packages/web/dist`) — `firebase.json:18-19`, `firebase.prod.json:18-19`. There is no app/pages router and no SSR. The plan below reflects that reality.

> **Backend reality:** the production AI/billing API is the Cloudflare Worker `toquemedia-studio-api` at `~/dev/deskotp/toquemedia-studio-api`, deployed to **`api-agents.toquemedia.net`** (per `wrangler.toml:32`). It serves both TM Code IDE (Tauri) and — once CORS is updated — the rebranded `code.toquemedia.net` web. There is no separate Cloud Run service.

> **Decisions registered (2026-05-02):** Q1 drop showcase · Q4 no PAT endpoint, defer api-keys tab · Q6 downloads via GitHub Releases (`ToqueMedia/TM-Code`) · Q7 rebrand to `code.toquemedia.net`. See §12.

> **Phase 0 audit findings (2026-05-02):**
> - Cross-coupling: `AuthContext.tsx` is clean ✓. The "delete" candidates have **no surprise importers** in surviving code once Q1 (drop showcase) is applied.
> - **Chain deletes confirmed**: `components/layout/Header.tsx` (only consumer is `DevStudioLauncher.tsx` — dies with devStudio) and `utils/sanitizeCode.ts` (only consumers: `aiService.ts`, `exportService.ts`, `useExportCode.ts` — all in deletion zone).
> - Worker (Q3): `blueprints`, `chatMessages`, `projects/{id}/screens`, `projects/{id}/files` are **never read or written by `toquemedia-studio-api`**. Safe to archive 30/60/90 days after the web stops writing.
> - Worker (Q10): zero references to a stale `aiService` Cloud Function URL anywhere in the worker. The `/ai/**` rewrite in `firebase.prod.json:48-52` is dead — confirmed.
> - Collection naming: canonical Firestore collection is `subscription_plans` (snake_case), not `subscriptionPlans`. Web `SubscriptionPlanDAO.ts:18` already matches the worker. Plan tables corrected.
> - `knip`/`depcheck` not configured. Run `npx knip --production` from `packages/web/` after Phase 8 deletions to surface unused deps (Monaco, tree-sitter, jszip, etc.).

---

## 1. Inventory

Repo root: `/Users/ithustle/dev/web/toquemedia-studio`
Frontend: `packages/web/src/` — total ~68k LOC of TS/TSX.

### 1.1 Bucketed by destination

| Bucket | Paths | Size hint |
|---|---|---|
| **DELETE — Prototype Studio** | `packages/web/src/screens/prototypeStudio/` (16 files), `packages/web/src/screens/prototypeCanvas/` (8 files), `packages/web/src/screens/components/PrototypeStudioHeader.tsx`, `packages/web/src/screens/components/PrototypeStudioSideBar/`, `packages/web/src/components/PrototypeViewerModal.tsx`, `packages/web/src/components/ElementSelectionModal/`, `packages/web/src/components/FloatingPropertiesPanel/`, `packages/web/src/hooks/useBlueprints.ts`, `packages/web/src/hooks/usePrototypeGenerator.ts`, `packages/web/src/hooks/useExportCode.ts`, `packages/web/src/repository/BlueprintRepository.ts`, `packages/web/src/database/BlueprintDAO.ts`, `packages/web/src/services/blueprintService.ts` | ~4.5k LOC |
| **DELETE — DevStudio** | `packages/web/src/screens/devStudio/` (entire tree, 60+ files, **~16.7k LOC**), `packages/web/src/components/devStudio/`, `packages/web/src/stores/devStudio/` (~4.9k LOC), `packages/web/src/hooks/devStudio/` (~728 LOC), `packages/web/src/services/devStudio/` (SSEClient, ContextSelectionService, DevStudioProjectService — ~1.4k LOC), `packages/web/src/repository/DevStudioRepository.ts`, `packages/web/src/repository/ChatMessageRepository.ts`, `packages/web/src/database/DevStudioDAO.ts`, `packages/web/src/database/ChatMessageDAO.ts`, `packages/web/src/hooks/useDevStudio.ts`, `packages/web/src/hooks/useDevStudioFirebase.ts`, `packages/web/src/config/monacoConfig.ts`, `packages/web/src/components/diagnostics/`, `packages/web/src/services/exportService.ts`, `packages/web/src/services/aiService.ts` (verify scope), `packages/web/src/services/projectService.ts` (verify scope), `packages/web/src/types/DevStudio.ts`, `packages/web/src/types/promptResponse.ts`, `packages/web/src/types/ProjectComponents.ts` | **~25k LOC** |
| **DELETE — Studio support pages** | `packages/web/src/screens/projects/ProjectsScreen.tsx`, `packages/web/src/screens/showCases/` (3 files — gallery for project previews) | ~1k LOC |
| **REFACTOR — Dashboard → /account** | `packages/web/src/screens/dashboard/` (DashboardScreen.tsx, WelcomeSection, ProjectsSection, StudioCardsSection, QuickActions, Header) — **most code dies; UserSection + part of Header survive as account chrome** | ~1.5k LOC |
| **REFACTOR — Profile → /account** | `packages/web/src/screens/profile/` (ProfileScreen, ProfileHeader, ProfileTabs, BalanceCard, TransactionsCard, SeatsManagement, AdminPanel) — **becomes the spine of /account** | ~2k LOC |
| **KEEP — Landing (expand)** | `packages/web/src/screens/landing/` — index.tsx + 9 sections + 8 sub-pages (login, register, forgot-password, plan-details, terms, privacy, third-party-notices, email-verification) | ~3k LOC |
| **KEEP — Auth (shared with TM Code)** | `packages/web/src/contexts/AuthContext.tsx`, `packages/web/src/lib/auth/` (DDD layout: domain/infrastructure/presentation/interfaces), `packages/web/src/lib/firebase/`, `packages/web/src/components/auth/` (LoginForm, RegisterForm, ForgotPasswordForm, PhoneVerificationModal), `packages/web/src/components/ProtectedRoute.tsx`, `packages/web/src/services/session/SessionService.ts` | ~2k LOC |
| **KEEP — Billing/payments core** | `packages/web/src/components/billing/TokenConsumptionBar.tsx`, `packages/web/src/components/payment/AddCreditsModal.tsx`, `packages/web/src/services/payment/` (PaymentService, DodoPaymentsApi, MulticaixaExpressGpoApi, MomenuPaymentService), `packages/web/src/hooks/usePaymentServiceRepository.ts`, `packages/web/src/screens/checkout/CheckoutPage.tsx`, `packages/web/src/screens/upgrade/UpgradePage.tsx`, `packages/web/src/services/seats/SeatsService.ts`, `packages/web/src/database/SubscriptionPlanDAO.ts`, `packages/web/src/database/CreditPackDAO.ts`, `packages/web/src/database/PlanUpgradeDAO.ts`, `packages/web/src/database/UserDAO.ts`, `packages/web/src/database/TokenManualAdditionDAO.ts` | ~3k LOC |
| **DELETE — Studio-only billing modal** | `packages/web/src/components/payment/ScreenPurchaseModal.tsx` (only used by prototype studio) | ~200 LOC |
| **KEEP — Shared infra** | `packages/web/src/components/ui/` (Chakra wrappers, GradientButton, GradientHeading, PlanCard, FeatureCard, BentoGrid, etc.), `packages/web/src/components/layout/` (LandingHeader survives; Header + DashboardLayout get rewritten), `packages/web/src/contexts/LanguageContext.tsx`, `packages/web/src/locales/`, `packages/web/src/theme/` (brand tokens), `packages/web/src/styles/`, `packages/web/src/utils/`, `packages/web/src/components/ErrorBoundary.tsx`, `packages/web/src/components/LanguageSelector.tsx`, `packages/web/src/components/ConfirmationDialog/`, `packages/web/src/components/TermsBanner.tsx`, `packages/web/src/components/modals/WaitlistModal.tsx`, `packages/web/src/services/HttpService.ts`, `packages/web/src/services/whitelistService.ts`, `packages/web/src/services/uploadService.ts`, `packages/web/src/services/AdminService.ts`, `packages/web/src/hooks/useAuth.ts`, `packages/web/src/hooks/useCountryDetection.ts`, `packages/web/src/hooks/useMessageBox.ts`, `packages/web/src/hooks/useBetaRepository.ts`, `packages/web/src/hooks/usePaymentServiceRepository.ts` | — |
| **DELETE — Showcase + Projects (Q1 closed)** | `packages/web/src/hooks/useShowCaseStore.ts`, `packages/web/src/hooks/useProjects.ts`, `packages/web/src/repository/ProjectRepository.ts`, `packages/web/src/database/ProjectDAO.ts`, `packages/web/src/screens/profile/components/admin/ShowcasesTab.tsx`, `packages/web/src/v2/`, `packages/web/src/mocks/`, `packages/web/src/data/` | ~500 LOC |
| **VERIFY then likely DELETE** | `packages/web/src/screens/profile/components/admin/AdminPanel.tsx` (verify which admin tabs still reference projects/devStudio after the showcase strip) | — |

### 1.2 Routes (`packages/web/src/App.tsx`)

| Route | Status |
|---|---|
| `/` (landing or redirect to dashboard if logged-in) | **CHANGE** — landing only; never redirect |
| `/login`, `/register`, `/forgot-password`, `/recover-account`, `/verify-email` | **KEEP** |
| `/plans` | **KEEP** as marketing page (rename to `/pricing` recommended) |
| `/terms-privacy`, `/privacy-notice`, `/third-party-notices` | **KEEP** |
| `/dashboard` | **DELETE** → 301 to `/account` |
| `/projects` | **DELETE** → 301 to `/account` |
| `/profile` | **DELETE** → 301 to `/account` |
| `/prototype-studio`, `/prototype-studio/editor` | **DELETE** → 301 to `/` (or `/pricing`) |
| `/dev-studio`, `/dev-studio/workspace/:projectId` | **DELETE** → 301 to TM Code download page (`/download` or `/`) |
| `/show-cases`, `/show-cases/preview/:projectId` | **DELETE** → 301 to `/` |
| `/upgrade`, `/checkout/:planId` | **KEEP** — billing flow |

---

## 2. Removal plan

### 2.1 Files / directories to delete (after refactor lands)

```
packages/web/src/screens/prototypeStudio/        # entire tree
packages/web/src/screens/prototypeCanvas/        # entire tree
packages/web/src/screens/devStudio/              # entire tree
packages/web/src/screens/showCases/              # entire tree
packages/web/src/screens/projects/               # entire tree
packages/web/src/screens/dashboard/              # entire tree (rebuilt as /account)
packages/web/src/screens/components/             # PrototypeStudioHeader + sidebar
packages/web/src/stores/devStudio/               # entire tree
packages/web/src/hooks/devStudio/                # entire tree
packages/web/src/hooks/useBlueprints.ts
packages/web/src/hooks/usePrototypeGenerator.ts
packages/web/src/hooks/useExportCode.ts
packages/web/src/hooks/useDevStudio.ts
packages/web/src/hooks/useDevStudioFirebase.ts
packages/web/src/hooks/useShowCaseStore.ts
packages/web/src/hooks/useProjects.ts            # only if no /account widget needs it
packages/web/src/hooks/useAssetGeneration.ts     # verify
packages/web/src/repository/BlueprintRepository.ts
packages/web/src/repository/DevStudioRepository.ts
packages/web/src/repository/ChatMessageRepository.ts
packages/web/src/repository/ProjectRepository.ts # only if no /account widget needs it
packages/web/src/database/BlueprintDAO.ts
packages/web/src/database/DevStudioDAO.ts
packages/web/src/database/ChatMessageDAO.ts
packages/web/src/database/ProjectDAO.ts          # only if no /account widget needs it
packages/web/src/database/BetaDAO.ts             # verify
packages/web/src/services/devStudio/             # entire tree
packages/web/src/services/blueprintService.ts
packages/web/src/services/aiService.ts           # verify scope
packages/web/src/services/projectService.ts      # verify scope
packages/web/src/services/exportService.ts
packages/web/src/components/devStudio/
packages/web/src/components/diagnostics/
packages/web/src/components/PrototypeViewerModal.tsx
packages/web/src/components/ElementSelectionModal/
packages/web/src/components/FloatingPropertiesPanel/
packages/web/src/components/payment/ScreenPurchaseModal.tsx
packages/web/src/components/project/             # DeleteProjectButton — verify
packages/web/src/components/layout/Header.tsx    # only consumer is DevStudioLauncher (audit-confirmed chain delete)
packages/web/src/utils/sanitizeCode.ts           # only consumers: aiService/exportService/useExportCode (audit-confirmed)
packages/web/src/config/monacoConfig.ts
packages/web/src/types/DevStudio.ts
packages/web/src/types/promptResponse.ts
packages/web/src/types/ProjectComponents.ts
packages/web/src/v2/
packages/web/src/mocks/
```

### 2.2 API routes / functions

The frontend doesn't own API routes. The production AI/billing API is the **Cloudflare Worker `toquemedia-studio-api`** at `~/dev/deskotp/toquemedia-studio-api`, deployed to `api-agents.toquemedia.net` (per `wrangler.toml:32`). Firebase Hosting still has a stale rewrite `/ai/**` → `aiService` Firebase Function (`firebase.prod.json:48-52`) that is almost certainly dead — Q10. The worker is reused by TM Code IDE (Tauri).

- **No deletion needed** — there are no Next.js API routes here.
- **One small addition required (not a deletion)**: the worker's `ALLOWED_ORIGINS` (`src/index.ts:132-138`) only whitelists Tauri origins (`tauri://localhost`, `https://tauri.localhost`, `http://localhost:1420`). The new web `/account` will be CORS-blocked when calling `/v1/me`. Need to add `https://code.toquemedia.net` (and during transition `https://studio.toquemedia.net`). One-line PR on `toquemedia-studio-api`.

### 2.3 Database / Firestore — delete nothing destructively

The shared-with-TM-Code project (`maiplayer-ac56d`) holds collections that may or may not still be needed. **Catalog now, decide later** — do not drop in this refactor:

| Collection | Used by | Action |
|---|---|---|
| `users/{uid}` | both (canonical user doc + `tokenBudget`) | **KEEP** |
| `subscriptions/{uid}` | both (TTL'd plan state) | **KEEP** |
| `projects/{id}` | studios (prototype + devStudio); also showcase gallery | **KEEP** (TM Code may still write); just stop reading from web |
| `projects/{id}/screens` (subcol) | prototype studio | **KEEP for now**; mark for archival audit |
| `projects/{id}/files` (subcol) | devStudio (used by warmup restorer per CLAUDE.md) | **KEEP** — TM Code's backend depends on it |
| `blueprints` | prototype studio | **SAFE to archive** — worker confirmed not to read (audit 2026-05-02) |
| `chatMessages` | devStudio chat | **SAFE to archive** — worker confirmed not to read (audit 2026-05-02) |
| `projects/{id}/screens`, `projects/{id}/files` | studios | **SAFE to archive** — worker confirmed not to read (audit 2026-05-02) |
| `creditPacks`, `subscription_plans`, `planUpgrades`, `tokenManualAdditions` | billing (worker reads `subscription_plans`) | **KEEP** |
| `seats/*` | billing seats | **KEEP** |
| `beta`, `whitelist` | onboarding | **KEEP** |

> Decision rule: a collection only goes from "candidate for archival" → "actually deleted" after Célio confirms the worker doesn't read it (open question Q3 below).

### 2.4 Dependencies to drop in `packages/web/package.json`

After the deletions above, run a `knip` or `depcheck` pass. Expected unused:

- `@monaco-editor/react`, `monaco-editor` — only `monacoConfig.ts` + DevStudio CodePanel use them
- `tree-sitter-wasms`, `web-tree-sitter` — only DevStudio context selection
- `react-syntax-highlighter`, `@types/react-syntax-highlighter` — chat code blocks
- `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` — prototype canvas drag-n-drop
- `jszip`, `file-saver`, `@types/file-saver` — export code modal
- `jspdf` — verify (probably export)
- `pexels` — image asset search (likely prototype-only)
- `react-dropzone` — verify (upload card)
- `react-virtuoso` — verify (chat list)
- `minisearch` — devStudio context
- `node-forge` — verify (license decrypt? keep if used by upgrade flow)
- `react-markdown`, `remark-gfm` — chat messages (verify if reused on landing)
- `source-map-js` — error mapping in devStudio errors
- `ip-info-react` — verify (country detection? hook keeps using `useCountryDetection.ts`)

Also remove `tree-sitter-wasms` + `web-tree-sitter` from root `package.json` devDependencies once `scripts/setup-parser.mjs` is no longer needed (postinstall hook in root `package.json:32`).

Estimated bundle reduction: monaco alone is ~3MB gzipped; total post-trim should drop the SPA bundle by **~60-70%**.

---

## 3. Refactor: dashboard + profile → `/account`

### 3.1 New route map (still React Router v7, no router migration)

```
/                       LandingScreen (public, never redirect — even if signed in show "Open account" CTA)
/features               new — feature deep-dive
/pricing                renamed from /plans
/download               new — OS picker for TM Code installers
/blog                   optional, MDX or external
/login, /register, /forgot-password, /verify-email, /recover-account
/terms, /privacy, /third-party-notices    (rename /terms-privacy → /terms)

/account                AccountScreen (protected) — default tab: Overview
/account/billing        BillingTab
/account/subscription   SubscriptionTab
/account/payment-methods PaymentMethodsTab
/account/security       SecurityTab (password, 2FA, sessions)
/account/admin          AdminTab (only if isAdmin from /v1/me)
                        # /account/api-keys is deferred — no worker endpoint (Q4)

/upgrade, /checkout/:planId    KEEP (linked from /account/billing)
```

Use a single nested layout: `AccountLayout` with sidebar nav + tab outlet. React Router v7 `Outlet` inside a parent route handles this cleanly.

### 3.2 File-by-file mapping

| Current | New | Notes |
|---|---|---|
| `screens/profile/ProfileScreen.tsx` | `screens/account/AccountScreen.tsx` | Becomes layout shell |
| `screens/profile/components/ProfileHeader.tsx` | `screens/account/components/AccountHeader.tsx` | Avatar + name + plan pill |
| `screens/profile/components/ProfileTabs.tsx` | DELETE | Replaced by router-driven sidebar nav |
| `screens/profile/components/BalanceCard.tsx` | `screens/account/billing/ConsumptionPanel.tsx` | Wrap `TokenConsumptionBar` |
| `screens/profile/components/TransactionsCard.tsx` | `screens/account/billing/BillingHistory.tsx` | Repurpose |
| `screens/profile/components/SeatsManagement.tsx` | `screens/account/team/SeatsPanel.tsx` | KEEP behind `isPaidPlan` gate |
| `screens/profile/components/AdminPanel.tsx` | `screens/account/admin/AdminPanel.tsx` | Strip ShowcasesTab + any project-management tabs |
| `screens/profile/components/StatsCard.tsx` | DELETE or fold into Overview | |
| `screens/upgrade/UpgradePage.tsx` | `screens/account/subscription/UpgradePage.tsx` (or keep at `/upgrade`) | |
| `screens/checkout/CheckoutPage.tsx` | KEEP at `/checkout/:planId` | Used by upgrade flow |
| `screens/dashboard/Header/{Logo,Navigation,UserSection}.tsx` | `components/layout/account/{Logo,AccountNav,UserMenu}.tsx` | Drop the prototype/dev studio nav items in `Navigation.tsx:26-30` |
| `components/layout/DashboardLayout.tsx` | DELETE / replace | `AccountLayout.tsx` is the new shell |
| `screens/dashboard/DashboardScreen.tsx` | DELETE | Logged-in users land directly on `/account` |
| `screens/dashboard/StudioCardsSection.tsx` | DELETE | Studios are gone |
| `screens/dashboard/WelcomeSection.tsx` | Fold into `AccountOverview.tsx` (greet + plan status + download CTA for desktop) | |
| `screens/dashboard/ProjectsSection.tsx` | DELETE | |

### 3.3 New components needed

- `screens/account/AccountOverview.tsx` — landing tab: greeting, plan badge, consumption summary, "Open TM Code" / "Download TM Code" CTA, recent activity (optional).
- `screens/account/billing/PlanCard.tsx` — current plan card with cycle dates + manage link.
- `screens/account/billing/ConsumptionChart.tsx` — historical usage bars (per-day from a future `consumption_history` collection — Q5).
- `screens/account/billing/UsageMeter.tsx` — wraps existing `TokenConsumptionBar` + adds "Consumo extra" pill from `tokenBudget.extraUsageBalance` (already in `TokenBudgetState`, see `AuthContext.tsx:218-220`).
- `screens/account/payment-methods/PaymentMethodList.tsx` — list cards/MB-Way + add/remove. Backed by Dodo + Multicaixa.
- `screens/account/security/SessionsPanel.tsx` — Firebase Auth session revocation + active devices.
- ~~`screens/account/api-keys/ApiKeysPanel.tsx`~~ — **deferred (Q4)**. No worker endpoint exists for personal access tokens. The IDE auths via Firebase ID token with refresh; nothing for the user to manage on the web today.
- `screens/account/components/AccountSidebar.tsx` — sidebar nav with active state.
- `components/layout/AccountLayout.tsx` — nested router layout shell.

### 3.4 Existing components to repurpose as-is

- `components/billing/TokenConsumptionBar.tsx` — already does cycle %, extra-usage. Keep.
- `components/payment/AddCreditsModal.tsx` — keep, surface from billing tab.
- `components/auth/PhoneVerificationModal.tsx` — keep (gates `/account` until phone verified).
- `components/ui/PlanCard.tsx`, `GradientButton`, `GradientHeading`, `BentoGrid`, `FeatureCard` — used by both landing and account.
- `contexts/LanguageContext.tsx`, `LanguageSelector.tsx`, `locales/` — keep.

---

## 4. New landing-page work

### 4.1 Section inventory (build/refactor inside `screens/landing/`)

| Section | Current | Action |
|---|---|---|
| `LandingHeader` | `components/layout/LandingHeader.tsx` | KEEP, swap CTA from "Studio" to "Download TM Code" + "Sign in → /account" |
| `HeroSection` | exists | Rewrite messaging for desktop IDE; replace `HeroLiveDemo` (currently shows a prototype) with desktop screenshot / video |
| `ProblemSolutionSection` | exists | Tweak copy |
| `FeaturesSection` | exists | Repurpose for IDE features (AI agents, multi-model, sandbox, deploy) |
| `DeploySection` | exists | Reframe as "from prompt to production" |
| ~~`ShowcaseSection`~~ | exists, reads `projects` Firestore collection for `showCase=true` | **DROP (Q1 resolved)** — delete the section + `ProjectDAO`, `ProjectRepository`, `useShowCaseStore`, `useProjects`, `screens/showCases/`, `ShowcasesTab.tsx`. Can re-add as a "Made with TM Code" gallery later if desired. |
| `PlansSection` | exists | Becomes `PricingSection`; keep `PlanCard` |
| `TestimonialsSection` | exists, commented out | Wire up later, leave placeholder |
| `CTASection` | exists | Final "Download TM Code" CTA |
| `FooterSection` | exists | Add legal/sitemap links |
| **New: `DownloadSection`** | — | Detect OS, show download buttons (macOS `.dmg`, Windows `.msi`, Linux `.AppImage`). Source: **GitHub Releases at `ToqueMedia/TM-Code` (Q6)** — fetch `https://api.github.com/repos/ToqueMedia/TM-Code/releases/latest`, pick asset by filename pattern. Cache the response (5–15 min) in `localStorage` to stay well under the 60 req/h unauthenticated limit per IP. |
| **New: `FaqSection`** | — | Static accordion (Chakra `Accordion`) with placeholder Q&A |
| **New: `/features` page** | — | Long-form features deep-dive |
| **New: `/download` page** | — | Standalone OS picker page (canonical destination of in-page Download button) |

### 4.2 Reusable existing pieces

- Brand tokens: `theme/brand.ts` — `brandColors`, `brandGradients`
- Fonts: `@fontsource-variable/geist`, `@fontsource-variable/geist-mono`
- Logos: `public/isologo.svg`, `public/isologo.png`, `public/logo.svg`, `public/momenu-logo.png`
- UI primitives: `components/ui/{GradientButton,GradientHeading,FeatureCard,BentoGrid,SectionBadge,PullQuote,PlanCard}.tsx`

### 4.3 SEO essentials

Current state (`packages/web/index.html`):
- Has `<title>`, description, OG tags, Twitter cards, JSON-LD `SoftwareApplication`, sitemap link, robots verification meta. Good baseline but **all messaging targets the prototype tool** — must be rewritten for TM Code.
- All `studio.toquemedia.net` references → **`code.toquemedia.net`** (Q7). Includes `og:url`, `twitter:url`, JSON-LD `url`, canonical link, sitemap `<loc>` entries.
- `public/sitemap.xml` exists but stale; regenerate with new routes + new host.
- `public/robots.txt` references `/_next/` (Next.js artifact, copy-pasted) — clean it up; update `Sitemap:` entry to `https://code.toquemedia.net/sitemap.xml`.
- Per-route meta tags need a head manager. Vite SPA has no built-in head — recommend `react-helmet-async` (small dep) or hand-rolled per-route effect.
- OG image: replace `/isologo.png` with a proper 1200×630 hero image of TM Code (`public/og-tm-code.png` to be designed).
- Add `<link rel="alternate" hreflang>` for pt/en/fr/zh (LanguageContext supports 4 locales).
- **Firebase Auth authorized domains**: must add `code.toquemedia.net` in the Firebase/GIP console (`maiplayer-ac56d` → Auth → Settings → Authorized domains). Without this, OAuth redirects fail in production. Code-side change is not enough.

### 4.4 Performance budget

Current bundle is bloated by Monaco (~3MB) and tree-sitter wasm. Post-cleanup target:
- LCP < 2.0s on 4G mid-tier mobile
- TTI < 3.5s
- CLS < 0.1
- Bundle: `< 250KB` gzipped initial JS (excluding fonts)
- Lighthouse mobile: ≥ 90 across all four
- Hero image: AVIF + WebP with `<picture>`, eager-load LCP only
- Lazy-load all below-fold sections via `React.lazy` + `Suspense`
- Self-host fonts (already via fontsource); remove `fonts.googleapis.com` preconnect after audit

---

## 5. Auth integration

The existing flow stays intact:

- `AuthProvider` (`contexts/AuthContext.tsx`) wraps the app; provides `user`, `userProfile`, `tokenBudget`, `requiresPhoneVerification`, `signIn*`, `signOut`, `updateUserProfile`.
- Auth uses Firebase Web SDK (`lib/firebase/`) + DDD-layered controller (`lib/auth/`).
- Real-time listeners (`AuthContext.tsx:191-315`):
  - `onSnapshot(users/{uid})` → updates `userProfile.userPlan`, `subscription`, `tokenBudget`
  - `onSnapshot(subscriptions/{uid})` → handles TTL expiry → soft downgrade to `explorer`
- `tokenBudget` hydration: `AuthContext.tsx:245-262` calls `GET {worker}/billing/snapshot` with the Firebase ID token to ensure the user doc has a default `tokenBudget` map. **Do not change this.** TM Code IDE relies on the same shape.
- `ProtectedRoute` component (`components/ProtectedRoute.tsx`) wraps all `/account/**` routes.

**Landing CTAs** route unauthenticated users to `/login` (with `?redirect=/account`). After successful login, `LoginPage` should consume the `redirect` query param (today it just `Navigate`s to `/dashboard` — needs update).

**No changes needed** to GIP tenant or worker auth. Both surfaces (landing CTAs + `/account`) talk to the same `auth.toquemedia.net` flow.

---

## 6. Billing integration on `/account`

Two complementary sources:

**Primary — `GET https://api-agents.toquemedia.net/v1/me`** (worker endpoint, auth: Firebase ID token Bearer). Returns the canonical billing summary in one round-trip with a 5s KV cache:
```json
{
  "plan": "pro",
  "isActive": true,
  "isAdmin": false,
  "billing": {
    "consumedPct": 0.42,
    "tokensConsumed": 1234567,
    "tokenBudget": 3000000,
    "cycleEnd": "2026-06-01",
    "extraUsageBalance": 0,
    "status": "ok"
  }
}
```
Use this on Account load + after upgrade/checkout return. Cheaper and stricter than reading Firestore directly from the SPA.

**Secondary — Firestore listeners (already wired in `AuthContext`)** for *real-time invalidation*:
- `userProfile.userPlan` — current plan id (`explorer` | paid tier ids)
- `userProfile.subscription` — `{ planId, billingCycle, startedAt, expiresAt, paymentMethod }`
- `tokenBudget` — `{ tokensConsumed, cycleStart, cycleEnd, extraUsageBalance, ... }`
- `onSnapshot(users/{uid})` + `onSnapshot(subscriptions/{uid})` trigger a re-fetch of `/v1/me`

Do NOT remove the listeners — they detect cycle resets and plan changes pushed by the worker's billing stream within seconds.

**CORS prerequisite**: add `https://code.toquemedia.net` to `ALLOWED_ORIGINS` in `toquemedia-studio-api/src/index.ts:132-138` before this tab works in production. One-line worker PR.

The `/account/billing` tab needs to:
1. Render plan card (planId + cycle progress in days, derived from `/v1/me` + listener-supplied `subscription.startedAt/expiresAt`)
2. Render `UsageMeter` (already exists as `TokenConsumptionBar` — feed it the `/v1/me` payload)
3. Render "Consumo extra" pill when `billing.extraUsageBalance > 0`
4. Render `BillingHistory` from `planUpgrades`/`tokenManualAdditions` Firestore (existing `TransactionsCard.tsx` already does this — verify shape)
5. Provide upgrade/downgrade flow: link to `/upgrade` (existing) → `/checkout/:planId` (existing)
6. Provide payment-method management:
   - **Recommended decision (Q2)**: keep in-app via `Dodo` + `Multicaixa` flows (already implemented in `services/payment/`). Stripe Customer Portal would require switching providers — out of scope.
   - "Cancelar subscrição": **no worker endpoint exists today**. Either (a) write a `cancellationRequests/{uid}` Firestore doc that the worker (or an out-of-band cron) processes, or (b) defer this action to a future worker PR. Recommendation: defer; add a "Contactar suporte" mailto button in v1.
7. Surface consumption history (optional, Phase 2): requires worker to expose `GET /v1/me/usage-history` (Q5 — out of scope of this refactor).

**Important:** `tokenBudget` snapshot listener already handles cycle reset detection — when the worker rotates `cycleStart`/`cycleEnd`, the UI re-renders automatically. No polling needed; just refetch `/v1/me` on the listener fire to refresh the cached snapshot.

---

## 7. Migration strategy

Recommendation: **Phased, not big-bang.** Two reasons:
1. The auth + billing context is critical and deeply intertwined; staging the rewrite preserves working code while we iterate.
2. Real users may have in-flight subscriptions; we cannot afford a billing regression window.

**Phase order (see §10):**
1. Build new `/account` alongside old `/dashboard`/`/profile` (both routes live).
2. Add 301 redirects + a banner on old routes ("Movemos o teu painel para /account").
3. Build new landing copy (still under feature flag `LANDING_V2=true` if helpful).
4. Cut over `/` to new landing; redirect studio routes to `/`.
5. Delete code in a single PR after a 1-week cooling period.

**Redirect rules** to add in `firebase.prod.json` `hosting.redirects`:

```
/dashboard          → /account               301
/dashboard/*        → /account               301
/profile            → /account               301
/projects           → /account               301
/prototype-studio   → /                      301
/prototype-studio/* → /                      301
/dev-studio         → /download              301
/dev-studio/*       → /download              301
/show-cases         → /                      301
/show-cases/*       → /                      301
/plans              → /pricing               301
/terms-privacy      → /terms                 301
```

**Mid-session safety:** if a logged-in user is on `/dev-studio` when we deploy, the SPA reload after redirect will land them on `/download` with a banner. There's nothing to lose because TM Code IDE is the new editor anyway. For prototype users: their projects in Firestore remain intact even though the editor is gone (Q1 — should we offer an export-on-deprecation tool?).

---

## 8. Risks

1. **`useProjects`/`ProjectDAO` cross-coupling** — `dashboard/DashboardScreen.tsx:21,37` imports `DevStudioDAO` and `useProjects`. The `Header` component (`components/layout/Header.tsx:8,17,21`) calls `loadProjects` on mount unconditionally. This must be removed before deleting `useProjects`, or the new account header will crash.
2. **`AdminPanel` admin tabs** — `screens/profile/components/admin/` includes `ShowcasesTab.tsx` (project-aware). Strip studio-specific tabs but preserve user/billing admin.
3. **Shared `@studio/shared` types** — if we delete `Blueprint`/`Patch`/`GeneratedFile` references on web, the shared package itself stays (worker uses them).
4. **Firestore rules** (`firestore.rules`) reference collections we're abandoning. Audit after deletion to remove obsolete rules — but **carefully**, because TM Code IDE writes to many of the same collections via the worker's admin SDK (which bypasses rules).
5. **CSP** in `firebase.prod.json` allows `cdn.jsdelivr.net`, `unpkg.com`, `cdn.tailwindcss.com` — these are required by *generated* sandbox previews loaded via iframe. Once we delete devStudio + showcase preview, **tighten CSP** to remove these origins. This is a security win, not a liability.
6. **Dodo Payments embedding** — `VITE_DODO_API_KEY` is in client env. If we switch to Stripe Customer Portal (we're not, per §6), we'd need a server hop. Keeping Dodo means keeping the existing flow.
7. **SEO impact** — `/show-cases` may have indexed pages with backlinks. Catch-all 301 to `/` mitigates but loses long-tail traffic. Acceptable.
8. **i18n strings** — `locales/` has hundreds of `prototypeStudio.*` and `devStudio.*` keys. Leave them; deletion is a follow-up.
9. **`prepare-deploy.sh`** in `firebase.prod.json:14` is a custom predeploy step for functions — verify it still passes after dependency cleanup.
10. **PhoneVerificationModal** is rendered inside `DashboardScreen.tsx:142` — must be hoisted into `AccountLayout` so it still gates account access.

---

## 9. Deployment

### 9.1 Where it deploys today

- **Frontend**: Firebase Hosting, project `maiplayer-ac56d`, target inferred from `.firebaserc`. Deploy: `yarn deploy:web` → `firebase deploy --only hosting --config firebase.prod.json`. Output dir: `packages/web/dist`. **New domain: `code.toquemedia.net`** (rebrand from `studio.toquemedia.net`; Cloudflare DNS handled separately by Célio).
- **AI rewrite**: `/ai/**` proxied to Firebase Function `aiService` — **stale**. All AI traffic moved to the Cloudflare Worker at `api-agents.toquemedia.net`. Drop the rewrite + the function (Q10).
- **Worker**: Cloudflare `toquemedia-studio-api` at `api-agents.toquemedia.net` (AI/billing/deploy/admin), plus `showcases.toquemedia.net` for R2 sites. **Untouched except for one CORS allowlist update** to permit the new web origin.

### 9.2 Recommendation: stay on Firebase Hosting

Rationale: auth flow, CSP rules, redirects, and the function rewrite are all already configured. Migration to Cloudflare Pages or Vercel adds risk for zero benefit. Domain rebrand: `studio.toquemedia.net` → **`code.toquemedia.net`** (Q7 resolved). Cloudflare DNS handled separately; Firebase Hosting custom domain + Auth authorized domains updated in code.

### 9.3 Env vars

| Var | Status |
|---|---|
| `VITE_FIREBASE_*` | KEEP (auth + Firestore listeners) |
| `VITE_DODO_API_KEY` | KEEP (billing) |
| `VITE_LICENSE_PUB_KEY` | VERIFY (was used for license decryption — likely studio-related; keep until audit complete) |
| `VITE_USE_EMULATORS` | KEEP |
| `REACT_APP_FIREBASE_FUNCTIONS_URL` | KEEP if `/ai/**` rewrite stays; else DELETE |
| `REACT_APP_NODE_ENV` | KEEP |
| ~~`VITE_TM_CODE_DOWNLOAD_BASE_URL`~~ | NOT NEEDED — downloads come from GitHub Releases at `ToqueMedia/TM-Code` (Q6) |
| New: `VITE_API_BASE_URL` | ADD — `https://api-agents.toquemedia.net` (worker base for `/v1/me` etc.) |

---

## 10. Phases & estimates

| Phase | Scope | Effort |
|---|---|---|
| **0. Audit** | Run `knip`/`depcheck`; confirm with worker which Firestore collections are still read; confirm device-token endpoint for `/account/api-keys`; confirm download manifest | **S** |
| **1. New `/account` shell** | `AccountLayout` + nested router + sidebar + Overview tab + auth gating + redirect from `/dashboard` and `/profile`. Wire existing `BalanceCard`/`SeatsManagement`/`AdminPanel` into new tabs without rewriting them | **M** |
| **2. Billing tab polish** | New `PlanCard`, `UsageMeter` wrapper, `BillingHistory` rebuild, link to `/upgrade`, "Cancelar subscrição" action | **M** |
| **3. Payment methods + security tabs** | Repurpose Dodo/Multicaixa flows; add Firebase session revocation UI; password change | **M** |
| ~~4. API keys / device pairing tab~~ | **DEFERRED** — Q4 confirmed no worker endpoint exists. Add later if we choose to build PAT infrastructure server-side |
| **5. Landing rewrite** | Replace messaging, swap hero demo, add `DownloadSection`, `FaqSection`, `/features`, `/download`, `/pricing` rename | **L** |
| **6. SEO + perf pass** | Per-route head manager, sitemap regen, OG image, robots cleanup, lazy-load sections, font audit | **M** |
| **7. Cutover + redirects** | Add 301s to `firebase.prod.json`; tighten CSP; banner on old routes | **S** |
| **8. Delete dead code** | Delete studios/projects/dashboard files + unused deps in single PR after 1-week cooling | **M** |
| **9. i18n cleanup** | Strip dead keys from `locales/*` | **S** |

Total: roughly 1×L + 4×M + 4×S of focused work.

---

## 11. Out of scope

- TM Code IDE (`exodus-ide`) — no changes
- GIP tenant / Identity Platform configuration
- Billing math, plan definitions, token budget logic (server-owned)
- Firebase Functions (`packages/functions`) — except removing the stale `/ai/**` rewrite (Q10)
- `packages/server`, `packages/cloudflare-worker`, `packages/workers/r2-site-proxy`, `packages/functions`, `packages/shared` source code (only the `web` package is refactored)
- Stripe migration (we are sticking with Dodo + Multicaixa)
- Firestore rules cleanup beyond best-effort comment-marking
- Migrating away from Vite to Next.js (the prompt's premise was incorrect — staying on Vite SPA)
- New endpoints on `toquemedia-studio-api`: API Keys / device tokens (Q4), subscription cancellation, usage-history chart (Q5)

**Two narrow exceptions** to "worker is untouched":

1. **CORS allowlist update** in `toquemedia-studio-api/src/index.ts:132-138` — add `https://code.toquemedia.net` (and `https://studio.toquemedia.net` during transition). One-line PR; required before `/account/billing` works in production.
2. **Optional**: drop the dead `/ai/**` Firebase Function rewrite + the `aiService` Cloud Function once confirmed nothing reads them (Q10).

---

## 12. Open questions for review

### Resolved (2026-05-02)

| # | Decision |
|---|---|
| **Q1** | **DROP** the showcase gallery on landing. No "Made with TM Code" section in v1. Frees us to delete `ProjectDAO`, `ProjectRepository`, `useShowCaseStore`, `useProjects`, `screens/showCases/`, `screens/profile/components/admin/ShowcasesTab.tsx`, and `screens/landing/ShowcaseSection.tsx` (which calls `ProjectDAO.shared.getShowCaseProjects()` at line 68 — confirmed audit). |
| **Q3** | **CONFIRMED** (audit 2026-05-02): worker `toquemedia-studio-api` does NOT read or write `blueprints`, `chatMessages`, `projects/{id}/screens`, or `projects/{id}/files`. Worker only touches `users`, `subscription_plans`, `admin_audit`, `deviceFingerprints`, `projectDeployments`, `subdomains`. The four web-only collections can be archived 30/60/90 days after the web stops writing them. |
| **Q4** | **CONFIRMED: no PAT/device-token endpoint exists.** Worker only accepts Firebase ID tokens. No `apiKeys` collection, no `/v1/account/api-keys` route. **`/account/api-keys` tab is removed from this refactor's scope.** Add it later only after a corresponding worker PR (new collection + 3 routes + middleware fallback). The IDE already authenticates via Firebase ID token with refresh — no functional regression. |
| **Q6** | **GitHub Releases at `https://github.com/ToqueMedia/TM-Code`.** Landing/`/download` calls `https://api.github.com/repos/ToqueMedia/TM-Code/releases/latest` (no auth, 60 req/h per IP — sufficient), detects OS, picks the asset by filename pattern (`.dmg` macOS, `.msi` Windows, `.AppImage` Linux). No new worker endpoint, no static manifest to maintain. `VITE_TM_CODE_DOWNLOAD_BASE_URL` is no longer needed. |
| **Q7** | **Rebrand to `code.toquemedia.net`.** DNS handled separately by Célio in Cloudflare. Code-side changes: `firebase.prod.json` (hosting site + CSP + OAuth domains), `index.html` (`<title>`, `og:url`, `og:image`, `twitter:*`, `<link rel="canonical">`, JSON-LD `SoftwareApplication.url`), `public/sitemap.xml` (regenerate), `public/robots.txt` (new `Sitemap:`), `<link rel="alternate" hreflang>` for pt/en/fr/zh, grep for hard-coded `studio.toquemedia.net` literals, **add `code.toquemedia.net` to Firebase Auth authorized domains** (GIP/Auth console). Also: add to worker `ALLOWED_ORIGINS` (see §11). |
| **Q10** | **CONFIRMED dead** (audit 2026-05-02): worker source has zero references to `aiService` Cloud Function. All AI traffic goes to `api-agents.toquemedia.net/v1/chat/completions`. Drop the `/ai/**` rewrite from `firebase.prod.json:48-52` and the `aiService` Cloud Function. Optional belt-and-braces: tail Functions logs for a week first to catch any rogue caller. |

### Still open

| # | Question |
|---|---|
| **Q2** | **Payment management UX**: in-app via existing Dodo/Multicaixa flows (recommended), or invest in Stripe Customer Portal migration (out of scope as written)? |
| **Q5** | **Consumption history**: do we want a per-day usage chart? If yes, the worker needs to expose `/v1/me/usage-history` (additive, not in scope of this refactor). |
| **Q8** | **Banner messaging**: copy in PT-AO for "your dashboard moved to /account" — Célio to provide. |
| **Q9** | **Old projects access**: do existing prototype/devStudio users need an "export-and-leave" tool, or can their work simply remain in Firestore and be inaccessible from the new web (still readable by TM Code IDE if applicable)? |

---

## Next step

**Resolved (2026-05-02):** Q1, Q3, Q4, Q6, Q7, Q10 — see §12. Phase 0 audit complete.

**Still pending from Célio** (non-blocking for Phase 1):

1. **Q2** — confirm we keep Dodo + Multicaixa in-app (recommended) vs. Stripe Customer Portal migration.
2. **Q5** — per-day usage chart for `/account/billing`? Requires worker work, deferrable.
3. **Q8** — PT-AO copy for "your dashboard moved to /account" banner.
4. **Q9** — export-and-leave tool for prototype/devStudio users? Otherwise their work stays in Firestore, accessible only via TM Code IDE.
5. **Approve the redirect map** in §7 (especially studio routes → `/` vs. `/pricing`).
6. **Approve "stay on Firebase Hosting"** (§9.2) over Cloudflare Pages.
7. **Approve phased migration** (§7) over big-bang rewrite.

**Ready to start now**: Phase 1 (`/account` shell using `/v1/me`). Deletion list for Phase 8 is locked in.

---

### Critical Files for Implementation

- `/Users/ithustle/dev/web/toquemedia-studio/packages/web/src/App.tsx` — the entire route table is rewritten here
- `/Users/ithustle/dev/web/toquemedia-studio/packages/web/src/contexts/AuthContext.tsx` — auth + billing data source for both surfaces; do **not** modify, but every new component reads from it
- `/Users/ithustle/dev/web/toquemedia-studio/packages/web/src/screens/profile/ProfileScreen.tsx` — template/spine for the new `AccountScreen`
- `/Users/ithustle/dev/web/toquemedia-studio/packages/web/src/screens/landing/index.tsx` — landing entry; sections list gets rewritten + extended here
- `/Users/ithustle/dev/web/toquemedia-studio/firebase.prod.json` — hosting config; redirects + CSP tightening land here