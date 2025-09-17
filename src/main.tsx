import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Provider } from "@/components/ui/provider";
import { ErrorBoundary } from "./components/ErrorBoundary";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Provider>
        <App />
      </Provider>
    </ErrorBoundary>
  </React.StrictMode>,
);
