import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { BlackBoxCockpit, MissingAuthentication } from "./app.js";
import { ViewerApiClient } from "./api.js";
import { parseViewerBootstrap } from "./bootstrap.js";
import "./styles.css";

const TOKEN_KEY = "blackbox.control-token";
const root = document.querySelector<HTMLDivElement>("#root");

if (root === null) {
  throw new Error("Black Box viewer root is missing.");
}

const bootstrap = parseViewerBootstrap(
  new URL(window.location.href),
  window.sessionStorage.getItem(TOKEN_KEY),
);
if (bootstrap.token !== undefined) {
  window.sessionStorage.setItem(TOKEN_KEY, bootstrap.token);
}
if (window.location.hash.length > 0) {
  window.history.replaceState(null, "", bootstrap.cleanPath);
}

const view =
  bootstrap.token === undefined ? (
    <MissingAuthentication />
  ) : (
    <BlackBoxCockpit
      api={
        new ViewerApiClient(
          import.meta.env.VITE_BLACKBOX_API_ORIGIN ?? window.location.origin,
          bootstrap.token,
        )
      }
      initialSessionId={bootstrap.sessionId}
    />
  );

createRoot(root).render(<StrictMode>{view}</StrictMode>);
