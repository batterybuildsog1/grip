export function registerServiceWorker(): void {
	if (!("serviceWorker" in navigator)) return;
	const isLocalDevHost =
		window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";

	if (import.meta.env.DEV && isLocalDevHost) {
		window.addEventListener("load", () => {
			void navigator.serviceWorker
				.getRegistrations()
				.then((registrations) =>
					Promise.all(registrations.map((registration) => registration.unregister())),
				)
				.catch(() => {});
		});
		return;
	}

	window.addEventListener("load", async () => {
		try {
			const registration = await navigator.serviceWorker.register("/sw.js", {
				scope: "/",
				updateViaCache: "none",
			});
			// Automation that blocks service workers (Playwright) resolves register() with nothing.
			if (!registration) return;

			// Check for updates every 5 minutes
			setInterval(
				() => {
					registration.update().catch(() => {});
				},
				5 * 60 * 1000,
			);

			// Check for updates when app returns to foreground (critical for iOS PWA)
			document.addEventListener("visibilitychange", () => {
				if (!document.hidden) registration.update().catch(() => {});
			});
		} catch (err) {
			console.error("SW registration failed:", err);
		}
	});

	// A service-worker update must never force-refresh the mail UI. Forced
	// reloads can interrupt compose/autosave and were also making cold mobile
	// loads restart mid-boot. The new worker can take over quietly; the current
	// app shell keeps running until the user naturally navigates or reloads.
}
