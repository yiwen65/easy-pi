import { isAbsolute } from "node:path";
import { isCodemodeTool } from "../extensions/codemode/tool.ts";
import { createInheritedMcpExtension } from "../extensions/mcp/index.ts";
import type { AgentSession } from "./agent-session.ts";
import { createEventBus } from "./event-bus.ts";
import { loadExtensionFromFactory, recreateExtension } from "./extensions/loader.ts";
import type { Extension, ExtensionRuntime, ToolDefinition } from "./extensions/types.ts";

/** Fresh session bindings; never reuse a parent's AgentTool wrappers or captured pi runtime. */
export async function recreateSideToolExtensions(
	parent: AgentSession,
	inherited: ReadonlySet<string>,
	runtime: ExtensionRuntime,
): Promise<{ extensions: Extension[]; customTools: ToolDefinition[] }> {
	const cwd = parent.sessionManager.getCwd();
	const eventBus = createEventBus();
	const source = parent.resourceLoader.getExtensions();
	for (const [name, value] of source.runtime.flagValues) runtime.flagValues.set(name, value);
	const extensions: Extension[] = [];
	for (const original of source.extensions) {
		const owned = [...original.tools.values()].filter(
			({ definition }) => inherited.has(definition.name) && parent.getToolDefinition(definition.name) === definition,
		);
		if (!owned.length || owned.every(({ definition }) => isCodemodeTool(definition))) {
			// Keep approved file paths available to the normal child host without sharing
			// parent handlers. Live root policy is forwarded separately for this side.
			if (isAbsolute(original.path))
				extensions.push({
					path: original.path,
					resolvedPath: original.resolvedPath,
					sourceInfo: original.sourceInfo,
					handlers: new Map(),
					tools: new Map(),
					messageRenderers: new Map(),
					commands: new Map(),
					flags: new Map(),
					shortcuts: new Map(),
				});
			continue;
		}
		const extension =
			original.path === "<inline:mcp>"
				? await loadExtensionFromFactory(
						createInheritedMcpExtension(parent.sessionManager),
						cwd,
						eventBus,
						runtime,
						original.path,
					)
				: await recreateExtension(original, cwd, eventBus, runtime);
		if (owned.some(({ definition }) => isCodemodeTool(definition))) extension.tools.delete("codemode");
		extensions.push(extension);
	}
	// SDK definitions are explicitly host-owned functions. Their fifth argument is rebound;
	// arbitrary external state captured by an embedding cannot be cloned automatically.
	const customTools = parent.getAllTools().flatMap((tool) => {
		if (tool.sourceInfo.source !== "sdk" || !inherited.has(tool.name) || isCodemodeTool(tool)) return [];
		const definition = parent.getToolDefinition(tool.name);
		return definition ? [definition] : [];
	});
	return { extensions, customTools };
}
