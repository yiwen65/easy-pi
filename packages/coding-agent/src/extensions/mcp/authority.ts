import type { ToolAccess } from "../../core/extensions/types.ts";
import { createToolNameMatcher, mcpNamespace } from "../../core/mcp-servers.ts";

const RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

/** Glob NFA after a known tool-name prefix. Only `*` has wildcard meaning. */
function statesAfterPrefix(pattern: string, prefix: string): Set<number> {
	const close = (states: Set<number>) => {
		for (const index of states) if (pattern[index] === "*") states.add(index + 1);
		return states;
	};
	let states = close(new Set([0]));
	for (const char of prefix) {
		const next = new Set<number>();
		for (const index of states) {
			if (pattern[index] === "*") next.add(index);
			else if (pattern[index] === char) next.add(index + 1);
		}
		states = close(next);
		if (states.size === 0) break;
	}
	return states;
}

/** Prove unreachability before connecting; unknown remote tool names are not authorization. */
export function canReachMcpServer(server: string, access: ToolAccess | undefined, resourcesAllowed: boolean): boolean {
	if (!access) return true;
	const excluded = createToolNameMatcher(access.excluded ?? []);
	const allowed = access.allowlist === undefined ? () => true : createToolNameMatcher(access.allowlist);
	if (resourcesAllowed && RESOURCE_TOOLS.some((name) => allowed(name) && !excluded(name))) return true;
	// Long tool names retain 55 characters before an 8-character hash; do not falsely
	// reject a server whose long namespace itself gets shortened in provider tool names.
	const prefix = `${mcpNamespace(server)}__`.slice(0, 55);
	const excludesAll = (access.excluded ?? []).some((pattern) => {
		const states = statesAfterPrefix(pattern, prefix);
		return [...states].some((index) => pattern.slice(index).length > 0 && /^\*+$/.test(pattern.slice(index)));
	});
	if (excludesAll) return false;
	if (access.allowlist === undefined) return true;
	return access.allowlist.some((pattern) => {
		if (/[^A-Za-z0-9_*]/.test(pattern)) return false;
		if (!pattern.includes("*") && excluded(pattern)) return false;
		return statesAfterPrefix(pattern, prefix).size > 0;
	});
}
