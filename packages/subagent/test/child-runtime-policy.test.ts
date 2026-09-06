import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPrivateChildRuntimeDirectory, wrapChildInvocation } from "../src/child-runtime-policy.ts";

describe("private child runtime directory", () => {
	it("creates private root and session directories and cleans them up idempotently", async () => {
		const testParent = await mkdtemp(join(tmpdir(), "wj-pi-child-policy-test-"));
		try {
			const runtimeDirectory = await createPrivateChildRuntimeDirectory(testParent);

			expect(runtimeDirectory.rootDirectory.startsWith(`${testParent}/`)).toBe(true);
			expect(runtimeDirectory.sessionDirectory).toBe(join(runtimeDirectory.rootDirectory, "sessions"));
			expect((await stat(runtimeDirectory.rootDirectory)).mode & 0o777).toBe(0o700);
			expect((await stat(runtimeDirectory.sessionDirectory)).mode & 0o777).toBe(0o700);

			await runtimeDirectory.cleanup();
			await runtimeDirectory.cleanup();
			await expect(access(runtimeDirectory.rootDirectory)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(testParent, { recursive: true, force: true });
		}
	});
});

describe("trusted sandbox launcher policy", () => {
	it("returns an isolated direct invocation as tool-bounded", () => {
		const args = ["child.js", "--print"];
		const invocation = wrapChildInvocation({ command: "/usr/bin/node", args });

		expect(invocation).toEqual({
			command: "/usr/bin/node",
			args: ["child.js", "--print"],
			isolationLevel: "tool-bounded",
		});
		args.push("--mutated");
		expect(invocation.args).toEqual(["child.js", "--print"]);
	});

	it("wraps the real child command and args behind a trusted sandbox prefix", () => {
		const childArgs = ["child.js", "--print", "prompt\ncontent"];
		const prefixArgs = ["-f", "/tmp/child.sb", "--"];
		const invocation = wrapChildInvocation(
			{ command: "/usr/bin/node", args: childArgs },
			{ command: "/usr/bin/sandbox-exec", prefixArgs },
		);

		expect(invocation).toEqual({
			command: "/usr/bin/sandbox-exec",
			args: ["-f", "/tmp/child.sb", "--", "/usr/bin/node", "child.js", "--print", "prompt\ncontent"],
			isolationLevel: "sandboxed",
		});
		childArgs.push("--mutated-child");
		prefixArgs.push("--mutated-prefix");
		expect(invocation.args).not.toContain("--mutated-child");
		expect(invocation.args).not.toContain("--mutated-prefix");
	});

	it("rejects relative commands and launcher argv injection", () => {
		expect(() => wrapChildInvocation({ command: "node", args: [] })).toThrow("absolute");
		expect(() =>
			wrapChildInvocation({ command: "/usr/bin/node", args: [] }, { command: "sandbox-exec", prefixArgs: [] }),
		).toThrow("absolute");
		expect(() =>
			wrapChildInvocation(
				{ command: "/usr/bin/node", args: [] },
				{ command: "/usr/bin/sandbox-exec", prefixArgs: ["--profile\n--disable-sandbox"] },
			),
		).toThrow("control characters");
		expect(() =>
			wrapChildInvocation(
				{ command: "/usr/bin/node", args: [] },
				{ command: "/usr/bin/sandbox-exec", prefixArgs: ["safe\u0000unsafe"] },
			),
		).toThrow("control characters");
		expect(() =>
			wrapChildInvocation(
				{ command: "/usr/bin/node", args: [] },
				{ command: "/usr/bin/sandbox-exec", prefixArgs: ["safe\u2028unsafe"] },
			),
		).toThrow("control characters");
	});
});
