import { initializeApp } from 'firebase/app'
import { checkTimeManipulation, EXPLORER_TOKEN_BUDGET } from '../timeManipulationGuard'
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  type User
} from 'firebase/auth'
import {
  initializeFirestore,
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  Timestamp,
} from 'firebase/firestore'
import {
  initializeAppCheck,
  CustomProvider,
  getToken as getAppCheckToken,
  type AppCheck,
  type AppCheckToken,
} from 'firebase/app-check'
import { useAuthStore } from '../../stores/authStore'
import { useBillingStore } from '../../stores/billingStore'
import { useFeaturesStore } from '../../stores/featuresStore'
import { useByokStore } from '../../stores/byokStore'
import { shouldUseEmulators, EMULATOR_CONFIG } from './emulatorConfig'
import { tauriFetch } from '../tauriFetch'
import { resolveWorkerUrl } from '../../utils/devUrls'

// Firebase config from environment variables — no hardcoded fallbacks.
// Lazy initialization: validated on first use (not at import time) so tests
// and CI that don't set env vars don't crash when importing other modules.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
}

let _app: ReturnType<typeof initializeApp> | null = null
let _auth: ReturnType<typeof getAuth> | null = null
let _db: ReturnType<typeof getFirestore> | null = null
let _appCheck: AppCheck | null = null

