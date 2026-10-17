import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("missing-target mutation queue identity (F14)", () => {
	it.each([false, true])("serializes aliases across absent target creation (create=%s)", async (create) => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-missing-alias-"));
		const real = join(cwd, "real");
		const alias = join(cwd, "alias");
		await mkdir(real);
		await symlink(real, alias, "dir");
		const entered = deferred();
		const release = deferred();
		let active = 0;
		let maxActive = 0;
		const first = withFileMutationQueue(join(alias, "missing", "file"), async () => {
			maxActive = Math.max(maxActive, ++active);
			if (create) {
				await mkdir(join(real, "missing"));
				await writeFile(join(real, "missing", "file"), "created");
			}
			entered.resolve();
			await release.promise;
			active--;
		});
		await entered.promise;
		const second = withFileMutationQueue(join(real, "missing", "file"), async () => {
			maxActive = Math.max(maxActive, ++active);
			active--;
		});
		try {
			// A different file proves the preceding registration finished while first still owns its key.
			await withFileMutationQueue(join(cwd, "sentinel"), async () => {});
			expect(maxActive).toBe(1);
		} finally {
			release.resolve();
			await Promise.all([first, second]);
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
