import { initializeApp } from 'firebase/app'
import { checkTimeManipulation, EXPLORER_TOKEN_BUDGET } from '../timeManipulationGuard'
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  reload,
  type User
} from 'firebase/auth'
import {
  initializeFirestore,
  getFirestore,
  connectFirestoreEmulator,
  doc,
  collection,
  getDoc,
  setDoc,
  onSnapshot,
  query,
  where,
  Timestamp,
} from 'firebase/firestore'
import { getDatabase, connectDatabaseEmulator } from 'firebase/database'
import {
  initializeAppCheck,
  CustomProvider,
  getToken as getAppCheckToken,
  type AppCheck,
  type AppCheckToken,
} from 'firebase/app-check'
import { useAuthStore } from '../../stores/authStore'
import { useBillingStore, persistBillingCache, getCachedBillingUid } from '../../stores/billingStore'
import { useFeaturesStore } from '../../stores/featuresStore'
import { usePromotionsStore } from '../../stores/promotionsStore'
import { useByokStore } from '../../stores/byokStore'
import { useTmSpeedStore } from '../../stores/tmSpeedStore'
import { useProjectStore } from '../../stores/projectStore'
import { useToastStore } from '../../stores/toastStore'
import { shouldUseEmulators, EMULATOR_CONFIG } from './emulatorConfig'
import { tauriFetch, registerHeaderProvider } from '../tauriFetch'
import { resolveWorkerUrl } from '../../utils/devUrls'
import { syncInstalledTmCodeVersion } from '../tmCodeVersionSync'

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
  // Optional — only set when the Realtime Database is enabled (used by the
  // team-collab offline relay). When absent, `rtdb()` returns null and the
  // relay gracefully no-ops.
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
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

