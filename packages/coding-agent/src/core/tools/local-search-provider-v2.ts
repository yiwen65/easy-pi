import type {
	SearchCandidate,
	SearchProvider,
	SearchProviderResult,
	SearchRequest,
} from "@earendil-works/pi-agent-core";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

function parseTextCandidates(output: string): SearchCandidate[] {
	const candidates: SearchCandidate[] = [];
	for (const line of output.split("\n")) {
		const match = /^(.*?):(\d+):\s?(.*)$/.exec(line);
		if (!match) continue;
		candidates.push({ kind: "text", path: match[1], line: Number(match[2]), text: match[3] });
	}
	return candidates;
}

/** Local rg/fd-backed provider for the v2 model-visible search tool. */
export class LocalSearchProviderV2 implements SearchProvider {
	async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchProviderResult> {
		if (request.kind === "text") {
			const definition = createGrepTool(request.path);
			const result = await definition.execute(
				"v2-search",
				{
					pattern: request.query,
					path: ".",
					glob: request.glob,
					ignoreCase: !request.caseSensitive,
					literal: !request.regex,
					limit: request.hardLimit,
				},
				signal,
			);
			return {
				candidates: parseTextCandidates(textContent(result)),
				truncated:
					result.details?.matchLimitReached !== undefined || result.details?.truncation?.truncated === true,
			};
		}

		const definition = createFindTool(request.path);
		const result = await definition.execute(
			"v2-search",
			{ pattern: request.glob ?? "**/*", path: ".", limit: Math.max(request.hardLimit * 20, 1000) },
			signal,
		);
		const needle = request.caseSensitive ? request.query : request.query.toLowerCase();
		const candidates = textContent(result)
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("[") && !line.endsWith("/"))
			.filter((path) => (request.caseSensitive ? path : path.toLowerCase()).includes(needle))
			.slice(0, request.hardLimit)
			.map((path): SearchCandidate => ({ kind: "file", path }));
		return {
			candidates,
			truncated:
				result.details?.resultLimitReached !== undefined ||
				result.details?.truncation?.truncated === true ||
				candidates.length >= request.hardLimit,
		};
	}

	async cleanup(): Promise<void> {}
}
