import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { summarize } from "./metrics.mjs";

for (const directory of process.argv.slice(2)) {
	const path = join(directory, "summary.json");
	if (!existsSync(path)) throw Error(`Missing summary: ${directory}`);
	const { samples } = JSON.parse(readFileSync(path, "utf8"));
	const codes = {};
	for (const folder of readdirSync(directory)) {
		const trace = join(directory, folder, "trace.jsonl");
		if (!existsSync(trace)) continue;
		for (const line of readFileSync(trace, "utf8").trim().split("\n")) {
			if (!line) continue;
			const event = JSON.parse(line);
			if (event.kind !== "tool") continue;
			for (const code of [event.details?.code, ...(event.details?.actions ?? []).map((action) => action.code)]) {
				if (code) codes[code] = (codes[code] ?? 0) + 1;
			}
		}
	}
	console.log(
		JSON.stringify(
			{
				directory,
				...summarize(samples),
				codes,
				rows: samples.map((row) => ({
					id: row.id,
					passed: row.passed,
					taskMs: row.taskMs,
					modelMs: row.modelMs,
					toolMs: row.toolMs,
					calls: row.calls.length,
					turns: row.turns,
					cost: row.cost,
					cleanup: row.cleanup,
				})),
			},
			null,
			2,
		),
	);
}
