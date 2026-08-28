import type { ExecutionEnv, FileError } from "../types.ts";
import { V2ToolError } from "./v2-errors.ts";

export interface WorkspacePolicy {
	roots: string[];
	allowOutsideWorkspaceRead: boolean;
	allowOutsideWorkspaceWrite: boolean;
	followSymlinks: boolean;
}

export interface ResolvedWorkspacePath {
	absolutePath: string;
	canonicalPath: string;
}

function normalizeComparablePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

function isWithinRoot(path: string, root: string): boolean {
	const candidate = normalizeComparablePath(path);
	const normalizedRoot = normalizeComparablePath(root);
	return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

function lexicalParent(path: string): string | undefined {
	const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
	const slash = normalized.lastIndexOf("/");
	if (slash < 0) return undefined;
	if (slash === 0) return "/";
	if (/^[A-Za-z]:$/.test(normalized.slice(0, slash))) return `${normalized.slice(0, slash)}/`;
	return normalized.slice(0, slash);
}

function errorFromFile(error: FileError, path: string): V2ToolError {
	switch (error.code) {
		case "aborted":
			return new V2ToolError("ABORTED", `Path resolution was aborted for ${path}.`, undefined, error);
		case "permission_denied":
			return new V2ToolError("PERMISSION_DENIED", `Permission denied while resolving ${path}.`, undefined, error);
		default:
			return new V2ToolError("INVALID_INPUT", `Could not resolve ${path}: ${error.message}`, undefined, error);
	}
}

async function canonicalExistingOrAncestor(
	env: ExecutionEnv,
	absolutePath: string,
	signal?: AbortSignal,
): Promise<{ canonicalPath: string; existingPath: string }> {
	let candidate: string | undefined = absolutePath;
	const suffix: string[] = [];
	while (candidate) {
		const canonical = await env.canonicalPath(candidate, signal);
		if (canonical.ok) {
			let rebuilt = canonical.value;
			for (const segment of suffix.reverse()) {
				const joined = await env.joinPath([rebuilt, segment], signal);
				if (!joined.ok) throw errorFromFile(joined.error, absolutePath);
				rebuilt = joined.value;
			}
			return { canonicalPath: rebuilt, existingPath: candidate };
		}
		if (canonical.error.code !== "not_found") throw errorFromFile(canonical.error, absolutePath);
		const parent = lexicalParent(candidate);
		if (!parent || parent === candidate) break;
		const child = candidate
			.replaceAll("\\", "/")
			.replace(/\/+$/, "")
			.slice(parent.replace(/\/$/, "").length + 1);
		suffix.push(child);
		candidate = parent;
	}
	throw new V2ToolError("NOT_FOUND", `No existing ancestor could be resolved for ${absolutePath}.`);
}

/**
 * Resolve and apply an optional workspace policy.
 * Pathname checks are best-effort and are not an adversarial filesystem boundary.
 */
export async function resolveWorkspacePath(
	env: ExecutionEnv,
	path: string,
	access: "read" | "write",
	policy?: WorkspacePolicy,
	signal?: AbortSignal,
): Promise<ResolvedWorkspacePath> {
	const absolute = await env.absolutePath(path, signal);
	if (!absolute.ok) throw errorFromFile(absolute.error, path);
	const resolved = await canonicalExistingOrAncestor(env, absolute.value, signal);
	if (!policy) return { absolutePath: absolute.value, canonicalPath: resolved.canonicalPath };

	if (!policy.followSymlinks) {
		const existingInfo = await env.fileInfo(resolved.existingPath, signal);
		const addressedExisting = normalizeComparablePath(resolved.existingPath);
		const canonicalExisting = await env.canonicalPath(resolved.existingPath, signal);
		if (
			(existingInfo.ok && existingInfo.value.kind === "symlink") ||
			(canonicalExisting.ok && normalizeComparablePath(canonicalExisting.value) !== addressedExisting)
		) {
			throw new V2ToolError(
				"SYMLINK_ESCAPE",
				`A symlink component is not allowed for ${path}. Use a non-symlink path or change the explicit policy.`,
				{ path },
			);
		}
	}

	const canonicalRoots: string[] = [];
	for (const root of policy.roots) {
		const absoluteRoot = await env.absolutePath(root, signal);
		if (!absoluteRoot.ok) throw errorFromFile(absoluteRoot.error, root);
		const canonicalRoot = await env.canonicalPath(absoluteRoot.value, signal);
		if (!canonicalRoot.ok) throw errorFromFile(canonicalRoot.error, root);
		canonicalRoots.push(canonicalRoot.value);
	}
	const outside = !canonicalRoots.some((root) => isWithinRoot(resolved.canonicalPath, root));
	const allowOutside = access === "read" ? policy.allowOutsideWorkspaceRead : policy.allowOutsideWorkspaceWrite;
	if (outside && !allowOutside) {
		throw new V2ToolError(
			"OUTSIDE_WORKSPACE",
			`${path} resolves outside the allowed workspace roots. Choose a path inside the workspace.`,
			{ path, canonicalPath: resolved.canonicalPath },
		);
	}
	return { absolutePath: absolute.value, canonicalPath: resolved.canonicalPath };
}
