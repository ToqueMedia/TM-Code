import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// Firestore emulator proxy target — MUST stay in sync with
// src/services/auth/emulatorConfig.ts. When the IDE runs inside a Windows UTM
// VM, the Firebase emulators live on the macOS HOST, reachable only via the VM
// gateway IP (192.168.64.1) — the VM's own 127.0.0.1 has nothing on :8082, so a
// hardcoded loopback target made every Firestore request 502 (Bad Gateway).
// Vite itself runs inside the VM, so process.platform === 'win32' is the same
// signal emulatorConfig uses (IS_WINDOWS). Override via the VITE_EMULATOR_HOST
// OS env var (e.g. a native-Windows dev running the emulator locally → 127.0.0.1).
const emulatorHost =
  process.env.VITE_EMULATOR_HOST ||
  (process.platform === "win32" ? "192.168.64.1" : "127.0.0.1");
const firestoreEmulatorTarget = `http://${emulatorHost}:8082`;
// Auth emulator (identitytoolkit sign-in + securetoken refresh). Proxied like
// Firestore so the Tauri WebView reaches it through the dev server instead of
// hitting 127.0.0.1:9999 cross-origin — that direct hit was CORS-blocked
// ("access control checks") and broke every token refresh on reload
// (auth/network-request-failed → no token → /v1/me could not authenticate).
const authEmulatorTarget = `http://${emulatorHost}:9999`;

// Stamp permissive CORS headers onto proxied emulator responses so the WebView
// accepts them regardless of its exact origin, and answer preflight. The Firebase
// emulators don't send CORS headers themselves.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addEmulatorCors = (proxy: any) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proxy.on("proxyRes", (proxyRes: any, req: any) => {
    const origin = req.headers?.origin;
    proxyRes.headers["access-control-allow-origin"] = origin || "*";
    proxyRes.headers["access-control-allow-credentials"] = "true";
    proxyRes.headers["access-control-allow-methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
    proxyRes.headers["access-control-allow-headers"] =
      req.headers?.["access-control-request-headers"] || "*";
  });
};

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  resolve: {
    tsconfigPaths: true,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    proxy: {
      // Proxy Firestore emulator requests to avoid CORS in Tauri WebView.
      // The emulator (firestoreEmulatorTarget) doesn't send CORS headers, so we
      // route through the Vite dev server (same-origin for the WebView). The
      // target host is VM-aware — see the firestoreEmulatorTarget note above.
      '/google.firestore.v1.Firestore': {
        target: firestoreEmulatorTarget,
        changeOrigin: true,
        configure: addEmulatorCors,
      },
      '/v1/projects': {
        target: firestoreEmulatorTarget,
        changeOrigin: true,
        configure: addEmulatorCors,
      },
      // Auth emulator — the SDK, when pointed at the proxy (see firebaseAuth.ts
      // connectAuthEmulator), calls /identitytoolkit.googleapis.com/* (sign-in)
      // and /securetoken.googleapis.com/* (token refresh); forward both to 9999.
      '/identitytoolkit.googleapis.com': {
        target: authEmulatorTarget,
        changeOrigin: true,
        configure: addEmulatorCors,
      },
      '/securetoken.googleapis.com': {
        target: authEmulatorTarget,
        changeOrigin: true,
        configure: addEmulatorCors,
      },
    },
  },

  // Configuration for Monaco Editor workers
  worker: {
    format: 'es' as const,
    plugins: () => [],
  },

  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT') {
          return;
        }
        warn(warning);
      },
      output: {
        manualChunks(id: string) {
          if (id.includes('monaco-editor')) {
            return 'monaco'
          }
        }
      }
    }
  }
}));