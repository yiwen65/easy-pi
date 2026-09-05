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
const MAX_CANDIDATES_PER_MODE = 100_000;

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
	candidateCatalog?: CandidateCatalog;
}

interface CursorRecord {
	hits: StructuredHitRecord[];
	generation: string;
	signature: string;
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

interface StructuredHitRecord {
	hit: Extract<SearchHit, { kind: "text" }>;
	handle: NodeHandle;
}

interface CandidateNode {
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
}

interface SymbolIdentity {
	simpleName: string;
	qualifiedName?: string;
}

interface CatalogCandidate extends CandidateNode {
	searchText?: string;
	searchStart?: number;
	implementationTargets?: SymbolIdentity[];
}

interface Candidate extends CandidateNode {
	rankReasons: string[];
	score: number;
}

type IndexedStructuredMode = Exclude<NonNullable<SearchRequest["mode"]>, "literal" | "regex" | "semantic_candidate">;

interface CandidateCatalog {
	byMode: Record<IndexedStructuredMode, CatalogCandidate[]>;
	truncatedModes: Set<IndexedStructuredMode>;
}

export interface TypeScriptCodeIndexDiagnostics {
	candidateCatalogBuilds: number;
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
		ts.isMethodSignature(node) ||
		ts.isPropertySignature(node) ||
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

function structuredCursorSignature(request: SearchRequest, context: SearchExecutionContext): string {
	return JSON.stringify({
		scopeId: context.scopeId,
		workspaceRoot: path.resolve(context.workspaceRoot),
		query: request.query,
		kind: request.kind,
		path: path.resolve(request.path),
		fileGlob: request.fileGlob,
		include: request.include ?? [],
		exclude: request.exclude ?? [],
		honorIgnore: request.honorIgnore !== false,
		includeHidden: request.includeHidden === true,
		followSymlinks: request.followSymlinks === true,
		case: request.case,
		regex: request.regex,
		mode: request.mode,
		targetKind: request.targetKind,
		wordBoundary: request.wordBoundary === true,
		context: request.context,
		limit: request.limit,
		ranking: request.ranking,
		queryTemplate: request.queryTemplate,
		preferredPaths: request.preferredPaths ?? [],
	});
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

function declarationIdentity(node: ts.Node): SymbolIdentity | undefined {
	const simpleName = nameText(nodeName(node));
	if (!simpleName) return undefined;
	return { simpleName, qualifiedName: declarationQualifiedName(node) };
}

function symbolIdentity(symbol: ts.Symbol | undefined): SymbolIdentity | undefined {
	for (const declaration of symbol?.declarations ?? []) {
		const identity = declarationIdentity(declaration);
		if (identity) return identity;
	}
	const simpleName = symbol?.getName();
	return simpleName && !simpleName.startsWith("__") ? { simpleName } : undefined;
}

function uniqueIdentities(identities: Array<SymbolIdentity | undefined>): SymbolIdentity[] {
	const seen = new Set<string>();
	const unique: SymbolIdentity[] = [];
	for (const identity of identities) {
		if (!identity) continue;
		const key = `${identity.simpleName}\0${identity.qualifiedName ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(identity);
	}
	return unique;
}

function hasModifier(node: ts.Declaration, modifier: ts.ModifierFlags): boolean {
	return (ts.getCombinedModifierFlags(node) & modifier) !== 0;
}

function declarationHasBody(node: ts.Declaration): boolean {
	return (
		(ts.isFunctionDeclaration(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isGetAccessorDeclaration(node) ||
			ts.isSetAccessorDeclaration(node)) &&
		node.body !== undefined
	);
}

function overloadImplementationTargets(node: ts.Node, checker: ts.TypeChecker): SymbolIdentity[] {
	if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node)) return [];
	if (!node.body || !node.name) return [];
	const symbol = dereferenceSymbol(checker, node.name);
	const hasOverload = symbol?.declarations?.some(
		(declaration) =>
			declaration !== node &&
			(ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) &&
			!declarationHasBody(declaration),
	);
	return hasOverload ? uniqueIdentities([declarationIdentity(node)]) : [];
}

type ClassRelationship = {
	type: ts.Type;
	identity?: SymbolIdentity;
	kind: "interface" | "abstract";
};

function isAbstractDeclaration(node: ts.Declaration): boolean {
	return hasModifier(node, ts.ModifierFlags.Abstract);
}

function classRelationships(node: ts.ClassDeclaration, checker: ts.TypeChecker): ClassRelationship[] {
	const relationships: ClassRelationship[] = [];
	const classType = checker.getTypeAtLocation(node);
	for (const clause of node.heritageClauses ?? []) {
		for (const typeNode of clause.types) {
			const relationshipType = checker.getTypeAtLocation(typeNode);
			if (!checker.isTypeAssignableTo(classType, relationshipType)) continue;
			const isInterface = clause.token === ts.SyntaxKind.ImplementsKeyword;
			const isAbstractBase =
				clause.token === ts.SyntaxKind.ExtendsKeyword &&
				checker
					.getPropertiesOfType(relationshipType)
					.some((property) => property.declarations?.some(isAbstractDeclaration));
			if (!isInterface && !isAbstractBase) continue;
			const identity = symbolIdentity(dereferenceSymbol(checker, typeNode.expression));
			relationships.push({
				type: relationshipType,
				identity,
				kind: isInterface ? "interface" : "abstract",
			});
		}
	}
	return relationships;
}

function classMemberImplementationTargets(node: ts.Node, checker: ts.TypeChecker): SymbolIdentity[] {
	const parent = node.parent;
	if (!ts.isClassDeclaration(parent)) return [];
	if (
		(!ts.isMethodDeclaration(node) &&
			!ts.isPropertyDeclaration(node) &&
			!ts.isGetAccessorDeclaration(node) &&
			!ts.isSetAccessorDeclaration(node)) ||
		hasModifier(node, ts.ModifierFlags.Abstract) ||
		hasModifier(node, ts.ModifierFlags.Ambient) ||
		((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
			node.body === undefined)
	) {
		return [];
	}
	const memberName = nameText(nodeName(node));
	if (!memberName) return [];
	const targets: Array<SymbolIdentity | undefined> = [];
	for (const relationship of classRelationships(parent, checker)) {
		const property = checker.getPropertyOfType(relationship.type, memberName);
		if (!property) continue;
		const declarations =
			relationship.kind === "abstract"
				? property.declarations?.filter(isAbstractDeclaration)
				: property.declarations;
		if (declarations && declarations.length > 0) {
			targets.push(...declarations.map(declarationIdentity));
		} else if (relationship.identity) {
			targets.push({
				simpleName: memberName,
				qualifiedName: relationship.identity.qualifiedName
					? `${relationship.identity.qualifiedName}.${memberName}`
					: `${relationship.identity.simpleName}.${memberName}`,
			});
		}
	}
	return uniqueIdentities(targets);
}

function implementationTargets(node: ts.Node, checker: ts.TypeChecker): SymbolIdentity[] {
	return uniqueIdentities([
		...overloadImplementationTargets(node, checker),
		...classMemberImplementationTargets(node, checker),
	]);
}

function createCandidateCatalog(snapshot: IndexSnapshot, signal?: AbortSignal): CandidateCatalog {
	const byMode: CandidateCatalog["byMode"] = {
		symbol_definition: [],
		symbol_reference: [],
		implementation: [],
		assignment: [],
		call: [],
		string_literal: [],
		comment: [],
	};
	const truncatedModes = new Set<IndexedStructuredMode>();
	const add = (mode: IndexedStructuredMode, candidate: CatalogCandidate): void => {
		if (byMode[mode].length >= MAX_CANDIDATES_PER_MODE) {
			truncatedModes.add(mode);
			return;
		}
		byMode[mode].push(candidate);
	};

	for (const sourceFile of snapshot.program.getSourceFiles()) {
		if (signal?.aborted) throw new SearchProviderError("unavailable", "Structured search aborted.");
		const record = snapshot.files.get(path.resolve(sourceFile.fileName));
		if (!record) continue;
		const scanner = ts.createScanner(sourceFile.languageVersion, false, sourceFile.languageVariant, record.content);
		let token = scanner.scan();
		while (token !== ts.SyntaxKind.EndOfFileToken) {
			if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
				add("comment", {
					sourceFile,
					record,
					matchNode: sourceFile,
					rangeNode: sourceFile,
					rangeStart: scanner.getTokenPos(),
					rangeEnd: scanner.getTextPos(),
					nodeKind: "CommentTrivia",
					matchKind: "comment",
					simpleName: "",
					searchText: scanner.getTokenText(),
					searchStart: scanner.getTokenPos(),
				});
			}
			token = scanner.scan();
		}

		const visit = (node: ts.Node): void => {
			const declaration = nodeName(node);
			const declaredName = nameText(declaration);
			if (declaration && declaredName) {
				const qualifiedName = declarationQualifiedName(node);
				const definition: CatalogCandidate = {
					sourceFile,
					record,
					matchNode: declaration,
					rangeNode: node,
					matchKind: "definition",
					simpleName: declaredName,
					qualifiedName,
					enclosingSymbol: qualifiedName,
				};
				add("symbol_definition", definition);
				const targets = implementationTargets(node, snapshot.checker);
				if (targets.length > 0) {
					add("implementation", {
						...definition,
						matchKind: "implementation",
						implementationTargets: targets,
					});
				}
			}
			let assignmentTarget: ts.Node | undefined;
			let assignmentRange: ts.Node | undefined;
			if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer !== undefined) {
				assignmentTarget = node.name;
				assignmentRange = node;
			} else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
				assignmentTarget = node.left;
				assignmentRange = node;
			}
			const assignmentName =
				nameText(assignmentTarget) ??
				(assignmentTarget ? assignmentTarget.getText(sourceFile).split(".").at(-1) : undefined);
			if (assignmentTarget && assignmentRange && assignmentName) {
				const qualifiedName =
					symbolQualifiedName(snapshot.checker, assignmentTarget) ??
					(enclosingSymbol(assignmentTarget)?.split(".")[0]
						? `${enclosingSymbol(assignmentTarget)?.split(".")[0]}.${assignmentName}`
						: undefined);
				add("assignment", {
					sourceFile,
					record,
					matchNode: assignmentTarget,
					rangeNode: assignmentRange,
					matchKind: "assignment",
					simpleName: assignmentName,
					qualifiedName,
					enclosingSymbol: enclosingSymbol(node),
				});
			}
			if (ts.isCallExpression(node)) {
				const target = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
				const simpleName = nameText(target) ?? target.getText(sourceFile);
				add("call", {
					sourceFile,
					record,
					matchNode: target,
					rangeNode: node,
					matchKind: "call",
					simpleName,
					qualifiedName: symbolQualifiedName(snapshot.checker, target),
					enclosingSymbol: enclosingSymbol(node),
				});
			}
			if (ts.isIdentifier(node) && !isDeclarationName(node)) {
				const qualifiedName =
					symbolQualifiedName(snapshot.checker, node) ??
					(node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
						? `${enclosingSymbol(node)?.split(".")[0]}.${node.text}`
						: undefined);
				add("symbol_reference", {
					sourceFile,
					record,
					matchNode: node,
					rangeNode: node,
					matchKind: "reference",
					simpleName: node.text,
					qualifiedName,
					enclosingSymbol: enclosingSymbol(node),
				});
			}
			if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
				add("string_literal", {
					sourceFile,
					record,
					matchNode: node,
					rangeNode: node,
					matchKind: "string_literal",
					simpleName: node.text,
					enclosingSymbol: enclosingSymbol(node),
					searchText: node.text,
				});
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return { byMode, truncatedModes };
}

function candidatesForRequest(
	catalog: CandidateCatalog,
	mode: IndexedStructuredMode,
	request: SearchRequest,
): Candidate[] {
	const candidates: Candidate[] = [];
	for (const candidate of catalog.byMode[mode]) {
		let rankIdentity: SymbolIdentity | undefined;
		let matchStart = candidate.matchStart;
		let matchEnd = candidate.matchEnd;
		if (mode === "implementation") {
			rankIdentity = candidate.implementationTargets?.find((target) =>
				queryMatches(request.query, target.simpleName, target.qualifiedName, request.case),
			);
			if (!rankIdentity) continue;
		} else if (mode === "string_literal" || mode === "comment") {
			const offset = candidate.searchText?.indexOf(request.query) ?? -1;
			if (offset < 0) continue;
			if (mode === "comment") {
				matchStart = (candidate.searchStart ?? 0) + offset;
				matchEnd = matchStart + request.query.length;
			}
		} else {
			rankIdentity = candidate;
			if (!queryMatches(request.query, candidate.simpleName, candidate.qualifiedName, request.case)) continue;
		}
		const ranked = rankIdentity
			? candidateScore(request.query, rankIdentity.simpleName, rankIdentity.qualifiedName, candidate.matchKind)
			: {
					score: 20,
					reasons: [mode === "comment" ? "comment_match" : "string_literal_match"],
				};
		candidates.push({
			...candidate,
			matchStart,
			matchEnd,
			rankReasons: ranked.reasons,
			score: ranked.score,
		});
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
	private candidateCatalogBuilds = 0;

	constructor(options: TypeScriptCodeIndexOptions = {}) {
		this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
		this.maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
		this.maxSnapshots = options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS;
	}

	getDiagnostics(): TypeScriptCodeIndexDiagnostics {
		return { candidateCatalogBuilds: this.candidateCatalogBuilds };
	}

	async search(request: SearchRequest, context: SearchExecutionContext, signal?: AbortSignal): Promise<SearchPage> {
		if (signal?.aborted) throw new SearchProviderError("unavailable", "Structured search aborted.");
		const mode = request.mode;
		if (!mode || !this.capabilities.structuredModes?.includes(mode as never)) {
			throw new SearchProviderError("unsupported", `${String(mode)} is not a supported JS/TS structured mode.`);
		}
		if (request.cursor) return this.continueCursor(request, request.cursor, context, signal);
		const snapshot = await this.snapshot(request, signal);
		const indexedMode = mode as IndexedStructuredMode;
		const catalog = this.candidateCatalog(snapshot, signal);
		const candidates = candidatesForRequest(catalog, indexedMode, request);
		const catalogTruncated = catalog.truncatedModes.has(indexedMode);
		const complete = snapshot.complete && !catalogTruncated;
		const skipped = [
			...snapshot.skipped,
			...(catalogTruncated ? [{ reason: "CANDIDATE_CATALOG_LIMIT", count: MAX_CANDIDATES_PER_MODE }] : []),
		];

		const hitRecords = this.toHitRecords(candidates, snapshot, request);
		const pageLimit = Math.min(request.limit, MAX_NODE_HANDLES);
		const page = this.materializeHits(hitRecords.slice(0, pageLimit));
		const remaining = hitRecords.slice(pageLimit);
		let nextCursor: string | undefined;
		if (remaining.length > 0) {
			nextCursor = `tsc_${this.sequence++}`;
			this.cursors.set(nextCursor, {
				hits: remaining,
				generation: snapshot.generation,
				signature: structuredCursorSignature(request, context),
				complete,
				skipped,
				matchedCount: hitRecords.length,
			});
			this.trim(this.cursors, MAX_CURSORS);
		}
		return {
			hits: page,
			nextCursor,
			complete,
			approximate: false,
			partial: !complete,
			generation: snapshot.generation,
			matchedCount: hitRecords.length,
			matchedCountRelation: complete ? "exact" : "at_least",
			truncatedBy: nextCursor ? "max_results_global" : catalogTruncated ? "provider_limit" : undefined,
			skipped: skipped.length > 0 ? skipped : undefined,
		};
	}

	async listSemanticDocuments(request: SearchRequest, signal?: AbortSignal): Promise<SemanticDocumentPage> {
		const snapshot = await this.snapshot(request, signal);
		const catalog = this.candidateCatalog(snapshot, signal);
		const documents: SemanticCandidateDocument[] = [];
		let truncated = false;
		for (const candidate of catalog.byMode.symbol_definition) {
			if (signal?.aborted) throw new SearchProviderError("unavailable", "Semantic indexing aborted.");
			const symbol = candidate.qualifiedName;
			if (!symbol) continue;
			if (documents.length >= MAX_SEMANTIC_DOCUMENTS) {
				truncated = true;
				break;
			}
			const { sourceFile, record, rangeNode: node } = candidate;
			const lines = record.content.split(/\r?\n/);
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
		const catalogTruncated = catalog.truncatedModes.has("symbol_definition");
		return {
			documents,
			generation: snapshot.generation,
			complete: snapshot.complete && !catalogTruncated && !truncated,
			skipped: [
				...snapshot.skipped,
				...(catalogTruncated ? [{ reason: "CANDIDATE_CATALOG_LIMIT", count: MAX_CANDIDATES_PER_MODE }] : []),
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

	private candidateCatalog(snapshot: IndexSnapshot, signal?: AbortSignal): CandidateCatalog {
		if (snapshot.candidateCatalog) return snapshot.candidateCatalog;
		const catalog = createCandidateCatalog(snapshot, signal);
		snapshot.candidateCatalog = catalog;
		this.candidateCatalogBuilds++;
		return catalog;
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
		if (request.checkPath && !(await request.checkPath(root))) {
			throw new SearchProviderError("unavailable", "Structured search root is forbidden by policy.");
		}
		const records: SourceRecord[] = [];
		const skipped: SearchSkipped[] = [];
		const ignored = await this.ignoreRules(root, request.honorIgnore !== false, skipped, request.checkPath);
		let totalBytes = 0;
		let complete = skipped.length === 0;
		let fileLimitReached = false;
		const consider = async (absolutePath: string): Promise<void> => {
			if (signal?.aborted) throw new SearchProviderError("unavailable", "Structured search aborted.");
			const relativePath = normalizePath(path.relative(root, absolutePath));
			if (!isSourcePath(relativePath) || !globMatches(relativePath, request)) return;
			if (ignored?.ignores(relativePath)) return;
			if (records.length >= this.maxFiles) {
				complete = false;
				fileLimitReached = true;
				return;
			}
			const info = await lstat(absolutePath);
			if (!info.isFile()) return;
			if (totalBytes + info.size > this.maxSourceBytes) {
				complete = false;
				skipped.push({ path: relativePath, reason: "INDEX_BYTE_LIMIT" });
				return;
			}
			if (request.checkPath && !(await request.checkPath(absolutePath))) {
				complete = false;
				skipped.push({ path: relativePath, reason: "WORKSPACE_POLICY" });
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
					if (request.checkPath && !(await request.checkPath(absolutePath))) {
						complete = false;
						skipped.push({ path: relativePath, reason: "WORKSPACE_POLICY" });
						continue;
					}
					if (entry.isSymbolicLink()) {
						if (request.followSymlinks) {
							complete = false;
							skipped.push({ path: relativePath, reason: "SYMLINK_FOLLOW_UNAVAILABLE" });
						}
						continue;
					}
					if (entry.isDirectory()) {
						if (ignored?.ignores(`${relativePath}/`)) continue;
						pending.push(absolutePath);
					} else if (entry.isFile()) await consider(absolutePath);
				}
			}
		}
		if (fileLimitReached) skipped.push({ reason: "INDEX_FILE_LIMIT", count: Math.max(1, records.length) });
		records.sort((left, right) =>
			left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
		);
		const generation = `ts-${createHash("sha256")
			.update(records.map((record) => `${record.relativePath}\0${record.contentHash}`).join("\0"))
			.digest("hex")
			.slice(0, 20)}`;
		const cached = this.snapshots.get(key);
		if (
			cached?.generation === generation &&
			cached.complete === complete &&
			JSON.stringify(cached.skipped) === JSON.stringify(skipped)
		) {
			return cached;
		}
		const program = createProgram(records, root);
		const snapshot: IndexSnapshot = {
			key,
			root,
			generation,
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

	private async ignoreRules(
		root: string,
		enabled: boolean,
		skipped: SearchSkipped[],
		checkPath?: SearchRequest["checkPath"],
	): Promise<Ignore | undefined> {
		if (!enabled) return undefined;
		const rules = ignore().add([".git/", "node_modules/"]);
		if (checkPath && !(await checkPath(path.join(root, ".gitignore")))) {
			skipped.push({ path: ".gitignore", reason: "WORKSPACE_POLICY" });
			return rules;
		}
		try {
			rules.add(await readFile(path.join(root, ".gitignore"), "utf8"));
		} catch {
			// A missing root ignore file is a complete, empty ignore rule set.
		}
		return rules;
	}

	private toHitRecords(
		candidates: Candidate[],
		snapshot: IndexSnapshot,
		request: SearchRequest,
	): StructuredHitRecord[] {
		const seen = new Set<string>();
		const hits: StructuredHitRecord[] = [];
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
			const hit: Extract<SearchHit, { kind: "text" }> = {
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
				fileClass: classification,
				score,
				rankReasons,
			};
			hits.push({ hit, handle });
		}
		hits.sort(
			(left, right) =>
				(left.hit.score ?? 0) - (right.hit.score ?? 0) ||
				(left.hit.path < right.hit.path ? -1 : left.hit.path > right.hit.path ? 1 : 0) ||
				left.hit.line - right.hit.line ||
				left.hit.column - right.hit.column,
		);
		return hits;
	}

	private materializeHits(records: StructuredHitRecord[]): SearchHit[] {
		return records.map(({ hit, handle }) => {
			const nodeId = `tsn_${this.sequence++}`;
			this.nodes.set(nodeId, handle);
			this.trim(this.nodes, MAX_NODE_HANDLES);
			return { ...hit, nodeId };
		});
	}

	private async continueCursor(
		request: SearchRequest,
		cursor: string,
		context: SearchExecutionContext,
		signal?: AbortSignal,
	): Promise<SearchPage> {
		const record = this.cursors.get(cursor);
		if (
			!record ||
			record.generation !== request.expectedGeneration ||
			record.signature !== structuredCursorSignature(request, context)
		) {
			throw new SearchProviderError("stale_cursor", "The JS/TS index cursor is no longer available.");
		}
		const current = await this.snapshot(request, signal);
		if (current.generation !== record.generation) {
			this.cursors.delete(cursor);
			throw new SearchProviderError("stale_cursor", "The JS/TS source changed after the cursor was issued.");
		}
		this.cursors.delete(cursor);
		const pageLimit = Math.min(request.limit, MAX_NODE_HANDLES);
		const hits = this.materializeHits(record.hits.slice(0, pageLimit));
		const remaining = record.hits.slice(pageLimit);
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
