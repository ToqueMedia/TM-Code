import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

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
      // The emulator at 127.0.0.1:8082 doesn't send CORS headers, so we
      // route through the Vite dev server (same-origin for the WebView).
      '/google.firestore.v1.Firestore': {
        target: 'http://127.0.0.1:8082',
        changeOrigin: true,
      },
      '/v1/projects': {
        target: 'http://127.0.0.1:8082',
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