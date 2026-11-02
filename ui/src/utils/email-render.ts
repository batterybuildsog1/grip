export interface EmailAttachmentReference {
	id: string;
	content_id: string | null;
}

export interface EmailRenderOptions {
	baseUrl?: string;
	attachments?: EmailAttachmentReference[];
	emailId?: string;
	allowRemoteImages?: boolean;
	title?: string;
	/**
	 * Render-time rewrite for outbound http(s)/ftp link hrefs (e.g. Google
	 * invite authuser injection). Anchors escape the sandbox natively on
	 * click, so click-time rewriting is no longer possible.
	 */
	rewriteLink?: (href: string) => string;
	/** Hide the blocks the server marked data-mc-quoted="<this id>" (quoted text). */
	hideQuotedId?: string;
	/**
	 * The app's theme. A sender's `prefers-color-scheme` rules are resolved for it here, because
	 * what the frame's own media query sees differs by browser (and from the app's setting).
	 */
	scheme?: "light" | "dark";
}

/** A message's frame document. */
export interface EmailFrameDocument {
	srcdoc: string;
	/** The sender styled a dark version (prefers-color-scheme: dark, or a color-scheme meta). */
	ownDark: boolean;
}

const BLOCKED_TAGS = new Set([
	"script",
	"iframe",
	"object",
	"embed",
	"form",
	"input",
	"textarea",
	"button",
	"select",
	"option",
	"optgroup",
	"video",
	"audio",
	"source",
	"track",
	"canvas",
	"applet",
	"frameset",
	"frame",
	"noscript",
	"template",
	"base",
	"meta",
	"link",
	"head",
]);

const SAFE_STYLE_PROPERTIES = new Set([
	"background",
	"background-color",
	"background-position",
	"background-repeat",
	"background-size",
	"border",
	"border-bottom",
	"border-bottom-color",
	"border-bottom-left-radius",
	"border-bottom-right-radius",
	"border-bottom-style",
	"border-bottom-width",
	"border-collapse",
	"border-color",
	"border-left",
	"border-left-color",
	"border-left-style",
	"border-left-width",
	"border-radius",
	"border-right",
	"border-right-color",
	"border-right-style",
	"border-right-width",
	"border-spacing",
	"border-style",
	"border-top",
	"border-top-color",
	"border-top-left-radius",
	"border-top-right-radius",
	"border-top-style",
	"border-top-width",
	"border-width",
	"box-shadow",
	"box-sizing",
	"caption-side",
	"clear",
	"color",
	"display",
	"empty-cells",
	"flex",
	"flex-basis",
	"flex-direction",
	"flex-grow",
	"flex-shrink",
	"flex-wrap",
	"float",
	"font",
	"font-family",
	"font-feature-settings",
	"font-size",
	"font-stretch",
	"font-style",
	"font-variant",
	"font-weight",
	"height",
	"hyphens",
	"letter-spacing",
	"line-height",
	"list-style",
	"list-style-image",
	"list-style-position",
	"list-style-type",
	"left",
	"margin",
	"margin-bottom",
	"margin-left",
	"margin-right",
	"margin-top",
	"max-height",
	"max-width",
	"min-height",
	"min-width",
	"bottom",
	"object-fit",
	"object-position",
	"opacity",
	"outline",
	"overflow",
	"overflow-wrap",
	"overflow-x",
	"overflow-y",
	"padding",
	"padding-bottom",
	"padding-left",
	"padding-right",
	"padding-top",
	"page-break-after",
	"page-break-before",
	"page-break-inside",
	"position",
	"table-layout",
	"text-align",
	"text-decoration",
	"text-indent",
	"text-overflow",
	"text-shadow",
	"text-transform",
	"top",
	"transform",
	"right",
	"transition-delay",
	"transition-duration",
	"transition-property",
	"transition-timing-function",
	"unicode-bidi",
	"vertical-align",
	"visibility",
	"white-space",
	"width",
	"word-break",
	"word-spacing",
	"word-wrap",
]);

const SAFE_BODY_ATTRS = new Set([
	"aria-label",
	"aria-live",
	"bgcolor",
	"background",
	"class",
	"dir",
	"id",
	"lang",
	"link",
	"role",
	"style",
	"text",
	"title",
	"vlink",
	"alink",
]);

