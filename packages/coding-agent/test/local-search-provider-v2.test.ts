import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSearchProviderV2 } from "../src/core/tools/local-search-provider-v2.ts";

describe("LocalSearchProviderV2", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = join(tmpdir(), `pi-v2-search-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "literal.ts"), "const value = 'a+b';\n");
	});

	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it("uses literal text search and substring file discovery", async () => {
		const provider = new LocalSearchProviderV2();
		const text = await provider.search({
			kind: "text",
			query: "a+b",
			path: cwd,
			regex: false,
			caseSensitive: true,
			hardLimit: 20,
		});
		expect(text.candidates).toEqual([
			{ kind: "text", path: "src/literal.ts", line: 1, text: "const value = 'a+b';" },
		]);

		const files = await provider.search({
			kind: "files",
			query: "literal",
			path: cwd,
			regex: false,
			caseSensitive: false,
			hardLimit: 20,
		});
		expect(files.candidates).toEqual([{ kind: "file", path: "src/literal.ts" }]);
	});
});
