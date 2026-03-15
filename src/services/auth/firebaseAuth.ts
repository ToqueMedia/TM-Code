import { initializeApp } from 'firebase/app'
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  getAdditionalUserInfo,
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
import { useAuthStore } from '../../stores/authStore'
import { shouldUseEmulators, EMULATOR_CONFIG } from './emulatorConfig'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyBaWQpRaCobIHsqSlJ7Aba1qhEZAlqnUJc",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "maiplayer-ac56d.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "maiplayer-ac56d",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "maiplayer-ac56d.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "113004896685",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:113004896685:web:fbc83072c4f870d92e0124",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-S6V1T01G96"
}

const app = initializeApp(firebaseConfig)
const auth = getAuth(app)

// Initialize Firestore
initializeFirestore(app, { ignoreUndefinedProperties: true })
export const db = getFirestore(app)

// Collections (aligned with web project)
export const COLLECTIONS = {
  USERS: 'users',
  PROJECTS: 'projects',
  DEV_STUDIO_PROJECTS: 'devStudioProjects',
} as const

// Connect to emulators in development
if (shouldUseEmulators()) {
  try {
    connectAuthEmulator(auth, `http://${EMULATOR_CONFIG.AUTH.HOST}:${EMULATOR_CONFIG.AUTH.PORT}`, {
      disableWarnings: true,
    })
    connectFirestoreEmulator(db, EMULATOR_CONFIG.FIRESTORE.HOST, EMULATOR_CONFIG.FIRESTORE.PORT)
    console.log('[Firebase] Connected to emulators (Auth + Firestore)')
  } catch (error) {
    console.warn('[Firebase] Failed to connect to emulators:', error)
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

    this.unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      this.currentUser = user
      const store = useAuthStore.getState()

      if (!user) {
        store.setUser(null)
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

      // Then enrich with Firestore profile (non-blocking)
      const gen = ++this.authGeneration
      this.loadProfile(user.uid).then(profile => {
        // Discard if a newer auth event already fired
        if (gen !== this.authGeneration) return
        if (!profile) return

        store.setUser({
          ...authData,
          displayName: profile.displayName || authData.displayName,
          photoURL: profile.photoURL || authData.photoURL,
        })
      }).catch(() => {
        // Firestore unavailable — Firebase Auth data is already set
      })
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
    const result = await signInWithEmailAndPassword(auth, email, password)

    // Update lastLogin (best-effort, aligned with web project)
    this.syncProfile(result.user.uid, {
      lastLogin: Timestamp.now(),
      updatedAt: Timestamp.now(),
    })

    return result.user
  }

  async signUp(email: string, password: string, displayName?: string): Promise<User> {
    const result = await createUserWithEmailAndPassword(auth, email, password)
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

    const result = await signInWithPopup(auth, provider)
    const additionalInfo = getAdditionalUserInfo(result)
    const user = result.user

    // setDoc with merge: true — works for both new and existing users,
    // avoids updateDoc crash when document doesn't exist yet
    try {
      if (additionalInfo?.isNewUser) {
        await setDoc(doc(db, COLLECTIONS.USERS, user.uid), {
          uid: user.uid,
          email: user.email,
          fullName: user.displayName || '',
          displayName: user.displayName || '',
          photoURL: user.photoURL || null,
          provider: 'google',
          emailVerified: user.emailVerified,
          onboarding: DEFAULT_ONBOARDING,
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now(),
          userPlan: 'explorer',
        })
      } else {
        await setDoc(doc(db, COLLECTIONS.USERS, user.uid), {
          displayName: user.displayName || '',
          photoURL: user.photoURL || null,
          lastLogin: Timestamp.now(),
          updatedAt: Timestamp.now(),
        }, { merge: true })
      }
    } catch {
      // Profile sync is best-effort
    }

    return user
  }

  async signOut(): Promise<void> {
    await signOut(auth)
  }

  async getIdToken(): Promise<string | null> {
    if (!this.currentUser) return null
    return this.currentUser.getIdToken(false)
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