const URL_ATTRS = new Set([
	"action",
	"background",
	"cite",
	"data",
	"formaction",
	"href",
	"longdesc",
	"poster",
	"src",
	"srcset",
	"xlink:href",
]);

const SAFE_DATA_URL_RE =
	/^data:image\/(?:avif|bmp|gif|jpeg|jpg|png|svg\+xml|webp);base64,[a-z0-9+/=\s]+$/i;
const FIXED_WIDTH_THRESHOLD = 240;

/* Render every email as a light document (white card, dark text) regardless
   of the app's dark theme — senders author for white backgrounds, so on
   MailClaw's dark reading-pane surface their black text was invisible
   (~1.5:1). This matches Gmail's dark mode, which keeps the email body light
   inside the dark chrome. Emails that set their own bg/colors override. */
const LIGHT_DOCUMENT_CSS = `
html, body {
	color-scheme: light;
	background-color: #ffffff;
}

body {
	color: #202124;
}
`;

/* The sender wrote a dark version and the app is dark: their rules, on a dark canvas. */
const DARK_DOCUMENT_CSS = `
html, body {
	color-scheme: dark;
}
`;

const BASE_RENDER_CSS = `
html, body {
	width: 100%;
	max-width: 100%;
	margin: 0;
	padding: 0;
	overflow-x: hidden;
	/* The frame is as tall as the mail (the size report measures body): a sender's
	   height:100% would pin it to whatever height the frame already has. */
	height: auto !important;
	min-height: 0 !important;
}

/* The frame never scrolls itself. overflow-x:hidden alone makes overflow-y auto, and in WebKit the
   scrollbar a briefly short frame showed narrowed the mail, which grew taller, so the reported
   height flipped between two values after a resize. */
html {
	overflow: hidden !important;
}

body {
	box-sizing: border-box;
	-webkit-text-size-adjust: 100%;
	text-size-adjust: 100%;
	min-width: 0 !important;
	overflow-wrap: anywhere;
	word-break: break-word;
}

body.mailclaw-email-root {
	min-width: 0;
}

.mailclaw-email-root {
	width: 100%;
	max-width: 100%;
	box-sizing: border-box;
}

.mailclaw-email-root *,
.mailclaw-email-root *::before,
.mailclaw-email-root *::after {
	box-sizing: border-box;
}

.mailclaw-email-root img,
.mailclaw-email-root video,
.mailclaw-email-root canvas,
.mailclaw-email-root svg,
.mailclaw-email-root iframe {
	max-width: 100%;
	height: auto;
}

.mailclaw-email-root table {
	border-collapse: collapse;
	border-spacing: 0;
	width: 100%;
	max-width: 100%;
	table-layout: auto;
}

.mailclaw-email-root table[width],
.mailclaw-email-root table[style*="width"],
.mailclaw-email-root div[width],
.mailclaw-email-root div[style*="width"],
.mailclaw-email-root center[width],
.mailclaw-email-root center[style*="width"],
.mailclaw-email-root section[width],
.mailclaw-email-root section[style*="width"],
.mailclaw-email-root article[width],
.mailclaw-email-root article[style*="width"],
.mailclaw-email-root main[width],
.mailclaw-email-root main[style*="width"] {
	width: 100% !important;
	max-width: 100% !important;
}

.mailclaw-email-root td,
.mailclaw-email-root th {
	min-width: 0 !important;
	max-width: 100%;
	white-space: normal;
	word-break: break-word;
	overflow-wrap: anywhere;
}

.mailclaw-email-root pre,
.mailclaw-email-root code {
	white-space: pre-wrap;
	word-break: break-word;
	overflow-x: auto;
}

.mailclaw-email-root blockquote {
	margin-left: 0;
	margin-right: 0;
}

/* A sender's width:100% <figure> plus the UA's 40 px side margins overflowed, and overflow-x:hidden
   cut its text off mid-word (d2-02; the native renderer got the same rule in 9aee85a). */
.mailclaw-email-root figure {
	margin-left: 0;
	margin-right: 0;
	max-width: 100%;
}

.mailclaw-email-root a {
	text-decoration: underline;
}

@media (max-width: 640px) {
	.mailclaw-email-root [style*="min-width"],
	.mailclaw-email-root [style*="width"] {
		min-width: 0 !important;
		max-width: 100% !important;
	}

	.mailclaw-email-root table,
	.mailclaw-email-root tbody,
	.mailclaw-email-root thead,
	.mailclaw-email-root tfoot,
	.mailclaw-email-root tr,
	.mailclaw-email-root td,
	.mailclaw-email-root th {
		max-width: 100% !important;
	}
}
`;

