import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFindTool } from "../src/core/tools/find.ts";

/**
 * A stand-in for a pre-8.7.0 fd build: it rejects `--no-require-git` (it does not list it in
 * `--help` and would fail on the unknown argument) and answers every search with one result.
 */
const legacyFd = `#!/bin/sh
if [ "$1" = "--help" ]; then
	echo "fd 8.3.1"
	echo "USAGE: fd [FLAGS/OPTIONS] [<pattern>] [<path>...]"
	exit 0
fi
echo "found.txt"
`;

describe("find on an fd build without --no-require-git", () => {
	const tempDirs: string[] = [];
	const originalPath = process.env.PATH;

	afterEach(() => {
		process.env.PATH = originalPath;
		while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	it("searches without the flag and reports that .gitignore files outside repositories are not applied", async () => {
		const binDir = mkdtempSync(join(tmpdir(), "find-legacy-fd-"));
		const workDir = mkdtempSync(join(tmpdir(), "find-legacy-fd-work-"));
		tempDirs.push(binDir, workDir);
		const fdPath = join(binDir, "fd");
		writeFileSync(fdPath, legacyFd);
		chmodSync(fdPath, 0o755);
		process.env.PATH = `${binDir}:${originalPath ?? ""}`;

		const result = await createFindTool(workDir).execute("call", { pattern: "**/*.txt", path: workDir });
		const text = result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		expect(text).toContain("found.txt");
		expect(text).toContain("predates fd 8.7.0: .gitignore files outside git repositories are not applied");
	});
});
