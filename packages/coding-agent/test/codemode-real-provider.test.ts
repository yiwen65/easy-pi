/** Manual, paid-model acceptance. Never activates just because credentials exist. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RUN = process.env.PI_REAL_MODEL_EVAL === "1";
const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const fixture = fileURLToPath(new URL("./fixtures/codemode-real-mcp.mjs", import.meta.url));
interface Event {
	type: string;
	toolName?: string;
	parentToolCallId?: string;
	isError?: boolean;
	result?: { details?: { calls?: Array<{ name: string; status: string }> } };
	message?: { role?: string; toolName?: string; details?: { calls?: Array<{ name: string; status: string }> } };
}

async function runProbe(
	prompt: string,
	inputs: Record<string, string>,
	check: (cwd: string, events: Event[]) => Promise<void>,
) {
	// All credential setup stays inside the explicitly gated test body.
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "epi-codemode-real-")));
	const agentDir = join(cwd, "agent");
	try {
		await mkdir(agentDir);
		const source = process.env.PI_AGENT_DIR ?? join(homedir(), ".epi", "agent");
		await symlink(join(source, "auth.json"), join(agentDir, "auth.json"));
		await symlink(join(source, "models.json"), join(agentDir, "models.json"));
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ transport: "sse", compaction: { enabled: false }, retry: { enabled: false } }),
		);
		await writeFile(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					rates: {
						command: process.execPath,
						args: [fixture, join(cwd, "mcp-audit.jsonl")],
						exposure: "deferred",
					},
				},
			}),
		);
		for (const [name, content] of Object.entries(inputs)) await writeFile(join(cwd, name), content);
		const args = [
			join(repo, "pi-test.sh"),
			"--mode",
			"json",
			"--print",
			"--no-session",
			"--provider",
			process.env.PI_REAL_CODEMODE_PROVIDER ?? "openai-codex",
			"--model",
			process.env.PI_REAL_CODEMODE_MODEL ?? "gpt-6.1-sol",
			"--thinking",
			process.env.PI_REAL_CODEMODE_EFFORT ?? "medium",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--no-prompt-templates",
			"--tools",
			"codemode,read,write,mcp__rates__*",
			prompt,
		];
		const env: NodeJS.ProcessEnv = { ...process.env, EASY_PI_CODING_AGENT_DIR: agentDir };
		delete env.PI_OFFLINE;
		const child = spawn("bash", args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const events: Event[] = [];
		let buffer = "";
		let stderrBytes = 0;
		let stdoutBytes = 0;
		let captureError: Error | undefined;
		let timedOut = false;
		const kill = (signal: NodeJS.Signals) => {
			if (child.pid) {
				try {
					process.kill(-child.pid, signal);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill("SIGKILL");
		}, 180_000);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (data: string) => {
			if (captureError) return;
			stdoutBytes += Buffer.byteLength(data);
			try {
				if (stdoutBytes > 8 * 1024 * 1024) throw new Error("CLI JSON output exceeded 8 MiB capture limit");
				buffer += data;
				for (;;) {
					const end = buffer.indexOf("\n");
					if (end < 0) break;
					const line = buffer.slice(0, end);
					buffer = buffer.slice(end + 1);
					if (line.trim()) events.push(JSON.parse(line) as Event);
				}
			} catch {
				captureError = new Error("CLI emitted invalid or oversized JSONL output");
				kill("SIGKILL");
			}
		});
		child.stderr.on("data", (data: Buffer) => {
			stderrBytes += data.length;
		});
		try {
			const code = await new Promise<number | null>((done, fail) => {
				child.once("error", fail);
				child.once("close", done);
			});
			if (captureError) throw captureError;
			if (buffer.trim()) events.push(JSON.parse(buffer) as Event);
			expect(timedOut, `CLI timeout; stderr bytes=${stderrBytes}`).toBe(false);
			expect(code, `CLI failed; stderr bytes=${stderrBytes}`).toBe(0);
			expect(events.some((event) => event.type === "tool_execution_start" && event.toolName === "codemode")).toBe(
				true,
			);
			expect(
				events.filter(
					(event) => event.type === "tool_execution_end" && event.toolName === "codemode" && event.isError,
				),
			).toEqual([]);
			expect(
				events
					.filter((event) => event.type === "tool_execution_start" && event.toolName !== "codemode")
					.every((event) => Boolean(event.parentToolCallId)),
			).toBe(true);
			await check(cwd, events);
		} finally {
			clearTimeout(timer);
			kill("SIGKILL");
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

function nestedCalls(events: Event[]) {
	return events.flatMap((event) =>
		event.type === "tool_execution_end" && event.toolName === "codemode" ? (event.result?.details?.calls ?? []) : [],
	);
}

describe.skipIf(!RUN)("codemode real-model source CLI acceptance", () => {
	it("batches reads, filters data and writes an independently verified artifact", async () => {
		const rows = [
			[
				{ amount: 3, keep: true },
				{ amount: 99, keep: false },
			],
			[{ amount: 8, keep: true }],
		];
		const expected = rows
			.flat()
			.filter((row) => row.keep)
			.reduce((sum, row) => sum + row.amount, 0);
		await runProbe(
			'Use codemode to read a.json and b.json in parallel, parse both arrays, sum amount only where keep is true, then write result.json containing only {"total":number}. Do not call read or write directly. Finish after writing.',
			{ "a.json": JSON.stringify(rows[0]), "b.json": JSON.stringify(rows[1]) },
			async (cwd, events) => {
				expect(JSON.parse(await readFile(join(cwd, "result.json"), "utf8"))).toEqual({ total: expected });
				expect(nestedCalls(events).filter((call) => call.name === "read" && call.status === "ok")).toHaveLength(2);
				expect(nestedCalls(events)).toContainEqual(expect.objectContaining({ name: "write", status: "ok" }));
			},
		);
	}, 200_000);

	it("retains successful reads when another input is missing", async () => {
		await runProbe(
			'Use codemode and Promise.allSettled to read present.txt and missing.txt. missing.txt intentionally does not exist. Write partial.json with exactly {"successful":["present.txt"],"failed":["missing.txt"]}. Keep successful results despite the failure. Do not call tools directly outside codemode.',
			{ "present.txt": "valid input" },
			async (cwd, events) => {
				expect(JSON.parse(await readFile(join(cwd, "partial.json"), "utf8"))).toEqual({
					successful: ["present.txt"],
					failed: ["missing.txt"],
				});
				expect(nestedCalls(events)).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ name: "read", status: "ok" }),
						expect.objectContaining({ name: "read", status: "error" }),
					]),
				);
			},
		);
	}, 200_000);

	it("discovers an undeclared MCP capability and uses its observed result", async () => {
		await runProbe(
			'Use codemode discovery helpers to find a tool that looks up the fictional ZED currency exchange rate. Inspect its schema, call it for ZED, and write rate.json containing exactly {"currency":"ZED","rate":number} using the actual returned rate. No external services. Do not call tools directly outside codemode.',
			{},
			async (cwd, events) => {
				const audit = (await readFile(join(cwd, "mcp-audit.jsonl"), "utf8"))
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { name: string; arguments: { currency: string } });
				expect(audit).toEqual([{ name: "lookup_rate", arguments: { currency: "ZED" } }]);
				expect(JSON.parse(await readFile(join(cwd, "rate.json"), "utf8"))).toEqual({ currency: "ZED", rate: 7 });
				expect(nestedCalls(events)).toContainEqual(
					expect.objectContaining({ name: "mcp__rates__lookup_rate", status: "ok" }),
				);
			},
		);
	}, 200_000);
});
