import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateSessionEntries, parseSessionEntries, type SessionEntry } from "../../../src/core/session-manager.ts";
import { convertSessionToFixture } from "./corpus-converter.ts";

const user = { role: "user" as const, timestamp: 1 };

function syntheticEntries(): SessionEntry[] {
	return [
		{
			type: "message",
			id: "m-1",
			parentId: null,
			timestamp: "t",
			message: { ...user, content: "fix the parser at /src/parser.ts please" },
		},
		{
			type: "message",
			id: "m-2",
			parentId: "m-1",
			timestamp: "t",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "/src/parser.ts" } }],
				api: "anthropic-messages",
				provider: "faux",
				model: "m",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "m-3",
			parentId: "m-2",
			timestamp: "t",
			message: {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: `PARSER SOURCE v3.4.1\n${"code\n".repeat(800)}` }],
				isError: false,
				timestamp: 3,
			},
		},
		{
			type: "message",
			id: "m-4",
			parentId: "m-3",
			timestamp: "t",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "the bug is in the tokenizer" }],
				api: "anthropic-messages",
				provider: "faux",
				model: "m",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 4,
			},
		},
	];
}

describe("convertSessionToFixture", () => {
	it("converts synthetic entries: contract, events, deterministic atoms", () => {
		const fixture = convertSessionToFixture(syntheticEntries(), {
			name: "synthetic",
			constraints: ["Never break the parser"],
		});
		expect(fixture.contract.goal).toContain("fix the parser");
		expect(fixture.contract.constraints).toEqual(["Never break the parser"]);
		expect(fixture.events.length).toBeGreaterThanOrEqual(4);
		// T atom: tc-1 succeeded (from deterministic reducer, not heuristics).
		const tAtom = fixture.atoms.find((a) => a.kind === "T" && a.toolCallId === "tc-1");
		expect(tAtom?.expectToolState).toBe("succeeded");
		// F atom mined the exact path and version.
		expect(fixture.atoms.some((a) => a.kind === "F" && a.exact?.includes("/src/parser.ts"))).toBe(true);
		expect(fixture.atoms.some((a) => a.kind === "F" && a.exact?.includes("v3.4.1"))).toBe(true);
		// P atom always present.
		expect(fixture.atoms.some((a) => a.kind === "P")).toBe(true);
		// Big tool result produced a needle.
		expect(fixture.needleQueries.length).toBe(1);
		expect(fixture.needleQueries[0].mustFind).toContain("PARSER SOURCE");
	});

	it("is deterministic: same input produces identical fixture", () => {
		const a = convertSessionToFixture(syntheticEntries(), { name: "x" });
		const b = convertSessionToFixture(syntheticEntries(), { name: "x" });
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it("honors maxEntries truncation and goal override", () => {
		const fixture = convertSessionToFixture(syntheticEntries(), { name: "x", maxEntries: 2, goal: "custom goal" });
		expect(fixture.contract.goal).toBe("custom goal");
		expect(fixture.events).toHaveLength(2);
	});

	it("converts a real long session prefix (large-session.jsonl, 150 entries)", () => {
		const raw = readFileSync(join(__dirname, "../../fixtures/large-session.jsonl"), "utf-8");
		const parsed = parseSessionEntries(raw);
		migrateSessionEntries(parsed);
		const entries = parsed.filter((e): e is SessionEntry => e.type !== "session").slice(0, 150);
		const fixture = convertSessionToFixture(entries, { name: "large-150" });
		expect(fixture.events.length).toBeGreaterThan(100);
		expect(fixture.atoms.filter((a) => a.kind === "T").length).toBeGreaterThan(0);
		expect(fixture.contract.goal.length).toBeGreaterThan(0);
		// Deterministic on real data too.
		const again = convertSessionToFixture(entries, { name: "large-150" });
		expect(JSON.stringify(again)).toBe(JSON.stringify(fixture));
	});
});
