import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";

export type ChildIsolationLevel = "tool-bounded" | "sandboxed";

export interface ChildRuntimeInvocation {
	command: string;
	args: readonly string[];
}

export interface TrustedSandboxLauncher {
	command: string;
	prefixArgs: readonly string[];
}

export interface PreparedChildInvocation {
	command: string;
	args: string[];
	isolationLevel: ChildIsolationLevel;
}

export interface PrivateChildRuntimeDirectory {
	rootDirectory: string;
	sessionDirectory: string;
	cleanup(): Promise<void>;
}

/** Create a process-private root and session directory. The caller owns their lifecycle and must invoke cleanup. */
export async function createPrivateChildRuntimeDirectory(
	parentDirectory: string = tmpdir(),
): Promise<PrivateChildRuntimeDirectory> {
	const rootDirectory = await mkdtemp(join(parentDirectory, "wj-pi-child-"));
	try {
		await chmod(rootDirectory, 0o700);
		const sessionDirectory = join(rootDirectory, "sessions");
		await mkdir(sessionDirectory, { mode: 0o700 });
		await chmod(sessionDirectory, 0o700);
		return {
			rootDirectory,
			sessionDirectory,
			async cleanup(): Promise<void> {
				await rm(rootDirectory, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await rm(rootDirectory, { recursive: true, force: true });
		throw error;
	}
}

function assertAbsoluteCommand(command: string, label: string): void {
	if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(command)) {
		throw new Error(`${label} contains control characters`);
	}
	if (!isAbsolute(command) && !win32.isAbsolute(command)) throw new Error(`${label} must be an absolute path`);
}

function assertChildArg(arg: string): void {
	if (arg.includes("\0")) throw new Error("Child argument contains a NUL byte");
}

function assertLauncherPrefixArg(arg: string): void {
	if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(arg)) {
		throw new Error("Sandbox launcher prefix contains control characters");
	}
}

/** Wrap a child invocation with an explicitly trusted sandbox executable without invoking a shell. */
export function wrapChildInvocation(
	child: ChildRuntimeInvocation,
	sandboxLauncher?: TrustedSandboxLauncher,
): PreparedChildInvocation {
	assertAbsoluteCommand(child.command, "Child command");
	for (const arg of child.args) assertChildArg(arg);
	if (!sandboxLauncher) {
		return { command: child.command, args: [...child.args], isolationLevel: "tool-bounded" };
	}

	assertAbsoluteCommand(sandboxLauncher.command, "Sandbox launcher command");
	for (const arg of sandboxLauncher.prefixArgs) assertLauncherPrefixArg(arg);
	return {
		command: sandboxLauncher.command,
		args: [...sandboxLauncher.prefixArgs, child.command, ...child.args],
		isolationLevel: "sandboxed",
	};
}