function preprocess(html: string): string {
	return html
		.replace(/<\/?#\/?part[^>]*>/gi, "")
		.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "")
		.replace(/<\?xml[^>]*\?>/gi, "");
}

function isBlockedTag(tagName: string): boolean {
	return BLOCKED_TAGS.has(tagName.toLowerCase());
}

function escapeCssString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function parseCssRules(cssText: string): CSSRule[] {
	const doc = document.implementation.createHTMLDocument("mailclaw-css");
	const style = doc.createElement("style");
	style.textContent = cssText.replace(/@import[\s\S]*?;/gi, "");
	doc.head.appendChild(style);
	return style.sheet ? Array.from(style.sheet.cssRules) : [];
}

function sanitizeCssUrl(rawValue: string, allowRemoteImages: boolean): string | null {
	const value = rawValue.trim().replace(/^['"]|['"]$/g, "");
	if (!value) return null;

	if (SAFE_DATA_URL_RE.test(value)) {
		return value;
	}

	if (/^cid:/i.test(value)) {
		return null;
	}

	const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):/i);
	if (!schemeMatch) {
		return null;
	}

	const protocol = `${schemeMatch[1].toLowerCase()}:`;
	if (protocol === "http:" || protocol === "https:" || protocol === "ftp:") {
		return allowRemoteImages ? value : null;
	}

	return null;
}

function sanitizeCssValue(value: string, allowRemoteImages: boolean): string {
	let sanitized = value.replace(/expression\s*\(/gi, "");
	sanitized = sanitized.replace(/-moz-binding\s*:/gi, "");
	sanitized = sanitized.replace(/behavior\s*:/gi, "");

	sanitized = sanitized.replace(/url\((.*?)\)/gi, (_match, rawUrl) => {
		const safeUrl = sanitizeCssUrl(String(rawUrl), allowRemoteImages);
		return safeUrl ? `url("${escapeCssString(safeUrl)}")` : "none";
	});

	sanitized = sanitized.replace(/\b(?:javascript|vbscript|data:text\/html)\s*:/gi, "");
	return sanitized.trim();
}

function sanitizeCssDeclaration(
	property: string,
	value: string,
	allowRemoteImages: boolean,
): string | null {
	const prop = property.toLowerCase();
	if (!SAFE_STYLE_PROPERTIES.has(prop)) {
		return null;
	}

	if (prop === "position" && /(fixed|sticky)/i.test(value)) {
		return null;
	}

	if (prop === "display" && /^(inline-table)$/i.test(value.trim())) {
		return null;
	}

	const sanitizedValue = sanitizeCssValue(value, allowRemoteImages);
	if (!sanitizedValue) {
		return null;
	}

	return sanitizedValue;
}

function serializeCssStyleDeclaration(
	style: CSSStyleDeclaration,
	allowRemoteImages: boolean,
): string {
	const declarations: string[] = [];

	for (let index = 0; index < style.length; index += 1) {
		const property = style.item(index);
		const value = style.getPropertyValue(property);
		const priority = style.getPropertyPriority(property);
		const sanitizedValue = sanitizeCssDeclaration(property, value, allowRemoteImages);
		if (!sanitizedValue) continue;
		declarations.push(`${property}: ${sanitizedValue}${priority ? " !important" : ""};`);
	}

	return declarations.join(" ");
}

interface CssContext {
	allowRemoteImages: boolean;
	scheme?: "light" | "dark";
	/** Set when a rule targets prefers-color-scheme: dark. */
	sawDark: boolean;
}

const COLOR_SCHEME_FEATURE = /\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/gi;

/**
 * `(prefers-color-scheme: dark)` becomes a feature that is always true (`(color)`) or always false
 * (`(monochrome)`) for the app's theme, so `not`, `and` and lists keep their meaning.
 */
function resolveColorScheme(condition: string, ctx: CssContext): string {
	return condition.replace(COLOR_SCHEME_FEATURE, (feature, wanted: string) => {
		const scheme = wanted.toLowerCase();
		if (scheme === "dark") ctx.sawDark = true;
		if (!ctx.scheme) return feature;
		return scheme === ctx.scheme ? "(color)" : "(monochrome)";
	});
}

function sanitizeCssRule(rule: CSSRule, ctx: CssContext): string {
	if (rule instanceof CSSMediaRule) {
		const inner = Array.from(rule.cssRules)
			.map((nestedRule) => sanitizeCssRule(nestedRule, ctx))
			.filter(Boolean)
			.join(" ");
		return inner ? `@media ${resolveColorScheme(rule.conditionText, ctx)} { ${inner} }` : "";
	}

	if (rule instanceof CSSSupportsRule) {
		const inner = Array.from(rule.cssRules)
			.map((nestedRule) => sanitizeCssRule(nestedRule, ctx))
			.filter(Boolean)
			.join(" ");
		return inner ? `@supports ${rule.conditionText} { ${inner} }` : "";
	}

	if (rule instanceof CSSStyleRule) {
		const cssText = serializeCssStyleDeclaration(rule.style, ctx.allowRemoteImages);
		return cssText ? `${rule.selectorText} { ${cssText} }` : "";
	}

	if (rule instanceof CSSPageRule) {
		const cssText = serializeCssStyleDeclaration(rule.style, ctx.allowRemoteImages);
		return cssText ? `@page ${rule.selectorText} { ${cssText} }` : "";
	}

	return "";
}

function sanitizeCssText(cssText: string, ctx: CssContext): string {
	const cleaned = cssText.replace(/@import[\s\S]*?;/gi, "").replace(/@charset\s+[^;]+;/gi, "");
	const rules = parseCssRules(cleaned);
	return rules
		.map((rule) => sanitizeCssRule(rule, ctx))
		.filter(Boolean)
		.join("\n");
}

function parsePixelWidth(value: string | null): number | null {
	if (!value) return null;
	const normalized = value.trim().toLowerCase();
	const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*(px)?$/);
	if (!match) return null;
	const numeric = Number(match[1]);
	return Number.isFinite(numeric) ? numeric : null;
}

