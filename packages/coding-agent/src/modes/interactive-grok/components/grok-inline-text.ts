/** Collapse all whitespace runs so multi-line content fits a single line. */
export function flattenInline(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
