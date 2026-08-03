import React from "react";
import { disableInputAssist } from "./utils/disableInputAssist";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import App from "./App";
import { Provider } from "@/components/ui/provider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { logger } from "./utils/logger";
import { installWindowHost } from "@/services/agent/host/windowHost";

/**
 * React 19: handlers de erro do root COM componentStack (disponível também em
 * produção — ao contrário do owner stack). A investigação do React #185
 * ("Maximum update depth exceeded", ver memória react-185) ficou inconclusiva
 * precisamente por falta do componentStack; na próxima ocorrência fica no log
 * o componente exato do loop. Docs: react.dev/reference/react-dom/client/createRoot.
 */
function logRootError(kind: string) {
  return (error: unknown, errorInfo: { componentStack?: string }) => {
    const message = error instanceof Error ? error.message : String(error);
    const depthLoop = /maximum update depth/i.test(message) ? " [REACT#185]" : "";
    logger.error(
      "react",
      `${kind}${depthLoop}: ${message}\ncomponentStack:${errorInfo.componentStack ?? " (unavailable)"}`,
    );
  };
}

// Nenhum campo da IDE completa nem corrige automaticamente. Ligado antes do
// render para o primeiro ecrã já nascer coberto — ver disableInputAssist.
disableInputAssist();

// Hospedeiro-janela da costura AgentHost (P1 headless): regista o handler de
// notificações de SO no hostBus antes de qualquer run poder notificar.
installWindowHost();

// Runner headless (P5, `--run`): se o processo carrega um job, o condutor
// instala o hospedeiro headless (substitui o de janela no registry) e conduz
// o run — a app continua a montar normalmente, numa janela invisível.
void import("@/services/agent/runner/headlessRunner")
  .then((m) => m.maybeStartHeadlessRunner())
  .catch(() => { /* fora do Tauri não há runner */ });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
  onUncaughtError: logRootError("Uncaught render error"),
  onCaughtError: logRootError("Caught render error (ErrorBoundary)"),
}).render(
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
