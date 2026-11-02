const DANGEROUS_TAGS = new Set([
	"script", "style", "iframe", "object", "embed", "form",
	"input", "textarea", "button", "select", "link", "meta",
	"base", "head", "title", "applet", "frameset", "frame", "noscript",
	// SVG animation can set an attribute to a URL (to=, values= lists) after insertion
	"animate", "set", "animatemotion", "animatetransform", "discard",
]);

// Attributes that hold a URL (srcset: a list of them). Only these are checked for a script scheme,
// so text attributes such as alt="Data: Q3" stay.
const URL_ATTRS = new Set([
	"href", "src", "xlink:href", "action", "formaction", "background", "poster",
	"cite", "longdesc", "lowsrc", "dynsrc", "ping", "srcset",
]);

/** javascript:, vbscript: or data:, ignoring the control chars and spaces browsers drop from a scheme. */
function isScriptUrl(value: string): boolean {
	return /^(javascript|vbscript|data):/i.test(value.replace(/[\u0000-\u0020]+/g, ""));
}

const DANGEROUS_ATTRS = /^on|^data-$/i;

/** Strip dangerous CSS values while preserving safe inline styles. */
function sanitizeStyleValue(style: string): string {
	return style
		.replace(/expression\s*\(/gi, "/* */")
		.replace(/-moz-binding\s*:/gi, "/* */:")
		.replace(/behavior\s*:/gi, "/* */:")
		.replace(/javascript\s*:/gi, "")
		.replace(/vbscript\s*:/gi, "");
}

/** Pre-process raw HTML to remove MIME boundary artifacts and other junk. */
function preprocess(html: string): string {
	// Remove <#part ...> and </#part> MIME boundary pseudo-tags
	html = html.replace(/<\/?#\/?part[^>]*>/gi, "");
	// Remove <!--[if...]--> conditional comments from Outlook
	html = html.replace(/<!--\[if[^\]]*\][\s\S]*?<!\[endif\]-->/gi, "");
	// Remove XML processing instructions
	html = html.replace(/<\?xml[^>]*\?>/gi, "");
	return html;
}

export function sanitizeHtml(html: string): string {
	html = preprocess(html);
	// DOMParser is native in browsers. Tests polyfill it from linkedom via
	// tests/setup-dom.ts so this same code path runs in both environments.
	const doc = new DOMParser().parseFromString(html, "text/html");
	walk(doc.body);
	return doc.body.innerHTML;
}

function walk(node: Node) {
	const remove: Node[] = [];

	node.childNodes.forEach((child) => {
		if (child.nodeType === Node.ELEMENT_NODE) {
			const el = child as Element;
			if (DANGEROUS_TAGS.has(el.tagName.toLowerCase())) {
				remove.push(child);
				return;
			}
			// Strip dangerous attributes but preserve safe inline styles
			for (const attr of Array.from(el.attributes)) {
				if (DANGEROUS_ATTRS.test(attr.name)) {
					el.removeAttribute(attr.name);
				}
			}
			// Script and data URLs in URL attributes (href, src, xlink:href, formaction, srcset, ...)
			for (const attr of Array.from(el.attributes)) {
				const name = attr.name.toLowerCase();
				if (!URL_ATTRS.has(name)) continue;
				const urls =
					name === "srcset"
						? attr.value.split(",").map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
						: [attr.value];
				if (urls.some(isScriptUrl)) el.removeAttribute(attr.name);
			}
			// Sanitize style attribute values (keep styles, remove dangerous CSS)
			const style = el.getAttribute("style");
			if (style) {
				el.setAttribute("style", sanitizeStyleValue(style));
			}
			// Force links to open in new tab
			if (el.tagName === "A") {
				el.setAttribute("target", "_blank");
				el.setAttribute("rel", "noopener noreferrer");
			}
			walk(child);
		}
	});

	remove.forEach((n) => node.removeChild(n));
}

export function plainTextToHtml(text: string): string {
	// Strip MIME boundary pseudo-tags from plain text before escaping
	text = text.replace(/<\/?#\/?part[^>]*>/gi, "");
	// Strip mailto: angle-bracket duplicates: "email<mailto:email>" -> "email"
	text = text.replace(/([^\s<]+)<mailto:[^>]+>/g, "$1");
	// Strip URL angle-bracket duplicates: "text<http://url>" -> "text"
	text = text.replace(/([^\s<]+)<https?:\/\/[^>]+>/g, "$1");
	// Strip standalone angle-bracket URLs: "<https://url>" -> "https://url"
	text = text.replace(/<(https?:\/\/[^>]+)>/g, "$1");
	// Remove unresolved CID references like [cid:image003.png@01DCBDEE.A5AD5AE0]
	text = text.replace(/\[cid:[^\]]+\]/g, "");
	// Clean up any resulting empty lines from stripped tags
	text = text.replace(/\n{3,}/g, "\n\n");
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		// Quotes too: the linkified URL below lands inside href="…"
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/\n/g, "<br/>")
		.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