function sanitizeUrlAttr(
	value: string,
	kind: "link" | "resource",
	allowRemoteImages: boolean,
): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;

	if (trimmed.startsWith("#")) {
		return trimmed;
	}

	if (/^cid:/i.test(trimmed)) {
		return null;
	}

	if (SAFE_DATA_URL_RE.test(trimmed)) {
		return kind === "resource" ? trimmed : null;
	}

	const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
	if (!schemeMatch) {
		return null;
	}

	const protocol = `${schemeMatch[1].toLowerCase()}:`;
	if (protocol === "http:" || protocol === "https:" || protocol === "ftp:") {
		return kind === "resource" && !allowRemoteImages ? null : trimmed;
	}

	if (protocol === "mailto:" || protocol === "tel:") {
		return kind === "link" ? trimmed : null;
	}

	return null;
}

function sanitizeSrcset(value: string, allowRemoteImages: boolean): string | null {
	const entries = value
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const parts = entry.split(/\s+/);
			const candidate = parts.shift();
			if (!candidate) return null;
			const safeUrl = sanitizeUrlAttr(candidate, "resource", allowRemoteImages);
			if (!safeUrl) return null;
			return [safeUrl, ...parts].join(" ");
		})
		.filter((entry): entry is string => Boolean(entry));

	return entries.length ? entries.join(", ") : null;
}

function resolveCidUrl(value: string, options: EmailRenderOptions): string | null {
	const cid = value.replace(/^cid:/i, "").replace(/^<|>$/g, "");
	const attachment = options.attachments?.find(
		(item) => item.content_id === cid || item.content_id === `<${cid}>`,
	);
	if (!attachment || !options.emailId) {
		return null;
	}

	const baseUrl = options.baseUrl ?? "/api";
	return `${baseUrl}/emails/${options.emailId}/attachments/${attachment.id}`;
}

function sanitizeInlineStyle(styleText: string, allowRemoteImages: boolean): string {
	const temp = document.createElement("div");
	temp.setAttribute("style", styleText);
	return serializeCssStyleDeclaration(temp.style, allowRemoteImages);
}

function appendInlineStyle(existing: string | null, extra: string): string {
	const parts = [existing?.trim(), extra.trim()].filter(Boolean);
	return parts.join(" ");
}

