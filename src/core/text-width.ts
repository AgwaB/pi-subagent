const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
	ANSI_PATTERN.lastIndex = 0;
	return text.replace(ANSI_PATTERN, "");
}

// Terminal display width of a single Unicode code point, in columns.
// Wide East Asian / fullwidth / emoji code points occupy 2 columns; combining
// marks and control characters occupy 0. Keep this aligned with the host TUI's
// line measurement so CJK-heavy text does not overflow the renderer.
export function charWidth(cp: number): number {
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
	if (
		cp === 0x200b ||
		(cp >= 0x0300 && cp <= 0x036f) ||
		(cp >= 0x1ab0 && cp <= 0x1aff) ||
		(cp >= 0x1dc0 && cp <= 0x1dff) ||
		(cp >= 0x20d0 && cp <= 0x20ff) ||
		(cp >= 0xfe00 && cp <= 0xfe0f) ||
		(cp >= 0xfe20 && cp <= 0xfe2f)
	) {
		return 0;
	}
	if (
		(cp >= 0x1100 && cp <= 0x115f) ||
		cp === 0x2329 ||
		cp === 0x232a ||
		(cp >= 0x2e80 && cp <= 0x303e) ||
		(cp >= 0x3041 && cp <= 0x33ff) ||
		(cp >= 0x3400 && cp <= 0x4dbf) ||
		(cp >= 0x4e00 && cp <= 0x9fff) ||
		(cp >= 0xa000 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe10 && cp <= 0xfe19) ||
		(cp >= 0xfe30 && cp <= 0xfe6f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1faff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

// Measure the visible terminal width of a string, ignoring ANSI escapes and
// accounting for wide characters.
export function visibleLength(text: string): number {
	let width = 0;
	for (let index = 0; index < text.length; ) {
		if (text.charCodeAt(index) === 0x1b) {
			ANSI_PATTERN.lastIndex = index;
			const match = ANSI_PATTERN.exec(text);
			if (match && match.index === index) {
				index = ANSI_PATTERN.lastIndex;
				continue;
			}
		}
		const cp = text.codePointAt(index) ?? 0;
		width += charWidth(cp);
		index += cp > 0xffff ? 2 : 1;
	}
	return width;
}

export function clip(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleLength(text) <= width) return text;
	if (width <= 1) return "…";

	let output = "";
	let visible = 0;
	for (let index = 0; index < text.length; ) {
		if (text.charCodeAt(index) === 0x1b) {
			ANSI_PATTERN.lastIndex = index;
			const match = ANSI_PATTERN.exec(text);
			if (match && match.index === index) {
				output += match[0];
				index = ANSI_PATTERN.lastIndex;
				continue;
			}
		}
		const cp = text.codePointAt(index) ?? 0;
		const w = charWidth(cp);
		if (visible + w > width - 1) break;
		output += String.fromCodePoint(cp);
		visible += w;
		index += cp > 0xffff ? 2 : 1;
	}
	return `${output}…`;
}
