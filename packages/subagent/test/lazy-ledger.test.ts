import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { RunLedger } from "../src/ledger.ts";

test("unused product ledger creates no files, including on shutdown", () => {
	const root = mkdtempSync(join(tmpdir(), "easy-pi-ledger-"));
	try {
		const path = join(root, "subagent", "state.sqlite");
		const ledger = new RunLedger(path, { lazy: true });
		expect(existsSync(path)).toBe(false);
		ledger.close();
		ledger.close();
		expect(existsSync(join(root, "subagent"))).toBe(false);
		expect(() => ledger.listDagRuns()).toThrow(/closed/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("first ledger access initializes the schema and then closes normally", () => {
	const root = mkdtempSync(join(tmpdir(), "easy-pi-ledger-"));
	try {
		const path = join(root, "state.sqlite");
		const ledger = new RunLedger(path, { lazy: true });
		expect(ledger.listDagRuns()).toEqual([]);
		expect(existsSync(path)).toBe(true);
		ledger.close();
		const reopened = new RunLedger(path);
		expect(reopened.listDagRuns()).toEqual([]);
		reopened.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
