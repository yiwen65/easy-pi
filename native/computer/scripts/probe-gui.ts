import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type * as CuaSdk from "@trycua/cua-driver";
import { type NativeCall, NativeComputerAdapter, type OwnedNativeDriver } from "../adapter.ts";
import { loadPinnedSdk } from "../loader.ts";

// Trusted, explicitly opted-in fixture host. This is not a ComputerBackend or an OS drain proof.
const tokenPattern = /^[A-Za-z0-9_-]{1,64}$/;
const nonceArgument = process.argv[7];
const nonce = nonceArgument && tokenPattern.test(nonceArgument) ? nonceArgument : "invalid";
const commands = ["preflight", "admit", "observe", "click", "cancel-observe", "ping", "stop", "close"] as const;
type Command = (typeof commands)[number];
type Fields = Record<string, string | number | boolean | readonly number[] | null | undefined>;
let sequence = 0;
let outputAvailable = true;

class ProbeFailure extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

function emit(event: string, fields: Fields = {}, id?: string): void {
	if (!outputAvailable) return;
	if (sequence >= Number.MAX_SAFE_INTEGER) throw new ProbeFailure("sequence_exhausted");
	process.stdout.write(
		`${JSON.stringify({
			...fields,
			event,
			nonce,
			pid: process.pid,
			seq: ++sequence,
			id,
			sdkSettlementOnly: true,
			osTerminalProven: false,
		})}\n`,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runHost(): void {
	if (process.env.ALLOW_GUI_TESTS !== "true" || process.env.ALLOW_REAL_APIS !== "false") {
		throw new ProbeFailure("opt_in_required");
	}
	const [sdkDirectory, manifestPath, arm, pidText, windowText] = process.argv.slice(2);
	if (
		process.argv.length !== 8 ||
		!sdkDirectory ||
		!isAbsolute(sdkDirectory) ||
		!manifestPath ||
		!isAbsolute(manifestPath) ||
		(arm !== "raw" && arm !== "adapter") ||
		!pidText ||
		!windowText ||
		!nonceArgument ||
		!tokenPattern.test(nonceArgument) ||
		!/^[1-9][0-9]{0,9}$/.test(pidText) ||
		!/^[1-9][0-9]{0,9}$/.test(windowText)
	) {
		throw new ProbeFailure("invalid_invocation");
	}
	const capabilityManifest = manifestPath;
	const fixturePid = Number(pidText);
	const fixtureWindowId = BigInt(windowText);
	if (fixturePid > 2_147_483_647 || fixtureWindowId > 4_294_967_295n) {
		throw new ProbeFailure("invalid_fixture_identity");
	}

	// The only SDK load. Requiring its absolute ESM core entry avoids the distinct CJS AbortError class.
	const sdk = loadPinnedSdk(sdkDirectory);
	const require = createRequire(pathToFileURL(join(realpathSync(sdkDirectory), "dist/native/node-runtime.js")));
	const coreEntry = realpathSync(require.resolve("@ubjs/core"));
	const core: unknown = require(join(dirname(dirname(dirname(coreEntry))), "dist/esm/index.js"));
	if (!isRecord(core) || !isRecord(core.UniffiInternalError)) throw new ProbeFailure("core_api_mismatch");
	const abortConstructor = core.UniffiInternalError.AbortError;
	if (typeof abortConstructor !== "function") throw new ProbeFailure("core_api_mismatch");
	const AbortError = abortConstructor;

	let stopped = false;
	let parsingStopped = false;
	let preflightAttempted = false;
	let preflightPassed = false;
	let admitAttempted = false;
	let admitted = false;
	let clickAttempted = false;
	let clickCompleted = false;
	let finalWork = false;
	let cancelObserveId: string | undefined;
	let cancelStopReceived = false;
	let explicitCloseRequested = false;
	let incrementToken: string | undefined;
	let adapter: NativeComputerAdapter | undefined;
	let rawOwner: OwnedNativeDriver | undefined;
	let opening: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	let cleanupId: string | undefined;
	let ordinary: { id: string; command: Command } | undefined;
	let active: { id: string; operation: string; call: NativeCall<unknown> } | undefined;
	let constructCalls = 0;
	let constructedOwners = 0;
	let shutdownPending = false;
	let shutdownStarts = 0;
	let shutdownFulfilled = 0;
	let destroys = 0;
	let authorizationRequests = 0;
	const ids = new Set<string>();
	const input: CuaSdk.GetWindowStateInput = {
		pid: fixturePid,
		windowId: fixtureWindowId,
		includeAccessibilityTree: true,
		includeScreenshot: false,
		maxElements: 64,
		maxDepth: 8,
	};

	function errorFields(error: unknown): Fields {
		if (error instanceof ProbeFailure) return { category: error.code };
		if (error instanceof AbortError) return { category: "ubjs_abort", matchingAbortClass: true };
		if (error instanceof Error && sdk.DriverError.instanceOf(error)) {
			return { category: "driver_error", tag: error.tag };
		}
		return { category: "unexpected_error" };
	}

	function latchStop(): void {
		stopped = true;
		incrementToken = undefined;
		active?.call.cancel();
	}

	function closeOnce(id?: string): Promise<void> {
		// Install the cached close before cancellation can reenter through a foreign callback.
		stopped = true;
		incrementToken = undefined;
		if (!closing) {
			cleanupId = id;
			const pending = active?.call.result;
			const admittedOpening = opening;
			closing = Promise.resolve().then(async () => {
				if (adapter) {
					await Promise.all([adapter.close(), Promise.allSettled([admittedOpening, pending])]);
				} else {
					await Promise.allSettled([admittedOpening, pending]);
					if (rawOwner) {
						await rawOwner.driver.shutdown();
						rawOwner.destroy();
						rawOwner = undefined;
					}
				}
			});
			// Stop may start close before the ordinary handler awaits its observed outcome.
			void closing.catch(() => {
				process.exitCode = 1;
			});
		}
		active?.call.cancel();
		return closing;
	}

	function closed(id?: string): void {
		emit("closed", { constructCalls, constructedOwners, shutdownStarts, shutdownFulfilled, destroys }, id);
	}

	function requestClose(id?: string): void {
		void closeOnce(id).then(
			() => closed(id),
			(error: unknown) => {
				process.exitCode = 1;
				emit("failed", { operation: "close", ...errorFields(error) }, id);
			},
		);
	}

	function fail(error: unknown, id?: string): void {
		process.exitCode = 1;
		latchStop();
		emit("failed", errorFields(error), id);
		requestClose(id);
	}

	function nativePromise<T>(operation: string, id: string | undefined, invoke: () => Promise<T>): Promise<T> {
		const started = performance.now();
		emit("dispatch", { operation }, id);
		const invocationStarted = performance.now();
		let promise: Promise<T>;
		try {
			promise = invoke();
		} catch (error) {
			emit("native-returned", { operation, synchronousMs: performance.now() - invocationStarted, threw: true }, id);
			throw error;
		}
		emit("native-returned", { operation, synchronousMs: performance.now() - invocationStarted, threw: false }, id);
		return promise.then(
			(value) => {
				emit("settlement", { operation, outcome: "fulfilled", durationMs: performance.now() - started }, id);
				return value;
			},
			(error: unknown) => {
				emit(
					"settlement",
					{ operation, outcome: "rejected", durationMs: performance.now() - started, ...errorFields(error) },
					id,
				);
				throw error;
			},
		);
	}

	const host: CuaSdk.DriverAuthorizationHost = {
		authorize: async (request) => {
			authorizationRequests++;
			const id = active?.id ?? ordinary?.id;
			emit("authorization", { requests: authorizationRequests, denied: true }, id);
			fail(new ProbeFailure("unexpected_authorization_request"), id);
			return { action: sdk.DriverAuthorizationAction.Deny, requestDigest: request.requestDigest };
		},
	};
	const observer: CuaSdk.DriverActivityObserver = {
		onActivity: (event) => {
			const safeMetadata = /^[A-Za-z0-9_.:-]{1,80}$/;
			if (
				!safeMetadata.test(event.toolName) ||
				(event.refusalCode !== undefined && !safeMetadata.test(event.refusalCode))
			) {
				fail(new ProbeFailure("invalid_activity_metadata"), active?.id ?? ordinary?.id);
				return;
			}
			emit(
				"activity",
				{ kind: event.kind, toolName: event.toolName, refusalCode: event.refusalCode },
				active?.id ?? ordinary?.id,
			);
		},
	};

	function createOwner(path: string): OwnedNativeDriver {
		const options: CuaSdk.ConfiguredDriverOptions = {
			claudeCodeCompatibility: false,
			authorization: {
				allowedModes: [sdk.SessionPermissionMode.Bounded],
				compatibilityMode: sdk.SessionPermissionMode.Bounded,
				compatibilityCapabilityManifestPath: path,
				unrestrictedAcknowledged: false,
				maxSessionTtlSeconds: 600n,
				maxIdleTtlSeconds: 120n,
			},
		};
		constructCalls++;
		const driver = sdk.CuaDriver.createConfiguredWithHostIntegrations(options, host, observer);
		constructedOwners++;
		return {
			driver: {
				getWindowState: (observation, asyncOptions) =>
					nativePromise(active?.operation ?? "observe", active?.id, () =>
						driver.getWindowState(observation, asyncOptions),
					),
				click: (click, asyncOptions) => nativePromise("click", active?.id, () => driver.click(click, asyncOptions)),
				shutdown: async () => {
					shutdownPending = true;
					shutdownStarts++;
					emit("shutdown-start", { count: shutdownStarts }, cleanupId);
					try {
						await nativePromise("shutdown", cleanupId, () => driver.shutdown());
						shutdownFulfilled++;
						emit("shutdown-settled", { outcome: "fulfilled", count: shutdownFulfilled }, cleanupId);
					} catch (error) {
						emit("shutdown-settled", { outcome: "rejected", ...errorFields(error) }, cleanupId);
						throw error;
					} finally {
						shutdownPending = false;
					}
				},
			},
			destroy: () => {
				if (!sdk.CuaDriver.instanceOf(driver)) throw new ProbeFailure("owner_identity_mismatch");
				driver.uniffiDestroy();
				destroys++;
				emit("destroy", { count: destroys }, cleanupId);
			},
		};
	}

	async function admit(id: string): Promise<void> {
		if (arm === "adapter") {
			const missingPath = `${capabilityManifest}.missing`;
			if (existsSync(missingPath)) throw new ProbeFailure("missing_manifest_not_absent");
			adapter = new NativeComputerAdapter(() => createOwner(missingPath));
			const first = adapter.open();
			const second = adapter.open();
			let failure: unknown;
			try {
				await first;
			} catch (error) {
				failure = error;
			}
			await adapter.close();
			let configuration = false;
			let boundaryMatched = false;
			if (
				failure instanceof Error &&
				sdk.DriverError.instanceOf(failure) &&
				sdk.DriverError.Configuration.instanceOf(failure)
			) {
				configuration = true;
				boundaryMatched = failure.inner.reason.startsWith(`failed to read capability manifest ${missingPath}:`);
			}
			const noOwner = constructedOwners === 0 && shutdownStarts === 0 && destroys === 0;
			if (!boundaryMatched || first !== second || !noOwner || constructCalls !== 1) {
				throw new ProbeFailure("creation_failure_boundary_mismatch");
			}
			emit(
				"creation-failure",
				{
					configuration,
					boundaryMatched,
					failedOpenCached: first === second,
					noOwner,
					failedCloseFulfilled: true,
					partialOwnerCleanupProven: false,
					globalRuntimeGuardTested: false,
				},
				id,
			);
			if (stopped) throw new ProbeFailure("stopped_before_admission");
			adapter = new NativeComputerAdapter(() => createOwner(capabilityManifest));
			await adapter.open();
		} else {
			rawOwner = createOwner(capabilityManifest);
		}
		if (stopped) throw new ProbeFailure("stopped_during_admission");
		admitted = true;
		emit("opened", { arm, authorizationRequests }, id);
	}

	function startCall<T>(id: string, operation: string, makeCall: () => NativeCall<T>): NativeCall<T> {
		if (active) throw new ProbeFailure("overlapping_native_call");
		let nativeCall: NativeCall<T> | undefined;
		let cancelled = false;
		const result = Promise.resolve().then(async () => {
			if (cancelled || stopped) throw new ProbeFailure("stopped_before_dispatch");
			nativeCall = makeCall();
			// A synchronous foreign callback can request stop before makeCall returns.
			if (cancelled) nativeCall.cancel();
			return await nativeCall.result;
		});
		const call: NativeCall<T> = {
			result,
			cancel: () => {
				cancelled = true;
				nativeCall?.cancel();
			},
		};
		const tracked = { id, operation, call };
		active = tracked;
		const settled = () => {
			if (active === tracked) active = undefined;
		};
		void result.then(settled, settled);
		return call;
	}

	function rawCall<T>(invoke: (signal: AbortSignal) => Promise<T>): NativeCall<T> {
		const controller = new AbortController();
		return { result: invoke(controller.signal), cancel: () => controller.abort() };
	}

	function observeCall(id: string, operation: string): NativeCall<CuaSdk.WindowStateOutput> {
		return startCall(id, operation, () => {
			if (adapter) return adapter.observe(input);
			if (!rawOwner) throw new ProbeFailure("not_admitted");
			return rawCall((signal) => rawOwner!.driver.getWindowState(input, { signal }));
		});
	}

	function assertObservationTarget(value: CuaSdk.WindowStateOutput): void {
		if (
			value.pid !== fixturePid ||
			value.windowId !== fixtureWindowId ||
			value.images.length !== 0 ||
			value.degraded === true ||
			value.truncated === true
		) {
			throw new ProbeFailure("invalid_observation");
		}
	}

	function inspectObservation(value: CuaSdk.WindowStateOutput, id: string): void {
		assertObservationTarget(value);
		const elements = value.elements ?? [];
		const button = (label: string) =>
			elements.filter(
				(element) =>
					element.role === "AXButton" &&
					element.label === label &&
					element.enabled !== false &&
					element.actions?.includes("AXPress") &&
					typeof element.elementToken === "string" &&
					element.elementToken.length > 0,
			);
		const increments = button("P02 Increment");
		const stops = button("Stop");
		const counters = new Set<number>();
		const text = [
			value.treeMarkdown,
			...elements.flatMap((element) => [element.label, element.value, element.valueDescription]),
		];
		for (const field of text) {
			for (const match of field?.matchAll(/\bcounter=([0-9]+)\b/g) ?? []) {
				const count = Number(match[1]);
				if (!Number.isSafeInteger(count)) throw new ProbeFailure("invalid_fixture_counter");
				counters.add(count);
			}
		}
		if (increments.length !== 1 || stops.length !== 1 || counters.size !== 1) {
			throw new ProbeFailure("fixture_elements_not_unique");
		}
		if (!clickAttempted && !stopped) incrementToken = increments[0]!.elementToken;
		emit(
			"observed",
			{
				counter: [...counters][0]!,
				incrementUnique: true,
				stopUnique: true,
				elementCount: elements.length,
				degraded: value.degraded ?? null,
				truncated: value.truncated ?? null,
				elementsComplete: value.elementsComplete ?? null,
			},
			id,
		);
	}

	async function execute(command: Command, id: string): Promise<void> {
		if (stopped || finalWork) throw new ProbeFailure("host_stopped");
		if (command === "preflight") {
			if (preflightAttempted || admitAttempted) throw new ProbeFailure("preflight_out_of_order");
			preflightAttempted = true;
			const permissions = sdk.currentMacOsPermissionStatus();
			preflightPassed = permissions.accessibility && permissions.screenRecording;
			emit(
				"permissions",
				{ accessibility: permissions.accessibility, screenRecording: permissions.screenRecording },
				id,
			);
			if (!preflightPassed) throw new ProbeFailure("permissions_missing");
			return;
		}
		if (command === "admit") {
			if (!preflightPassed || admitAttempted) throw new ProbeFailure("admission_out_of_order");
			admitAttempted = true;
			opening = admit(id);
			await opening;
			return;
		}
		if (!admitted) throw new ProbeFailure("not_admitted");
		if (command === "observe") {
			incrementToken = undefined;
			inspectObservation(await observeCall(id, command).result, id);
			return;
		}
		if (command === "click") {
			if (clickAttempted || !incrementToken) throw new ProbeFailure("click_not_armed");
			const elementToken = incrementToken;
			incrementToken = undefined;
			clickAttempted = true;
			const click: CuaSdk.ClickInput = {
				target: new sdk.ActionTarget.Window({ pid: fixturePid, windowId: fixtureWindowId }),
				position: new sdk.ClickPosition.Element({ elementToken }),
				deliveryMode: sdk.InputDeliveryMode.Background,
				button: sdk.ClickButton.Left,
				count: 1,
			};
			const call = startCall(id, command, () => {
				if (adapter) return adapter.click(click);
				if (!rawOwner) throw new ProbeFailure("not_admitted");
				return rawCall((signal) => rawOwner!.driver.click(click, { signal }));
			});
			const result = await call.result;
			clickCompleted = true;
			emit(
				"clicked",
				{
					effect: result.effect,
					route: result.route,
					deliveryPresent: result.delivery !== undefined,
					delivery: result.delivery?.mode,
					deliveredCount: result.delivery?.deliveredCount,
					evidencePresent: result.evidence !== undefined,
					evidenceKinds: result.evidence?.map((evidence) => evidence.kind) ?? [],
					hasEscalation: result.escalation !== undefined,
					escalationTarget: result.escalation?.target,
					escalationReason: result.escalation?.reason,
				},
				id,
			);
			return;
		}
		if (command !== "cancel-observe" || arm !== "adapter" || !clickCompleted) {
			throw new ProbeFailure("cancel_observe_out_of_order");
		}
		finalWork = true;
		cancelObserveId = id;
		const call = observeCall(id, command);
		let settled = false;
		const outcome = call.result.then(
			(value) => {
				settled = true;
				return { fulfilled: true as const, value, stopBeforeSettlement: cancelStopReceived };
			},
			(error: unknown) => {
				settled = true;
				return { fulfilled: false as const, error, stopBeforeSettlement: cancelStopReceived };
			},
		);
		await new Promise<void>((resolve) => {
			setImmediate(() => {
				emit("loop-turn", { pending: !settled, operation: command }, id);
				resolve();
			});
		});
		const result = await outcome;
		if (result.fulfilled) assertObservationTarget(result.value);
		const matchingAbortClass = !result.fulfilled && result.error instanceof AbortError;
		emit(
			"cancelled-observe",
			{
				outcome: result.fulfilled ? "fulfilled_race" : matchingAbortClass ? "ubjs_abort" : "error",
				matchingAbortClass,
				stopBeforeSettlement: result.stopBeforeSettlement,
				...(result.fulfilled ? {} : errorFields(result.error)),
			},
			id,
		);
		if (!result.fulfilled && !matchingAbortClass) throw result.error;
	}

	function handleLine(line: Buffer): void {
		let id: string | undefined;
		try {
			const message: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
			if (isRecord(message) && typeof message.id === "string" && tokenPattern.test(message.id)) id = message.id;
			if (
				!isRecord(message) ||
				Object.keys(message).length !== 3 ||
				!Object.keys(message).every((key) => key === "nonce" || key === "id" || key === "command") ||
				message.nonce !== nonce ||
				!id ||
				!commands.some((command) => message.command === command)
			) {
				throw new ProbeFailure("invalid_command");
			}
			if (ids.has(id)) throw new ProbeFailure("duplicate_command_id");
			ids.add(id);
			const command = message.command as Command;
			if (command === "ping") {
				emit(
					"pong",
					{
						pending: active !== undefined || shutdownPending,
						operation: active?.operation ?? (shutdownPending ? "shutdown" : (ordinary?.command ?? null)),
					},
					id,
				);
				return;
			}
			if (command === "stop") {
				const pending = active !== undefined;
				if (cancelObserveId !== undefined) {
					cancelStopReceived = true;
					emit("cancel-requested", { pendingAtCancel: pending, operationId: cancelObserveId }, id);
				}
				latchStop();
				if (cancelObserveId !== undefined) closeOnce(id);
				emit("stopped", { pending }, id);
				return;
			}
			if (command === "close") {
				explicitCloseRequested = true;
				requestClose(id);
				return;
			}
			if (ordinary) throw new ProbeFailure("overlapping_command");
			if (stopped || finalWork) throw new ProbeFailure("host_stopped");
			const current = { id, command };
			ordinary = current;
			void Promise.resolve()
				.then(() => execute(command, current.id))
				.then(
					() => {
						if (ordinary === current) ordinary = undefined;
					},
					(error: unknown) => {
						if (ordinary === current) ordinary = undefined;
						fail(error, current.id);
					},
				);
		} catch (error) {
			parsingStopped = true;
			fail(error instanceof ProbeFailure ? error : new ProbeFailure("invalid_command"), id);
		}
	}

	let partial = Buffer.alloc(0);
	process.stdin.on("data", (chunk: Buffer) => {
		if (parsingStopped) return;
		let offset = 0;
		while (offset < chunk.length) {
			const newline = chunk.indexOf(10, offset);
			const end = newline < 0 ? chunk.length : newline;
			const segment = chunk.subarray(offset, end);
			// Account for the required LF even before it arrives; never accumulate an unbounded line.
			if (partial.length + segment.length + 1 > 1024) {
				parsingStopped = true;
				partial = Buffer.alloc(0);
				fail(new ProbeFailure("command_too_large"));
				return;
			}
			partial = Buffer.concat([partial, segment]);
			if (newline < 0) return;
			handleLine(partial);
			partial = Buffer.alloc(0);
			if (parsingStopped) return;
			offset = newline + 1;
		}
	});
	process.stdin.on("end", () => {
		parsingStopped = true;
		if (partial.length !== 0) fail(new ProbeFailure("unterminated_command"));
		else if (!explicitCloseRequested) requestClose();
	});
	process.stdin.on("error", () => {
		parsingStopped = true;
		fail(new ProbeFailure("input_error"));
	});
	process.stdout.on("error", () => {
		outputAvailable = false;
		parsingStopped = true;
		process.exitCode = 1;
		latchStop();
		requestClose();
	});
	emit("ready", { arm });
}

try {
	runHost();
} catch (error) {
	process.exitCode = 1;
	emit("failed", { category: error instanceof ProbeFailure ? error.code : "startup_failure" });
}
