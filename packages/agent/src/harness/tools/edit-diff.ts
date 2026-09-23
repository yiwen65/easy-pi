/**
 * Shared diff computation utilities for the edit and similar tools.
 */

import * as Diff from "diff";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findBlankLineTolerantMatches(content: string, oldText: string): RegExpMatchArray[] {
	if (!oldText.includes("\n")) return [];

	const pattern = oldText
		.split(/\n(?:[\t ]*\n)*/)
		.map(escapeRegExp)
		.join("\\n(?:[\\t ]*\\n)*");
	return [...content.matchAll(new RegExp(pattern, "gu"))];
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
	start: number;
	end: number;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (replacementStart >= line.start && replacementStart < line.end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}

	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) {
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}

	return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

/**
 * Apply replacements matched against `baseContent` to `originalContent` while
 * preserving unchanged line blocks from the original.
 *
 * This is useful when `baseContent` is a normalized view of the original. Each
 * replacement is widened to the lines it actually touches, those touched lines
 * are rewritten from the normalized base, and all other lines are copied back
 * from `originalContent`. The actual replacement ranges drive preservation so
 * duplicate normalized lines cannot be aligned to the wrong occurrence.
 */
export function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): string {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");

		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		result += applyReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		originalLineIndex = group.endLine;
	}
	result += originalLines.slice(originalLineIndex).join("");

	return result;
}

export type EditMatchTier = "exact" | "normalized" | "blank-lines" | "loose-lines" | "similar-block";

export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts (in the content that should be used for replacement) */
	index: number;
	/** Length of the matched text */
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	usedFuzzyMatch: boolean;
	/**
	 * The content to use for replacement operations.
	 * When exact match: original content. When fuzzy match: normalized content.
	 */
	contentForReplacement: string;
	/** Which matching tier produced this result. */
	matchTier?: EditMatchTier;
	/** Occurrences of oldText in the matched tier's space (>1 means the match is not unique). */
	occurrenceCount?: number;
	/** 1-indexed start lines of the occurrences (capped). */
	occurrenceLines?: number[];
	/** 1-indexed start lines of disjoint similar regions when similar-block matching is ambiguous. */
	ambiguousLines?: number[];
}

/** Collapse whitespace runs and trim; used for line-oriented loose comparisons. */
function normalizeLineLoose(line: string): string {
	return line.replace(/[\t ]+/g, " ").trim();
}

function toNonBlankLooseLines(text: string): string[] {
	return text
		.split("\n")
		.map(normalizeLineLoose)
		.filter((line) => line !== "");
}

interface LineMatch {
	/** Char offset of the first matched line's start */
	index: number;
	/** Length through the last matched line's content (excluding its line terminator) */
	length: number;
	/** 1-indexed line number where the match starts */
	startLine: number;
	/** Index into the non-blank line array (for clustering) */
	nonBlankStart: number;
	/** Number of non-blank lines covered (for clustering) */
	nonBlankCount: number;
}

function toLineMatch(
	spans: LineSpan[],
	contentLines: string[],
	nonBlank: number[],
	nonBlankStart: number,
	nonBlankCount: number,
): LineMatch {
	const firstLineIndex = nonBlank[nonBlankStart];
	const lastLineIndex = nonBlank[nonBlankStart + nonBlankCount - 1];
	const lastText = contentLines[lastLineIndex];
	const lastHasTerminator = lastText.endsWith("\n");
	const start = spans[firstLineIndex].start;
	return {
		index: start,
		length: spans[lastLineIndex].end - (lastHasTerminator ? 1 : 0) - start,
		startLine: firstLineIndex + 1,
		nonBlankStart,
		nonBlankCount,
	};
}

/**
 * Line-oriented loose matching. Blank lines are ignored on both sides and each
 * line is compared after collapsing whitespace runs and trimming, so drift in
 * indentation, alignment padding (e.g. markdown tables), and blank-line counts
 * is tolerated. Matches span whole lines.
 */
