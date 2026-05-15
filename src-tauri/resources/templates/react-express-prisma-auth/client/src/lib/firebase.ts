// Firebase init for the proxy-only auth flow.
//
// Hard rules from the auth-proxy skill:
//   - the ONLY allowed import from firebase/auth is `onAuthStateChanged`
//     (and even that listener will not fire in this flow — see skill)
//   - tenantId MUST be set so Firebase Admin REST calls scope correctly
//   - inside an iframe (IDE preview), use inMemoryPersistence to dodge
//     IndexedDB partitioning that breaks login state on every reload
import { initializeApp } from 'firebase/app'
import { getAuth, inMemoryPersistence, setPersistence } from 'firebase/auth'

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
})

export const auth = getAuth(app)
auth.tenantId = import.meta.env.VITE_GIP_TENANT_ID

if (typeof window !== 'undefined' && window !== window.parent) {
  setPersistence(auth, inMemoryPersistence)
}
