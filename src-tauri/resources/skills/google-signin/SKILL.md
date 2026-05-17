---
name: google-signin
description: Implement Google Sign-In via the GIS (Google Identity Services) inline button. The popup-based signInWithPopup / GoogleAuthProvider / signInWithRedirect approaches are silently blocked in the IDE preview's webview — use the GIS inline button instead. Applies whenever Google sign-in is added to a project, however phrased ("add Google login", "sign-in with Google", "#auth-google", OAuth button, etc.) — the trigger is intentionally broad. The backend endpoint POST /api/auth/proxy/google is pre-installed; this skill covers the frontend GIS integration.
license: MIT
metadata:
  author: toquemedia-studio
  version: "1.0"
  language: en
---

# Google Sign-In — Implementation Recipe

Google Sign-In via the GIS (Google Identity Services) inline button + the backend auth-proxy. The backend endpoint `POST /api/auth/proxy/google` is PRE-INSTALLED.

**Note:** The IDE itself warns the developer when Google Sign-In is clicked inside the in-app preview (it's blocked in iframes by browser security and requires a real browser to test). Do NOT add inline notices, banner text, comments, or hint paragraphs about this in the generated code or chat — the IDE handles it. Just implement the recipe.

## CRITICAL: Use the GIS inline button — popup-style sign-in is silently blocked

This is the single most-common mistake on this skill — the model's training prior is `signInWithPopup` (the most-cited pattern in popup-style OAuth tutorials). The popup approach fails in the IDE preview's child webview; use the GIS button approach (Step 2 below) instead.

**Forbidden imports** — never import any of these from `firebase/auth`:

```ts
// ❌ NEVER — every line below produces a broken sign-in in the IDE preview:
import { signInWithPopup, GoogleAuthProvider } from 'firebase/auth'
import { signInWithRedirect } from 'firebase/auth'
import { signInWithCustomToken } from 'firebase/auth'
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth'
import { signOut } from 'firebase/auth'

// ✅ DO — the only allowed import from firebase/auth on the client:
import { onAuthStateChanged } from 'firebase/auth'  // (note: won't fire in proxy flow — see auth-proxy)
```

**Why popup specifically fails here**: the IDE preview runs the user's app inside a wry/WKWebView **child webview**. Browser security blocks `window.open()` popups in that context — the popup never appears, the click registers as no-op, the user reports "the button does nothing". The GIS button approach (Step 2) renders the credential picker **inline as part of the page** (FedCM dialog) — that works in BOTH the IDE preview AND any real browser. There is no scenario where the popup approach is acceptable in this product.

**Why the other client-side auth-library methods are also forbidden**: `signInWithEmailAndPassword`, `createUserWithEmailAndPassword`, `signOut` etc. bypass the auth-proxy and would talk directly to the auth API from the client — the project's auth contract requires every credential exchange to go through `POST /api/auth/proxy/*` (signup, signin, google, refresh) so the backend can attach tenant context, JWT-verify, and upsert into the platform data layer via `/api/auth/sync`. Direct client-side auth-library calls skip all of that.

**If you find yourself reaching for `signInWithPopup`, stop and read Step 2.** The hook there is a drop-in: render the `<div ref={googleButtonRef} />`, wire `onSuccess` to `navigate('/dashboard')`, done.

## CRITICAL: Copy the reference hook verbatim

**The hook in Step 2 is the canonical contract.** Copy its signature and structure exactly. Do NOT improvise the API surface, do NOT swap `useRef` for `getElementById`, do NOT change the parameter order or rename `onSuccess`.

Improvising this hook breaks Google sign-in in three specific ways documented below. Each broken generation needed manual fixes from the developer to ship. The reference is the contract.

## CRITICAL: Poll for `window.google`

**MUST** poll for `window.google` to exist before calling `initialize` / `renderButton`. The GIS `<script async defer>` loads non-blocking — on first render `window.google` is `undefined`, and `useEffect` runs ONCE per dependency change.

**DO**:
```ts
const interval = setInterval(() => { if (window.google) { clearInterval(interval); init() } }, 100)
const timeout = setTimeout(() => clearInterval(interval), 10000)
```

**DO NOT**:
```ts
if (!window.google) return  // silent exit — button only appears after manual page refresh
```

The reference impl in Step 2 has the polling baked in. Use it.

## CRITICAL: Hook signature is `(buttonRef, options?)`

**MUST** match this signature:
```ts
useGoogleSignIn(buttonRef: RefObject<HTMLDivElement | null>, options?: { onSuccess?: (user) => void })
```

**MUST** render the button via the passed `ref`, not via `document.getElementById`. The Login screen creates the ref with `useRef<HTMLDivElement>(null)`, mounts it on `<div ref={ref} />`, and passes the ref to the hook.

**DO NOT** invent alternative signatures like `useGoogleSignIn(onSuccess?)` or `useGoogleSignIn({ onSuccess })`. The two-positional form is the canonical contract.

## CRITICAL: Post-token contract — execute all four steps

After the GIS callback exchanges the Google credential for session tokens via `POST /api/auth/proxy/google`, you **MUST** execute these four calls IN ORDER:

1. `setAuthToken(idToken, refreshToken)` — persists the Bearer for `authFetch`. Skipping this causes the very next `/api/auth/sync` to return 401.
2. `await authFetch('/api/auth/sync', { method: 'POST', body: JSON.stringify({ uid, email, name, avatarUrl }) })` — upserts the user into your DB. The skill's backend route returns the canonical user row.
3. `setUser(syncedUser)` — populates the Zustand store. Without this the auth state stays empty and `AuthGuard` redirects back to `/login` on refresh.
4. `options?.onSuccess?.(user)` — fires the navigation callback. Without this the user lands authenticated but on `/login` (the route guard only redirects FROM protected routes TO login, never the inverse).

Skipping any step breaks the flow in a different observable way: 401 on next request, redirect loop, stranded on login. ALL FOUR are mandatory.

## CRITICAL: The Vite proxy must exist

`/api/auth/proxy/google` is a **same-origin** path. Without `vite.config.ts` proxying `/api` to the backend, the request hits port 5173 and returns **404**. See `auth-proxy` skill, hard rule #8 — the snippet is one line and **MUST** be present in `vite.config.ts` before this hook can possibly work.

## CRITICAL: Render Google avatars with `referrerPolicy="no-referrer"`

Google profile photos served from \`lh3.googleusercontent.com\` (and \`googleusercontent.com\` siblings) reject requests whose \`Referer\` header points at \`localhost\` or other non-Google origins — the CDN returns 403 with an empty body, which the browser displays as a broken image. There is no console error; the Network tab shows the 403.

**MUST** set \`referrerPolicy="no-referrer"\` on every \`<img>\` whose \`src\` is the user's Google photo:

```tsx
<img
  src={user.avatar_url}
  alt={user.name}
  referrerPolicy="no-referrer"
/>
```

This strips the \`Referer\` header on the image fetch, and Google's CDN serves the photo. Applies to ALL profile-photo URLs returned by the auth API's \`signInWithIdp\` for the \`google.com\` provider — never skip the attribute even when it "works on my machine" (cached by previous fetches).

## Pre-installed (READ-ONLY)

- `backend/src/routes/auth-proxy.ts` — `POST /api/auth/proxy/google` accepts `{ idToken }` from GIS callback
- `.env` — `VITE_TM_GOOGLE_CLIENT_ID` is auto-injected by the platform (legacy `VITE_GOOGLE_CLIENT_ID` also written for backward compat with old code). Do not modify .env directly.

> **Monorepo note:** `.env` is at the project root. If your Vite app lives in `client/` (or any subdirectory), Vite won't find `VITE_TM_GOOGLE_CLIENT_ID` by default and the GIS button will silently fail to render. See `auth-proxy` skill, "Frontend (Vite) — `VITE_*` vars in monorepo layouts" for the `envDir` fix.

## Step 1: Load GIS script in index.html

Edit `index.html` — add the GIS script in `<head>`:

```html
<script src="https://accounts.google.com/gsi/client" async defer></script>
```

## Step 2: Create Google Sign-In hook

The hook accepts an optional `onSuccess` callback fired AFTER the user is set. The Login screen passes a navigation closure so the user lands on the post-auth route. Without this, the auth store updates but the page stays on `/login` — the email/password flow handles its own navigation in the form `onSubmit` handler, but the GIS callback fires inside this hook and has no way to navigate unless the screen wires it.

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

interface UseGoogleSignInOptions {
    /** Called after the user is upserted and stored. Use to navigate to the post-auth route. */
    onSuccess?: (user: any) => void;
}

export function useGoogleSignIn(
    buttonRef: React.RefObject<HTMLDivElement | null>,
    options?: UseGoogleSignInOptions,
) {
    const setUser = useAuthStore(function (s) { return s.setUser; });
    const onSuccess = options?.onSuccess;

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
                if (onSuccess) onSuccess(user);
            }
        } catch (err: any) {
            console.error('Google sign-in error:', err.message);
        }
    }, [setUser, onSuccess]);

    useEffect(function () {
        const clientId = import.meta.env.VITE_TM_GOOGLE_CLIENT_ID || import.meta.env.VITE_GOOGLE_CLIENT_ID;
        if (!clientId) return;

        let cancelled = false;

        function init() {
            if (cancelled || !window.google) return;
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
        }

        if (window.google) {
            // Script already loaded (cached refresh, etc.) — initialize sync.
            init();
            return;
        }

        // The GSI script has `async defer` so on first load it may not be
        // ready when this effect runs. Poll briefly until it lands. Without
        // this, the button only appears after a manual page refresh.
        const interval = setInterval(function () {
            if (window.google) {
                clearInterval(interval);
                init();
            }
        }, 100);
        // Cap polling at ~10s — if the script never loads (offline, blocked)
        // we stop trying and the user sees the email/password form only.
        const timeout = setTimeout(function () { clearInterval(interval); }, 10000);

        return function () {
            cancelled = true;
            clearInterval(interval);
            clearTimeout(timeout);
        };
    }, [buttonRef, handleCredentialResponse]);
}
```

> **Why the polling?** The `<script src=".../gsi/client" async defer>` in `index.html` loads non-blocking. On first page load, React mounts before the GSI script finishes — `window.google` is undefined and `useEffect` runs once, exits silently, and never retries (deps are stable). The user only sees the button after a manual refresh (cached script loads sync). The polling above closes the race without forcing a synchronous script load.

**Note:** The auth store needs a `setUser` action (or use the existing `login` flow to set user state after Google auth).

## Step 3: Add button to Login/Signup screens

Wire the redirect via the `onSuccess` option. Use the same target route as the email/password handler (typically `/success` or `/dashboard`) so both flows behave identically.

```tsx
import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGoogleSignIn } from '@/hooks/useGoogleSignIn';

function LoginScreen() {
    const navigate = useNavigate();
    const googleButtonRef = useRef<HTMLDivElement>(null);
    useGoogleSignIn(googleButtonRef, {
        onSuccess: () => navigate('/success', { replace: true }),
    });

    return (
        <div>
            {/* Email/password form above — its onSubmit handler also calls navigate('/success') */}

            <div style={{ textAlign: 'center', margin: '16px 0' }}>
                or
            </div>

            {/* Google renders its own button here */}
            <div ref={googleButtonRef} />
        </div>
    );
}
```

For routers other than React Router (TanStack, Wouter, Next App Router), substitute the equivalent navigation primitive in the `onSuccess` body — the hook does not assume a specific router.

## Auth flow sequence

1. GIS library renders Google button
2. User clicks → Google popup → returns `credential` (Google ID token)
3. Frontend calls `POST /api/auth/proxy/google` with `{ idToken: credential }`
4. Backend exchanges Google ID token with the auth API → returns `{ idToken, refreshToken, localId, email, displayName, photoUrl }`
5. Frontend calls `setAuthToken(idToken, refreshToken)`
6. Frontend calls `authFetch('/api/auth/sync')` to upsert user (with `displayName` and `photoUrl`)
7. Hook fires `onSuccess(user)` — Login screen navigates to the post-auth route (e.g. `/success`)
8. User is logged in and on the destination page

## Rules

- Use the GIS inline button, not `signInWithPopup` / `GoogleAuthProvider` / `signInWithRedirect` or any client-side auth-library method — they are silently blocked in the IDE preview's webview.
- `.env` is platform-managed — read `VITE_TM_GOOGLE_CLIENT_ID` from it; do not modify the file directly.
- **ALWAYS** load GIS via `<script src="https://accounts.google.com/gsi/client">` in index.html
- **ALWAYS** call `/api/auth/sync` after Google sign-in to upsert user with name and avatar
- **ALWAYS** use `use_fedcm_for_prompt: true` in GIS initialize config
- **ALWAYS** wire navigation via `onSuccess` so the user lands on the post-auth route — without it, `setUser` updates the store but the page stays on `/login` (route guards only redirect *to* login, not *from* it). Use the same target route as the email/password form's `navigate(...)` call
- Do NOT add notices/comments about iframe limitations — the IDE shows a friendly toast when the developer clicks the GIS button in preview. Just implement the flow.
- Only implement Google Sign-In if the user explicitly requests it

## FINAL REMINDER — the four rules whose violation costs the entire flow

Re-read these before submitting any Google Sign-In change. Each one breaks the flow in a different way that looks like a generic auth issue but isn't:

1. **GIS inline button, NEVER `signInWithPopup`.** Popups are silently no-op'd in the IDE preview webview. The user sees "the button does nothing" and nothing in the console. Forbidden imports from `firebase/auth`: `signInWithPopup`, `GoogleAuthProvider`, `signInWithRedirect`, `signInWithCustomToken`. Only `onAuthStateChanged` is allowed AS AN IMPORT (note: won't fire in proxy flow; use bootstrap pattern from `auth-proxy` skill).
2. **Execute ALL FOUR post-token steps in order**: `setAuthToken(idToken, refreshToken)` → `await authFetch('/api/auth/sync', ...)` → `setUser(syncedUser)` → `options?.onSuccess?.(user)`. Skipping any step breaks differently — 401 on next request, redirect loop, or stranded on `/login` after successful sign-in. The hook in Step 2 has all four — do not improvise.
3. **Google avatar `<img>` MUST set `referrerPolicy="no-referrer"`.** `lh3.googleusercontent.com` returns 403 when `Referer` is `localhost`. Avatar appears broken with no console error. Apply to every `<img>` displaying a Google profile photo.
4. **Vite dev proxy MUST forward `/api`** to the backend (one-line `server.proxy['/api']` in `vite.config.ts`). Without it, `POST /api/auth/proxy/google` hits port 5173 and returns 404 HTML — the request never reaches the backend. CORS on the backend is NOT a substitute. Verify with `curl http://localhost:5173/api/auth/me` returning JSON, not HTML.

**Symptom-to-rule map for fast debugging**:
- "Button does nothing on click" → rule 1 (popup blocked, switch to GIS).
- "Sign-in succeeds but next request is 401" → rule 2 step 1 (setAuthToken not called).
- "Sign-in succeeds, refresh lands on /login" → rule 2 (init() before render — see auth-proxy skill).
- "Avatar broken / empty image" → rule 3 (referrerPolicy="no-referrer").
- "POST /api/auth/proxy/google → 404 HTML" → rule 4 (Vite proxy missing).
