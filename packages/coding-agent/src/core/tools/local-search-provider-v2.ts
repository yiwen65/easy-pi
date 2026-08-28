import { stat } from "node:fs/promises";
import path from "node:path";
import {
	compareSearchPaths,
	ExecutionEnvSearchProvider,
	type ExecutionToolContext,
	type SearchCapabilities,
	type SearchExecutionContext,
	type SearchHit,
	type SearchPage,
	type SearchProvider,
	SearchProviderError,
	type SearchRequest,
	scoreSearchPath,
} from "@earendil-works/pi-agent-core";
import type { ChildProcess } from "child_process";
import { spawn } from "child_process";
import { minimatch } from "minimatch";
import { ensureTool } from "../../utils/tools-manager.ts";

const MAX_BUFFERED_HITS = 10_000;
const MAX_SCANNED_PATHS = 100_000;
const MAX_SNAPSHOTS = 200;

type Snapshot = {
	hits: SearchHit[];
	complete: boolean;
	approximate: boolean;
	partial: boolean;
	generation: string;
};

type RgEvent = {
	type?: string;
	data?: {
		path?: { text?: string };
		lines?: { text?: string };
		line_number?: number;
		submatches?: Array<{ start?: number; end?: number }>;
	};
};

type RgRow = {
	path: string;
	line: number;
	text: string;
	ranges: Array<[number, number]>;
};

function normalizePath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function removeLineEnding(value: string): string {
	return value.replace(/\r?\n$/, "").replace(/\r$/, "");
}

