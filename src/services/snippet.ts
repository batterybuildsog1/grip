/** Read-time list text shared by every API projection. Marks travel with characters, never slices of tags. */
export function cleanSnippet(
	source: string | null | undefined,
	subject: string | null | undefined,
	stripHtml = false,
): string | null {
	if (!source) return null;
	let input = source.slice(0, 8192);
	if (stripHtml) {
		input = input
			.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
			.replace(/<(?!\/?mark>|https?:\/\/)[^>]+>/gi, " ")
			.replace(/<[^<]*$/g, " ");
	}
	input = input.replace(/&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi, (all, entity) => {
		const named: Record<string, string> = {
			nbsp: " ",
			amp: "&",
			lt: "<",
			gt: ">",
			quot: '"',
			apos: "'",
		};
		if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? all;
		const n =
			entity[1].toLowerCase() === "x"
				? Number.parseInt(entity.slice(2), 16)
				: Number(entity.slice(1));
		return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
	});
	let text = "";
	let marks: boolean[] = [];
	let marked = false;
	for (const token of input.split(/(<\/?mark>)/gi)) {
		if (/^<mark>$/i.test(token)) marked = true;
		else if (/^<\/mark>$/i.test(token)) marked = false;
		else {
			text += token;
			marks.push(...Array(token.length).fill(marked));
		}
	}
	const replace = (
		pattern: RegExp,
		replacement: (match: RegExpExecArray) => string | { value: string; offset: number },
	) => {
		const before = text;
		const oldMarks = marks;
		let next = "";
		const nextMarks: boolean[] = [];
		let end = 0;
		for (const match of before.matchAll(pattern)) {
			const start = match.index;
			next += before.slice(end, start);
			nextMarks.push(...oldMarks.slice(end, start));
			const result = replacement(match);
			const value = typeof result === "string" ? result : result.value;
			next += value;
			nextMarks.push(
				...(typeof result === "string"
					? Array(value.length).fill(oldMarks.slice(start, start + match[0].length).some(Boolean))
					: oldMarks.slice(start + result.offset, start + result.offset + value.length)),
			);
			end = start + match[0].length;
		}
		next += before.slice(end);
		nextMarks.push(...oldMarks.slice(end));
		text = next;
		marks = nextMarks;
	};
	replace(/\s+/g, () => " ");
	// Only paired emphasis at word boundaries; identifiers and email local parts stay literal.
	for (let pass = 0; pass < 3; pass++) {
		const before = text;
		replace(/(?<![\p{L}\p{N}_@*])(\*{1,2}|_{1,2})(?=\S)(.+?\S|\S)\1(?![\p{L}\p{N}_@*])/gu, (m) => ({
			value: m[2],
			offset: m[1].length,
		}));
		if (text === before) break;
	}
	replace(/^[\s>•*\-–—]+/g, () => "");
	const baseSubject = subject?.replace(/^(?:\s*(?:re|fwd?)\s*:\s*)+/i, "").trim();
	if (baseSubject) {
		const escaped = baseSubject
			.split(/\s+/)
			.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join("\\s*");
		replace(
			new RegExp(
				`^(?:subject\\s*:\\s*)?(?:(?:re|fwd?)\\s*:\\s*)*${escaped}(?=$|[\\s:;,.!?…|–—-])(?:[\\s:;…|–—-]+)?`,
				"gi",
			),
			() => "",
		);
	}
	replace(/<?https?:\/\/[^\s<>]+>?/gi, (m) => {
		const raw = m[0].replace(/^</, "").replace(/>$/, "");
		const punctuation = raw.match(/[.,;!?)]+$/)?.[0] ?? "";
		try {
			const host = new URL(raw.slice(0, raw.length - punctuation.length)).hostname.replace(
				/^www\./i,
				"",
			);
			return `${host} link${punctuation}`;
		} catch {
			return m[0];
		}
	});
	replace(/^[\s>•*\-–—]+/g, () => "");
	replace(/\s+/g, () => " ");
	replace(/^\s+|\s+$/g, () => "");
	if (!text) return null;
	// The complete serialized snippet, including balanced markup, fits in 180 characters.
	let output = "";
	let open = false;
	for (let i = 0; i < text.length; ) {
		const char = String.fromCodePoint(text.codePointAt(i) ?? 32);
		const nextMark = marks[i];
		const tag = nextMark === open ? "" : nextMark ? "<mark>" : "</mark>";
		if (output.length + tag.length + char.length + (nextMark ? 7 : 0) > 180) break;
		output += tag + char;
		open = nextMark;
		i += char.length;
	}
	if (open) output += "</mark>";
	return output.trim() || null;
}
