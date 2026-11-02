import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import unocss from "unocss/vite";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import solid from "vite-plugin-solid";

/**
 * Mileage maps on this machine: /mileage-local/* from ui/.mileage-local (the kit's sample-region tiles and
 * glyphs, copied by scripts/mileage-web-tiles.sh, gitignored), for `vite` and `vite preview` only. A
 * build never contains it; production reads VITE_MILEAGE_TILES / VITE_MILEAGE_GLYPHS (R2). PMTiles
 * reads byte ranges, so Range is answered with 206.
 */
function mileageLocalTiles(): Plugin {
	const root = fileURLToPath(new URL("./.mileage-local/", import.meta.url));
	const serve = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
		const url = new URL(req.url ?? "/", "http://local");
		if (!url.pathname.startsWith("/mileage-local/")) return next();
		const file = normalize(
			join(root, decodeURIComponent(url.pathname.slice("/mileage-local/".length))),
		);
		if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
			res.statusCode = 404;
			res.end("not found");
			return;
		}
		const size = statSync(file).size;
		const type = file.endsWith(".pbf") ? "application/x-protobuf" : "application/octet-stream";
		res.setHeader("Content-Type", type);
		res.setHeader("Accept-Ranges", "bytes");
		res.setHeader("Cache-Control", "no-store");
		const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
		if (range) {
			const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
			const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
			if (start > end || start >= size) {
				res.statusCode = 416;
				res.setHeader("Content-Range", `bytes */${size}`);
				res.end();
				return;
			}
			res.statusCode = 206;
			res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
			res.setHeader("Content-Length", String(end - start + 1));
			createReadStream(file, { start, end }).pipe(res);
			return;
		}
		res.setHeader("Content-Length", String(size));
		createReadStream(file).pipe(res);
	};
	return {
		name: "mileage-local-tiles",
		configureServer: (server) => void server.middlewares.use(serve),
		configurePreviewServer: (server) => void server.middlewares.use(serve),
	};
}

export default defineConfig({
	plugins: [
		mileageLocalTiles(),
		unocss(),
		solid(),
		VitePWA({
			strategies: "injectManifest",
			srcDir: "src",
			filename: "sw.ts",
			injectRegister: false,
			manifestFilename: "manifest.webmanifest",
			manifest: {
				id: "/",
				name: "Grip",
				short_name: "Grip",
				description: "Fast, private email client",
				theme_color: "#dcd4c3",
				background_color: "#dcd4c3",
				display: "standalone",
				scope: "/",
				start_url: "/",
				icons: [
					{
						src: "/icon-192.png",
						sizes: "192x192",
						type: "image/png",
					},
					{
						src: "/icon-512.png",
						sizes: "512x512",
						type: "image/png",
					},
					{
						src: "/icon-maskable-512.png",
						sizes: "512x512",
						type: "image/png",
						purpose: "maskable",
					},
				],
			},
			injectManifest: {
				// Classic script: browsers fetch a module service worker without cookies, so behind
				// Cloudflare Access its registration and every update hit the login redirect.
				rollupFormat: "iife",
				globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
				// Mileage carries MapLibre (about 1.2 MB): it loads when Mileage opens, not for everyone
				// on install.
				globIgnores: ["**/MileageView-*"],
			},
			devOptions: {
				enabled: false,
			},
		}),
	],
	server: { port: 3000, strictPort: true },
	build: { target: "esnext", outDir: "dist" },
});
