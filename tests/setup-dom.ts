/**
 * Test bootstrap: polyfill DOMParser + Node in the Node runtime so code
 * under test (UI utilities) can use the browser DOM APIs it expects.
 *
 * Imported as the first side-effect of tests/mailclaw.test.ts. Import order
 * matters — the global must be installed before any module that calls
 * DOMParser at evaluation or invocation time.
 *
 * Uses linkedom, a zero-config, Node-compatible DOM implementation that
 * exposes the subset of APIs sanitize.ts needs (DOMParser, Element, Node
 * constants). Kept as a devDependency only — Vite tree-shakes it out of
 * the browser bundle.
 */

import { parseHTML } from "linkedom";

type Global = typeof globalThis & {
	DOMParser?: unknown;
	Node?: unknown;
	Element?: unknown;
	HTMLElement?: unknown;
};

const g = globalThis as Global;

// Pull DOM constructors from a linkedom window. parseHTML gives us a
// consistent window/document with all the globals we need.
const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");

/**
 * Shim DOMParser so sanitize.ts's `new DOMParser().parseFromString(html, "text/html")`
 * works identically to the browser:
 *  - Fragments get wrapped in <html><body>...</body></html>.
 *  - `doc.body` returns the body element.
 *
 * linkedom's own DOMParser returns a document whose body is null when given
 * a fragment, which is different from the browser. We use parseHTML to get
 * the right shape.
 */
class ShimDOMParser {
	parseFromString(html: string, _type: string) {
		const doc = parseHTML(
			`<!doctype html><html><head></head><body>${html}</body></html>`,
		).document;
		return doc;
	}
}

if (typeof g.DOMParser === "undefined") {
	// biome-ignore lint/suspicious/noExplicitAny: runtime polyfill
	g.DOMParser = ShimDOMParser as any;
}

if (typeof g.Node === "undefined") {
	// biome-ignore lint/suspicious/noExplicitAny: runtime polyfill
	g.Node = (window as any).Node;
	// biome-ignore lint/suspicious/noExplicitAny: runtime polyfill
	g.Element = (window as any).Element;
	// biome-ignore lint/suspicious/noExplicitAny: runtime polyfill
	g.HTMLElement = (window as any).HTMLElement;
}