function sanitizeElementAttributes(el: Element, options: EmailRenderOptions, isBody = false) {
	for (const attr of Array.from(el.attributes)) {
		const name = attr.name;
		const lower = name.toLowerCase();

		if (lower.startsWith("on")) {
			el.removeAttribute(name);
			continue;
		}

		if (lower.startsWith("xmlns") || lower.startsWith("xml:")) {
			el.removeAttribute(name);
			continue;
		}

		if (lower === "srcdoc" || lower === "nonce" || lower === "integrity") {
			el.removeAttribute(name);
			continue;
		}

		// Anchors activate natively now (escaping the sandbox into a new tab):
		// strip click side-effect attributes. Downloads rely on the server's
		// Content-Disposition; ping would fire tracking beacons on activation.
		if (
			(lower === "download" || lower === "ping") &&
			(el.tagName.toLowerCase() === "a" || el.tagName.toLowerCase() === "area")
		) {
			el.removeAttribute(name);
			continue;
		}

		if (lower === "style") {
			const sanitizedStyle = sanitizeInlineStyle(attr.value, Boolean(options.allowRemoteImages));
			if (sanitizedStyle) {
				el.setAttribute("style", sanitizedStyle);
			} else {
				el.removeAttribute(name);
			}
			continue;
		}

		if (lower === "srcset") {
			const sanitized = sanitizeSrcset(attr.value, Boolean(options.allowRemoteImages));
			if (sanitized) {
				el.setAttribute(name, sanitized);
			} else {
				el.removeAttribute(name);
			}
			continue;
		}

		if (URL_ATTRS.has(lower)) {
			const urlKind =
				lower === "href" ||
				lower === "action" ||
				lower === "formaction" ||
				lower === "cite" ||
				lower === "xlink:href"
					? "link"
					: "resource";
			const cidResolved =
				lower === "src" && attr.value.trim().toLowerCase().startsWith("cid:")
					? resolveCidUrl(attr.value.trim(), options)
					: null;

			const sanitized =
				cidResolved ?? sanitizeUrlAttr(attr.value, urlKind, Boolean(options.allowRemoteImages));
			const finalValue =
				sanitized && urlKind === "link" && /^(https?|ftp):/i.test(sanitized) && options.rewriteLink
					? options.rewriteLink(sanitized)
					: sanitized;
			if (finalValue) {
				el.setAttribute(name, finalValue);
			} else {
				el.removeAttribute(name);
			}
			continue;
		}

		if (lower === "target" && el.tagName.toLowerCase() === "a") {
			el.setAttribute(name, "_blank");
			continue;
		}

		if (lower === "rel" && el.tagName.toLowerCase() === "a") {
			el.setAttribute(name, "noopener noreferrer");
			continue;
		}

		if (
			isBody &&
			!SAFE_BODY_ATTRS.has(lower) &&
			!lower.startsWith("data-") &&
			!lower.startsWith("aria-")
		) {
			el.removeAttribute(name);
		}
	}

	const tag = el.tagName.toLowerCase();
	if (tag === "a" || tag === "area") {
		el.setAttribute("target", "_blank");
		el.setAttribute("rel", "noopener noreferrer");
	}
}

function normalizeFluidWidth(el: Element, width: number) {
	const tag = el.tagName.toLowerCase();
	if (width < FIXED_WIDTH_THRESHOLD) {
		return;
	}

	if (tag === "img" || tag === "video" || tag === "canvas" || tag === "svg") {
		el.setAttribute("data-mailclaw-original-width", String(width));
		el.setAttribute(
			"style",
			appendInlineStyle(el.getAttribute("style"), "max-width: 100%; height: auto;"),
		);
		return;
	}

	if (
		tag === "table" ||
		tag === "div" ||
		tag === "center" ||
		tag === "section" ||
		tag === "article" ||
		tag === "main"
	) {
		el.setAttribute("data-mailclaw-original-width", String(width));
		el.setAttribute(
			"style",
			appendInlineStyle(
				el.getAttribute("style"),
				"width: 100%; max-width: 100%; margin-left: auto; margin-right: auto;",
			),
		);
	}

	if (tag === "td" || tag === "th") {
		el.setAttribute("data-mailclaw-original-width", String(width));
		el.setAttribute(
			"style",
			appendInlineStyle(
				el.getAttribute("style"),
				"width: auto; min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere;",
			),
		);
	}
}

