import { EventEmitter } from "node:events";
import { execFile, spawnSync } from "child_process";
import type * as Fs from "fs";
import {
	appendFileSync,
	existsSync,
	type FSWatcher,
	mkdirSync,
	mkdtempSync,
	rmSync,
	unwatchFile,
	watchFile,
	writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let resolvedBranch = "main";

vi.mock("fs", async (original) => {
	const actual = await original<typeof Fs>();
	return { ...actual, watchFile: vi.fn(actual.watchFile), unwatchFile: vi.fn(actual.unwatchFile) };
});

vi.mock("child_process", () => ({
	execFile: vi.fn(
		(
			_command: string,
			args: readonly string[],
			_options: unknown,
			callback: (error: Error | null, stdout: string, stderr: string) => void,
		) => {
			if (args[1] === "symbolic-ref") {
				setTimeout(
					() =>
						callback(
							resolvedBranch ? null : new Error("detached"),
							resolvedBranch ? `${resolvedBranch}\n` : "",
							"",
						),
					0,
				);
				return;
			}
			setTimeout(() => callback(new Error("unsupported"), "", ""), 0);
		},
	),
	spawnSync: vi.fn((_command: string, args: readonly string[]) => {
		if (args[1] === "symbolic-ref") {
			return { status: resolvedBranch ? 0 : 1, stdout: resolvedBranch ? `${resolvedBranch}\n` : "", stderr: "" };
		}
		return { status: 1, stdout: "", stderr: "" };
	}),
}));

import { FooterDataProvider } from "../src/core/footer-data-provider.ts";
import * as fsWatch from "../src/utils/fs-watch.ts";

class TestWatcher extends EventEmitter implements FSWatcher {
	close(): void {
		this.removeAllListeners();
	}
	ref(): this {
		return this;
	}
	unref(): this {
		return this;
	}
}

function mockGitWatchers(): Map<string, FSWatcher> {
	const watchers = new Map<string, FSWatcher>();
	vi.spyOn(fsWatch, "watchWithErrorHandler").mockImplementation((path, listener, onError) => {
		const watcher = new TestWatcher();
		watcher.on("change", listener);
		watcher.on("error", onError);
		watchers.set(path, watcher);
		return watcher;
	});
	vi.mocked(watchFile).mockImplementation(() => new TestWatcher());
	vi.mocked(unwatchFile).mockImplementation(() => {});
	return watchers;
}

type WorktreeFixture = {
	worktreeDir: string;
	reftableDir: string;
};

function createPlainReftableRepo(tempDir: string): string {
	const repoDir = join(tempDir, "repo");
	mkdirSync(join(repoDir, ".git", "reftable"), { recursive: true });
	writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/.invalid\n");
	return repoDir;
}

function createPlainRepo(tempDir: string): string {
	const repoDir = join(tempDir, "repo");
	mkdirSync(join(repoDir, ".git"), { recursive: true });
	writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
	return repoDir;
}

function createReftableWorktree(tempDir: string): WorktreeFixture {
	const repoDir = join(tempDir, "repo");
	const commonGitDir = join(repoDir, ".git");
	const gitDir = join(commonGitDir, "worktrees", "src");
	const worktreeDir = join(tempDir, "worktree");
	const reftableDir = join(commonGitDir, "reftable");

	mkdirSync(gitDir, { recursive: true });
	mkdirSync(reftableDir, { recursive: true });
	mkdirSync(worktreeDir, { recursive: true });

	writeFileSync(join(worktreeDir, ".git"), `gitdir: ${gitDir}\n`);
	writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/.invalid\n");
	writeFileSync(join(gitDir, "commondir"), "../..\n");
	writeFileSync(join(reftableDir, "tables.list"), "0\n");

	return { worktreeDir, reftableDir };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
	const startedAt = Date.now();
	while (!condition()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("FooterDataProvider reftable branch detection", () => {
	let originalCwd: string;
	let tempDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "footer-data-provider-"));
		resolvedBranch = "main";
		vi.mocked(spawnSync).mockClear();
		vi.mocked(execFile).mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.mocked(watchFile).mockReset();
		vi.mocked(unwatchFile).mockReset();
		process.chdir(originalCwd);
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses HEAD directly in a regular repo from a nested directory", () => {
		const repoDir = createPlainRepo(tempDir);
		const nestedDir = join(repoDir, "src", "nested");
		mkdirSync(nestedDir, { recursive: true });
		process.chdir(nestedDir);

		const provider = new FooterDataProvider(nestedDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
		} finally {
			provider.dispose();
		}
	});

	it("resolves the branch via git when HEAD is .invalid in a reftable repo", () => {
		const repoDir = createPlainReftableRepo(tempDir);
		process.chdir(repoDir);

		const provider = new FooterDataProvider(repoDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
				"git",
				["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
				expect.objectContaining({
					cwd: expect.stringMatching(/repo$/),
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}),
			);
		} finally {
			provider.dispose();
		}
	});

	it("resolves the branch via git in a reftable-backed worktree", () => {
		const { worktreeDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
		} finally {
			provider.dispose();
		}
	});

	it("treats an unresolved .invalid reftable HEAD as detached", () => {
		const repoDir = createPlainReftableRepo(tempDir);
		process.chdir(repoDir);
		resolvedBranch = "";

		const provider = new FooterDataProvider(repoDir);
		try {
			expect(provider.getGitBranch()).toBe("detached");
		} finally {
			provider.dispose();
		}
	});

	it("does not notify listeners when reftable updates keep the same branch", async () => {
		vi.useFakeTimers();
		const watchers = mockGitWatchers();
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			vi.mocked(spawnSync).mockClear();
			const onBranchChange = vi.fn();
			provider.onBranchChange(onBranchChange);

			watchers.get(reftableDir)!.emit("change", "rename", "tables.list");
			await vi.advanceTimersByTimeAsync(501);

			expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
			expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
			expect(provider.getGitBranch()).toBe("main");
			expect(onBranchChange).not.toHaveBeenCalled();
		} finally {
			provider.dispose();
		}
	});

	it("debounces rapid reftable updates into a single async refresh", async () => {
		vi.useFakeTimers();
		const watchers = mockGitWatchers();
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			vi.mocked(execFile).mockClear();

			watchers.get(reftableDir)!.emit("change", "rename", "tables.list");
			await vi.advanceTimersByTimeAsync(250);
			watchers.get(join(reftableDir, "tables.list"))!.emit("change", "change", "tables.list");
			watchers.get(reftableDir)!.emit("change", "rename", "next.ref");
			await vi.advanceTimersByTimeAsync(249);
			expect(vi.mocked(execFile)).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(650);

			expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
		} finally {
			provider.dispose();
		}
	});

	it("updates the cached branch when the reftable directory changes", async () => {
		vi.useFakeTimers();
		const watchers = mockGitWatchers();
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			resolvedBranch = "foo";
			const onBranchChange = vi.fn();
			provider.onBranchChange(onBranchChange);

			watchers.get(reftableDir)!.emit("change", "rename", "tables.list");
			await vi.advanceTimersByTimeAsync(501);

			expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
			expect(provider.getGitBranch()).toBe("foo");
			expect(onBranchChange).toHaveBeenCalledTimes(1);
		} finally {
			provider.dispose();
		}
	});

	it("observes native reftable directory events in a worktree", async () => {
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			const providerWithInternals = provider as unknown as { reftableWatcher: FSWatcher | null };
			const nativeChange = vi.fn();
			expect(providerWithInternals.reftableWatcher).not.toBeNull();
			providerWithInternals.reftableWatcher!.on("change", nativeChange);

			// fs.watch has no ready event and immediate fixture writes can be missed.
			// Establish observed delivery separately; never retry the branch changes.
			const probePath = join(reftableDir, "watch-ready");
			const probe = setInterval(() => appendFileSync(probePath, "\n"), 10);
			try {
				await waitFor(() => nativeChange.mock.calls.some(([, filename]) => filename === "watch-ready"));
			} finally {
				clearInterval(probe);
				rmSync(probePath, { force: true });
			}
			const onBranchChange = vi.fn();
			provider.onBranchChange(onBranchChange);
			resolvedBranch = "foo";

			// A new file exercises the directory watcher, not tables.list polling. Native
			// event counts/timing are OS-dependent; debounce counts are tested above.
			writeFileSync(join(reftableDir, "next.ref"), "new reftable\n");
			await waitFor(() => nativeChange.mock.calls.some(([, filename]) => filename === "next.ref"));
			await waitFor(() => provider.getGitBranch() === "foo");
			expect(vi.mocked(execFile)).toHaveBeenCalled();
			expect(onBranchChange).toHaveBeenCalledTimes(1);

			// The first observed event establishes readiness before changing tables.list.
			resolvedBranch = "bar";
			writeFileSync(join(reftableDir, "tables.list"), "1\n");
			await waitFor(() => provider.getGitBranch() === "bar");
			expect(onBranchChange).toHaveBeenCalledTimes(2);
		} finally {
			provider.dispose();
		}
	});

	it("retries git watchers 5 seconds after an async fs.watch error", async () => {
		vi.useFakeTimers();
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);

		const provider = new FooterDataProvider(repoDir);
		try {
			const providerWithInternals = provider as unknown as {
				headWatcher: FSWatcher | null;
			};
			const originalWatcher = providerWithInternals.headWatcher;
			expect(originalWatcher).not.toBeNull();
			expect(originalWatcher?.listenerCount("error")).toBeGreaterThan(0);

			originalWatcher?.emit("error", new Error("simulated EMFILE"));
			expect(providerWithInternals.headWatcher).toBeNull();

			await vi.advanceTimersByTimeAsync(4999);
			expect(providerWithInternals.headWatcher).toBeNull();

			await vi.advanceTimersByTimeAsync(1);
			expect(providerWithInternals.headWatcher).not.toBeNull();
			expect(providerWithInternals.headWatcher).not.toBe(originalWatcher);
		} finally {
			provider.dispose();
			vi.useRealTimers();
		}
	});
});
