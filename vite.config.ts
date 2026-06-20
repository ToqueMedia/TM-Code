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
      },
      '/v1/projects': {
        target: firestoreEmulatorTarget,
        changeOrigin: true,
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