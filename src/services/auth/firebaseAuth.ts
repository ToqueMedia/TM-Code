import { initializeApp } from 'firebase/app'
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
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
  Timestamp,
} from 'firebase/firestore'
import {
  initializeAppCheck,
  CustomProvider,
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
          const auth = getAuth(_app!)
          const user = auth.currentUser
          if (!user) {
            return { token: '', expireTimeMillis: Date.now() + 5_000 }
          }

          const idToken = await user.getIdToken()
          const res = await tauriFetch(`${workerUrl}/v1/appcheck-token`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${idToken}`,
              'Content-Type': 'application/json',
            },
          })

          if (!res.ok) {
            throw new Error(`AppCheck token exchange failed: ${res.status}`)
          }

          const data = await res.json() as { token: string; expireTimeMillis: number }
          return { token: data.token, expireTimeMillis: data.expireTimeMillis }
        },
      })

      initializeAppCheck(_app, {
        provider: appCheckProvider,
        isTokenAutoRefreshEnabled: true,
      })
    } catch {
      // AppCheck init failed — non-fatal
    }
  }
}

function getFirebaseAuth() { ensureFirebase(); return _auth! }
function getFirebaseDb() { ensureFirebase(); return _db! }

// For backward-compat — lazy getter
export const db = new Proxy({} as ReturnType<typeof getFirestore>, {
  get(_target, prop) {
    return Reflect.get(getFirebaseDb(), prop)
  },
})

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

      // Set user immediately with Firebase Auth data
      const authData = {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || null,
        photoURL: user.photoURL || null,
      }
      store.setUser(authData)

      // Enrich with Firestore profile (for displayName/photoURL) — non-blocking
      const gen = ++this.authGeneration
      this.loadProfile(user.uid).then(profile => {
        if (gen !== this.authGeneration) return
        if (!profile) return
        store.setUser({
          ...authData,
          displayName: profile.displayName || profile.fullName || authData.displayName,
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
        this.fetchBillingInfo(gen)
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
    const snap = await getDoc(doc(db, COLLECTIONS.USERS, uid))
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
    const result = await createUserWithEmailAndPassword(getFirebaseAuth(), email, password)
    const user = result.user

    // Create Firestore user profile (best-effort)
    try {
      await setDoc(doc(db, COLLECTIONS.USERS, user.uid), {
        uid: user.uid,
        email: user.email,
        fullName: displayName || '',
        displayName: displayName || '',
        photoURL: null,
        provider: 'email',
        emailVerified: user.emailVerified,
        onboarding: DEFAULT_ONBOARDING,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
        userPlan: 'explorer',
      })
    } catch {
      // Firestore may be unavailable
    }

    return user
  }

  async signInWithGoogle(): Promise<User> {
    const provider = new GoogleAuthProvider()
    provider.addScope('email')
    provider.addScope('profile')

    const result = await signInWithPopup(getFirebaseAuth(), provider)
    const user = result.user

    // Single setDoc with merge: true — creates doc if missing, merges if exists.
    // Includes ALL fields needed for a new user. merge:true means existing fields
    // (like userPlan set by subscription) won't be overwritten.
    try {
      await setDoc(doc(db, COLLECTIONS.USERS, user.uid), {
        uid: user.uid,
        email: user.email,
        fullName: user.displayName || '',
        displayName: user.displayName || '',
        photoURL: user.photoURL || null,
        provider: 'google',
        emailVerified: user.emailVerified,
        lastLogin: Timestamp.now(),
        updatedAt: Timestamp.now(),
      }, { merge: true })

      // Set defaults for new users only (fields that shouldn't exist yet).
      // merge:true won't overwrite existing userPlan/tmsQuota if present.
      const userDoc = doc(db, COLLECTIONS.USERS, user.uid)
      const snap = await getDoc(userDoc)
      const data = snap.data()
      if (data && !data.userPlan) {
        await setDoc(userDoc, {
          userPlan: 'explorer',
          onboarding: DEFAULT_ONBOARDING,
          createdAt: Timestamp.now(),
        }, { merge: true })
      }
    } catch (err) {
      console.warn('[auth] Google profile sync failed:', err)
    }

    return user
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
          // 403 = inactive account. Won't recover via retry. Mark loaded with
          // isActive=false so the UI can render the right state instead of
          // staying in loading state forever.
          if (res.status === 403) {
            console.warn('[billing] /v1/me returned 403 — account inactive')
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
          `Consumed: ${(data.billing.consumedPct * 100).toFixed(1)}%, ` +
          `Extra: ${data.billing.extraUsageBalance}, Status: ${data.billing.status}`
        )

        useBillingStore.getState().updateFromMe(data)
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
    setDoc(doc(db, COLLECTIONS.USERS, uid), fields, { merge: true }).catch(() => {})
  }
}

export default FirebaseAuthService