function findLooseLineMatches(content: string, oldText: string): LineMatch[] {
	const oldNonBlank = toNonBlankLooseLines(oldText);
	if (oldNonBlank.length === 0) return [];
	const contentLines = splitLinesWithEndings(content);
	const spans = getLineSpans(content);
	const nonBlank: number[] = [];
	for (let i = 0; i < contentLines.length; i++) {
		if (normalizeLineLoose(contentLines[i]) !== "") nonBlank.push(i);
	}
	const matches: LineMatch[] = [];
	outer: for (let j = 0; j + oldNonBlank.length <= nonBlank.length; j++) {
		for (let k = 0; k < oldNonBlank.length; k++) {
			if (normalizeLineLoose(contentLines[nonBlank[j + k]]) !== oldNonBlank[k]) continue outer;
		}
		matches.push(toLineMatch(spans, contentLines, nonBlank, j, oldNonBlank.length));
	}
	return matches;
}

function bigramCounts(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (let i = 0; i < text.length - 1; i++) {
		const gram = text.slice(i, i + 2);
		counts.set(gram, (counts.get(gram) ?? 0) + 1);
	}
	return counts;
}

/** Sørensen–Dice coefficient over character bigrams; O(n) and robust for near-identical strings. */
function bigramSimilarity(a: string, b: string, aCounts?: Map<string, number>): number {
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return 0;
	const counts = new Map(aCounts ?? bigramCounts(a));
	let overlap = 0;
	for (let i = 0; i < b.length - 1; i++) {
		const gram = b.slice(i, i + 2);
		const available = counts.get(gram);
		if (available) {
			overlap++;
			counts.set(gram, available - 1);
		}
	}
	return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

const LEVENSHTEIN_MAX_CELLS = 2_000_000;

/**
 * Levenshtein similarity (1 - distance / max length). Returns 0 when the
 * inputs are too large to compare within the cell budget; matching callers
 * treat that as no match, diagnostic callers fall back to coarser signals.
 */
function levenshteinSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	const maxLength = Math.max(a.length, b.length);
	if (maxLength === 0) return 1;
	if (a.length * b.length > LEVENSHTEIN_MAX_CELLS) return 0;
	let previous: number[] = [];
	for (let j = 0; j <= b.length; j++) previous.push(j);
	for (let i = 1; i <= a.length; i++) {
		const current: number[] = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		previous = current;
	}
	return 1 - previous[b.length] / maxLength;
}

const SIMILAR_BLOCK_MIN_NON_BLANK_LINES = 3;
const SIMILAR_BLOCK_MAX_NON_BLANK_LINES = 200;
const SIMILAR_BLOCK_THRESHOLD = 0.8;
const SIMILAR_SINGLE_LINE_THRESHOLD = 0.9;

interface SimilarBlockResult {
	match: (LineMatch & { similarity: number }) | null;
	/** 1-indexed start lines of disjoint accepted regions when more than one region qualifies */
	ambiguousStartLines: number[];
}

/**
 * Approximate block matching for oldText that drifts by a few characters or
 * lines from the file (model transcription drift). Multi-line blocks require
 * exact first/last non-blank line anchors plus a Levenshtein similarity of at
 * least SIMILAR_BLOCK_THRESHOLD over the joined loose-normalized lines; a
 * single line requires a bigram similarity of at least
 * SIMILAR_SINGLE_LINE_THRESHOLD. Accepted windows must form exactly one
 * overlapping cluster, otherwise the match is reported ambiguous.
 */
