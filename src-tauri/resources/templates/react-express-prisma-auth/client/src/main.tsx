// Auth bootstrap MUST run BEFORE first render. The proxy flow stores tokens
// in sessionStorage; without init() a hard refresh leaves the user on an
// infinite Loading state because onAuthStateChanged never fires.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { useAuthStore } from './store/authStore'
import './lib/firebase'

useAuthStore.getState().init().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
