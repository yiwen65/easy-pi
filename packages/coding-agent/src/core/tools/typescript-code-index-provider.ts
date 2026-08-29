import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
	ReadProviderError,
	type SearchCapabilities,
	type SearchExecutionContext,
	type SearchHit,
	type SearchPage,
	type SearchProvider,
	SearchProviderError,
	type SearchRequest,
	type SearchSkipped,
	type SymbolReadProvider,
	type SymbolReadRequest,
	type SymbolReadTarget,
} from "@earendil-works/pi-agent-core";
import ignore, { type Ignore } from "ignore";
import { minimatch } from "minimatch";
import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOTS = 4;
const MAX_CURSORS = 200;
const MAX_NODE_HANDLES = 1_000;
const MAX_SEMANTIC_DOCUMENTS = 5_000;

interface SourceRecord {
	absolutePath: string;
	relativePath: string;
	content: string;
	contentHash: string;
	size: number;
	mtimeMs: number;
}

interface IndexSnapshot {
	key: string;
	root: string;
	generation: string;
	program: ts.Program;
	checker: ts.TypeChecker;
	files: Map<string, SourceRecord>;
	complete: boolean;
	skipped: SearchSkipped[];
}

interface CursorRecord {
	hits: SearchHit[];
	generation: string;
	complete: boolean;
	skipped: SearchSkipped[];
	matchedCount: number;
}

interface NodeHandle {
	path: string;
	startLine: number;
	endLine: number;
	startByte: number;
	endByte: number;
	symbol?: string;
	nodeKind: string;
	generation: string;
	contentHash: string;
}

interface Candidate {
	sourceFile: ts.SourceFile;
	record: SourceRecord;
	matchNode: ts.Node;
	rangeNode: ts.Node;
	matchStart?: number;
	matchEnd?: number;
	rangeStart?: number;
	rangeEnd?: number;
	nodeKind?: string;
	matchKind: string;
	simpleName: string;
	qualifiedName?: string;
	enclosingSymbol?: string;
	rankReasons: string[];
	score: number;
}

export interface TypeScriptCodeIndexOptions {
	maxFiles?: number;
	maxSourceBytes?: number;
	maxSnapshots?: number;
}

export interface SemanticCandidateDocument {
	id: string;
	path: string;
	line: number;
	endLine: number;
	column: number;
	symbol: string;
	nodeKind: string;
	text: string;
	lineText: string;
	fileClass: string;
	generation: string;
}

export interface SemanticDocumentPage {
	documents: SemanticCandidateDocument[];
	generation: string;
	complete: boolean;
	skipped: SearchSkipped[];
}

function normalizePath(value: string): string {
	return value.replaceAll("\\", "/");
}

function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function fileClass(relativePath: string): string {
	const normalized = `/${normalizePath(relativePath).toLowerCase()}/`;
	if (/\/(?:vendor|third_party|node_modules)\//.test(normalized)) return "vendor";
	if (/\/(?:generated|dist|build|coverage)\//.test(normalized)) return "generated";
	if (/\/(?:docs?|documentation)\//.test(normalized) || /\.(?:md|mdx|rst)$/.test(normalized)) {
		return "documentation";
	}
	if (
		/\/(?:test|tests|__tests__|spec|fixtures?)\//.test(normalized) ||
		/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized)
	) {
		return normalized.includes("fixture") ? "fixture" : "test";
	}
	if (normalized.includes("snapshot") || /\.snap$/.test(normalized)) return "snapshot";
	return "production";
}

function isSourcePath(value: string): boolean {
	return SOURCE_EXTENSIONS.has(path.extname(value).toLowerCase()) && !value.toLowerCase().endsWith(".d.ts");
}

function scriptKind(value: string): ts.ScriptKind {
	switch (path.extname(value).toLowerCase()) {
		case ".js":
		case ".mjs":
		case ".cjs":
			return ts.ScriptKind.JS;
		case ".jsx":
			return ts.ScriptKind.JSX;
		case ".tsx":
			return ts.ScriptKind.TSX;
		default:
			return ts.ScriptKind.TS;
	}
}

function nodeName(node: ts.Node): ts.Node | undefined {
	if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node)) return node.name;
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isClassDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node) ||
		ts.isInterfaceDeclaration(node) ||
		ts.isTypeAliasDeclaration(node) ||
		ts.isEnumDeclaration(node) ||
		ts.isImportSpecifier(node)
	) {
		return node.name;
	}
	return undefined;
}

