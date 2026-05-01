import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import App from "./App";
import { Provider } from "@/components/ui/provider";
import { ErrorBoundary } from "./components/ErrorBoundary";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <Provider>
          <App />
        </Provider>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);

// Reveal the Tauri window only after React's first paint commits. The window
// was created hidden in `lib.rs` to avoid a flash of empty/dark frame while
// the SPA mounts. Two `requestAnimationFrame` calls is the canonical "after
// paint" trick: rAF#1 fires before the next paint, rAF#2 fires after.
if (typeof window !== 'undefined' && (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
  requestAnimationFrame(() => {
    requestAnimationFrame(async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        await win.show();
        await win.setFocus();
      } catch {
        // Already visible or Tauri API unreachable — nothing to do.
      }
    });
  });
}