function ensureFirebase() {
  if (_app) return
  if (!firebaseConfig.apiKey) {
    throw new Error(
      'Missing Firebase config. Set VITE_FIREBASE_API_KEY and related env vars in .env or .env.local. '
      + 'See .env.example for the required variables.'
    )
  }
  _app = initializeApp(firebaseConfig)
  _auth = getAuth(_app)
  // Localizes the verification email + SMS templates Firebase sends. Without
  // this, users in PT-speaking markets (Angola, PT, BR) get English defaults.
  _auth.languageCode = 'pt'
  initializeFirestore(_app, { ignoreUndefinedProperties: true })
  _db = getFirestore(_app)

  // AppCheck — opt-in via VITE_APPCHECK_ENABLED=true.
  // Requires backend /v1/appcheck-token endpoint to be deployed first.
  if (import.meta.env.VITE_APPCHECK_ENABLED === 'true') {
    try {
      if (import.meta.env.DEV) {
        // Debug-token wiring only when the developer has actually registered
        // a debug token in Firebase Console → App Check → Apps → Manage debug
        // tokens. Setting the flag to `true` blindly makes the SDK request a
        // fresh debug token via Firebase's `exchangeDebugToken` endpoint,
        // which 403s when no token is registered for this machine — that
        // 403 was bleeding into Identity Toolkit refresh flows and breaking
        // deploys. Setting the flag to a real token string skips that
        // exchange and just uses the registered value.
        const debugToken = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN
        if (debugToken && typeof debugToken === 'string') {
          // @ts-expect-error — Firebase debug token interface
          self.FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken
        }
      }

      const workerUrl = resolveWorkerUrl()

      const appCheckProvider = new CustomProvider({
        getToken: async (): Promise<AppCheckToken> => {
          // CRITICAL: must work BEFORE the user signs in. Firebase Auth itself
          // requires an App Check token when enforcement is on — gating this
          // call on `auth.currentUser` creates a chicken-and-egg lock-out
          // (`auth/firebase-app-check-token-is-invalid`). The backend `/v1/appcheck-token`
          // is auth-less and rate-limited per-IP for the same reason.
          const res = await tauriFetch(`${workerUrl}/v1/appcheck-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          })

          if (!res.ok) {
            throw new Error(`AppCheck token exchange failed: ${res.status}`)
          }

          const data = await res.json() as { token: string; expireTimeMillis: number }
          return { token: data.token, expireTimeMillis: data.expireTimeMillis }
        },
      })

      _appCheck = initializeAppCheck(_app, {
        provider: appCheckProvider,
        isTokenAutoRefreshEnabled: true,
      })
    } catch (err) {
      console.warn('[appCheck] init failed:', err)
    }
  }
}

/**
 * Returns the headers needed to satisfy backend App Check enforcement on
 * gated endpoints. Callers should spread the result into their `headers`
 * object — empty when App Check is disabled or the SDK hasn't initialized,
 * matching the dev/emulator no-op contract.
 *
 * Uses cached tokens when valid (the SDK refreshes them automatically every
 * ~50 min when `isTokenAutoRefreshEnabled` is on).
 */
export async function getAppCheckHeader(): Promise<Record<string, string>> {
  if (!_appCheck) return {}
  try {
    const result = await getAppCheckToken(_appCheck, /* forceRefresh */ false)
    if (!result?.token) return {}
    return { 'X-Firebase-AppCheck': result.token }
  } catch (err) {
    console.warn('[appCheck] getToken failed:', err)
    return {}
  }
}

function getFirebaseAuth() { ensureFirebase(); return _auth! }
function getFirebaseDb() { ensureFirebase(); return _db! }

// Lazy Firestore accessor. We *must* return the real Firestore instance —
// Firebase SDK v10+'s `doc()` / `getDoc()` validate the first arg via a brand
// check that a Proxy wrapper fails ("Expected first argument to doc() to be a
// CollectionReference, a DocumentReference or FirebaseFirestore"). Earlier
// this file exposed `db` as a Proxy for lazy init — the Proxy forwarded
// property reads but the brand check still rejected it at runtime.
// `getFirebaseDb()` is the real, initialized instance; use it directly.
export const db = (): ReturnType<typeof getFirestore> => getFirebaseDb()

// Collections (aligned with web project)
export const COLLECTIONS = {
  USERS: 'users',
  PROJECTS: 'projects',
  DEV_STUDIO_PROJECTS: 'devStudioProjects',
} as const

// Connect to emulators in development (deferred until Firebase is initialized)
let emulatorsConnected = false
function connectEmulatorsIfNeeded() {
  if (emulatorsConnected || !shouldUseEmulators()) return
  emulatorsConnected = true
  try {
    connectAuthEmulator(getFirebaseAuth(), `http://${EMULATOR_CONFIG.AUTH.HOST}:${EMULATOR_CONFIG.AUTH.PORT}`, {
      disableWarnings: true,
    })
    // In dev, route Firestore through Vite proxy (localhost:1420) to avoid
    // CORS blocks from the Tauri WebView — the emulator doesn't send headers.
    connectFirestoreEmulator(getFirebaseDb(), 'localhost', 1420)
  } catch {
    // Emulator connection failed — non-fatal, will use production services
  }
}

class FirebaseAuthService {
  private static instance: FirebaseAuthService
  private currentUser: User | null = null
  private unsubscribeAuth: (() => void) | null = null
  private unsubscribeUserDoc: (() => void) | null = null
  private unsubscribeSubscription: (() => void) | null = null
  private lastBillingFetchMs = 0
  private authGeneration = 0
  /** Tracks the uid for which device registration was last attempted.
   *  Prevents redundant register-device calls on token refresh (~50min). */
  private lastRegisteredUid: string | null = null
  /** Prevents writing blocked=true to Firestore more than once per session.
   *  Each syncProfile write changes updatedAt → triggers onSnapshot →
   *  fetchBillingInfo → checkTimeManipulation → write again = infinite loop.
   *  Setting this flag after the first write breaks the cycle. */
  private blockedSynced = false  // set true on first fetchBillingInfo if Firestore says blocked

  static getInstance(): FirebaseAuthService {
    if (!FirebaseAuthService.instance) {
      FirebaseAuthService.instance = new FirebaseAuthService()
    }
    return FirebaseAuthService.instance
  }

  init(): void {
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth()
    }

    connectEmulatorsIfNeeded()
    this.unsubscribeAuth = onAuthStateChanged(getFirebaseAuth(), (user) => {
      this.currentUser = user
      const store = useAuthStore.getState()

      if (!user) {
        store.setUser(null)
        useBillingStore.getState().reset()
        this.lastBillingFetchMs = 0 // allow immediate fetch on next login
        this.lastRegisteredUid = null // allow re-registration on next login
        this.unsubscribeUserDocListener()
        this.unsubscribeSubscriptionDocListener()
        return
      }

      // Preserve `isAdmin` across token refreshes. onAuthStateChanged fires
      // every ~50min when Firebase rotates the ID token, and rebuilding
      // authData from scratch each time wiped the flag — making the Admin
      // gate flicker (`/v1/me` is throttled to 5min, so the next fetch that
      // would restore it could be far away).
      const previousIsAdmin = store.user?.isAdmin === true

      const authData = {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || null,
        photoURL: user.photoURL || null,
        isAdmin: previousIsAdmin,
      }
      store.setUser(authData)

      // Enrich with Firestore profile (for displayName/photoURL) — non-blocking.
      // Precedence: Firestore profile → live Firebase user → store (may have been
      // set manually by signUp after updateProfile) → initial authData snapshot.
      // The store-fallback matters because the backend /v1/me can seed the
      // Firestore doc with an empty displayName before our signUp setDoc wins;
      // in that window Firestore reads back `''` and without this fallback
      // we'd clobber the name that signUp just pushed to the store.
      const gen = ++this.authGeneration
      // blockedSynced will be initialized from Firestore profile below
      this.blockedSynced = false
      this.loadProfile(user.uid).then(profile => {
        if (gen !== this.authGeneration) return
        if (!profile) return
        // Re-read the current store user so we don't clobber `isAdmin` if
        // /v1/me has already resolved and populated it. `authData.isAdmin`
        // is the snapshot captured at onAuthStateChanged time and may be
        // stale by the time this Firestore read returns.
        const currentStoreUser = useAuthStore.getState().user
        const storeDisplayName = currentStoreUser?.displayName || null
        const currentIsAdmin = currentStoreUser?.isAdmin ?? authData.isAdmin
        store.setUser({
          ...authData,
          isAdmin: currentIsAdmin,
          displayName: profile.displayName || profile.fullName || user.displayName || storeDisplayName || authData.displayName,
          photoURL: profile.photoURL || authData.photoURL,
        })
        // Initialize blockedSynced from Firestore so a restart doesn't
        // re-write blocked: true (the previous blockedSynced=true was lost
        // when the app closed). If Firestore says blocked, we respect it
        // and don't need to write again.
        if (profile.blocked === true) {
          this.blockedSynced = true
        }
      }).catch(() => {})

      // Load billing data from backend API.
      // Always fetch if not yet loaded (first login, after logout).
      // Throttle to 5 min for subsequent auth events (token refresh, tab focus).
      // Backend /v1/me always reads fresh from Firestore (no KV cache).
      const billingState = useBillingStore.getState()
      const BILLING_THROTTLE_MS = 5 * 60 * 1000
      const now = Date.now()
      const shouldFetch = !billingState.isLoaded || (now - this.lastBillingFetchMs > BILLING_THROTTLE_MS)
      if (shouldFetch) {
        this.lastBillingFetchMs = now
        this.fetchBillingInfo(gen)
      }

      // Real-time listener for plan/quota changes on the user document.
      // Mirrors toquemedia-studio AuthContext:191-238 — when an admin updates
      // tokenBudget, userPlan, or extraUsageBalance in Firestore, the listener
      // fires and we refetch /v1/me so the cycle counters and computed pct
      // (which depend on plan caps the client doesn't know) reflect the new
      // server-side state. Without this, admin changes only surface on next
      // window-focus, network reconnect, or chat turn.
      this.subscribeToUserDoc(user.uid)

      // Real-time listener for subscription document (TTL delete detection).
      // Mirrors toquemedia-studio AuthContext:257-298 — when the subscription
      // doc is deleted by Firestore TTL or manual cleanup, this detects it
      // immediately (<1s) instead of waiting for the onSubscriptionExpired
      // Cloud Function to write userPlan='explorer' to the user doc (1-3s).
      this.subscribeToSubscriptionDoc(user.uid)

      // Register device fingerprint for anti-abuse tracking (fire-and-forget).
      // Skip if already registered for this uid (prevents redundant calls on
      // token refresh which fires ~every 50min).
      if (this.lastRegisteredUid !== user.uid) {
        this.lastRegisteredUid = user.uid
        this.registerDevice()
      }
    })
  }

  /**
   * Attach an onSnapshot listener to users/{uid}. Skips the first snapshot
   * (initial doc state — already loaded via /v1/me from onAuthStateChanged).
   * Subsequent snapshots trigger a /v1/me refetch with the throttle bypass:
   * any admin write to the user doc surfaces in the UI within ~1s.
   */
  private subscribeToUserDoc(uid: string): void {
    this.unsubscribeUserDocListener()

    let firstSnapshot = true
    const expectedGen = this.authGeneration
    this.unsubscribeUserDoc = onSnapshot(
      doc(getFirebaseDb(), COLLECTIONS.USERS, uid),
      (snap) => {
        if (expectedGen !== this.authGeneration) return // stale listener
        if (firstSnapshot) {
          firstSnapshot = false
          return
        }
        if (!snap.exists()) return
        // Update the throttle stamp so onAuthStateChanged's token-refresh
        // path doesn't redundantly refetch within the next 5 minutes.
        // Backend /v1/me reads fresh from Firestore on every call.
        this.lastBillingFetchMs = Date.now()
        this.fetchBillingInfo(expectedGen).catch(() => {})
      },
      (err) => {
        console.warn('[billing] user-doc listener error:', err)
      }
    )
  }

  /**
   * Attach an onSnapshot listener to subscriptions/{uid}. Detects TTL
   * delete immediately — the onSubscriptionExpired Cloud Function then
   * writes userPlan='explorer' to the user doc, which the other listener
   * picks up. This listener provides <1s latency (vs 1-3s via the
   * Cloud Function path) so the IDE matches the Web's detection speed.
   */
  private subscribeToSubscriptionDoc(uid: string): void {
    this.unsubscribeSubscriptionDocListener()

    let firstSnapshot = true
    const expectedGen = this.authGeneration
    this.unsubscribeSubscription = onSnapshot(
      doc(getFirebaseDb(), 'subscriptions', uid),
      (snap) => {
        if (expectedGen !== this.authGeneration) return
        if (firstSnapshot) { firstSnapshot = false; return }
        if (snap.exists()) return // doc exists (active/pending) — no action
        // Subscription doc deleted (TTL or manual) → refetch from /v1/me.
        // The Cloud Function onSubscriptionExpired will write userPlan='explorer'
        // to the user doc, but we trigger a refetch now so the billingStore
        // updates as soon as the Cloud Function completes (instead of waiting
        // for the user-doc listener to pick it up).
        //
        // If fetchBillingInfo fails (network, 401, 5xx), fall back to a
        // direct billingStore downgrade so the IDE doesn't stay on the old
        // plan while the Web already downgraded.
        this.lastBillingFetchMs = Date.now()
        this.fetchBillingInfo(expectedGen).catch(() => {
          if (expectedGen !== this.authGeneration) return
          const store = useBillingStore.getState()
          if (store.plan !== 'explorer') {
            store.reset()
          }
        })
      },
      (err) => {
        console.warn('[billing] subscription-doc listener error:', err)
      }
    )
  }

  private unsubscribeSubscriptionDocListener(): void {
    if (this.unsubscribeSubscription) {
      this.unsubscribeSubscription()
      this.unsubscribeSubscription = null
    }
  }

  private unsubscribeUserDocListener(): void {
    if (this.unsubscribeUserDoc) {
      this.unsubscribeUserDoc()
      this.unsubscribeUserDoc = null
    }
  }

  /**
   * Register this device's hardware fingerprint with the backend for
   * anti-abuse tracking (MAX_ACCOUNTS_PER_DEVICE). Fire-and-forget —
   * failures are non-blocking.
   */
  private async registerDevice(): Promise<void> {
    try {
      const { getDeviceFingerprint } = await import('./deviceFingerprint')
      const fingerprint = await getDeviceFingerprint()
      if (!fingerprint) return

      const token = await this.getIdToken()
      if (!token) return

      const workerUrl = resolveWorkerUrl()
      const appCheck = await getAppCheckHeader()
      await tauriFetch(`${workerUrl}/v1/auth/register-device`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...appCheck,
        },
        body: JSON.stringify({ fingerprint }),
      })
    } catch {
      // Non-blocking — device registration failure should not prevent login
    }
  }

  dispose(): void {
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth()
      this.unsubscribeAuth = null
    }
    this.unsubscribeUserDocListener()
    this.unsubscribeSubscriptionDocListener()
  }

  private async loadProfile(uid: string) {
    const snap = await getDoc(doc(getFirebaseDb(), COLLECTIONS.USERS, uid))
    return snap.exists() ? snap.data() : null
  }

  async signIn(email: string, password: string): Promise<User> {
    const result = await signInWithEmailAndPassword(getFirebaseAuth(), email, password)

    // Update lastLogin (best-effort, aligned with web project)
    this.syncProfile(result.user.uid, {
      lastLogin: Timestamp.now(),
      updatedAt: Timestamp.now(),
    })

    return result.user
  }

  async signOut(): Promise<void> {
    await signOut(getFirebaseAuth())
  }

  /**
   * Fetch billing info from backend /v1/me endpoint. Retries once on failure.
   *
   * Public so it can be called from event-driven hooks (window focus, post-purchase
   * deep link, network reconnect). NEVER from a polling loop — see
   * `~/.claude/projects/.../memory/feedback_no_polling.md`.
   */
  async fetchBillingInfo(gen?: number): Promise<void> {
    const MAX_ATTEMPTS = 2
    const RETRY_DELAY = 3000
    // When called externally (no gen), use the current generation
    const targetGen = gen ?? this.authGeneration

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const token = await this.getIdToken(attempt > 1) // force refresh on retry
        if (!token) {
          console.warn('[billing] No token available — user not authenticated')
          return
        }
        if (targetGen !== this.authGeneration) return

        const workerUrl = resolveWorkerUrl()
        const res = await tauriFetch(`${workerUrl}/v1/me`, {
          headers: { 'Authorization': `Bearer ${token}` },
        })

        if (!res.ok) {
          // 403 = signup gate failed. Distinguishes inactive / signup-incomplete /
          // email-not-verified so the UI can show the right action. signup-incomplete
          // means the user authenticated but never finished phone link → keep them
          // on the LoginScreen so they can retry; the existing Firebase user
          // remains until they complete or explicitly cancel.
          if (res.status === 403) {
            const reason = await res.json().catch(() => ({})) as { reason?: string }
            console.warn(`[billing] /v1/me 403 reason=${reason.reason || 'unknown'}`)
            if (reason.reason === 'signup_incomplete') {
              useAuthStore.getState().setSignupComplete(false)
              useBillingStore.setState({ isLoaded: true })
              return
            }
            useAuthStore.getState().setSignupComplete(true) // not the gate that's blocking
            useBillingStore.setState({ isLoaded: true, isActive: false, noCredits: true })
            return
          }
          // 401 = token expired. Retry with forceRefresh on next iteration.
          // 5xx = server issue. Retry.
          console.warn(`[billing] /v1/me returned ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS})`)
          if (attempt < MAX_ATTEMPTS) {
            await new Promise(r => setTimeout(r, RETRY_DELAY))
            continue
          }
          return
        }
        if (targetGen !== this.authGeneration) return

        const data = await res.json() as import('../../stores/billingStore').MeResponse

        console.info(
          `[billing] Plan: ${data.plan}, Active: ${data.isActive}, ` +
          `Admin: ${data.isAdmin === true}, ` +
          `Consumed: ${(data.billing.consumedPct * 100).toFixed(1)}%, ` +
          `Extra: ${data.billing.extraUsageBalance}, Status: ${data.billing.status}`
        )

        // Check if the welcome plan has expired — downgrade to explorer
        // if the user's welcomePlanExpiresAt is in the past.
        if (data.plan === 'welcome') {
          const downgraded = await this.downgradeExpiredWelcomePlan()
          if (downgraded) {
            data.plan = 'explorer'
            data.billing.tokenBudget = 1_500_000 // Explorer: 1.5M
            data.billing.tokensConsumed = 0
            data.billing.consumedPct = 0
            data.billing.status = 'allowed'
          }
        }

        // Time manipulation guard — detect clock rollback and block abuse.
        try {
          const { getDeviceFingerprint } = await import('./deviceFingerprint')
          const fingerprint = await getDeviceFingerprint()
          if (fingerprint) {
            const timeCheck = checkTimeManipulation(fingerprint)
            if (timeCheck.manipulated) {
              console.warn('[billing] Time manipulation detected — blocking account')
              // Block server-side. Write once per session — subsequent calls
              // would loop via onSnapshot → fetchBillingInfo → write.
              const uid = this.currentUser?.uid
              if (uid && !this.blockedSynced) {
                this.blockedSynced = true
                this.syncProfile(uid, {
                  blocked: true,
                  blockedReason: 'time_manipulation',
                  updatedAt: Timestamp.now(),
                })
              }
              // Downgrade non-explorer/non-welcome plans to explorer.
              if (timeCheck.downgradeToExplorer) {
                data.plan = 'explorer'
                data.billing.tokenBudget = EXPLORER_TOKEN_BUDGET
                data.billing.tokensConsumed = EXPLORER_TOKEN_BUDGET
                data.billing.consumedPct = 1
                data.billing.status = 'rejected'
              }
            }
            // NOTE: Auto-unblock removed. Once blocked: true is written to
            // Firestore, only admin action or MIN_BLOCK_DURATION_MS expiry
            // clears it. The client never clears blocked unilaterally —
            // that's the backend's responsibility.
          }
        } catch {
          // Fingerprint unavailable — fail open (don't block legitimate users)
        }

        useBillingStore.getState().updateFromMe(data)
        useFeaturesStore.getState().updateFromMe(data.features)

        // BYOK catalog: load ONCE per session. BYOK is always available
        // (no feature flag, no per-plan check) so we kick off the catalog
        // load on every auth — `catalogLoaded` gates the duplicate work.
        // /v1/me fires on every window-restore (useBillingRefresh); the
        // provider catalog is essentially static for the session, so re-
        // fetching would needlessly call byok_has_key on each provider
        // and briefly flip `hasKey` while in flight.
        if (!useByokStore.getState().catalogLoaded) {
          useByokStore.getState().loadProviders().catch(() => {})
          // Seed local-provider model lists from the disk cache while the
          // network discovery is in flight. The Settings panel can render
          // models from the cache immediately instead of waiting for the
          // Ollama / LM Studio probe to round-trip on every IDE launch.
          // Stale-then-refresh: if the cache is within its 30min TTL
          // we use it; the Settings panel's own refresh button (or
          // refreshLocalModels-from-mount) catches new pulls.
          useByokStore.getState().hydrateLocalModelsFromCache().catch(() => {})
        }

        // /v1/me only returns 200 after all signup gates pass — flip the
        // local flag so the App auth gate can render the IDE.
        useAuthStore.getState().setSignupComplete(true)

        // Propagate isAdmin into the auth store so Settings can gate the Admin
        // panel. The backend is authoritative; we don't trust any local flag.
        const authStore = useAuthStore.getState()
        const currentUser = authStore.user
        if (currentUser) {
          authStore.setUser({ ...currentUser, isAdmin: data.isAdmin === true })
        }

        return // success
      } catch (err) {
        console.warn(`[billing] Fetch failed (attempt ${attempt}/${MAX_ATTEMPTS}):`, err)
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, RETRY_DELAY))
        }
      }
    }
  }

  async getIdToken(forceRefresh = false): Promise<string | null> {
    if (!this.currentUser) {
      console.warn('[auth] getIdToken: currentUser is null')
      return null
    }
    // Firebase ID tokens expire after 1h (Google-imposed, not configurable).
    // The Web SDK already auto-refreshes when the cached token is within ~5min
    // of expiry — calling getIdToken() without args is enough in the steady
    // state. The fallback below covers two edge cases:
    //   1. Laptop sleep beyond the proactive-refresh timer — first call after
    //      wake may return an expired/near-expired token; we retry with force.
    //   2. SDK cache corruption — rare but observed when IndexedDB is purged.
    // The cost is one extra Identity Toolkit RTT when the cached token is
    // already stale; happy path is unchanged because Firebase decodes the JWT
    // locally before deciding to refresh.
    try {
      const token = await this.currentUser.getIdToken(forceRefresh)
      if (token && !forceRefresh && this.isTokenNearExpiry(token)) {
        return await this.currentUser.getIdToken(true)
      }
      return token
    } catch (err) {
      // SDK refresh itself failed (network blip, revoked refresh token).
      // Surface null so callers can decide between "session expired" UX vs.
      // a transient retry — same contract as before for the no-user branch.
      console.warn('[auth] getIdToken refresh failed:', err)
      return null
    }
  }

  /**
   * Decode the JWT payload without verification and check whether the exp
   * claim is within 60s of now. Local-only — used to decide whether to
   * proactively force-refresh before handing the token to a long-running
   * call (chat streaming, deploy upload). No verification because the SDK
   * just minted/cached this token; if it's tampered the upstream JWKS
   * verification will reject it.
   */
  private isTokenNearExpiry(token: string): boolean {
    try {
      const [, payload] = token.split('.')
      if (!payload) return false
      const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number }
      if (typeof decoded.exp !== 'number') return false
      return decoded.exp * 1000 - Date.now() < 60_000
    } catch {
      return false
    }
  }

  isAuthenticated(): boolean {
    return this.currentUser !== null
  }

  getCurrentUser(): User | null {
    return this.currentUser
  }

  /** Best-effort profile field sync (fire-and-forget) */
  private syncProfile(uid: string, fields: Record<string, unknown>) {
    setDoc(doc(getFirebaseDb(), COLLECTIONS.USERS, uid), fields, { merge: true }).catch(() => {})
  }

  /**
   * Persist the welcome plan claim to the user's Firestore document.
   * Called once after activation so the backend `/v1/me` can read the plan
   * on subsequent app launches — even if the activation endpoint is not
   * yet deployed.
   *
   * Returns a promise so callers can await it before triggering a
   * billing re-sync, ensuring IDE/Web/Backend stay in sync.
   */
  async claimWelcomePlan(fingerprint: string): Promise<void> {
    if (!this.currentUser) throw new Error('Not authenticated — cannot claim welcome plan')
    await setDoc(doc(getFirebaseDb(), COLLECTIONS.USERS, this.currentUser.uid), {
      userPlan: 'welcome',
      welcomePlanClaimed: true,
      welcomePlanFingerprint: fingerprint,
      welcomePlanClaimedAt: Timestamp.now(),
      welcomePlanExpiresAt: '2026-05-28',
      updatedAt: Timestamp.now(),
    }, { merge: true })
  }

  /**
   * If the user's plan was set by the welcome promo and the expiry date
   * has passed, downgrade to 'explorer' in Firestore so the backend
   * returns the correct plan on the next /v1/me call.
   *
   * Reads the user doc once, checks `welcomePlanExpiresAt`, and writes
   * back `userPlan: 'explorer'` if expired. Silent no-op on errors.
   */
  private async downgradeExpiredWelcomePlan(): Promise<boolean> {
    if (!this.currentUser) return false
    try {
      const snap = await getDoc(doc(getFirebaseDb(), COLLECTIONS.USERS, this.currentUser.uid))
      if (!snap.exists()) return false
      const data = snap.data() as Record<string, unknown>
      if (data.welcomePlanClaimed !== true) return false
      const expiresAt = data.welcomePlanExpiresAt as string | undefined
      if (!expiresAt) return false
      if (new Date(expiresAt) >= new Date()) return false

      // Expired — downgrade to explorer. Reset tokenBudget so the backend
      // doesn't return stale vibe-level tokensConsumed against the 1.5M
      // explorer budget (which would make the user appear permanently
      // over-budget). Cycle dates use the same anchor-based calculation as
      // the backend's computeCycleDates() to stay consistent.
      const now = new Date()
      const anchorDay = Math.min(28, Math.max(1, now.getUTCDate()))
      const todayDay = now.getUTCDate()
      let startYear = now.getUTCFullYear()
      let startMonth = now.getUTCMonth()
      if (todayDay < anchorDay) {
        startMonth -= 1
        if (startMonth < 0) { startMonth = 11; startYear -= 1 }
      }
      const fmtUtc = (d: Date) => d.toISOString().slice(0, 10)
      const cycleStart = fmtUtc(new Date(Date.UTC(startYear, startMonth, anchorDay)))
      const cycleEnd = fmtUtc(new Date(new Date(Date.UTC(startYear, startMonth + 1, anchorDay)).getTime() - 86400000))
      await setDoc(doc(getFirebaseDb(), COLLECTIONS.USERS, this.currentUser.uid), {
        userPlan: 'explorer',
        welcomePlanExpired: true,
        tokenBudget: {
          tokensConsumed: 0,
          cycleStart,
          cycleEnd,
          billingAnchorDay: anchorDay,
          extraUsageBalance: 0,
        },
        updatedAt: Timestamp.now(),
      }, { merge: true })
      console.info('[billing] Welcome plan expired — downgraded to explorer')
      return true
    } catch {
      // Silent — worst case the user stays on 'vibe' until next /v1/me
      // call with a backend-side check.
      return false
    }
  }
}

export default FirebaseAuthService
