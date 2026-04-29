import { initializeApp } from 'firebase/app'
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  RecaptchaVerifier,
  signOut,
  onAuthStateChanged,
  sendEmailVerification,
  updateProfile,
  linkWithPhoneNumber,
  type ConfirmationResult,
  type User
} from 'firebase/auth'
import {
  initializeFirestore,
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
  setDoc,
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
        // @ts-expect-error — Firebase debug token interface
        self.FIREBASE_APPCHECK_DEBUG_TOKEN = true
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
    connectFirestoreEmulator(getFirebaseDb(), EMULATOR_CONFIG.FIRESTORE.HOST, EMULATOR_CONFIG.FIRESTORE.PORT)
  } catch {
    // Emulator connection failed — non-fatal, will use production services
  }
}

// Default onboarding status (aligned with web project)
const DEFAULT_ONBOARDING = {
  completed: false,
  currentStep: 0,
  completedSteps: [] as number[],
  skipped: false,
}

class FirebaseAuthService {
  private static instance: FirebaseAuthService
  private currentUser: User | null = null
  private unsubscribeAuth: (() => void) | null = null
  private lastBillingFetchMs = 0
  private authGeneration = 0
  /**
   * When signUp is in flight, holds a promise that resolves after the Firestore
   * profile write completes. `onAuthStateChanged` awaits this before calling
   * `/v1/me` so the backend's GET finds the doc the frontend just wrote instead
   * of racing ahead, seeing 404, and creating a minimal doc that — even with
   * `updateMask` — ends up sharing the write window with the frontend. Cleared
   * to null immediately after the await so existing-user sign-ins never wait.
   */
  private signupWriteGate: Promise<void> | null = null

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
      }).catch(() => {})

      // Load billing data from backend API.
      // Always fetch if not yet loaded (first login, after logout).
      // Throttle to 5 min for subsequent auth events (token refresh, tab focus).
      const billingState = useBillingStore.getState()
      const BILLING_THROTTLE_MS = 5 * 60 * 1000
      const now = Date.now()
      const shouldFetch = !billingState.isLoaded || (now - this.lastBillingFetchMs > BILLING_THROTTLE_MS)
      if (shouldFetch) {
        this.lastBillingFetchMs = now
        // Wait for an in-flight signUp to finish writing the Firestore profile
        // BEFORE calling /v1/me. Otherwise the backend's GET returns 404, the
        // backend creates a minimal billing doc (without the profile fields),
        // and the user sees no displayName in Firestore. The gate resolves
        // synchronously to `undefined` for sign-ins (no signup in flight),
        // adding zero overhead to the common path.
        const gate = this.signupWriteGate
        this.signupWriteGate = null
        const kickBilling = () => this.fetchBillingInfo(gen)
        if (gate) gate.then(kickBilling).catch(kickBilling)
        else kickBilling()
      }
    })
  }

  dispose(): void {
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth()
      this.unsubscribeAuth = null
    }
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

  async signUp(email: string, password: string, displayName?: string): Promise<User> {
    // Arm the gate BEFORE createUserWithEmailAndPassword fires — onAuthStateChanged
    // will pick up the new user synchronously, and if the gate isn't set yet the
    // /v1/me call leaves before our setDoc lands. Resolved in the try below
    // after the Firestore write completes (success OR failure — we never want
    // to hang onAuthStateChanged if setDoc throws).
    let gateResolve: () => void = () => {}
    this.signupWriteGate = new Promise<void>(resolve => { gateResolve = resolve })

    let result
    try {
      result = await createUserWithEmailAndPassword(getFirebaseAuth(), email, password)
    } catch (err) {
      // Auth rejected (email already in use, weak password, etc.). Release the
      // gate so a subsequent successful signIn/signUp in this session isn't
      // blocked by a dangling unresolved promise.
      gateResolve()
      this.signupWriteGate = null
      throw err
    }
    const user = result.user
    const trimmedName = displayName?.trim() || ''

    // ── Step 1: Auth profile ─────────────────────────────────────
    // Persist the display name on the Firebase Auth user object. Without this,
    // `user.displayName` stays null — the ID-token `name` claim is empty, the
    // email-template sender has no name, and every place reading `user.displayName`
    // (onAuthStateChanged, UI fallbacks, ProfileSection) shows the fallback
    // until Firestore enrichment races in (and often not even then — see below).
    if (trimmedName) {
      try {
        await updateProfile(user, { displayName: trimmedName })
      } catch (err) {
        console.warn('[auth] updateProfile failed during signUp:', err)
      }
    }

    // ── Step 2: Firestore profile (merge:true so backend /v1/me seed doesn't clobber) ─
    // The backend's /v1/me endpoint auto-creates the user doc on first call. That
    // request fires as soon as onAuthStateChanged runs (before this setDoc gets
    // scheduled), so we race with it. Without `{ merge: true }`, whichever write
    // lands second REPLACES the other. With merge:true both sides contribute
    // their fields and the name always survives.
    // Catch logs instead of swallowing — silent failures previously hid rule
    // violations and emulator connectivity issues for weeks.
    try {
      await setDoc(doc(getFirebaseDb(), COLLECTIONS.USERS, user.uid), {
        uid: user.uid,
        email: user.email,
        fullName: trimmedName,
        displayName: trimmedName,
        photoURL: null,
        provider: 'email',
        emailVerified: user.emailVerified,
        onboarding: DEFAULT_ONBOARDING,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
        userPlan: 'explorer',
        // Set false here so the backend's signup gates block this account
        // until phone link succeeds. Flipped to true in confirmPhoneCode.
        signupComplete: false,
      }, { merge: true })
    } catch (err) {
      console.warn('[auth] Firestore profile write failed during signUp:', err)
    } finally {
      // Release the gate whether setDoc succeeded or failed — we never want
      // onAuthStateChanged to hang indefinitely on a failed write.
      gateResolve()
    }

    // ── Step 3: Sync displayName to authStore ────────────────────
    // onAuthStateChanged fired synchronously on createUser with displayName=null.
    // `updateProfile` does NOT re-trigger onAuthStateChanged, so the store still
    // holds the stale null. Push the name explicitly so the UI shows the real
    // name immediately (previously showed "User" fallback until next token refresh).
    if (trimmedName) {
      const authStore = useAuthStore.getState()
      const current = authStore.user
      if (current && !current.displayName) {
        authStore.setUser({ ...current, displayName: trimmedName })
      }
    }

    // ── Step 4: Email verification (fire-and-forget) ─────────────
    // The backend /v1/me will reject unverified accounts older than 24h with
    // 403, so this email must reach the user. We don't block signUp on it —
    // a transient network error here would otherwise force the user to retry
    // the entire signup. Failures here are logged and surface as the 24h-grace
    // verification reminder banner; they're not fatal at this moment.
    sendEmailVerification(user).catch(err => {
      console.warn('[auth] sendEmailVerification failed:', err)
    })

    return user
  }

  /**
   * Initiate the phone-number link flow. Renders an invisible reCAPTCHA in
   * the given container element, sends an SMS code to `phoneE164`, and
   * returns a `ConfirmationResult` to be passed to `confirmPhoneCode`.
   *
   * The container element must exist in the DOM at call time. Caller is
   * responsible for cleanup of the verifier via the returned `cleanup` fn —
   * Firebase keeps internal references that prevent GC otherwise.
   */
  async startPhoneLink(
    phoneE164: string,
    recaptchaContainer: HTMLElement,
  ): Promise<{ confirmation: ConfirmationResult; cleanup: () => void }> {
    if (!this.currentUser) {
      throw new Error('No authenticated user — call signUp first')
    }

    const verifier = new RecaptchaVerifier(getFirebaseAuth(), recaptchaContainer, {
      size: 'invisible',
    })

    try {
      const confirmation = await linkWithPhoneNumber(this.currentUser, phoneE164, verifier)
      return {
        confirmation,
        cleanup: () => {
          try { verifier.clear() } catch { /* noop */ }
        },
      }
    } catch (err) {
      try { verifier.clear() } catch { /* noop */ }
      throw err
    }
  }

  /**
   * Complete the phone-link flow with the 6-digit code the user received via
   * SMS. On success, the phone number is linked to the account and persisted
   * to Firestore. Throws on invalid code so the UI can show an inline error.
   */
  async confirmPhoneCode(confirmation: ConfirmationResult, code: string): Promise<void> {
    const result = await confirmation.confirm(code)
    const user = result.user

    // Persist phone fields to Firestore so the backend /v1/me sees the
    // linked phone without having to read it from the Auth admin SDK.
    // signupComplete=true unlocks all backend signup gates.
    try {
      await setDoc(doc(getFirebaseDb(), COLLECTIONS.USERS, user.uid), {
        phoneNumber: user.phoneNumber,
        phoneVerifiedAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
        signupComplete: true,
      }, { merge: true })
    } catch (err) {
      console.warn('[auth] phone profile sync failed:', err)
    }
  }

  /** Re-send email verification — used by the persistent unverified banner. */
  async resendEmailVerification(): Promise<void> {
    if (!this.currentUser) throw new Error('No authenticated user')
    await sendEmailVerification(this.currentUser)
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

        useBillingStore.getState().updateFromMe(data)

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
    return this.currentUser.getIdToken(forceRefresh)
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
}

export default FirebaseAuthService