// Lazy Realtime Database accessor for the team-collab offline relay. Returns
// null when no `databaseURL` is configured (RTDB not enabled) so the relay
// degrades cleanly. Connects to the emulator (port 9000) in dev on first use.
let _rtdb: ReturnType<typeof getDatabase> | null = null
let _rtdbEmulatorConnected = false
export function rtdb(): ReturnType<typeof getDatabase> | null {
  ensureFirebase()
  if (_rtdb) return _rtdb
  if (!firebaseConfig.databaseURL) return null
  _rtdb = getDatabase(_app!)
  if (!_rtdbEmulatorConnected && shouldUseEmulators()) {
    _rtdbEmulatorConnected = true
    try {
      connectDatabaseEmulator(_rtdb, EMULATOR_CONFIG.DATABASE.HOST, EMULATOR_CONFIG.DATABASE.PORT)
    } catch {
      /* non-fatal — falls back to the configured databaseURL */
    }
  }
  return _rtdb
}

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
    // Route the Auth emulator through the Vite dev proxy (localhost:1420), the
    // SAME same-origin trick used for Firestore below. Hitting the emulator
    // directly (127.0.0.1:9999) was cross-origin from the WebView → every
    // securetoken token refresh was CORS-blocked on reload
    // (auth/network-request-failed → no token → /v1/me couldn't authenticate).
    // Vite forwards /identitytoolkit.* + /securetoken.* to the emulator (9999).
    connectAuthEmulator(getFirebaseAuth(), 'http://localhost:1420', {
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
  private unsubscribePromotions: (() => void) | null = null
  private lastBillingFetchMs = 0
  private authGeneration = 0
  /** uid the current authGeneration belongs to. The generation must only
   *  advance when the SIGNED-IN USER changes (login/logout), never on
   *  same-user token rotations — onAuthStateChanged fires on those too, and
   *  bumping the generation there aborted the in-flight startup /v1/me fetch
   *  at its gen guard, leaving billing empty until a later trigger. */
  private lastAuthUid: string | null = null
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
        useTmSpeedStore.getState().reset()
        this.lastBillingFetchMs = 0 // allow immediate fetch on next login
        this.lastRegisteredUid = null // allow re-registration on next login
        this.lastAuthUid = null
        this.authGeneration++ // invalidate in-flight fetches/listeners
        this.unsubscribeUserDocListener()
        this.unsubscribeSubscriptionDocListener()
        this.unsubscribePromotionsListener()
        return
      }

      // Cache de arranque do billing: se o snapshot hidratado pertence a
      // OUTRA conta (troca de utilizador sem logout limpo), descarta-o já —
      // mostrar o plano de outro user até ao /v1/me seria pior do que o
      // flash de explorer que a cache existe para evitar.
      if (getCachedBillingUid() !== null && getCachedBillingUid() !== user.uid) {
        useBillingStore.getState().reset()
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

      this.syncInstalledVersion(user.uid)

      // Enrich with Firestore profile (for displayName/photoURL) — non-blocking.
      // Precedence: Firestore profile → live Firebase user → store (may have been
      // set manually by signUp after updateProfile) → initial authData snapshot.
      // The store-fallback matters because the backend /v1/me can seed the
      // Firestore doc with an empty displayName before our signUp setDoc wins;
      // in that window Firestore reads back `''` and without this fallback
      // we'd clobber the name that signUp just pushed to the store.
      // Advance the generation only on a real user change. Same-user events
      // (token rotation ~50min, tab focus) keep the generation stable so
      // fetches/listeners started by an earlier event aren't spuriously
      // invalidated mid-flight.
      if (this.lastAuthUid !== user.uid) {
        this.lastAuthUid = user.uid
        this.authGeneration++
      }
      const gen = this.authGeneration
      // blockedSynced will be initialized from Firestore profile below
      this.blockedSynced = false
      this.loadProfile(user.uid).then(profile => {
        if (gen !== this.authGeneration) return
        if (!profile) {
          useTmSpeedStore.getState().updateFromProfile(null)
          return
        }
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
          // Seed the suspension flag from the profile so the banner + Welcome
          // gate are correct on first paint; the user-doc listener keeps it in
          // sync (and expels from Chat/Terminal) in real time afterwards.
          blocked: profile.blocked === true,
          blockedReason: profile.blockedReason,
        })
        // Initialize blockedSynced from Firestore so a restart doesn't
        // re-write blocked: true (the previous blockedSynced=true was lost
        // when the app closed). If Firestore says blocked, we respect it
        // and don't need to write again.
        if (profile.blocked === true) {
          this.blockedSynced = true
        }
        useTmSpeedStore.getState().updateFromProfile(profile)
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

      // Real-time promotions listener — updates PromoBanner instantly when
      // admin creates/edits/deletes promotions in the web admin.
      this.subscribeToPromotions()

      // Register device fingerprint for anti-abuse tracking. signIn() already
      // ran this for the interactive login path (and set lastRegisteredUid);
      // here it covers restored sessions / token refresh. On an explicit
      // per-device cap rejection, block the session: sign out and surface a
      // descriptive message. Skip if already registered for this uid.
      if (this.lastRegisteredUid !== user.uid) {
        this.lastRegisteredUid = user.uid
        this.registerDevice().then(({ rejected }) => {
          if (rejected) {
            this.lastRegisteredUid = null
            useAuthStore.getState().setError(
              'Este dispositivo já tem o número máximo de contas permitido. Inicie sessão com uma conta já associada a este computador.'
            )
            this.signOut().catch(() => {})
          }
        })
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
    let previousBillingHash = ''
    let previousBlocked = false
    const expectedGen = this.authGeneration
    this.unsubscribeUserDoc = onSnapshot(
      doc(getFirebaseDb(), COLLECTIONS.USERS, uid),
      (snap) => {
        if (expectedGen !== this.authGeneration) return // stale listener

        // ── Suspensão de conta (tempo-real) ────────────────────────────
        // Corre em TODOS os snapshots (incluindo o primeiro) para que um
        // bloqueio/eliminação aplicado por um admin reflita em <1s.
        if (snap.exists()) {
          const d = snap.data()
          // Soft-delete → expulsa a sessão por completo (a conta foi removida;
          // o Auth também foi desativado no servidor, mas isto é imediato).
          if (d.deleted === true) {
            useToastStore.getState().addToast('error', 'A sua conta foi removida. Contacte o suporte.')
            this.signOut().catch(() => {})
            return
          }
          const isBlocked = d.blocked === true
          // Mantém a flag no authStore (banner + gate do Welcome em App.tsx).
          useAuthStore.getState().setBlocked(isBlocked, d.blockedReason)
          // Na transição para bloqueado (e também num restart já-bloqueado:
          // previousBlocked arranca a false), expulsa do Chat/Terminal.
          if (isBlocked && !previousBlocked) {
            useProjectStore.getState().expelToWelcome()
            useToastStore.getState().addToast('warning', 'A sua conta foi suspensa por um administrador.')
          }
          previousBlocked = isBlocked
        }

        if (firstSnapshot) {
          firstSnapshot = false
          if (snap.exists()) {
            const d = snap.data()
            useTmSpeedStore.getState().updateFromProfile(d)
            previousBillingHash = `${d.userPlan}|${d.tokenBudget}|${d.extraUsageBalance}`
          }
          return
        }
        if (!snap.exists()) return
        // Update the throttle stamp so onAuthStateChanged's token-refresh
        // path doesn't redundantly refetch within the next 5 minutes.
        // Backend /v1/me reads fresh from Firestore on every call.
        const data = snap.data()
        useTmSpeedStore.getState().updateFromProfile(data)
        const currentBillingHash = `${data.userPlan}|${data.tokenBudget}|${data.extraUsageBalance}`
        if (currentBillingHash === previousBillingHash) {
          return
        }
        previousBillingHash = currentBillingHash
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

  /**
   * Attach an onSnapshot listener to the promotions collection.
   * Updates promotionsStore in real-time when admin creates/edits/deletes promotions.
   */
  private subscribeToPromotions(): void {
    this.unsubscribePromotionsListener()

    const expectedGen = this.authGeneration
    const q = query(collection(getFirebaseDb(), 'promotions'), where('active', '==', true))
    this.unsubscribePromotions = onSnapshot(
      q,
      (snapshot) => {
        if (expectedGen !== this.authGeneration) return
        const now = Date.now()
        const promotions = snapshot.docs
          .map(d => ({ id: d.id, ...d.data() } as import('../../stores/promotionsStore').Promotion))
          .filter(p => {
            const start = new Date(p.startsAt).getTime()
            const end = new Date(p.endsAt).getTime()
            return now >= start && now <= end
          })
          .sort((a, b) => b.priority - a.priority)
        usePromotionsStore.getState().updateFromMe(promotions)
      },
      (err) => {
        console.warn('[promotions] listener error:', err)
      }
    )
  }

  private unsubscribePromotionsListener(): void {
    if (this.unsubscribePromotions) {
      this.unsubscribePromotions()
      this.unsubscribePromotions = null
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
   * anti-abuse tracking (MAX_ACCOUNTS_PER_DEVICE).
   *
   * Returns `{ rejected: true }` ONLY when the backend explicitly reports the
   * per-device account cap was exceeded (HTTP 403 reason=limit_exceeded) — the
   * caller then blocks the session. Every other outcome (success, network
   * error, timeout, malformed response) returns `{ rejected: false }`: device
   * checks must FAIL OPEN so a backend hiccup can never lock a legitimate user
   * out of the app.
   */
  private async registerDevice(): Promise<{ rejected: boolean }> {
    try {
      const { getDeviceFingerprint } = await import('./deviceFingerprint')
      const fingerprint = await getDeviceFingerprint()
      if (!fingerprint) return { rejected: false }

      const token = await this.getIdToken()
      if (!token) return { rejected: false }

      const workerUrl = resolveWorkerUrl()
      const appCheck = await getAppCheckHeader()
      const res = await tauriFetch(`${workerUrl}/v1/auth/register-device`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...appCheck,
        },
        body: JSON.stringify({ fingerprint }),
      })

      if (res.status === 403) {
        const data = await res.json().catch(() => ({})) as { reason?: string }
        if (data.reason === 'limit_exceeded') return { rejected: true }
      }
      return { rejected: false }
    } catch {
      // Non-blocking — device registration failure should not prevent login
      return { rejected: false }
    }
  }

  dispose(): void {
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth()
      this.unsubscribeAuth = null
    }
    this.unsubscribeUserDocListener()
    this.unsubscribeSubscriptionDocListener()
    this.unsubscribePromotionsListener()
  }

  private async loadProfile(uid: string) {
    const snap = await getDoc(doc(getFirebaseDb(), COLLECTIONS.USERS, uid))
    return snap.exists() ? snap.data() : null
  }

  async signIn(email: string, password: string): Promise<User> {
    const result = await signInWithEmailAndPassword(getFirebaseAuth(), email, password)

    // Anti-abuse device gate (blocking). If this machine already holds the max
    // number of accounts and this one is new to it, reject the login: sign out
    // and throw a coded error the LoginScreen maps to a descriptive message.
    // Fails open on any non-limit error (see registerDevice).
    const { rejected } = await this.registerDevice()
    if (rejected) {
      await signOut(getFirebaseAuth()).catch(() => {})
      const err = new Error('device-limit-exceeded') as Error & { code?: string }
      err.code = 'device/limit-exceeded'
      throw err
    }
    // Registered (or failed open) — let the onAuthStateChanged listener skip
    // its own registerDevice call for this uid.
    this.lastRegisteredUid = result.user.uid

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
          // At cold boot the SDK's token refresh can transiently fail (App
          // Check still minting, network not up) — retry instead of giving
          // up, otherwise billing stays empty until the next focus/refetch.
          console.warn(`[billing] No token available (attempt ${attempt}/${MAX_ATTEMPTS})`)
          if (attempt < MAX_ATTEMPTS) {
            await new Promise(r => setTimeout(r, RETRY_DELAY))
            continue
          }
          break // total failure — handled by the post-loop terminal fallback
        }
        if (targetGen !== this.authGeneration) return

        const workerUrl = resolveWorkerUrl()
        const appCheck = await getAppCheckHeader()
        const res = await tauriFetch(`${workerUrl}/v1/me`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            ...appCheck,
          },
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
          break // total failure — handled by the post-loop terminal fallback
        }
        if (targetGen !== this.authGeneration) return

        const data = await res.json() as import('../../stores/billingStore').MeResponse

        console.info(
          `[billing] Plan: ${data.plan}, Active: ${data.isActive}, ` +
          `Admin: ${data.isAdmin === true}, ` +
          `Consumed: ${(data.billing.consumedPct * 100).toFixed(1)}%, ` +
          `Extra: ${data.billing.extraUsageBalance}, Status: ${data.billing.status}`
        )

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
              // Downgrade paid plans to explorer (time manipulation).
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
        usePromotionsStore.getState().updateFromMe(data.promotions)

        // Snapshot de arranque: o próximo boot hidrata o billingStore daqui
        // de forma síncrona (antes do primeiro render) — elimina o flash de
        // "explorer" enquanto o /v1/me não responde. Ver billingStore.ts.
        {
          const cacheUid = this.currentUser?.uid
          if (cacheUid) persistBillingCache(cacheUid)
        }

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

    // Terminal fallback for a TOTAL /v1/me failure (network / 5xx / 401 / no
    // token — NOT a signup gate, which returns 403 and is handled above). Without
    // this, `signupComplete` stayed `null` and the app hung on the "A entrar…"
    // spinner FOREVER: there was no code path out of that state on backend
    // failure. Firebase sign-in already succeeded and billing has a cache +
    // defaults + an event-driven refetch on window focus, so we enter the IDE
    // optimistically rather than trap the user. A genuinely incomplete signup is
    // a 403 (handled), and a later focus refetch self-corrects if needed. Guard
    // on the generation so a superseded fetch (account switch mid-flight) never
    // forces this, and only act while still null (a refetch after a prior success
    // must not downgrade anything).
    if (targetGen === this.authGeneration && useAuthStore.getState().signupComplete === null) {
      console.warn('[billing] /v1/me unreachable after retries — entering IDE with cached/default billing; will refetch on focus')
      useAuthStore.getState().setSignupComplete(true)
      useBillingStore.setState({ isLoaded: true })
    }
  }

  /**
   * Plano de Equipas: liga/desliga o consumo de equipa do próprio user (move
   * `activeTeamId` no control-plane). `active=true` → o consumo passa a faturar
   * a fatia da equipa; `false` → consumo do plano pessoal. Refaz o /v1/me para
   * o billingStore refletir o novo modo. Atira em falha (a UI mostra erro).
   */
  async setTeamBillingMode(active: boolean): Promise<void> {
    const token = await this.getIdToken()
    if (!token) throw new Error('Sessão sem token.')
    const workerUrl = resolveWorkerUrl()
    const appCheck = await getAppCheckHeader()
    const res = await tauriFetch(`${workerUrl}/v1/me/billing-mode`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...appCheck,
      },
      body: JSON.stringify({ active }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(err.error || `Falha ao mudar o modo de consumo (${res.status}).`)
    }
    // Re-lê o estado autoritativo (bypassa o throttle de 5 min).
    this.lastBillingFetchMs = Date.now()
    await this.fetchBillingInfo()
  }

  private getLiveCurrentUser(): User | null {
    const sdkUser = getFirebaseAuth().currentUser
    if (sdkUser && sdkUser !== this.currentUser) {
      this.currentUser = sdkUser
    }
    return this.currentUser ?? sdkUser ?? null
  }

  async getIdToken(forceRefresh = false): Promise<string | null> {
    const user = this.getLiveCurrentUser()
    if (!user) {
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
      const token = await user.getIdToken(forceRefresh)
      if (token && !forceRefresh && this.isTokenNearExpiry(token)) {
        return await user.getIdToken(true)
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
   * Refresh the Firebase user record and force-mint a fresh ID token without
   * signing out. Use this after wake-from-sleep or platform 401s where the SDK
   * still has a persisted account but local auth state may be stale.
   */
  async refreshLogin(): Promise<boolean> {
    const user = this.getLiveCurrentUser()
    if (!user) {
      console.warn('[auth] refreshLogin: currentUser is null')
      return false
    }

    try {
      await reload(user)
      const liveUser = this.getLiveCurrentUser()
      const token = await (liveUser ?? user).getIdToken(true)
      if (!token) return false
      this.fetchBillingInfo(this.authGeneration).catch(() => {})
      return true
    } catch (err) {
      console.warn('[auth] refreshLogin failed:', err)
      return false
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

  async setTmSpeedEnabled(enabled: boolean): Promise<void> {
    if (!this.currentUser) {
      throw new Error('Not authenticated')
    }

    const previous = useTmSpeedStore.getState().enabled
    useTmSpeedStore.getState().setEnabled(enabled)
    try {
      await setDoc(doc(getFirebaseDb(), COLLECTIONS.USERS, this.currentUser.uid), {
        tmSpeedEnabled: enabled,
        tmSpeedUpdatedAt: Timestamp.now(),
      }, { merge: true })
    } catch (err) {
      useTmSpeedStore.getState().setEnabled(previous)
      throw err
    }
  }

  /** Best-effort profile field sync (fire-and-forget) */
  private syncProfile(uid: string, fields: Record<string, unknown>) {
    setDoc(doc(getFirebaseDb(), COLLECTIONS.USERS, uid), fields, { merge: true }).catch(() => {})
  }

  /** Best-effort installed IDE version sync, keyed locally per authenticated user. */
  private syncInstalledVersion(uid: string) {
    syncInstalledTmCodeVersion(uid, async (version) => {
      const now = Timestamp.now()
      await setDoc(doc(getFirebaseDb(), COLLECTIONS.USERS, uid), {
        tmCodeVersion: version,
        tmCodeVersionUpdatedAt: now,
      }, { merge: true })
    }).catch((err) => {
      console.warn('[auth] TM Code version sync failed:', err)
    })
  }

  // NOTA (2026-06): persistTokensConsumed foi removido. Escrevia valores
  // ABSOLUTOS de consumo calculados no cliente em users/{uid} (last-writer-
  // wins entre dispositivos, clobber do cycle-reset do servidor — e o
  // extraUsageBalance ia para o caminho errado, raiz em vez de
  // tokenBudget.extraUsageBalance, pelo que as deduções de overage nunca
  // persistiam). A contabilidade é agora exclusiva do worker ai-pass-through
  // (increments atómicos server-side com o usage real do provider). Isto
  // também permite fechar as Security Rules de escrita dos campos de billing
  // ao cliente.
}

// Automatically register our App Check token provider with tauriFetch
registerHeaderProvider(getAppCheckHeader)

export default FirebaseAuthService