function normalizeLayout(root: ParentNode) {
	const elements = Array.from(root.querySelectorAll("*"));
	for (const el of elements) {
		const lower = el.tagName.toLowerCase();
		const widthAttr = parsePixelWidth(el.getAttribute("width"));
		const styleWidth = parsePixelWidth((el as HTMLElement).style?.width ?? null);
		const styleMinWidth = parsePixelWidth((el as HTMLElement).style?.minWidth ?? null);
		const width = widthAttr ?? styleWidth;

		if (width) {
			normalizeFluidWidth(el, width);
		}

		if (styleMinWidth && styleMinWidth >= FIXED_WIDTH_THRESHOLD) {
			el.setAttribute(
				"style",
				appendInlineStyle(el.getAttribute("style"), "min-width: 0; max-width: 100%;"),
			);
		}

		if (lower === "table") {
			el.setAttribute(
				"style",
				appendInlineStyle(
					el.getAttribute("style"),
					"border-collapse: collapse; border-spacing: 0; width: 100%; max-width: 100%;",
				),
			);
		}

		if (lower === "pre" || lower === "code") {
			el.setAttribute(
				"style",
				appendInlineStyle(
					el.getAttribute("style"),
					"white-space: pre-wrap; overflow-wrap: anywhere;",
				),
			);
		}
	}
}

function sanitizeNode(node: ParentNode, options: EmailRenderOptions) {
	for (const child of Array.from(node.childNodes)) {
		if (child.nodeType !== Node.ELEMENT_NODE) {
			continue;
		}

		const el = child as Element;
		const tagName = el.tagName.toLowerCase();

		if (isBlockedTag(tagName)) {
			el.remove();
			continue;
		}

		sanitizeElementAttributes(el, options, tagName === "body");
		sanitizeNode(el, options);
	}
}

function collectStyleBlocks(doc: Document, ctx: CssContext): string[] {
	const blocks: string[] = [];
	const styles = Array.from(doc.querySelectorAll("style"));

	for (const style of styles) {
		// <style media="(prefers-color-scheme: dark)"> is a media rule too.
		const media = style.getAttribute("media")?.trim();
		const css = style.textContent ?? "";
		const sanitized = sanitizeCssText(
			media && media.toLowerCase() !== "all" ? `@media ${media} { ${css} }` : css,
			ctx,
		);
		if (sanitized) {
			blocks.push(sanitized);
		}
		style.remove();
	}

	return blocks;
}

/** `<meta name="color-scheme" content="light dark">`: the sender says the mail has a dark form. */
function declaresDark(doc: Document): boolean {
	return Array.from(doc.querySelectorAll("meta[name]")).some(
		(meta) =>
			/^(color-scheme|supported-color-schemes)$/i.test(meta.getAttribute("name") ?? "") &&
			/\bdark\b/i.test(meta.getAttribute("content") ?? ""),
	);
}

/** A fresh nonce per document: a sender can't know it, and the sanitizer drops nonce attributes. */
function frameNonce(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes)).replace(/[^a-z0-9]/gi, "");
}

const FRAME_SCRIPT = `(function () {
	var last = -1;
	var queued = false;
	function report() {
		queued = false;
		var b = document.body;
		if (!b) return;
		var r = b.getBoundingClientRect();
		var m = parseFloat(getComputedStyle(b).marginBottom) || 0;
		var h = Math.ceil(Math.max(r.bottom, r.top + b.scrollHeight) + m + (window.scrollY || 0));
		if (h === last) return;
		last = h;
		parent.postMessage({ mc: "frame-height", h: h }, "*");
	}
	function schedule() {
		if (queued) return;
		queued = true;
		setTimeout(report, 0);
	}
	if (window.ResizeObserver) {
		var ro = new ResizeObserver(schedule);
		ro.observe(document.documentElement);
		if (document.body) ro.observe(document.body);
	}
	document.addEventListener("load", schedule, true);
	document.addEventListener("error", schedule, true);
	window.addEventListener("load", schedule);
	window.addEventListener("resize", schedule);
	if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
	document.addEventListener("click", function (ev) {
		var a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
		var href = a ? a.getAttribute("href") || "" : "";
		if (!/^(mailto|tel):/i.test(href)) return;
		ev.preventDefault();
		parent.postMessage({ mc: "frame-open", href: href }, "*");
	}, true);
	report();
})();`;

