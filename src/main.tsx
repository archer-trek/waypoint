import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installOverlayScrollbars } from "./lib/overlay-scrollbars";

if (typeof window !== "undefined" && typeof document !== "undefined") {
  installOverlayScrollbars(window, document);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
