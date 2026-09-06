import { appendFile, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createExternalMutationJournal,
	ExternalMutationJournalReader,
	ExternalMutationJournalWriter,
	readExternalMutationJournal,
} from "../src/external-mutation-journal.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function journal() {
	const handle = await createExternalMutationJournal({
		runId: "run-1",
		taskId: "publish",
		attemptId: "attempt-1",
		attemptNumber: 1,
	});
	temporaryPaths.push(dirname(handle.policy.path));
	return handle;
}

describe("External mutation journal", () => {
	it("lets a live reader consume the complete prefix while an append has an unterminated tail", async () => {
		const handle = await journal();
		const targetRoot = await mkdtemp(join(tmpdir(), "wj-external-journal-target-"));
		temporaryPaths.push(targetRoot);
		const target = join(targetRoot, "published.txt");
		await writeFile(target, "published\n");
		const writer = new ExternalMutationJournalWriter(handle.policy);
		const mutation = writer.authorize("write-1", "write", target, 10);
		const observation = JSON.stringify({
			journalVersion: 1,
			journalSequence: 2,
			type: "observed",
			mutationId: mutation.mutationId,
			toolResult: "succeeded",
			observedAt: 11,
			postState: {
				status: "confirmed",
				fileType: "regular",
				size: 10,
				mode: 0o600,
				modifiedAtMs: 12,
				sha256: "a".repeat(64),
			},
		});
		const split = Math.floor(observation.length / 2);
		await appendFile(handle.policy.path, observation.slice(0, split));

		const delivered: string[] = [];
		const reader = new ExternalMutationJournalReader(handle.policy);
		expect(reader.drain((event) => delivered.push(event.type))).toBe(1);
		expect(delivered).toEqual(["authorized"]);
		expect(() => readExternalMutationJournal(handle.policy)).toThrow("incomplete record");

		await appendFile(handle.policy.path, `${observation.slice(split)}\n`);
		expect(reader.drain((event) => delivered.push(event.type))).toBe(2);
		expect(delivered).toEqual(["authorized", "observed"]);
	});

	it("permanently blocks new authorizations after an append failure", async () => {
		const handle = await journal();
		const targetRoot = await mkdtemp(join(tmpdir(), "wj-external-journal-target-"));
		temporaryPaths.push(targetRoot);
		const target = join(targetRoot, "published.txt");
		await writeFile(target, "published\n");
		const writer = new ExternalMutationJournalWriter(handle.policy);

		await unlink(handle.policy.path);
		await mkdir(handle.policy.path);
		expect(() => writer.authorize("write-1", "write", target, 10)).toThrow();
		await rm(handle.policy.path, { recursive: true, force: true });
		await writeFile(handle.policy.path, "", { mode: 0o600 });

		expect(() => writer.authorize("write-2", "write", target, 11)).toThrow("unusable after an append failure");
		expect(readExternalMutationJournal(handle.policy)).toEqual([]);
	});

	it("rejects a reused tool-call identity before another mutation can be authorized", async () => {
		const handle = await journal();
		const targetRoot = await mkdtemp(join(tmpdir(), "wj-external-journal-target-"));
		temporaryPaths.push(targetRoot);
		const target = join(targetRoot, "published.txt");
		await writeFile(target, "published\n");
		const writer = new ExternalMutationJournalWriter(handle.policy);
		writer.authorize("write-1", "write", target, 10);
		await writer.observe("write-1", "succeeded", 11);

		expect(() => writer.authorize("write-1", "edit", target, 12)).toThrow("already been authorized");
		expect(() => new ExternalMutationJournalWriter(handle.policy).authorize("write-1", "edit", target, 12)).toThrow(
			"already been authorized",
		);
	});
});
