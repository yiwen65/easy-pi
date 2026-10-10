import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { BashResult } from "../../../src/core/bash-executor.ts";
import type { ExtensionError, UserBashEvent, UserBashEventResult } from "../../../src/core/extensions/types.ts";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

// Regression for #9068. The real runner and mode routing execute, but shell execution and RPC I/O do not.
const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => rpcIo.outputLines.push(line),
}));

vi.mock("../../../src/modes/interactive/components/bash-execution.ts", () => ({
	BashExecutionComponent: class {
		appendOutput(): void {}
		setComplete(): void {}
	},
}));

vi.mock("../../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];
type ListenerSnapshot = {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
};

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] =
		process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) process.stdin.off("end", listener);
	}
	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) process.off(signal, listener);
		}
	}
}

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const localResult: BashResult = { output: "local output", exitCode: 0, cancelled: false, truncated: false };
const handledResult: BashResult = { output: "handled output", exitCode: 0, cancelled: false, truncated: false };
const operations: BashOperations = {
	exec: vi.fn(async () => ({ exitCode: 0 })),
};

type BashCase = {
	name: string;
	handle(): unknown;
	error?: string;
	executeCount: number;
	operations?: BashOperations;
	result?: BashResult;
};

const bashCases: BashCase[] = [
	{
		name: "a thrown routing error",
		handle: () => {
			throw new Error("Routing failed");
		},
		error: "Routing failed",
		executeCount: 0,
	},
	...[
		["an empty object", {}],
		["null", null],
		["false", false],
		["invalid operations", { operations: {} }],
		["an incomplete result", { result: { output: "handled" } }],
		["both overrides", { operations, result: handledResult }],
	].map(
		([name, value]): BashCase => ({
			name: String(name),
			handle: () => value,
			error: "Invalid user_bash handler result",
			executeCount: 0,
		}),
	),
	{ name: "undefined", handle: () => undefined, executeCount: 1 },
	{ name: "valid operations", handle: () => ({ operations }), executeCount: 1, operations },
	{ name: "a completed result", handle: () => ({ result: handledResult }), executeCount: 0, result: handledResult },
];

async function createBashHarness(bashCase: BashCase) {
	const events: UserBashEvent[] = [];
	const sameExtension = vi.fn();
	const nextExtension = vi.fn();
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("user_bash", async (event) => {
					events.push(event);
					return bashCase.handle() as UserBashEventResult | undefined;
				});
				pi.on("user_bash", () => {
					sameExtension();
				});
			},
			(pi) => {
				pi.on("user_bash", () => {
					nextExtension();
				});
			},
		],
	});
	const executeBash = vi.spyOn(harness.session, "executeBash").mockResolvedValue(localResult);
	const recordBashResult = vi.spyOn(harness.session, "recordBashResult");
	return { harness, events, sameExtension, nextExtension, executeBash, recordBashResult };
}

