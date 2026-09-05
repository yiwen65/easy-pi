import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { convertResponsesTools } from "../../ai/src/api/openai-responses-shared.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { fixture, materialize } from "./tool-profile-eval/v2-attribution/fixtures.ts";
import { bytes, contentFreeWrite, object } from "./tool-profile-eval/v2-attribution/metrics.ts";
import { createHost, protocol, sourceIdentity } from "./tool-profile-eval/v2-attribution/runner.ts";
import { stableHash } from "./tool-profile-eval/v2-bounded-real-eval.ts";

it("avoids contradictory Bash discovery guidance without changing the native-only prompt", () => {
	const native = buildSystemPrompt({ cwd: "/workspace", selectedTools: ["read", "bash", "edit", "write"] });
	const v2 = buildSystemPrompt({ cwd: "/workspace", selectedTools: ["search", "read", "edit", "bash"] });
	expect(native).toContain("Use bash for file operations like ls, rg, find");
	expect(v2).not.toContain("Use bash for file operations like ls, rg, find");
});

it("reduces fixed protocol bytes, not capabilities, without making provider requests", async () => {
	process.env.PI_HF_COMPACTION = "off";
	delete process.env.PI_EXPERIMENTAL;
	const requested = process.env.PI_V2_PROTOCOL_METRICS_DIR;
	const iteration = Number(process.env.PI_V2_PROTOCOL_METRICS_ITERATION ?? "1");
	if (![1, 2].includes(iteration)) throw new Error("invalid_iteration");
	if (requested && !/^\/tmp\/pi-v2-attribution-[A-Za-z0-9]+$/.test(requested)) throw new Error("invalid_metrics_root");
	const root = requested ? realpathSync(requested) : realpathSync(mkdtempSync(join(tmpdir(), "pi-protocol-cost-")));
	const cwd = join(root, "workspace");
	if (existsSync(cwd)) throw new Error("workspace_not_empty");
	const data = fixture("D-11");
	materialize(cwd, data);
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const host = await createHost(cwd, join(root, "agent"), data, "C", runtime);
	try {
		const snapshot = protocol(host);
		expect(snapshot.tools.map((tool) => tool.name)).toEqual(["search", "read", "edit", "bash"]);
		expect(snapshot.systemPrompt).toContain("Read supplied paths directly");
		expect(snapshot.systemPrompt).toContain("host approval and preimage checks still run");
		expect(snapshot.systemPrompt).toContain("explicit range only narrows it");
		expect(snapshot.systemPrompt).toContain("Never infer absence from partial");
		const converted = convertResponsesTools(snapshot.tools, { strict: null, supportsStrictMode: true });
		expect(bytes(converted)).toBeLessThan(9243);
		if (requested) {
			const previous = JSON.parse(readFileSync(join(root, "protocol-B.json"), "utf8")) as typeof snapshot;
			const frozen = JSON.parse(readFileSync(join(root, "freeze-AB.json"), "utf8")) as {
				protocolHashes: { B: string };
				identity: { runnerHash: string };
			};
			expect(stableHash(previous)).toBe(frozen.protocolHashes.B);
			const identity = sourceIdentity();
			expect(identity.runnerHash).toBe(frozen.identity.runnerHash);
			const oldTools = convertResponsesTools(previous.tools, { strict: null, supportsStrictMode: true });
			for (const name of ["read", "edit", "bash"])
				expect(snapshot.tools.find((tool) => tool.name === name)).toEqual(
					previous.tools.find((tool) => tool.name === name),
				);
			const before = { systemBytes: bytes(previous.systemPrompt), toolBytes: bytes(oldTools) };
			const after = { systemBytes: bytes(snapshot.systemPrompt), toolBytes: bytes(converted) };
			expect(after.systemBytes).toBeLessThan(before.systemBytes);
			const parameters = Object.fromEntries(
				converted.map((tool) => [object(tool)?.name, bytes(object(tool)?.parameters)]),
			);
			const metrics = {
				stage: "offline_candidate",
				iteration,
				providerRequests: 0,
				before,
				after,
				savedBytesPerRequest: before.systemBytes + before.toolBytes - after.systemBytes - after.toolBytes,
				parameterBytes: parameters,
				identity,
				protocolHash: stableHash(snapshot),
			};
			contentFreeWrite(join(root, `offline-C${iteration}.json`), metrics, true);
			console.log(JSON.stringify(metrics));
		}
	} finally {
		await host.close();
		rmSync(requested ? cwd : root, { recursive: true });
	}
});
