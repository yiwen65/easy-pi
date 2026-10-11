import { type Static, Type } from "typebox";
import { AgentToolError } from "../../types.ts";
import type { AgentHarnessTool } from "../types.ts";
import { getOrThrow } from "../types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToolPath } from "./path-utils.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export function createWriteTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof writeSchema,
	undefined
> {
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: writeSchema,
		async execute(_toolCallId, { path, content }, signal, _onUpdate, { env }) {
			let mutationStarted = false;
			try {
				const absolutePath = await resolveToolPath(env, path, signal);
				return await withFileMutationQueue(env, absolutePath, async () => {
					if (signal?.aborted) throw new Error("Operation aborted");
					// The backend may create parent directories before writing the target.
					mutationStarted = true;
					getOrThrow(await env.writeFile(absolutePath, content, signal));
					// A fulfilled target write is acknowledged, even if cancellation arrived meanwhile.
					return {
						content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
						details: undefined,
					};
				});
			} catch (error) {
				if (mutationStarted) throw error;
				throw new AgentToolError(error instanceof Error ? error.message : String(error), undefined, {
					executionOutcome: "not_started",
				});
			}
		},
	};
}
