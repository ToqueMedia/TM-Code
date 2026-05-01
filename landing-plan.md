
# `landing-plan.md` — Refactoring Plan: toquemedia-studio web → Landing + Account

> **Critical correction up front:** the prompt says "Next.js web project". It is **not** Next.js. It is a Vite + React 19 + React Router v7 SPA inside a Yarn 4 monorepo (`packages/web`), deployed to **Firebase Hosting** (`packages/web/dist`) — `firebase.json:18-19`, `firebase.prod.json:18-19`. There is no app/pages router and no SSR. The plan below reflects that reality.

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
| **VERIFY then likely DELETE** | `packages/web/src/hooks/useShowCaseStore.ts`, `packages/web/src/hooks/useProjects.ts`, `packages/web/src/repository/ProjectRepository.ts`, `packages/web/src/database/ProjectDAO.ts`, `packages/web/src/screens/profile/components/admin/ShowcasesTab.tsx`, `packages/web/src/screens/profile/components/admin/AdminPanel.tsx` (verify which admin tabs reference projects/devStudio), `packages/web/src/v2/` (only an `image.png`), `packages/web/src/mocks/`, `packages/web/src/data/` | — |

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
packages/web/src/config/monacoConfig.ts
packages/web/src/types/DevStudio.ts
packages/web/src/types/promptResponse.ts
packages/web/src/types/ProjectComponents.ts
packages/web/src/v2/
packages/web/src/mocks/
```

### 2.2 API routes / functions

The frontend doesn't own API routes — Firebase Hosting rewrites `/ai/**` to the `aiService` Firebase Function (`firebase.prod.json:48-52`), and the bulk of AI traffic lives on Cloud Run / `agent.toquemedia.net`. **Don't touch the worker** per scope. Internal to the web app:

- **No deletion needed** — there are no Next.js API routes here. All AI / project / preview endpoints live in `packages/server` (Cloud Run) and are reused by TM Code.

### 2.3 Database / Firestore — delete nothing destructively

The shared-with-TM-Code project (`maiplayer-ac56d`) holds collections that may or may not still be needed. **Catalog now, decide later** — do not drop in this refactor:

| Collection | Used by | Action |
|---|---|---|
| `users/{uid}` | both (canonical user doc + `tokenBudget`) | **KEEP** |
| `subscriptions/{uid}` | both (TTL'd plan state) | **KEEP** |
| `projects/{id}` | studios (prototype + devStudio); also showcase gallery | **KEEP** (TM Code may still write); just stop reading from web |
| `projects/{id}/screens` (subcol) | prototype studio | **KEEP for now**; mark for archival audit |
| `projects/{id}/files` (subcol) | devStudio (used by warmup restorer per CLAUDE.md) | **KEEP** — TM Code's backend depends on it |
| `blueprints` | prototype studio | **CANDIDATE for archival** — confirm nothing in worker reads it |
| `chatMessages` | devStudio chat | **CANDIDATE for archival** — confirm worker doesn't read |
| `creditPacks`, `subscriptionPlans`, `planUpgrades`, `tokenManualAdditions` | billing | **KEEP** |
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
/account/api-keys       ApiKeysTab (TM Code device tokens)
/account/admin          AdminTab (only if userProfile.isAdmin)

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
- `screens/account/api-keys/ApiKeysPanel.tsx` — TM Code device pairing tokens (verify token endpoint exists in worker — Q4).
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
| `ShowcaseSection` | exists, reads `projects` Firestore collection for `showCase=true` | **Decision (Q1)**: keep gallery (needs `ProjectDAO` + `useShowCaseStore` to survive) or drop? Recommendation: **drop** for v1 simplicity since worker still publishes to R2 — can re-add later |
| `PlansSection` | exists | Becomes `PricingSection`; keep `PlanCard` |
| `TestimonialsSection` | exists, commented out | Wire up later, leave placeholder |
| `CTASection` | exists | Final "Download TM Code" CTA |
| `FooterSection` | exists | Add legal/sitemap links |
| **New: `DownloadSection`** | — | Build: detect OS, show download buttons (macOS .dmg, Windows .msi, Linux .AppImage); pulls latest version from a static manifest or a `/v1/releases/latest` worker endpoint (Q6) |
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
- `public/sitemap.xml` exists but stale; regenerate with new routes.
- `public/robots.txt` references `/_next/` (Next.js artifact, copy-pasted) — clean it up.
- Per-route meta tags need a head manager. Vite SPA has no built-in head — recommend `react-helmet-async` (small dep) or hand-rolled per-route effect.
- OG image: replace `/isologo.png` with a proper 1200×630 hero image of TM Code (`public/og-tm-code.png` to be designed).
- Add `<link rel="alternate" hreflang>` for pt/en/fr/zh (LanguageContext supports 4 locales).

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

Data sources (already wired in `AuthContext`):
- `userProfile.userPlan` — current plan id (`explorer` | paid tier ids)
- `userProfile.subscription` — `{ planId, billingCycle, startedAt, expiresAt, paymentMethod }`
- `tokenBudget` — `{ tokensConsumed, cycleStart, cycleEnd, extraUsageBalance, ... }` from `@studio/shared`
- Real-time updates via the existing `onSnapshot(users/{uid})` and `onSnapshot(subscriptions/{uid})`

The `/account/billing` tab needs to:
1. Render plan card (planId + cycle progress in days)
2. Render `UsageMeter` (already exists as `TokenConsumptionBar` — no new fetch needed; `tokenBudget` is on context)
3. Render "Consumo extra" pill when `tokenBudget.extraUsageBalance > 0`
4. Render `BillingHistory` from a `transactions` or `planUpgrades` Firestore subcollection (existing `TransactionsCard.tsx` already does this — verify shape)
5. Provide upgrade/downgrade flow: link to `/upgrade` (existing) → `/checkout/:planId` (existing)
6. Provide payment-method management:
   - **Recommended decision (Q2)**: keep in-app via `Dodo` + `Multicaixa` flows (already implemented in `services/payment/`). Stripe Customer Portal would require switching providers — out of scope.
   - Add a "Cancelar subscrição" action that POSTs to a worker endpoint (Q4 — confirm endpoint exists).
7. Surface consumption history (optional, Phase 2): requires worker to expose `GET /v1/me/usage-history` (Q5).

**Important:** `tokenBudget` snapshot listener already handles cycle reset detection — when the worker rotates `cycleStart`/`cycleEnd`, the UI re-renders automatically. No polling needed.

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

- **Frontend**: Firebase Hosting, project `maiplayer-ac56d`, target inferred from `.firebaserc`. Deploy: `yarn deploy:web` → `firebase deploy --only hosting --config firebase.prod.json`. Output dir: `packages/web/dist`. Domain: `studio.toquemedia.net` (per OG meta).
- **AI rewrite**: `/ai/**` proxied to Firebase Function `aiService` (different from the Cloud Run worker — verify whether this is still active; CLAUDE.md says main AI is on Cloud Run via `agent.toquemedia.net`).
- **Worker**: Cloudflare (`agent.toquemedia.net` for AI/billing, `showcases.toquemedia.net` for R2 sites). **Untouched.**

### 9.2 Recommendation: stay on Firebase Hosting

Rationale: auth flow, CSP rules, redirects, and the function rewrite are all already configured. Migration to Cloudflare Pages or Vercel adds risk for zero benefit. Domain `studio.toquemedia.net` may want to be renamed to `toquemedia.net` or `tmcode.dev` — open question (Q7).

### 9.3 Env vars

| Var | Status |
|---|---|
| `VITE_FIREBASE_*` | KEEP (auth + Firestore listeners) |
| `VITE_DODO_API_KEY` | KEEP (billing) |
| `VITE_LICENSE_PUB_KEY` | VERIFY (was used for license decryption — likely studio-related; keep until audit complete) |
| `VITE_USE_EMULATORS` | KEEP |
| `REACT_APP_FIREBASE_FUNCTIONS_URL` | KEEP if `/ai/**` rewrite stays; else DELETE |
| `REACT_APP_NODE_ENV` | KEEP |
| New: `VITE_TM_CODE_DOWNLOAD_BASE_URL` | ADD (e.g. `https://releases.toquemedia.net`) |

---

## 10. Phases & estimates

| Phase | Scope | Effort |
|---|---|---|
| **0. Audit** | Run `knip`/`depcheck`; confirm with worker which Firestore collections are still read; confirm device-token endpoint for `/account/api-keys`; confirm download manifest | **S** |
| **1. New `/account` shell** | `AccountLayout` + nested router + sidebar + Overview tab + auth gating + redirect from `/dashboard` and `/profile`. Wire existing `BalanceCard`/`SeatsManagement`/`AdminPanel` into new tabs without rewriting them | **M** |
| **2. Billing tab polish** | New `PlanCard`, `UsageMeter` wrapper, `BillingHistory` rebuild, link to `/upgrade`, "Cancelar subscrição" action | **M** |
| **3. Payment methods + security tabs** | Repurpose Dodo/Multicaixa flows; add Firebase session revocation UI; password change | **M** |
| **4. API keys / device pairing tab** | Depends on Q4. If endpoint exists: **S**. If we need worker work: out of scope per constraints |
| **5. Landing rewrite** | Replace messaging, swap hero demo, add `DownloadSection`, `FaqSection`, `/features`, `/download`, `/pricing` rename | **L** |
| **6. SEO + perf pass** | Per-route head manager, sitemap regen, OG image, robots cleanup, lazy-load sections, font audit | **M** |
| **7. Cutover + redirects** | Add 301s to `firebase.prod.json`; tighten CSP; banner on old routes | **S** |
| **8. Delete dead code** | Delete studios/projects/dashboard files + unused deps in single PR after 1-week cooling | **M** |
| **9. i18n cleanup** | Strip dead keys from `locales/*` | **S** |

Total: roughly 1×L + 4×M + 4×S of focused work.

---

## 11. Out of scope

- Cloud Run / Cloudflare worker (`toquemedia-studio-api`) code or endpoints
- TM Code IDE (`exodus-ide`) — no changes
- GIP tenant / Identity Platform configuration
- Billing math, plan definitions, token budget logic (server-owned)
- Firebase Functions (`packages/functions`) — except removing the `/ai/**` rewrite if confirmed unused
- `packages/server`, `packages/cloudflare-worker`, `packages/workers/r2-site-proxy`, `packages/functions`, `packages/shared` source code (only the `web` package is refactored)
- Stripe migration (we are sticking with Dodo + Multicaixa)
- Firestore rules cleanup beyond best-effort comment-marking
- Migrating away from Vite to Next.js (the prompt's premise was incorrect — staying on Vite SPA)

---

## 12. Open questions for review

| # | Question |
|---|---|
| **Q1** | **Showcase gallery on landing**: drop entirely (recommended) or keep as a reduced "Made with TM Code" section? Keeping it requires preserving `ProjectDAO`, `useShowCaseStore`, and the showcase-related Firestore reads. |
| **Q2** | **Payment management UX**: in-app via existing Dodo/Multicaixa flows (recommended), or invest in Stripe Customer Portal migration (out of scope as written)? |
| **Q3** | **Firestore archival**: which of `blueprints`, `chatMessages`, `projects/{id}/screens` can be archived after 30/60/90 days? Need confirmation from worker codebase that nothing reads them. |
| **Q4** | **Device tokens for `/account/api-keys`**: does `toquemedia-studio-api` already expose a device-pairing / personal-access-token endpoint for TM Code IDE? If not, the API Keys tab is deferred. |
| **Q5** | **Consumption history**: do we want a per-day usage chart? If yes, the worker needs to expose `/v1/me/usage-history` (additive, not in scope of this refactor). |
| **Q6** | **Download manifest**: where does the landing page fetch the latest TM Code release URLs from? GitHub Releases? A `/v1/releases/latest` worker endpoint? A static JSON in `public/`? |
| **Q7** | **Domain**: keep `studio.toquemedia.net` or rebrand to `toquemedia.net` / `tmcode.dev` for the marketing site? Affects OG/canonical URLs and DNS. |
| **Q8** | **Banner messaging**: copy in PT-AO for "your dashboard moved to /account" — Célio to provide. |
| **Q9** | **Old projects access**: do existing prototype/devStudio users need an "export-and-leave" tool, or can their work simply remain in Firestore and be inaccessible from the new web (still readable by TM Code IDE if applicable)? |
| **Q10** | **`/ai/**` Firebase Function rewrite** in `firebase.prod.json:50-52` — is `aiService` Cloud Function still in use, or has all AI traffic moved to `agent.toquemedia.net`? If unused, drop the rewrite and the function. |

---

## Next step

**For Célio:** confirm the following before any code changes start:

1. **Q1, Q2, Q6, Q7** — these are product decisions that block landing/account scope.
2. **Q3 + Q4 + Q10** — these need a 30-min audit of the worker codebase to confirm what's still in use. Without these answers we can't safely delete dependencies or design the API Keys tab.
3. **Approve the redirect map** in §7 (especially the studio routes → `/` decision; alternative is `/pricing`).
4. **Approve "stay on Firebase Hosting"** decision (§9.2) or signal preference to migrate to Cloudflare Pages.
5. **Approve the phased migration** strategy (§7) over a big-bang rewrite.

Once those are settled, Phase 0 (audit) can start immediately, and Phase 1 (new `/account` shell) can start in parallel since it doesn't depend on any deletion.

---

### Critical Files for Implementation

- `/Users/ithustle/dev/web/toquemedia-studio/packages/web/src/App.tsx` — the entire route table is rewritten here
- `/Users/ithustle/dev/web/toquemedia-studio/packages/web/src/contexts/AuthContext.tsx` — auth + billing data source for both surfaces; do **not** modify, but every new component reads from it
- `/Users/ithustle/dev/web/toquemedia-studio/packages/web/src/screens/profile/ProfileScreen.tsx` — template/spine for the new `AccountScreen`
- `/Users/ithustle/dev/web/toquemedia-studio/packages/web/src/screens/landing/index.tsx` — landing entry; sections list gets rewritten + extended here
- `/Users/ithustle/dev/web/toquemedia-studio/firebase.prod.json` — hosting config; redirects + CSP tightening land here