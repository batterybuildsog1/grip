import { convert } from "html-to-text";

const MAX_HTML_LENGTH = 500_000;
const MAX_TEXT_LENGTH = 200_000;
const DANGEROUS_BLOCK_TAGS = [
	"script",
	"style",
	"iframe",
	"object",
	"embed",
	"form",
	"svg",
	"math",
	"template",
	"head",
	"title",
	"noscript",
];
const STRIP_ONLY_TAGS = new Set([
	"html",
	"body",
	"main",
	"article",
	"section",
	"header",
	"footer",
	"aside",
	"span",
	"font",
	"tbody",
	"thead",
	"tfoot",
	"table",
	"tr",
	"td",
	"th",
	"colgroup",
	"col",
]);
const PARAGRAPH_TAGS = new Set(["div", "p", "h1", "h2", "h3", "h4", "h5", "h6"]);
const ALLOWED_TAGS = new Set(["p", "br", "strong", "em", "u", "a", "ul", "ol", "li", "blockquote"]);

export function processEmailContent(
	html: string | null,
	text: string | null,
): { htmlContent: string | null; textContent: string | null } {
	const htmlContent = html ? html.slice(0, MAX_HTML_LENGTH) : null;
	let textContent = text ? text.slice(0, MAX_TEXT_LENGTH) : null;

	// Generate text from HTML if no plain text provided
	if (!textContent && htmlContent) {
		try {
			textContent = convert(htmlContent, {
				wordwrap: false,
				selectors: [
					{ selector: "img", format: "skip" },
					{ selector: "a", options: { ignoreHref: true } },
				],
			}).slice(0, MAX_TEXT_LENGTH);
		} catch {
			textContent = null;
		}
	}

	return { htmlContent, textContent };
}

function normalizeTextContent(text: string | null): string | null {
	if (!text) return null;
	const normalized = text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
	return normalized.trim() ? normalized.slice(0, MAX_TEXT_LENGTH) : null;
}

function escapeHtmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function extractSafeHref(attrs: string): string | null {
	const match = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i);
	const href = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
	if (!href) return null;
	if (/^(https?:|mailto:)/i.test(href)) return href;
	return null;
}

function canonicalizeComposeHtml(html: string | null): string | null {
	if (!html) return null;

	let normalized = html.trim();
	if (!normalized) return null;

	normalized = normalized.slice(0, MAX_HTML_LENGTH);
	normalized = normalized
		.replace(/<\/?#\/?part[^>]*>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<\?xml[\s\S]*?\?>/gi, "")
		.replace(/<!doctype[\s\S]*?>/gi, "");

	normalized = normalized.replace(
		/<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
		(_match, attrs: string, inner: string) => {
			const href = extractSafeHref(attrs);
			return href ? `<a href="${escapeHtmlAttribute(href)}">${inner}</a>` : inner;
		},
	);

	for (const tag of DANGEROUS_BLOCK_TAGS) {
		const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
		normalized = normalized.replace(pattern, "");
	}

	normalized = normalized
		.replace(/<(?:link|meta|base|input|textarea|button|select)\b[^>]*\/?>/gi, "")
		.replace(/<\s*br\b[^>]*\/?\s*>/gi, "<br>");

	normalized = normalized.replace(
		/<\s*(\/?)\s*([a-z0-9:-]+)\b([^>]*)>/gi,
		(_match, slash: string, rawTag: string, attrs: string) => {
			let tag = rawTag.toLowerCase();
			const closing = slash === "/";

			if (tag === "b") tag = "strong";
			if (tag === "i") tag = "em";

			if (PARAGRAPH_TAGS.has(tag)) {
				tag = "p";
			}

			if (STRIP_ONLY_TAGS.has(tag)) {
				return "";
			}

			if (tag === "a") {
				if (closing) return "</a>";
				const href = extractSafeHref(attrs);
				return href ? `<a href="${escapeHtmlAttribute(href)}">` : "";
			}

			if (!ALLOWED_TAGS.has(tag)) {
				return "";
			}

			return closing ? `</${tag}>` : `<${tag}>`;
		},
	);

	normalized = normalized
		.replace(/(?:<br>\s*){3,}/gi, "<br><br>")
		.replace(/<p>\s*(?:<br>\s*)*<\/p>/gi, "")
		.replace(/\s+(<\/(?:p|li|blockquote|ul|ol)>)/gi, "$1")
		.replace(/(<(?:p|li|blockquote|ul|ol)>)[\s\n]+/gi, "$1")
		.trim();

	return normalized || null;
}

export function canonicalizeOutgoingEmailContent(
	html: string | null,
	text: string | null,
): { htmlContent: string | null; textContent: string | null } {
	const htmlContent = canonicalizeComposeHtml(html);
	let textContent = normalizeTextContent(text);

	if (!textContent && htmlContent) {
		try {
			textContent =
				convert(htmlContent, {
					wordwrap: false,
					selectors: [
						{ selector: "img", format: "skip" },
						{ selector: "a", options: { ignoreHref: true } },
					],
				})
					.replace(/\r\n?/g, "\n")
					.slice(0, MAX_TEXT_LENGTH)
					.trim() || null;
		} catch {
			textContent = null;
		}
	}

	return { htmlContent, textContent };
}