function findSimilarBlockMatch(content: string, oldText: string): SimilarBlockResult {
	const none: SimilarBlockResult = { match: null, ambiguousStartLines: [] };
	const oldNonBlank = toNonBlankLooseLines(oldText);
	if (oldNonBlank.length === 0 || oldNonBlank.length > SIMILAR_BLOCK_MAX_NON_BLANK_LINES) return none;
	const contentLines = splitLinesWithEndings(content);
	const spans = getLineSpans(content);
	const nonBlank: number[] = [];
	for (let i = 0; i < contentLines.length; i++) {
		if (normalizeLineLoose(contentLines[i]) !== "") nonBlank.push(i);
	}
	const nbLoose = nonBlank.map((lineIndex) => normalizeLineLoose(contentLines[lineIndex]));

	type Accepted = LineMatch & { similarity: number };
	const accepted: Accepted[] = [];

	if (oldNonBlank.length === 1) {
		const target = oldNonBlank[0];
		const targetGrams = bigramCounts(target);
		for (let j = 0; j < nbLoose.length; j++) {
			const similarity = bigramSimilarity(target, nbLoose[j], targetGrams);
			if (similarity >= SIMILAR_SINGLE_LINE_THRESHOLD) {
				accepted.push({ ...toLineMatch(spans, contentLines, nonBlank, j, 1), similarity });
			}
		}
	} else if (oldNonBlank.length >= SIMILAR_BLOCK_MIN_NON_BLANK_LINES) {
		const first = oldNonBlank[0];
		const last = oldNonBlank[oldNonBlank.length - 1];
		const oldJoined = oldNonBlank.join("\n");
		const counts = [oldNonBlank.length, oldNonBlank.length - 1, oldNonBlank.length + 1];
		for (const count of counts) {
			if (count < 2 || count > nbLoose.length) continue;
			for (let j = 0; j + count <= nbLoose.length; j++) {
				if (nbLoose[j] !== first || nbLoose[j + count - 1] !== last) continue;
				const similarity = levenshteinSimilarity(oldJoined, nbLoose.slice(j, j + count).join("\n"));
				if (similarity >= SIMILAR_BLOCK_THRESHOLD) {
					accepted.push({ ...toLineMatch(spans, contentLines, nonBlank, j, count), similarity });
				}
			}
		}
	} else {
		return none;
	}

	if (accepted.length === 0) return none;

	// Cluster windows that overlap in non-blank line space; overlapping windows
	// describe the same region, disjoint windows are competing regions.
	accepted.sort((a, b) => a.nonBlankStart - b.nonBlankStart);
	const clusters: Accepted[][] = [];
	for (const candidate of accepted) {
		const current = clusters[clusters.length - 1];
		const currentEnd = current
			? Math.max(...current.map((c) => c.nonBlankStart + c.nonBlankCount))
			: -1;
		if (current && candidate.nonBlankStart < currentEnd) {
			current.push(candidate);
		} else {
			clusters.push([candidate]);
		}
	}
	if (clusters.length > 1) {
		return { match: null, ambiguousStartLines: clusters.map((cluster) => cluster[0].startLine) };
	}
	const best = clusters[0].reduce((a, b) => (b.similarity > a.similarity ? b : a));
	return { match: best, ambiguousStartLines: [] };
}

/** Map char offsets to 1-indexed line numbers (line structure is shared across all matching tiers). */
function offsetsToLines(content: string, offsets: number[], cap = 5): number[] {
	const lines: number[] = [];
	let lineStart = 0;
	let lineNumber = 1;
	let offsetIndex = 0;
	const sorted = [...offsets].sort((a, b) => a - b);
	while (offsetIndex < sorted.length && lines.length < cap) {
		const nextNewline = content.indexOf("\n", lineStart);
		if (nextNewline !== -1 && nextNewline < sorted[offsetIndex]) {
			lineStart = nextNewline + 1;
			lineNumber++;
			continue;
		}
		lines.push(lineNumber);
		offsetIndex++;
	}
	return lines;
}