/**
 * The frame's own runtime (EmailHtmlFrame's sandbox is opaque-origin, so the app can't measure the
 * document): a CSP that runs nothing but FRAME_SCRIPT (the sanitizer has removed the sender's
 * scripts and handlers; the nonce also stops any it missed), and that script, which reports the
 * mail's height and hands mailto:/tel: links to the app.
 */
function addFrameRuntime(doc: Document, options: EmailRenderOptions) {
	const nonce = frameNonce();
	// cid: images are the app's own /api URLs; an opaque origin has no 'self' to name them by.
	const images = options.allowRemoteImages ? "* data: blob:" : `${location.origin} data: blob:`;
	const policy = [
		"default-src 'none'",
		`script-src 'nonce-${nonce}'`,
		"style-src 'unsafe-inline'",
		`img-src ${images}`,
		"font-src data:",
		"form-action 'none'",
		"base-uri 'none'",
	].join("; ");
	const meta = doc.createElement("meta");
	meta.setAttribute("http-equiv", "Content-Security-Policy");
	meta.setAttribute("content", policy);
	doc.head.prepend(meta);

	const script = doc.createElement("script");
	script.setAttribute("nonce", nonce);
	script.textContent = FRAME_SCRIPT;
	doc.body.appendChild(script);
}

function ensureHeadMeta(doc: Document) {
	const head = doc.head ?? doc.createElement("head");
	if (!head.isConnected && doc.documentElement) {
		doc.documentElement.insertBefore(head, doc.body ?? null);
	}

	if (!head.querySelector("meta[charset]")) {
		const charset = doc.createElement("meta");
		charset.setAttribute("charset", "utf-8");
		head.prepend(charset);
	}

	if (!head.querySelector('meta[name="viewport"]')) {
		const viewport = doc.createElement("meta");
		viewport.setAttribute("name", "viewport");
		viewport.setAttribute("content", "width=device-width, initial-scale=1");
		head.appendChild(viewport);
	}
}

function buildStyleBlock(doc: Document, styleBlocks: string[], dark: boolean) {
	const head = doc.head ?? doc.createElement("head");
	if (!head.isConnected && doc.documentElement) {
		doc.documentElement.insertBefore(head, doc.body ?? null);
	}

	const style = doc.createElement("style");
	const scheme = dark ? DARK_DOCUMENT_CSS : LIGHT_DOCUMENT_CSS;
	style.textContent = `${BASE_RENDER_CSS}\n${scheme}\n${styleBlocks.join("\n")}`.trim();
	head.appendChild(style);
}

function applyBodyDefaults(doc: Document, options: EmailRenderOptions) {
	const body = doc.body;
	body.classList.add("mailclaw-email-root");

	if (options.title && !doc.title) {
		doc.title = options.title;
	}

	if (!body.getAttribute("dir")) {
		const htmlDir = doc.documentElement.getAttribute("dir");
		if (htmlDir) {
			body.setAttribute("dir", htmlDir);
		}
	}
}

export function buildEmailFrame(html: string, options: EmailRenderOptions = {}): EmailFrameDocument {
	const doc = new DOMParser().parseFromString(preprocess(html), "text/html");
	const metaDark = declaresDark(doc);
	ensureHeadMeta(doc);
	const css: CssContext = {
		allowRemoteImages: Boolean(options.allowRemoteImages),
		scheme: options.scheme,
		sawDark: false,
	};
	const styles = collectStyleBlocks(doc, css);
	sanitizeElementAttributes(doc.documentElement, options);
	sanitizeNode(doc.documentElement, options);
	applyBodyDefaults(doc, options);
	normalizeLayout(doc.body);
	if (options.hideQuotedId) {
		styles.push(
			`[data-mc-quoted="${escapeCssString(options.hideQuotedId)}"]{display:none!important}`,
		);
	}
	const ownDark = metaDark || css.sawDark;
	buildStyleBlock(doc, styles, ownDark && options.scheme === "dark");
	addFrameRuntime(doc, options);
	return { srcdoc: `<!doctype html>\n${doc.documentElement.outerHTML}`, ownDark };
}

export function buildEmailSrcdoc(html: string, options: EmailRenderOptions = {}): string {
	return buildEmailFrame(html, options).srcdoc;
}

