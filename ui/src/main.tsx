/* @refresh reload */
import "virtual:uno.css";
import "./styles/themes.css";
import "./index.css";
import { render } from "solid-js/web";
import App from "./App";
import { AppPassword, SetPassword } from "./components/SetPassword";
import { evictStaleSummaries } from "./lib/db";
import { reloadIfEdgeLoginNeeded } from "./lib/edge-login";
import { registerServiceWorker } from "./lib/sw-register";

const root = document.getElementById("app");
if (!root) throw new Error("No #app element");
// The native app's password screens (the set-password link, the account menu's App password)
// stand alone: they never boot the mailbox. The web itself signs in with Cloudflare Access.
const screens: Record<string, () => ReturnType<typeof App>> = {
	"/set-password": () => <SetPassword />,
	"/app-password": () => <AppPassword />,
};
const screen = screens[window.location.pathname];
render(screen ?? (() => <App />), root);

registerServiceWorker();

// A lazy view's chunk 302s to the Access login once the session ends.
window.addEventListener("vite:preloadError", () => void reloadIfEdgeLoginNeeded());

// Evict cached email summaries older than 30 days on startup
evictStaleSummaries().catch(() => {});

// Surface otherwise-uncaught async failures (best-effort fetches, IDB,
// push setup) in a controlled way so they don't spam the console as
// "Uncaught (in promise)". Real render errors still bubble to <ErrorBoundary>.
window.addEventListener("unhandledrejection", (event) => {
	const reason = event.reason as { name?: string } | undefined;
	// Only swallow benign aborts (navigations / cancelled fetches). Everything
	// else is logged with full context and left to surface so real bugs and
	// production error capture are not masked.
	if (reason?.name === "AbortError") {
		event.preventDefault();
		return;
	}
	console.warn("[unhandledrejection]", event.reason);
});
window.addEventListener("error", (event) => {
	console.warn("[window.error]", event.message, event.filename, event.lineno, event.error);
});