function nameText(node: ts.Node | undefined): string | undefined {
	if (!node) return undefined;
	if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
		return node.text;
	}
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	return undefined;
}

function isDeclarationName(node: ts.Node): boolean {
	return node.parent !== undefined && nodeName(node.parent) === node;
}

function declarationQualifiedName(node: ts.Node): string | undefined {
	const own = nameText(nodeName(node));
	if (!own) return undefined;
	const names = [own];
	let parent = node.parent;
	while (parent) {
		if (
			ts.isClassDeclaration(parent) ||
			ts.isInterfaceDeclaration(parent) ||
			ts.isFunctionDeclaration(parent) ||
			ts.isMethodDeclaration(parent)
		) {
			const parentName = nameText(nodeName(parent));
			if (parentName) names.unshift(parentName);
		}
		parent = parent.parent;
	}
	return names.join(".");
}

function enclosingSymbol(node: ts.Node): string | undefined {
	const names: string[] = [];
	let parent: ts.Node | undefined = node;
	while (parent) {
		if (
			ts.isClassDeclaration(parent) ||
			ts.isInterfaceDeclaration(parent) ||
			ts.isFunctionDeclaration(parent) ||
			ts.isMethodDeclaration(parent) ||
			ts.isGetAccessorDeclaration(parent) ||
			ts.isSetAccessorDeclaration(parent)
		) {
			const parentName = nameText(nodeName(parent));
			if (parentName) names.unshift(parentName);
		}
		parent = parent.parent;
	}
	return names.length > 0 ? names.join(".") : undefined;
}

function dereferenceSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
	let symbol = checker.getSymbolAtLocation(node);
	if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
		try {
			symbol = checker.getAliasedSymbol(symbol);
		} catch {
			return symbol;
		}
	}
	return symbol;
}

function symbolQualifiedName(checker: ts.TypeChecker, node: ts.Node): string | undefined {
	const symbol = dereferenceSymbol(checker, node);
	for (const declaration of symbol?.declarations ?? []) {
		const qualified = declarationQualifiedName(declaration);
		if (qualified) return qualified;
	}
	return undefined;
}

function queryMatches(
	query: string,
	simpleName: string,
	qualifiedName: string | undefined,
	caseMode: SearchRequest["case"],
): boolean {
	const sensitive = caseMode === "sensitive" || (caseMode === "smart" && /[A-Z]/.test(query));
	const expected = sensitive ? query : query.toLowerCase();
	const simple = sensitive ? simpleName : simpleName.toLowerCase();
	const qualified = sensitive ? qualifiedName : qualifiedName?.toLowerCase();
	return query.includes(".")
		? qualified === expected
		: simple === expected || qualified?.split(".").at(-1) === expected;
}

function extensionForFile(fileName: string): ts.Extension {
	switch (path.extname(fileName).toLowerCase()) {
		case ".js":
		case ".mjs":
		case ".cjs":
			return ts.Extension.Js;
		case ".jsx":
			return ts.Extension.Jsx;
		case ".tsx":
			return ts.Extension.Tsx;
		case ".mts":
			return ts.Extension.Mts;
		case ".cts":
			return ts.Extension.Cts;
		default:
			return ts.Extension.Ts;
	}
}