function fuzzyFdPattern(query: string): string {
	return [...query].map((character) => character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")).join(".*");
}

function byteIndexToStringIndex(value: string, byteIndex: number): number {
	return Buffer.from(value).subarray(0, byteIndex).toString("utf8").length;
}

function relativeResultPath(resultPath: string, searchPath: string, scopeIsDirectory: boolean): string {
	if (scopeIsDirectory) return normalizePath(path.relative(searchPath, resultPath));
	return path.basename(resultPath);
}

/** Direct structured rg/fd provider. It never invokes or parses another ToolDefinition. */
export class LocalSearchProviderV2 implements SearchProvider {
	readonly id = "local-rg-fd";
	readonly capabilities: SearchCapabilities = {
		textLiteral: true,
		textRegex: true,
		context: true,
		fuzzyFiles: true,
		glob: true,
		stableCursor: true,
		globalRanking: true,
	};
	private readonly fallback: ExecutionEnvSearchProvider;
	private readonly snapshots = new Map<string, Snapshot>();
	private readonly children = new Set<ChildProcess>();
	private sequence = 0;

	constructor(env: ExecutionToolContext["env"]) {
		this.fallback = new ExecutionEnvSearchProvider(env);
	}

	async search(request: SearchRequest, context: SearchExecutionContext, signal?: AbortSignal): Promise<SearchPage> {
		if (signal?.aborted) throw new SearchProviderError("unavailable", "Search aborted.");
		if (request.cursor) return this.continueSnapshot(request.cursor, request.expectedGeneration, request.limit);
		if (request.kind === "text") return this.searchText(request, signal);
		const fdPath = await ensureTool("fd");
		if (!fdPath) return this.fallback.search(request, context, signal);
		return this.searchPaths(fdPath, request, signal);
	}

	private async searchText(request: SearchRequest, signal?: AbortSignal): Promise<SearchPage> {
		const rgPath = await ensureTool("rg");
		if (!rgPath) throw new SearchProviderError("unavailable", "ripgrep is unavailable.");
		const args = ["--json", "--line-number", "--column", "--color=never", "--hidden"];
		if (request.case === "sensitive") args.push("--case-sensitive");
		else if (request.case === "insensitive") args.push("--ignore-case");
		else args.push("--smart-case");
		if (!request.regex) args.push("--fixed-strings");
		if (request.context > 0) args.push("--context", String(request.context));
		if (request.fileGlob) args.push("--glob", request.fileGlob);
		args.push("--", request.query, request.path);

		const scopeIsDirectory = (await stat(request.path)).isDirectory();
		const rows: RgRow[] = [];
		const contextRows = new Map<string, RgRow>();
		let partial = false;
		const { code, stderr } = await this.consumeLines(rgPath, args, signal, (line, child) => {
			let event: RgEvent;
			try {
				event = JSON.parse(line) as RgEvent;
			} catch {
				return;
			}
			if (event.type !== "match" && event.type !== "context") return;
			const eventPath = event.data?.path?.text;
			const lineNumber = event.data?.line_number;
			const rawText = event.data?.lines?.text;
			if (!eventPath || lineNumber === undefined || rawText === undefined) return;
			const text = removeLineEnding(rawText);
			const ranges =
				event.type === "match"
					? (event.data?.submatches ?? []).flatMap((range): Array<[number, number]> => {
							if (range.start === undefined || range.end === undefined) return [];
							return [[byteIndexToStringIndex(text, range.start), byteIndexToStringIndex(text, range.end)]];
						})
					: [];
			const row = { path: eventPath, line: lineNumber, text, ranges };
			if (event.type === "match") {
				rows.push(row);
				if (rows.length > MAX_BUFFERED_HITS) {
					partial = true;
					child.kill();
				}
			} else contextRows.set(`${eventPath}\0${lineNumber}`, row);
		});
		if (signal?.aborted) throw new SearchProviderError("unavailable", "Search aborted.");
		if (!partial && code !== 0 && code !== 1) {
			throw new SearchProviderError(request.regex ? "invalid_regex" : "unavailable", stderr || `rg exited ${code}`);
		}

		const hits: SearchHit[] = [];
		for (const row of rows.slice(0, MAX_BUFFERED_HITS)) {
			const relativePath = relativeResultPath(row.path, request.path, scopeIsDirectory);
			const before: Array<{ line: number; text: string }> = [];
			const after: Array<{ line: number; text: string }> = [];
			for (let distance = request.context; distance > 0; distance--) {
				const context = contextRows.get(`${row.path}\0${row.line - distance}`);
				if (context) before.push({ line: context.line, text: context.text });
			}
			for (let distance = 1; distance <= request.context; distance++) {
				const context = contextRows.get(`${row.path}\0${row.line + distance}`);
				if (context) after.push({ line: context.line, text: context.text });
			}
			hits.push({
				kind: "text",
				path: relativePath,
				line: row.line,
				column: (row.ranges[0]?.[0] ?? 0) + 1,
				text: row.text,
				ranges: row.ranges,
				before: before.length > 0 ? before : undefined,
				after: after.length > 0 ? after : undefined,
			});
		}
		hits.sort((left, right) => {
			if (left.path !== right.path) return left.path < right.path ? -1 : 1;
			if (left.kind !== "text" || right.kind !== "text") return 0;
			return left.line - right.line || left.column - right.column;
		});
		return this.createPage(hits, request.limit, !partial, false, partial);
	}

	private async searchPaths(fdPath: string, request: SearchRequest, signal?: AbortSignal): Promise<SearchPage> {
		const scopeIsDirectory = (await stat(request.path)).isDirectory();
		const fastLimit = Math.max(request.limit * 50, 1000);
		const processLimit = request.kind === "files" && request.ranking === "fast" ? fastLimit : MAX_SCANNED_PATHS + 1;
		const args = ["--print0", "--color=never", "--hidden", "--type", "f", "--type", "d"];
		if (request.kind === "glob") {
			args.push("--glob");
			let pattern = request.query;
			if (pattern.includes("/")) {
				args.push("--full-path");
				if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") pattern = `**/${pattern}`;
				if (process.platform === "win32") pattern = pattern.replaceAll("/", String.raw`[/\\]`);
			}
			args.push("--max-results", String(Math.min(MAX_BUFFERED_HITS + 1, processLimit)), "--", pattern, request.path);
		} else {
			args.push("--full-path");
			if (request.case === "sensitive") args.push("--case-sensitive");
			else if (request.case === "insensitive") args.push("--ignore-case");
			args.push("--max-results", String(processLimit), "--", fuzzyFdPattern(request.query), request.path);
		}

		const paths: Array<{ path: string; pathKind: "file" | "directory" }> = [];
		let partial = false;
		const { code, stderr } = await this.consumeNul(fdPath, args, signal, (rawPath, child) => {
			const resultPath = relativeResultPath(rawPath, request.path, scopeIsDirectory);
			const directory = rawPath.endsWith(path.sep);
			paths.push({ path: resultPath, pathKind: directory ? "directory" : "file" });
			if (paths.length >= processLimit) {
				partial = true;
				child.kill();
			}
		});
		if (signal?.aborted) throw new SearchProviderError("unavailable", "Search aborted.");
		if (!partial && code !== 0) throw new SearchProviderError("unavailable", stderr || `fd exited ${code}`);

		let hits: SearchHit[];
		if (request.kind === "glob") {
			hits = paths.slice(0, MAX_BUFFERED_HITS).map((candidate) => ({
				kind: "file",
				path: candidate.path,
				pathKind: candidate.pathKind,
				exact: true,
			}));
			hits.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
			if (paths.length > MAX_BUFFERED_HITS) partial = true;
		} else {
			hits = paths.flatMap((candidate): SearchHit[] => {
				if (request.fileGlob && !minimatch(candidate.path, request.fileGlob, { dot: true })) return [];
				const score = scoreSearchPath(candidate.path, request.query, request.case);
				return score === undefined
					? []
					: [
							{
								kind: "file",
								path: candidate.path,
								pathKind: candidate.pathKind,
								score,
								exact: score === 0,
							},
						];
			});
			hits.sort(compareSearchPaths);
			if (hits.length > MAX_BUFFERED_HITS) {
				hits = hits.slice(0, MAX_BUFFERED_HITS);
				partial = true;
			}
		}
		const approximate = request.kind === "files" && request.ranking === "fast" && partial;
		return this.createPage(hits, request.limit, !partial, approximate, partial);
	}

	private consumeLines(
		command: string,
		args: string[],
		signal: AbortSignal | undefined,
		onLine: (line: string, child: ChildProcess) => void,
	): Promise<{ code: number | null; stderr: string }> {
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
			this.children.add(child);
			let stdout = "";
			let stderr = "";
			const abort = () => child.kill();
			signal?.addEventListener("abort", abort, { once: true });
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
				let newline = stdout.indexOf("\n");
				while (newline >= 0) {
					const line = stdout.slice(0, newline);
					stdout = stdout.slice(newline + 1);
					if (line) onLine(line, child);
					newline = stdout.indexOf("\n");
				}
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			child.on("error", reject);
			child.on("close", (code) => {
				this.children.delete(child);
				signal?.removeEventListener("abort", abort);
				if (stdout) onLine(stdout, child);
				resolve({ code, stderr: stderr.trim() });
			});
		});
	}

	private consumeNul(
		command: string,
		args: string[],
		signal: AbortSignal | undefined,
		onPath: (path: string, child: ChildProcess) => void | Promise<void>,
	): Promise<{ code: number | null; stderr: string }> {
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
			this.children.add(child);
			let stdout = Buffer.alloc(0);
			let stderr = "";
			let processing = Promise.resolve();
			const abort = () => child.kill();
			signal?.addEventListener("abort", abort, { once: true });
			child.stdout.on("data", (chunk: Buffer) => {
				stdout = Buffer.concat([stdout, chunk]);
				let separator = stdout.indexOf(0);
				while (separator >= 0) {
					const value = stdout.subarray(0, separator).toString("utf8");
					stdout = stdout.subarray(separator + 1);
					if (value) processing = processing.then(() => onPath(value, child));
					separator = stdout.indexOf(0);
				}
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			child.on("error", reject);
			child.on("close", (code) => {
				this.children.delete(child);
				signal?.removeEventListener("abort", abort);
				processing.then(
					() => resolve({ code, stderr: stderr.trim() }),
					(error: unknown) => reject(error),
				);
			});
		});
	}

	private createPage(
		hits: SearchHit[],
		limit: number,
		complete: boolean,
		approximate: boolean,
		partial: boolean,
		generation = `local-${this.sequence++}`,
	): SearchPage {
		const page = hits.slice(0, limit);
		const remaining = hits.slice(limit);
		let nextCursor: string | undefined;
		if (remaining.length > 0) {
			nextCursor = `local-cursor-${this.sequence++}`;
			this.snapshots.set(nextCursor, { hits: remaining, complete, approximate, partial, generation });
			while (this.snapshots.size > MAX_SNAPSHOTS) {
				const oldest = this.snapshots.keys().next().value;
				if (oldest === undefined) break;
				this.snapshots.delete(oldest);
			}
		}
		return { hits: page, nextCursor, complete, approximate, partial, generation };
	}

	private continueSnapshot(
		cursor: string,
		expectedGeneration: string | number | undefined,
		limit: number,
	): SearchPage {
		const snapshot = this.snapshots.get(cursor);
		if (!snapshot || snapshot.generation !== expectedGeneration) {
			throw new SearchProviderError("stale_cursor", "The local search snapshot is no longer available.");
		}
		return this.createPage(
			snapshot.hits,
			limit,
			snapshot.complete,
			snapshot.approximate,
			snapshot.partial,
			snapshot.generation,
		);
	}

	async close(): Promise<void> {
		for (const child of this.children) child.kill();
		this.children.clear();
		this.snapshots.clear();
		await this.fallback.close();
	}
}
