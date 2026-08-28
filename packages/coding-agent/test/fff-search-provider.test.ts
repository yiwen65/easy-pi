import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchRequest } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FffSearchProvider } from "../src/core/tools/fff-search-provider.ts";

function request(overrides: Partial<SearchRequest>): SearchRequest {
	return {
		kind: "files",
		query: "authservice",
		path: ".",
		case: "smart",
		regex: false,
		context: 0,
		limit: 20,
		ranking: "fast",
		...overrides,
	};
}

describe("FffSearchProvider", () => {
	let cwd: string;
	let provider: FffSearchProvider;

	beforeEach(() => {
		cwd = join(tmpdir(), `pi-fff-search-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "AuthenticationService.ts"), "export const authMarker = true;\n");
		writeFileSync(join(cwd, "src", "other.ts"), "export const other = true;\n");
		provider = new FffSearchProvider(new NodeExecutionEnv({ cwd }));
	});

	afterEach(async () => {
		await provider.close();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("uses the verified native index for opt-in fuzzy file search", async () => {
		const page = await provider.search(request({ query: "authentcationservice", path: cwd }), {
			workspaceRoot: cwd,
			scopeId: "fff-test",
		});
		expect(page.hits[0]).toMatchObject({
			kind: "file",
			path: "src/AuthenticationService.ts",
			pathKind: "file",
		});
	});

	it("routes text search through the direct structured local provider", async () => {
		const page = await provider.search(request({ kind: "text", query: "authMarker", path: cwd, ranking: "fast" }), {
			workspaceRoot: cwd,
			scopeId: "fff-test",
		});
		expect(page.hits).toMatchObject([
			{ kind: "text", path: "src/AuthenticationService.ts", line: 1, text: "export const authMarker = true;" },
		]);
	});
});