function createProgram(records: SourceRecord[], root: string): ts.Program {
	const options: ts.CompilerOptions = {
		allowJs: true,
		checkJs: false,
		jsx: ts.JsxEmit.Preserve,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		noEmit: true,
		noLib: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.Latest,
	};
	const byPath = new Map(records.map((record) => [path.resolve(record.absolutePath), record]));
	const base = ts.createCompilerHost(options, true);
	const restrictedResolutionHost: ts.ModuleResolutionHost = {
		fileExists: (fileName) => byPath.has(path.resolve(fileName)),
		readFile: (fileName) => byPath.get(path.resolve(fileName))?.content,
		directoryExists: base.directoryExists,
		getCurrentDirectory: () => root,
		getDirectories: base.getDirectories,
		realpath: base.realpath,
	};
	base.getCurrentDirectory = () => root;
	base.fileExists = restrictedResolutionHost.fileExists;
	base.readFile = restrictedResolutionHost.readFile;
	base.getSourceFile = (fileName, languageVersion) => {
		const record = byPath.get(path.resolve(fileName));
		return record
			? ts.createSourceFile(fileName, record.content, languageVersion, true, scriptKind(fileName))
			: undefined;
	};
	base.resolveModuleNames = (moduleNames, containingFile) =>
		moduleNames.map((moduleName) => {
			const resolved = ts.resolveModuleName(
				moduleName,
				containingFile,
				options,
				restrictedResolutionHost,
			).resolvedModule;
			if (!resolved || !byPath.has(path.resolve(resolved.resolvedFileName))) return undefined;
			return { ...resolved, extension: extensionForFile(resolved.resolvedFileName) };
		});
	return ts.createProgram({ rootNames: records.map((record) => record.absolutePath), options, host: base });
}

function globMatches(relativePath: string, request: SearchRequest): boolean {
	const candidate = normalizePath(relativePath);
	const options = { dot: request.includeHidden === true, matchBase: true };
	if (request.fileGlob && !minimatch(candidate, request.fileGlob, options)) return false;
	if (request.include?.length && !request.include.some((pattern) => minimatch(candidate, pattern, options))) {
		return false;
	}
	return !request.exclude?.some((pattern) => minimatch(candidate, pattern, options));
}

function candidateScore(
	query: string,
	simpleName: string,
	qualifiedName: string | undefined,
	kind: string,
): {
	score: number;
	reasons: string[];
} {
	const reasons: string[] = [];
	let score = 20;
	if (qualifiedName === query) {
		score = 0;
		reasons.push("exact_qualified_symbol");
	} else if (simpleName === query) {
		score = 5;
		reasons.push("exact_symbol");
	}
	reasons.push(`${kind}_match`);
	return { score, reasons };
}

function commentCandidates(sourceFile: ts.SourceFile, record: SourceRecord, query: string): Candidate[] {
	const candidates: Candidate[] = [];
	const scanner = ts.createScanner(sourceFile.languageVersion, false, sourceFile.languageVariant, record.content);
	let token = scanner.scan();
	while (token !== ts.SyntaxKind.EndOfFileToken) {
		if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
			const tokenText = scanner.getTokenText();
			const offset = tokenText.indexOf(query);
			if (offset >= 0) {
				const start = scanner.getTokenPos() + offset;
				const end = start + query.length;
				candidates.push({
					sourceFile,
					record,
					matchNode: sourceFile,
					rangeNode: sourceFile,
					matchStart: start,
					matchEnd: end,
					rangeStart: scanner.getTokenPos(),
					rangeEnd: scanner.getTextPos(),
					nodeKind: "CommentTrivia",
					matchKind: "comment",
					simpleName: query,
					rankReasons: ["comment_match"],
					score: 20,
				});
			}
		}
		token = scanner.scan();
	}
	return candidates;
}

/** Bounded JS/TS AST index used by structured Search and symbol/AST Read. */
export class TypeScriptCodeIndexProvider implements SearchProvider, SymbolReadProvider {
	readonly id = "typescript-code-index";
	readonly languages = ["javascript", "typescript"];
	readonly capabilities: SearchCapabilities = {
		textLiteral: false,
		textRegex: false,
		context: false,
		fuzzyFiles: false,
		glob: false,
		stableCursor: true,
		globalRanking: false,
		taskRanking: true,
		scopeFilters: true,
		wordBoundary: false,
		structuredModes: [
			"symbol_definition",
			"symbol_reference",
			"implementation",
			"assignment",
			"call",
			"string_literal",
			"comment",
		],
	};
	private readonly maxFiles: number;
	private readonly maxSourceBytes: number;
	private readonly maxSnapshots: number;
	private readonly snapshots = new Map<string, IndexSnapshot>();
	private readonly cursors = new Map<string, CursorRecord>();
	private readonly nodes = new Map<string, NodeHandle>();
	private sequence = 0;

