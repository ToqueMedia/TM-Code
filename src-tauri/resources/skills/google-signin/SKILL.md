---
name: google-signin
description: Implement Google Sign-In using Google Identity Services (GIS) library with the boilerplate's backend auth-proxy. Use when the user explicitly requests Google/OAuth login. The backend endpoint POST /api/auth/proxy/google is pre-installed — this skill covers the frontend GSI integration only.
license: MIT
metadata:
  author: toquemedia-studio
  version: "1.0"
  language: en
---

# Google Sign-In — Implementation Recipe

Google Sign-In via Google Identity Services (GIS) library + backend auth-proxy. The backend endpoint `POST /api/auth/proxy/google` is PRE-INSTALLED.

**Important:** Google Sign-In is blocked inside iframes (preview mode) due to browser security. It works after deploy.

## Pre-installed (READ-ONLY)

- `backend/src/routes/auth-proxy.ts` — `POST /api/auth/proxy/google` accepts `{ idToken }` from GIS callback
- `.env` — `VITE_GOOGLE_CLIENT_ID` is auto-injected by the system. Do NOT modify.

## Step 1: Load GIS script in index.html

Edit `index.html` — add the GIS script in `<head>`:

```html
<script src="https://accounts.google.com/gsi/client" async defer></script>
```

## Step 2: Create Google Sign-In hook

```typescript
// src/hooks/useGoogleSignIn.ts
import { useEffect, useCallback } from 'react';
import { setAuthToken, authFetch } from '@/lib/authClient';
import { useAuthStore } from '@/hooks/useAuthStore';

declare global {
    interface Window {
        google?: {
            accounts: {
                id: {
                    initialize: (config: any) => void;
                    renderButton: (element: HTMLElement, config: any) => void;
                    prompt: () => void;
                };
            };
        };
    }
}

export function useGoogleSignIn(buttonRef: React.RefObject<HTMLDivElement | null>) {
    const setUser = useAuthStore(function (s) { return s.setUser; });

    const handleCredentialResponse = useCallback(async function (response: any) {
        try {
            const res = await fetch('/api/auth/proxy/google', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken: response.credential }),
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Google sign-in failed');

            setAuthToken(data.idToken, data.refreshToken);

            // Sync user to local DB
            const sync = await authFetch('/api/auth/sync', {
                method: 'POST',
                body: JSON.stringify({
                    uid: data.localId,
                    email: data.email,
                    name: data.displayName || data.email.split('@')[0],
                    avatarUrl: data.photoUrl || null,
                }),
            });

            if (sync.ok) {
                const user = await sync.json();
                if (setUser) setUser(user);
            }
        } catch (err: any) {
            console.error('Google sign-in error:', err.message);
        }
    }, [setUser]);

    useEffect(function () {
        const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
        if (!clientId || !window.google) return;

        window.google.accounts.id.initialize({
            client_id: clientId,
            callback: handleCredentialResponse,
            use_fedcm_for_prompt: true,
        });

        if (buttonRef.current) {
            window.google.accounts.id.renderButton(buttonRef.current, {
                theme: 'outline',
                size: 'large',
                width: '100%',
                text: 'continue_with',
            });
        }
    }, [buttonRef, handleCredentialResponse]);
}
```

**Note:** The auth store needs a `setUser` action (or use the existing `login` flow to set user state after Google auth).

## Step 3: Add button to Login/Signup screens

```tsx
import { useRef } from 'react';
import { useGoogleSignIn } from '@/hooks/useGoogleSignIn';

function LoginScreen() {
    const googleButtonRef = useRef<HTMLDivElement>(null);
    useGoogleSignIn(googleButtonRef);

    return (
        <div>
            {/* Email/password form above */}

            <div style={{ textAlign: 'center', margin: '16px 0' }}>
                or
            </div>

            {/* Google renders its own button here */}
            <div ref={googleButtonRef} />
        </div>
    );
}
```

## Auth flow sequence

1. GIS library renders Google button
2. User clicks → Google popup → returns `credential` (Google ID token)
3. Frontend calls `POST /api/auth/proxy/google` with `{ idToken: credential }`
4. Backend exchanges Google ID token with Identity Toolkit → returns `{ idToken, refreshToken, localId, email, displayName, photoUrl }`
5. Frontend calls `setAuthToken(idToken, refreshToken)`
6. Frontend calls `authFetch('/api/auth/sync')` to upsert user (with `displayName` and `photoUrl`)
7. User is logged in

## Rules

- **NEVER** use `signInWithPopup`, `GoogleAuthProvider`, or any Firebase JS SDK auth method
- **NEVER** modify `.env` — `VITE_GOOGLE_CLIENT_ID` is system-managed
- **ALWAYS** load GIS via `<script src="https://accounts.google.com/gsi/client">` in index.html
- **ALWAYS** call `/api/auth/sync` after Google sign-in to upsert user with name and avatar
- **ALWAYS** use `use_fedcm_for_prompt: true` in GIS initialize config
- Google Sign-In does NOT work in iframe preview — only after deploy. Do not try to work around this.
- Only implement Google Sign-In if the user explicitly requests it