function expectPropagation(bash: Awaited<ReturnType<typeof createBashHarness>>, bashCase: BashCase): void {
	const count = bashCase.name === "undefined" ? 1 : 0;
	expect(bash.sameExtension).toHaveBeenCalledTimes(count);
	expect(bash.nextExtension).toHaveBeenCalledTimes(count);
	expect(bash.executeBash).toHaveBeenCalledTimes(bashCase.executeCount);
	expect(bash.recordBashResult).toHaveBeenCalledTimes(bashCase.result ? 1 : 0);
	expect(operations.exec).not.toHaveBeenCalled();
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

afterEach(() => {
	vi.restoreAllMocks();
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;
});

describe("RPC user_bash routing (#9068)", () => {
	test.each(bashCases)("handles $name without unsafe fallback", async (bashCase) => {
		const listeners = takeListenerSnapshot();
		const bash = await createBashHarness(bashCase);
		try {
			void runRpcMode(createRuntimeHost(bash.harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			if (!rpcIo.lineHandler) throw new Error("RPC line handler is not attached");
			rpcIo.lineHandler(
				JSON.stringify({ id: "bash-request", type: "bash", command: "pwd", excludeFromContext: true }),
			);
			await vi.waitFor(() => {
				const response = parseOutputLines().find(
					(output) => output.type === "response" && output.id === "bash-request",
				);
				expect(response).toMatchObject({
					id: "bash-request",
					type: "response",
					command: "bash",
					success: bashCase.error === undefined,
					...(bashCase.error
						? { error: expect.stringContaining(bashCase.error) }
						: { data: bashCase.result ?? localResult }),
				});
			});
			const errors = parseOutputLines().filter((output) => output.type === "extension_error");
			if (bashCase.error) {
				expect(errors).toMatchObject([{ event: "user_bash", error: expect.stringContaining(bashCase.error) }]);
			} else {
				expect(errors).toEqual([]);
			}
			expect(bash.events).toEqual([
				{ type: "user_bash", command: "pwd", excludeFromContext: true, cwd: bash.harness.sessionManager.getCwd() },
			]);
			expectPropagation(bash, bashCase);
			if (bashCase.executeCount) {
				expect(bash.executeBash).toHaveBeenCalledWith("pwd", undefined, {
					excludeFromContext: true,
					id: "bash-request",
					operations: bashCase.operations,
				});
			}
			if (bashCase.result) {
				expect(bash.recordBashResult).toHaveBeenCalledWith("pwd", bashCase.result, { excludeFromContext: true });
			}
		} finally {
			bash.harness.cleanup();
			restoreListeners(listeners);
		}
	});
});

type InteractiveBashContext = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> | void };
	editor: { addToHistory?: (text: string) => void };
	session: Harness["session"];
	sessionManager: Harness["sessionManager"];
	ui: { requestRender(): void };
	chatContainer: { addChild(component: unknown): void };
	pendingMessagesContainer: { addChild(component: unknown): void };
	pendingBashComponents: unknown[];
	bashComponent?: unknown;
	isBashMode: boolean;
	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void>;
	showError(message: string): void;
	updateEditorBorderColor(): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	setupEditorSubmitHandler(this: InteractiveBashContext): void;
	handleBashCommand(this: InteractiveBashContext, command: string, excludeFromContext?: boolean): Promise<void>;
};

describe.each([
	["!pwd", false],
	["!!pwd", true],
] as const)("Interactive user_bash routing for %s (#9068)", (input, excludeFromContext) => {
	test.each(bashCases)("handles $name without unsafe fallback", async (bashCase) => {
		const bash = await createBashHarness(bashCase);
		const errors: ExtensionError[] = [];
		const unsubscribe = bash.harness.session.extensionRunner.onError((error) => errors.push(error));
		const context: InteractiveBashContext = {
			defaultEditor: {},
			editor: { addToHistory: vi.fn() },
			session: bash.harness.session,
			sessionManager: bash.harness.sessionManager,
			ui: { requestRender: vi.fn() },
			chatContainer: { addChild: vi.fn() },
			pendingMessagesContainer: { addChild: vi.fn() },
			pendingBashComponents: [],
			isBashMode: true,
			handleBashCommand: interactiveModePrototype.handleBashCommand,
			showError: vi.fn(),
			updateEditorBorderColor: vi.fn(),
		};
		interactiveModePrototype.setupEditorSubmitHandler.call(context);
		try {
			await expect(context.defaultEditor.onSubmit?.(input)).resolves.toBeUndefined();
			expect(bash.events).toEqual([
				{ type: "user_bash", command: "pwd", excludeFromContext, cwd: bash.harness.sessionManager.getCwd() },
			]);
			expectPropagation(bash, bashCase);
			if (bashCase.error) {
				expect(errors).toMatchObject([{ event: "user_bash", error: expect.stringContaining(bashCase.error) }]);
				expect(context.chatContainer.addChild).not.toHaveBeenCalled();
			} else {
				expect(errors).toEqual([]);
				expect(context.chatContainer.addChild).toHaveBeenCalledOnce();
			}
			if (bashCase.executeCount) {
				expect(bash.executeBash).toHaveBeenCalledWith("pwd", expect.any(Function), {
					excludeFromContext,
					operations: bashCase.operations,
				});
			}
			if (bashCase.result) {
				expect(bash.recordBashResult).toHaveBeenCalledWith("pwd", bashCase.result, { excludeFromContext });
			}
			expect(context.showError).not.toHaveBeenCalled();
			expect(context.isBashMode).toBe(false);
			expect(context.bashComponent).toBeUndefined();
			expect(context.updateEditorBorderColor).toHaveBeenCalledOnce();
			expect(context.pendingBashComponents).toEqual([]);
		} finally {
			unsubscribe();
			bash.harness.cleanup();
		}
	});
});