	constructor(options: TypeScriptCodeIndexOptions = {}) {
		this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
		this.maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
		this.maxSnapshots = options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS;
	}

	async search(request: SearchRequest, _context: SearchExecutionContext, signal?: AbortSignal): Promise<SearchPage> {
		if (signal?.aborted) throw new SearchProviderError("unavailable", "Structured search aborted.");
		const mode = request.mode;
		if (!mode || !this.capabilities.structuredModes?.includes(mode as never)) {
			throw new SearchProviderError("unsupported", `${String(mode)} is not a supported JS/TS structured mode.`);
		}
		if (request.cursor) return this.continueCursor(request, request.cursor, signal);
		const snapshot = await this.snapshot(request, signal);
		const candidates: Candidate[] = [];
		for (const sourceFile of snapshot.program.getSourceFiles()) {
			if (signal?.aborted) throw new SearchProviderError("unavailable", "Structured search aborted.");
			const record = snapshot.files.get(path.resolve(sourceFile.fileName));
			if (!record) continue;
			if (mode === "comment") {
				candidates.push(...commentCandidates(sourceFile, record, request.query));
				continue;
			}
			const visit = (node: ts.Node): void => {
				const declaration = nodeName(node);
				const declaredName = nameText(declaration);
				if ((mode === "symbol_definition" || mode === "implementation") && declaration && declaredName) {
					const qualified = declarationQualifiedName(node);
					const hasImplementation =
						ts.isClassDeclaration(node) ||
						((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body !== undefined);
					if (
						(mode === "symbol_definition" || hasImplementation) &&
						queryMatches(request.query, declaredName, qualified, request.case)
					) {
						const ranked = candidateScore(
							request.query,
							declaredName,
							qualified,
							mode === "implementation" ? "implementation" : "definition",
						);
						candidates.push({
							sourceFile,
							record,
							matchNode: declaration,
							rangeNode: node,
							matchKind: mode === "implementation" ? "implementation" : "definition",
							simpleName: declaredName,
							qualifiedName: qualified,
							enclosingSymbol: qualified,
							rankReasons: ranked.reasons,
							score: ranked.score,
						});
					}
				}
				if (mode === "assignment") {
					let target: ts.Node | undefined;
					let rangeNode: ts.Node | undefined;
					if (
						(ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
						node.initializer !== undefined
					) {
						target = node.name;
						rangeNode = node;
					} else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
						target = node.left;
						rangeNode = node;
					}
					const simple = nameText(target) ?? (target ? target.getText(sourceFile).split(".").at(-1) : undefined);
					if (target && rangeNode && simple) {
						const qualified =
							symbolQualifiedName(snapshot.checker, target) ??
							(enclosingSymbol(target)?.split(".")[0]
								? `${enclosingSymbol(target)?.split(".")[0]}.${simple}`
								: undefined);
						if (queryMatches(request.query, simple, qualified, request.case)) {
							const ranked = candidateScore(request.query, simple, qualified, "assignment");
							candidates.push({
								sourceFile,
								record,
								matchNode: target,
								rangeNode,
								matchKind: "assignment",
								simpleName: simple,
								qualifiedName: qualified,
								enclosingSymbol: enclosingSymbol(node),
								rankReasons: ranked.reasons,
								score: ranked.score,
							});
						}
					}
				}
				if (mode === "call" && ts.isCallExpression(node)) {
					const target = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
					const simple = nameText(target) ?? target.getText(sourceFile);
					const qualified = symbolQualifiedName(snapshot.checker, target);
					if (queryMatches(request.query, simple, qualified, request.case)) {
						const ranked = candidateScore(request.query, simple, qualified, "call");
						candidates.push({
							sourceFile,
							record,
							matchNode: target,
							rangeNode: node,
							matchKind: "call",
							simpleName: simple,
							qualifiedName: qualified,
							enclosingSymbol: enclosingSymbol(node),
							rankReasons: ranked.reasons,
							score: ranked.score,
						});
					}
				}
				if (mode === "symbol_reference" && ts.isIdentifier(node) && !isDeclarationName(node)) {
					const qualified =
						symbolQualifiedName(snapshot.checker, node) ??
						(node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
							? `${enclosingSymbol(node)?.split(".")[0]}.${node.text}`
							: undefined);
					if (queryMatches(request.query, node.text, qualified, request.case)) {
						const ranked = candidateScore(request.query, node.text, qualified, "reference");
						candidates.push({
							sourceFile,
							record,
							matchNode: node,
							rangeNode: node,
							matchKind: "reference",
							simpleName: node.text,
							qualifiedName: qualified,
							enclosingSymbol: enclosingSymbol(node),
							rankReasons: ranked.reasons,
							score: ranked.score,
						});
					}
				}
				if (
					mode === "string_literal" &&
					(ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
					node.text.includes(request.query)
				) {
					candidates.push({
						sourceFile,
						record,
						matchNode: node,
						rangeNode: node,
						matchKind: "string_literal",
						simpleName: request.query,
						enclosingSymbol: enclosingSymbol(node),
						rankReasons: ["string_literal_match"],
						score: 20,
					});
				}
				ts.forEachChild(node, visit);
			};
			visit(sourceFile);
		}

		const hits = this.toHits(candidates, snapshot, request);
		const page = hits.slice(0, request.limit);
		const remaining = hits.slice(request.limit);
		let nextCursor: string | undefined;
		if (remaining.length > 0) {
			nextCursor = `tsc_${this.sequence++}`;
			this.cursors.set(nextCursor, {
				hits: remaining,
				generation: snapshot.generation,
				complete: snapshot.complete,
				skipped: snapshot.skipped,
				matchedCount: hits.length,
			});
			this.trim(this.cursors, MAX_CURSORS);
		}
		return {
			hits: page,
			nextCursor,
			complete: snapshot.complete,
			approximate: false,
			partial: !snapshot.complete,
			generation: snapshot.generation,
			matchedCount: hits.length,
			matchedCountRelation: snapshot.complete ? "exact" : "at_least",
			truncatedBy: nextCursor ? "max_results_global" : undefined,
			skipped: snapshot.skipped.length > 0 ? snapshot.skipped : undefined,
		};
	}

	async listSemanticDocuments(request: SearchRequest, signal?: AbortSignal): Promise<SemanticDocumentPage> {
		const snapshot = await this.snapshot(request, signal);
		const documents: SemanticCandidateDocument[] = [];
		let truncated = false;
		for (const sourceFile of snapshot.program.getSourceFiles()) {
			const record = snapshot.files.get(path.resolve(sourceFile.fileName));
			if (!record) continue;
			const lines = record.content.split(/\r?\n/);
			const visit = (node: ts.Node): void => {
				if (signal?.aborted) throw new SearchProviderError("unavailable", "Semantic indexing aborted.");
				const declaration = nodeName(node);
				const symbol = declarationQualifiedName(node);
				if (declaration && symbol) {
					if (documents.length >= MAX_SEMANTIC_DOCUMENTS) {
						truncated = true;
						return;
					}
					const start = node.getStart(sourceFile);
					const end = node.getEnd();
					const startLocation = sourceFile.getLineAndCharacterOfPosition(start);
					const endLocation = sourceFile.getLineAndCharacterOfPosition(end);
					const nodeText = record.content.slice(start, Math.min(end, start + 1_200));
					const leadingTrivia = record.content.slice(Math.max(node.getFullStart(), start - 600), start);
					const leadingComments = leadingTrivia.match(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g)?.join("\n") ?? "";
					const identifiers = [...`${leadingComments}\n${nodeText}`.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)]
						.map((match) => match[0])
						.slice(0, 80)
						.join(" ");
					const nodeKind = ts.SyntaxKind[node.kind];
					const text = `${record.relativePath}\n${symbol}\n${nodeKind}\n${identifiers}\n${leadingComments}\n${nodeText}`;
					documents.push({
						id: createHash("sha256")
							.update(`${record.relativePath}\0${start}\0${end}\0${record.contentHash}`)
							.digest("hex"),
						path: record.relativePath,
						line: startLocation.line + 1,
						endLine: endLocation.line + 1,
						column: startLocation.character + 1,
						symbol,
						nodeKind,
						text,
						lineText: lines[startLocation.line] ?? "",
						fileClass: fileClass(record.relativePath),
						generation: snapshot.generation,
					});
				}
				if (!truncated) ts.forEachChild(node, visit);
			};
			visit(sourceFile);
			if (truncated) break;
		}
		return {
			documents,
			generation: snapshot.generation,
			complete: snapshot.complete && !truncated,
			skipped: [
				...snapshot.skipped,
				...(truncated ? [{ reason: "SEMANTIC_DOCUMENT_LIMIT", count: documents.length }] : []),
			],
		};
	}

	async resolve(request: SymbolReadRequest, signal?: AbortSignal): Promise<SymbolReadTarget> {
		if (signal?.aborted) throw new ReadProviderError("unsupported", "Symbol read aborted.");
		if (request.mode === "ast_node") {
			const handle = this.nodes.get(request.nodeId ?? "");
			if (!handle || path.resolve(handle.path) !== path.resolve(request.path)) {
				throw new ReadProviderError("stale_cursor", "The AST node handle expired or belongs to another file.");
			}
			const content = await readFile(handle.path, "utf8");
			if (contentHash(content) !== handle.contentHash) {
				this.nodes.delete(request.nodeId ?? "");
				throw new ReadProviderError("stale_cursor", "The AST node source changed after search.");
			}
			return { ...handle };
		}
		if (!request.symbol) throw new ReadProviderError("invalid", "A symbol name is required.");
		const page = await this.search(
			{
				query: request.symbol,
				kind: "text",
				path: request.path,
				case: "sensitive",
				regex: false,
				mode: "symbol_definition",
				context: 0,
				limit: 100,
				ranking: "fast",
				honorIgnore: true,
				includeHidden: false,
				followSymlinks: false,
			},
			{ workspaceRoot: path.dirname(request.path), scopeId: "symbol-read" },
			signal,
		);
		if (page.hits.length === 0) throw new ReadProviderError("not_found", `Symbol ${request.symbol} was not found.`);
		if (page.hits.length !== 1) {
			throw new ReadProviderError("invalid", `Symbol ${request.symbol} is ambiguous; use a qualified symbol name.`);
		}
		const hit = page.hits[0];
		if (hit.kind !== "text" || !hit.nodeId) throw new ReadProviderError("unsupported", "Symbol range unavailable.");
		const handle = this.nodes.get(hit.nodeId);
		if (!handle) throw new ReadProviderError("stale_cursor", "The symbol handle expired.");
		return { ...handle };
	}

	async close(): Promise<void> {
		this.snapshots.clear();
		this.cursors.clear();
		this.nodes.clear();
	}

	private async snapshot(request: SearchRequest, signal?: AbortSignal): Promise<IndexSnapshot> {
		const rootStat = await lstat(request.path).catch(() => undefined);
		if (!rootStat) throw new SearchProviderError("unavailable", `Structured search root was not found.`);
		const root = rootStat.isDirectory() ? path.resolve(request.path) : path.dirname(path.resolve(request.path));
		const rootFile = rootStat.isFile() ? path.resolve(request.path) : undefined;
		if (rootFile && !isSourcePath(rootFile)) {
			throw new SearchProviderError("unsupported", "Structured search supports JS/TS source files only.");
		}
		const key = JSON.stringify({
			path: path.resolve(request.path),
			fileGlob: request.fileGlob,
			include: request.include,
			exclude: request.exclude,
			honorIgnore: request.honorIgnore,
			includeHidden: request.includeHidden,
		});
		const ignored = await this.ignoreRules(root, request.honorIgnore !== false);
		const records: SourceRecord[] = [];
		const skipped: SearchSkipped[] = [];
		let totalBytes = 0;
		let complete = true;
		const consider = async (absolutePath: string): Promise<void> => {
			if (signal?.aborted) throw new SearchProviderError("unavailable", "Structured search aborted.");
			const relativePath = normalizePath(path.relative(root, absolutePath));
			if (!isSourcePath(relativePath) || !globMatches(relativePath, request)) return;
			if (ignored?.ignores(relativePath)) return;
			if (records.length >= this.maxFiles) {
				complete = false;
				return;
			}
			const info = await lstat(absolutePath);
			if (!info.isFile()) return;
			if (totalBytes + info.size > this.maxSourceBytes) {
				complete = false;
				skipped.push({ path: relativePath, reason: "INDEX_BYTE_LIMIT" });
				return;
			}
			const content = await readFile(absolutePath, "utf8");
			totalBytes += Buffer.byteLength(content);
			records.push({
				absolutePath: path.resolve(absolutePath),
				relativePath,
				content,
				contentHash: contentHash(content),
				size: info.size,
				mtimeMs: info.mtimeMs,
			});
		};
		if (rootFile) {
			await consider(rootFile);
		} else {
			const pending = [root];
			while (pending.length > 0) {
				const directory = pending.pop();
				if (!directory) break;
				const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
					left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
				);
				for (let index = entries.length - 1; index >= 0; index--) {
					const entry = entries[index];
					if (!entry) continue;
					if (!request.includeHidden && entry.name.startsWith(".")) continue;
					const absolutePath = path.join(directory, entry.name);
					const relativePath = normalizePath(path.relative(root, absolutePath));
					if (entry.isSymbolicLink()) continue;
					if (entry.isDirectory()) {
						if (ignored?.ignores(`${relativePath}/`)) continue;
						pending.push(absolutePath);
					} else if (entry.isFile()) await consider(absolutePath);
				}
			}
		}
		if (!complete) skipped.push({ reason: "INDEX_FILE_LIMIT", count: Math.max(1, records.length) });
		records.sort((left, right) =>
			left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
		);
		const generation = createHash("sha256")
			.update(records.map((record) => `${record.relativePath}\0${record.contentHash}`).join("\0"))
			.digest("hex")
			.slice(0, 20);
		const cached = this.snapshots.get(key);
		if (cached?.generation === generation && cached.complete === complete) return cached;
		const program = createProgram(records, root);
		const snapshot: IndexSnapshot = {
			key,
			root,
			generation: `ts-${generation}`,
			program,
			checker: program.getTypeChecker(),
			files: new Map(records.map((record) => [path.resolve(record.absolutePath), record])),
			complete,
			skipped,
		};
		this.snapshots.delete(key);
		this.snapshots.set(key, snapshot);
		this.trim(this.snapshots, this.maxSnapshots);
		return snapshot;
	}