export interface Edit {
	oldText: string;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

function countStringOccurrences(content: string, text: string): number {
	return content.split(text).length - 1;
}

function findAllOccurrenceOffsets(content: string, text: string): number[] {
	const offsets: number[] = [];
	let index = content.indexOf(text);
	while (index !== -1) {
		offsets.push(index);
		index = content.indexOf(text, index + 1);
	}
	return offsets;
}

/**
 * Find oldText in content through a ladder of increasingly tolerant tiers:
 * exact → Unicode/quote/trailing-whitespace normalized → blank-line tolerant →
 * loose lines (whitespace runs and indentation ignored, whole-line spans) →
 * similar block (anchored approximate match for small transcription drift).
 * When a non-exact tier matches, the returned contentForReplacement is the
 * fuzzy-normalized version of the content (trailing whitespace stripped,
 * Unicode quotes/dashes normalized to ASCII); line structure is preserved, so
 * callers can overlay replacements onto the original content.
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// Try exact match first
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
			matchTier: "exact",
			occurrenceCount: countStringOccurrences(content, oldText),
			occurrenceLines: offsetsToLines(content, findAllOccurrenceOffsets(content, oldText)),
		};
	}

	// Try fuzzy match - work entirely in normalized space
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex !== -1) {
		// When fuzzy matching, return offsets in normalized space. Callers can use
		// the normalized content to compute replacements, then decide how much of
		// that normalized output should be written back.
		return {
			found: true,
			index: fuzzyIndex,
			matchLength: fuzzyOldText.length,
			usedFuzzyMatch: true,
			contentForReplacement: fuzzyContent,
			matchTier: "normalized",
			occurrenceCount: countStringOccurrences(fuzzyContent, fuzzyOldText),
			occurrenceLines: offsetsToLines(fuzzyContent, findAllOccurrenceOffsets(fuzzyContent, fuzzyOldText)),
		};
	}

	// Models occasionally reproduce a recently read block with one blank line
	// added or omitted. Treat blank-line runs as equivalent, while preserving all
	// non-blank text and relying on the existing uniqueness check for safety.
	const blankLineMatches = findBlankLineTolerantMatches(fuzzyContent, fuzzyOldText);
	if (blankLineMatches.length > 0 && blankLineMatches[0].index !== undefined) {
		return {
			found: true,
			index: blankLineMatches[0].index,
			matchLength: blankLineMatches[0][0].length,
			usedFuzzyMatch: true,
			contentForReplacement: fuzzyContent,
			matchTier: "blank-lines",
			occurrenceCount: blankLineMatches.length,
			occurrenceLines: offsetsToLines(
				fuzzyContent,
				blankLineMatches.map((m) => m.index).filter((index): index is number => index !== undefined),
			),
		};
	}

	// Loose line matching: tolerate whitespace-run and indentation drift plus
	// blank-line drift; matches span whole lines.
	const looseMatches = findLooseLineMatches(fuzzyContent, fuzzyOldText);
	if (looseMatches.length > 0) {
		return {
			found: true,
			index: looseMatches[0].index,
			matchLength: looseMatches[0].length,
			usedFuzzyMatch: true,
			contentForReplacement: fuzzyContent,
			matchTier: "loose-lines",
			occurrenceCount: looseMatches.length,
			occurrenceLines: looseMatches.map((m) => m.startLine),
		};
	}

	// Approximate block matching: tolerate small transcription drift within an
	// anchored, unique region.
	const similar = findSimilarBlockMatch(fuzzyContent, fuzzyOldText);
	if (similar.match) {
		return {
			found: true,
			index: similar.match.index,
			matchLength: similar.match.length,
			usedFuzzyMatch: true,
			contentForReplacement: fuzzyContent,
			matchTier: "similar-block",
			occurrenceCount: 1,
			occurrenceLines: [similar.match.startLine],
		};
	}
	if (similar.ambiguousStartLines.length > 0) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
			ambiguousLines: similar.ambiguousStartLines,
		};
	}

	return {
		found: false,
		index: -1,
		matchLength: 0,
		usedFuzzyMatch: false,
		contentForReplacement: content,
	};
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

const ERROR_PREVIEW_MAX = 80;
const ERROR_MAX_ANCHORS = 50;
const ERROR_SIMILAR_REGION_THRESHOLD = 0.5;

function previewLine(line: string): string {
	return line.length > ERROR_PREVIEW_MAX ? `${line.slice(0, ERROR_PREVIEW_MAX - 3)}...` : line;
}

/**
 * Explain why oldText matched nothing. First try to anchor oldText's first
 * non-blank line (compared with the same loose normalization the loose
 * matching tier uses) and report the first diverging line. If no anchor line
 * exists at all, report the most similar region so the model can correct the
 * text instead of re-reading blindly.
 */
function diagnoseNoMatch(content: string, oldText: string): string {
	const contentLines = content.split("\n");
	const oldLines = oldText.split("\n");
	const firstOldIndex = oldLines.findIndex((line) => normalizeLineLoose(line) !== "");
	const firstOldLine = firstOldIndex >= 0 ? normalizeLineLoose(oldLines[firstOldIndex]) : "";
	const anchors: number[] = [];
	if (firstOldLine) {
		for (let i = 0; i < contentLines.length && anchors.length < ERROR_MAX_ANCHORS; i++) {
			if (normalizeLineLoose(contentLines[i]) === firstOldLine) anchors.push(i);
		}
	}
	if (anchors.length > 0) {
		let bestAnchor = anchors[0];
		let bestMatched = 0;
		for (const anchor of anchors) {
			let matched = 0;
			while (
				firstOldIndex + matched < oldLines.length &&
				anchor + matched < contentLines.length &&
				normalizeLineLoose(contentLines[anchor + matched]) === normalizeLineLoose(oldLines[firstOldIndex + matched])
			) {
				matched++;
			}
			if (matched > bestMatched) {
				bestMatched = matched;
				bestAnchor = anchor;
			}
		}
		const divergeLine = bestAnchor + bestMatched;
		const divergeOldLine = firstOldIndex + bestMatched;
		const actual = divergeLine < contentLines.length ? `"${previewLine(contentLines[divergeLine])}"` : "end of file";
		return (
			`Nearest region starts at line ${bestAnchor + 1}; first difference at oldText line ${divergeOldLine + 1} ` +
			`(file line ${divergeLine + 1}): oldText has "${previewLine(oldLines[divergeOldLine] ?? "")}", file has ${actual}. ` +
			`Re-read that region and retry with the verbatim text.`
		);
	}

	// No anchor line anywhere: locate the most similar region for the report.
	const oldNonBlank = toNonBlankLooseLines(oldText);
	let bestSimilarity = 0;
	let bestStartLine = -1;
	let bestWindow: string[] = [];
	if (oldNonBlank.length > 0 && oldNonBlank.length <= SIMILAR_BLOCK_MAX_NON_BLANK_LINES) {
		const contentNonBlank: Array<{ lineNumber: number; loose: string }> = [];
		for (let i = 0; i < contentLines.length; i++) {
			const loose = normalizeLineLoose(contentLines[i]);
			if (loose !== "") contentNonBlank.push({ lineNumber: i + 1, loose });
		}
		const nbLoose = contentNonBlank.map((entry) => entry.loose);
		if (oldNonBlank.length === 1) {
			for (let j = 0; j < nbLoose.length; j++) {
				const similarity = bigramSimilarity(oldNonBlank[0], nbLoose[j]);
				if (similarity > bestSimilarity) {
					bestSimilarity = similarity;
					bestStartLine = contentNonBlank[j].lineNumber;
					bestWindow = [nbLoose[j]];
				}
			}
		} else {
			const oldJoined = oldNonBlank.join("\n");
			const count = Math.min(oldNonBlank.length, nbLoose.length);
			for (let j = 0; j + count <= nbLoose.length; j++) {
				const windowLines = nbLoose.slice(j, j + count);
				const similarity = levenshteinSimilarity(oldJoined, windowLines.join("\n"));
				if (similarity > bestSimilarity) {
					bestSimilarity = similarity;
					bestStartLine = contentNonBlank[j].lineNumber;
					bestWindow = windowLines;
				}
			}
		}
	}
	const firstPreview = firstOldIndex >= 0 ? previewLine(oldLines[firstOldIndex]) : "";
	if (bestSimilarity >= ERROR_SIMILAR_REGION_THRESHOLD && bestStartLine !== -1) {
		let divergence = "";
		for (let k = 0; k < Math.min(oldNonBlank.length, bestWindow.length); k++) {
			if (oldNonBlank[k] !== bestWindow[k]) {
				divergence = ` First difference inside it: oldText has "${previewLine(oldNonBlank[k])}", file has "${previewLine(bestWindow[k])}".`;
				break;
			}
		}
		return (
			`No line of oldText (starting with "${firstPreview}") appears verbatim in the file. ` +
			`The most similar region (~${Math.round(bestSimilarity * 100)}%) starts at line ${bestStartLine}.${divergence} ` +
			`Re-read that region and retry with the verbatim text.`
		);
	}
	return (
		`No line of oldText (starting with "${firstPreview}") appears in the file and no similar region exists. ` +
		`The text is likely outdated or belongs to a different file. Re-read the file before editing.`
	);
}

function getNotFoundError(
	path: string,
	editIndex: number,
	totalEdits: number,
	content: string,
	oldText: string,
): Error {
	const diagnostic = diagnoseNoMatch(content, oldText);
	if (totalEdits === 1) {
		return new Error(`Could not find the text in ${path}. ${diagnostic}`);
	}
	return new Error(`Could not find edits[${editIndex}] in ${path}. ${diagnostic}`);
}

function getIncrementalMatchError(path: string, editIndex: number, totalEdits: number): Error {
	const target = totalEdits === 1 ? "The oldText" : `edits[${editIndex}]`;
	return new Error(
		`${target} in ${path} only matches after applying the earlier edits in this call. ` +
			`All edits in one call are matched against the original file content, not applied incrementally. ` +
			`Rewrite the oldText to match the original file text, or split the work into sequential edit calls.`,
	);
}

function getAmbiguousSimilarError(path: string, editIndex: number, totalEdits: number, lines: number[]): Error {
	const target = totalEdits === 1 ? "The oldText" : `edits[${editIndex}]`;
	return new Error(
		`${target} in ${path} approximately matches ${lines.length} different regions (starting near lines ${lines.join(", ")}). ` +
			`Provide more surrounding context so the oldText identifies one unique region.`,
	);
}

function getDuplicateError(
	path: string,
	editIndex: number,
	totalEdits: number,
	occurrences: number,
	occurrenceLines: number[],
): Error {
	const location =
		occurrenceLines.length > 0
			? ` (lines ${occurrenceLines.join(", ")}${occurrences > occurrenceLines.length ? ", …" : ""})`
			: "";
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}${location}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}${location}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content through the matching
 * ladder in fuzzyFindText (exact → normalized → blank-line tolerant → loose
 * lines → similar block). Replacements are then applied in reverse order so
 * offsets remain stable. If any edit needs non-exact matching, the operation
 * runs in fuzzy-normalized content space and then overlays those line-level
 * changes onto the original content so unchanged line blocks keep their
 * original bytes.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
	const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
		if (!matchResult.found) {
			if (matchResult.ambiguousLines && matchResult.ambiguousLines.length > 0) {
				throw getAmbiguousSimilarError(path, i, normalizedEdits.length, matchResult.ambiguousLines);
			}
			// Detect edits written against the result of earlier edits in the same
			// call (incremental intent); all edits match the original content, so
			// report that instead of a bare not-found.
			if (matchedEdits.length > 0) {
				const simulated = applyReplacements(
					replacementBaseContent,
					[...matchedEdits].sort((a, b) => a.matchIndex - b.matchIndex),
				);
				if (fuzzyFindText(simulated, edit.oldText).found) {
					throw getIncrementalMatchError(path, i, normalizedEdits.length);
				}
			}
			throw getNotFoundError(path, i, normalizedEdits.length, normalizedContent, edit.oldText);
		}

		if ((matchResult.occurrenceCount ?? 1) > 1) {
			throw getDuplicateError(
				path,
				i,
				normalizedEdits.length,
				matchResult.occurrenceCount ?? 0,
				matchResult.occurrenceLines ?? [],
			);
		}

		// Loose and similar-block matches span whole lines excluding the final
		// line terminator; drop one trailing newline from newText so it cannot
		// introduce an extra blank line.
		let newText = edit.newText;
		if (
			(matchResult.matchTier === "loose-lines" || matchResult.matchTier === "similar-block") &&
			newText.endsWith("\n")
		) {
			newText = newText.slice(0, -1);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	const baseContent = normalizedContent;
	const newContent = usedFuzzyMatch
		? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
		: applyReplacements(replacementBaseContent, matchedEdits);

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}