	private async ignoreRules(root: string, enabled: boolean): Promise<Ignore | undefined> {
		if (!enabled) return undefined;
		const rules = ignore().add([".git/", "node_modules/"]);
		try {
			rules.add(await readFile(path.join(root, ".gitignore"), "utf8"));
		} catch {
			// A missing root ignore file is a complete, empty ignore rule set.
		}
		return rules;
	}

	private toHits(candidates: Candidate[], snapshot: IndexSnapshot, request: SearchRequest): SearchHit[] {
		const seen = new Set<string>();
		const hits: SearchHit[] = [];
		for (const candidate of candidates) {
			const matchStart = candidate.matchStart ?? candidate.matchNode.getStart(candidate.sourceFile);
			const matchEnd = candidate.matchEnd ?? candidate.matchNode.getEnd();
			const rangeStart = candidate.rangeStart ?? candidate.rangeNode.getStart(candidate.sourceFile);
			const rangeEnd = candidate.rangeEnd ?? candidate.rangeNode.getEnd();
			const start = candidate.sourceFile.getLineAndCharacterOfPosition(matchStart);
			const rangeStartLocation = candidate.sourceFile.getLineAndCharacterOfPosition(rangeStart);
			const rangeEndLocation = candidate.sourceFile.getLineAndCharacterOfPosition(rangeEnd);
			const lines = candidate.record.content.split(/\r?\n/);
			const lineText = lines[start.line] ?? "";
			const key = `${candidate.record.relativePath}\0${matchStart}\0${matchEnd}\0${candidate.matchKind}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const nodeId = `tsn_${this.sequence++}`;
			const classification = fileClass(candidate.record.relativePath);
			const rankReasons = [...candidate.rankReasons];
			let score = candidate.score;
			if (classification === "production") {
				rankReasons.push("production_source");
			} else score += 10;
			if (
				request.preferredPaths?.some((pattern) =>
					minimatch(normalizePath(candidate.record.relativePath), pattern, { dot: true, matchBase: true }),
				) === true
			) {
				score -= 5;
				rankReasons.push("preferred_path");
			}
			const handle: NodeHandle = {
				path: candidate.record.absolutePath,
				startLine: rangeStartLocation.line + 1,
				endLine: rangeEndLocation.line + 1,
				startByte: Buffer.byteLength(candidate.record.content.slice(0, rangeStart)),
				endByte: Buffer.byteLength(candidate.record.content.slice(0, rangeEnd)),
				symbol: candidate.qualifiedName ?? candidate.simpleName,
				nodeKind: candidate.nodeKind ?? ts.SyntaxKind[candidate.rangeNode.kind],
				generation: snapshot.generation,
				contentHash: candidate.record.contentHash,
			};
			this.nodes.set(nodeId, handle);
			this.trim(this.nodes, MAX_NODE_HANDLES);
			hits.push({
				kind: "text",
				path: candidate.record.relativePath,
				line: start.line + 1,
				endLine: handle.endLine,
				column: start.character + 1,
				endColumn: start.character + Math.max(1, matchEnd - matchStart) + 1,
				text: lineText,
				ranges: [[start.character, start.character + Math.max(1, matchEnd - matchStart)]],
				byteOffset: Buffer.byteLength(candidate.record.content.slice(0, matchStart)),
				matchKind: candidate.matchKind,
				enclosingSymbol: candidate.enclosingSymbol,
				nodeKind: handle.nodeKind,
				nodeId,
				fileClass: classification,
				score,
				rankReasons,
			});
		}
		hits.sort((left, right) => {
			if (left.kind !== "text" || right.kind !== "text") return 0;
			return (
				(left.score ?? 0) - (right.score ?? 0) ||
				(left.path < right.path ? -1 : left.path > right.path ? 1 : 0) ||
				left.line - right.line ||
				left.column - right.column
			);
		});
		return hits;
	}

	private async continueCursor(request: SearchRequest, cursor: string, signal?: AbortSignal): Promise<SearchPage> {
		const record = this.cursors.get(cursor);
		if (!record || record.generation !== request.expectedGeneration) {
			throw new SearchProviderError("stale_cursor", "The JS/TS index cursor is no longer available.");
		}
		const current = await this.snapshot(request, signal);
		if (current.generation !== record.generation) {
			this.cursors.delete(cursor);
			throw new SearchProviderError("stale_cursor", "The JS/TS source changed after the cursor was issued.");
		}
		this.cursors.delete(cursor);
		const hits = record.hits.slice(0, request.limit);
		const remaining = record.hits.slice(request.limit);
		let nextCursor: string | undefined;
		if (remaining.length > 0) {
			nextCursor = `tsc_${this.sequence++}`;
			this.cursors.set(nextCursor, { ...record, hits: remaining });
		}
		return {
			hits,
			nextCursor,
			complete: record.complete,
			approximate: false,
			partial: !record.complete,
			generation: record.generation,
			matchedCount: record.matchedCount,
			matchedCountRelation: record.complete ? "exact" : "at_least",
			truncatedBy: nextCursor ? "max_results_global" : undefined,
			skipped: record.skipped.length > 0 ? record.skipped : undefined,
		};
	}

	private trim<T>(map: Map<string, T>, limit: number): void {
		while (map.size > limit) {
			const oldest = map.keys().next().value;
			if (oldest === undefined) break;
			map.delete(oldest);
		}
	}
}
