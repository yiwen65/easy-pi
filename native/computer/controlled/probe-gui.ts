import { isAbsolute } from "node:path";
import type * as CuaSdk from "@trycua/cua-driver";
import {
	ComputerHost,
	ComputerHostError,
	type ComputerSession,
} from "../../../packages/coding-agent/src/core/computer/host.ts";
import {
	type ControlledComputerCall,
	ControlledComputerRuntime,
	type ControlledComputerSession,
	type NativeResult,
} from "./adapter.ts";
import { loadControlledSdk } from "./loader.ts";

// Dedicated-fixture qualification only. No default tool, P01 bridge, model or fallback.
const tokenPattern = /^[A-Za-z0-9_-]{1,64}$/;
const nonceArgument = process.argv[7];
const nonce = nonceArgument && tokenPattern.test(nonceArgument) ? nonceArgument : "invalid";
const commands = [
	"preflight",
	"admit",
	"admit-busy",
	"observe",
	"click",
	"session-contention",
	"cancel-observe",
	"ping",
	"stop",
	"close",
] as const;
type Command = (typeof commands)[number];
type Fields = Record<string, string | number | boolean | null | undefined>;
type ActiveOperation = { id: string; operation: string; call?: ControlledComputerCall };
let sequence = 0;
let outputAvailable = true;

class ProbeFailure extends Error {}

function emit(event: string, fields: Fields = {}, id?: string): void {
	if (!outputAvailable) return;
	process.stdout.write(
		`${JSON.stringify({ ...fields, event, nonce, pid: process.pid, seq: ++sequence, id, externalEffectsDrained: false })}\n`,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runHost(): void {
	if (process.env.ALLOW_GUI_TESTS !== "true" || process.env.ALLOW_REAL_APIS !== "false")
		throw new ProbeFailure("opt_in_required");
	const [sdkDirectory, manifest, role, pidText, windowText] = process.argv.slice(2);
	if (
		process.argv.length !== 8 ||
		!sdkDirectory ||
		!isAbsolute(sdkDirectory) ||
		!manifest ||
		!isAbsolute(manifest) ||
		!["owner", "contender", "successor"].includes(role ?? "") ||
		!pidText ||
		!windowText ||
		!/^[1-9][0-9]{0,9}$/.test(pidText) ||
		!/^[1-9][0-9]{0,9}$/.test(windowText) ||
		!nonceArgument ||
		!tokenPattern.test(nonceArgument)
	)
		throw new ProbeFailure("invalid_invocation");
	const pid = Number(pidText);
	const windowId = BigInt(windowText);
	if (pid > 2_147_483_647 || windowId > 4_294_967_295n) throw new ProbeFailure("invalid_fixture_identity");
	const sdk = loadControlledSdk(sdkDirectory);
	let stopped = false;
	let preflightAttempted = false;
	let preflightPassed = false;
	let admitAttempted = false;
	let admitted = false;
	let clickAttempted = false;
	let finalWork = false;
	let parsingStopped = false;
	let explicitClose = false;
	let ordinary: { id: string; command: Command } | undefined;
	let active: ActiveOperation | undefined;
	let closing: Promise<void> | undefined;
	let constructedOwners = 0;
	let destroys = 0;
	let incrementToken: string | undefined;
	let root: ComputerSession<ControlledComputerSession> | undefined;
	let worker: ComputerSession<ControlledComputerSession> | undefined;
	let sibling: ComputerSession<ControlledComputerSession> | undefined;
	const ids = new Set<string>();
	const desktopId = "p03-current-desktop-fixture";
	const computer = new ComputerHost<ControlledComputerSession>({
		desktopId,
		createRuntime: () => {
			const options: CuaSdk.ConfiguredDriverOptions = {
				claudeCodeCompatibility: false,
				authorization: {
					allowedModes: [sdk.SessionPermissionMode.Bounded],
					compatibilityMode: sdk.SessionPermissionMode.Bounded,
					compatibilityCapabilityManifestPath: manifest,
					unrestrictedAcknowledged: false,
					maxSessionTtlSeconds: 600n,
					maxIdleTtlSeconds: 120n,
				},
			};
			const native = sdk.ComputerHost.create(options);
			constructedOwners++;
			return new ControlledComputerRuntime(
				{
					host: {
						openSession: (targetPid, targetWindow, parent) => native.openSession(targetPid, targetWindow, parent),
						revoke: () => native.revoke(),
						close: async () => {
							emit("native-close-start");
							await native.close(); // Never pass a foreign-waiter AbortSignal.
							emit("native-close-complete");
						},
					},
					destroy: () => {
						if (!sdk.ComputerHost.instanceOf(native)) throw new ProbeFailure("native_identity_mismatch");
						native.uniffiDestroy();
						destroys++;
						emit("native-destroy", { destroys });
					},
				},
				{ pid, windowId },
			);
		},
	});

	function category(error: unknown): string {
		if (error instanceof ProbeFailure) return error.message;
		if (error instanceof ComputerHostError) return error.code;
		if (sdk.ComputerError.instanceOf(error)) return `native_${error.tag}`;
		return "unexpected_error";
	}

	function latchStop(): void {
		stopped = true;
		incrementToken = undefined;
		root?.revoke();
		active?.call?.cancel();
	}

	function closeOnce(): Promise<void> {
		closing ??= Promise.resolve().then(() => computer.close());
		latchStop();
		void closing.catch(() => {
			process.exitCode = 1;
		});
		return closing;
	}

	function requestClose(id?: string): void {
		void closeOnce().then(
			() => emit("closed", { constructedOwners, destroys, quarantined: computer.quarantined }, id),
			(error: unknown) => {
				process.exitCode = 1;
				emit("failed", { category: category(error), operation: "close" }, id);
			},
		);
	}

	function fail(error: unknown, id?: string): void {
		process.exitCode = 1;
		emit("failed", { category: category(error) }, id);
		requestClose(id);
	}

	async function runOperation(
		id: string,
		operation: "observe" | "click" | "cancel-observe",
		token?: string,
	): Promise<NativeResult> {
		if (!worker || stopped || active) throw new ProbeFailure("operation_not_admitted");
		const tracked: ActiveOperation = { id, operation };
		active = tracked;
		// This is the ordinary OUTER resource acquisition. ComputerSession.run never reacquires it.
		const lease = await computer.scheduler.acquire({ key: `desktop:${desktopId}`, mode: "exclusive" });
		try {
			return await worker.run((session, signal) => {
				const call = operation === "click" ? session.click(token!, signal) : session.observe(64, 8, signal);
				tracked.call = call;
				void call.receipt
					.then((receipt) => {
						if (!receipt) throw new ProbeFailure("missing_native_receipt");
						emit(
							"terminal",
							{
								operationId: receipt.operationId,
								cancelled: receipt.cancelled,
								inputCommitted: receipt.inputCommitted,
							},
							id,
						);
					})
					.catch((error: unknown) => fail(error, id));
				emit("dispatch", { operation }, id);
				return call;
			});
		} finally {
			lease?.release();
			if (active === tracked) active = undefined;
		}
	}

	function inspectObservation(result: NativeResult, id: string): void {
		if (!sdk.ComputerResult.Observation.instanceOf(result)) throw new ProbeFailure("wrong_observation_variant");
		const value = result.inner.value;
		if (
			value.pid !== pid ||
			value.windowId !== windowId ||
			value.images.length !== 0 ||
			value.degraded === true ||
			value.truncated === true
		)
			throw new ProbeFailure("invalid_observation");
		const elements = value.elements ?? [];
		const button = (label: string) =>
			elements.filter(
				(element) =>
					element.role === "AXButton" &&
					element.label === label &&
					element.enabled === true &&
					element.actions?.includes("AXPress") &&
					element.elementToken,
			);
		const increments = button("P02 Increment");
		const stops = button("Stop");
		const counters = new Set<number>();
		for (const field of [
			value.treeMarkdown,
			...elements.flatMap((element) => [element.label, element.value, element.valueDescription]),
		]) {
			for (const match of field?.matchAll(/\bcounter=([0-9]+)\b/g) ?? []) {
				const count = Number(match[1]);
				if (!Number.isSafeInteger(count)) throw new ProbeFailure("invalid_counter");
				counters.add(count);
			}
		}
		if (increments.length !== 1 || stops.length !== 1 || counters.size !== 1)
			throw new ProbeFailure("fixture_elements_not_unique");
		if (role === "owner" && !clickAttempted && !stopped) incrementToken = increments[0]!.elementToken;
		emit(
			"observed",
			{ counter: [...counters][0]!, elementCount: elements.length, incrementUnique: true, stopUnique: true },
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
		if (command === "admit" || command === "admit-busy") {
			if (!preflightPassed || admitAttempted || (command === "admit-busy") !== (role === "contender"))
				throw new ProbeFailure("admission_out_of_order");
			admitAttempted = true;
			root = computer.openSession();
			worker = root.fork();
			sibling = root.fork();
			try {
				await computer.native();
			} catch (error) {
				if (
					command === "admit-busy" &&
					sdk.ComputerError.Refused.instanceOf(error) &&
					error.inner.reason === "desktop_lease_unavailable"
				) {
					emit("lease-refused", { reason: error.inner.reason }, id);
					finalWork = true;
					return;
				}
				throw error;
			}
			if (command === "admit-busy") throw new ProbeFailure("lease_overlap");
			if (stopped) throw new ProbeFailure("stopped_during_admission");
			admitted = true;
			emit("opened", { role }, id);
			return;
		}
		if (!admitted || role === "contender") throw new ProbeFailure("not_admitted");
		if (command === "observe") {
			incrementToken = undefined;
			inspectObservation(await runOperation(id, "observe"), id);
			return;
		}
		if (command === "session-contention") {
			const refused = async (session: ComputerSession<ControlledComputerSession>) => {
				try {
					await session.run(() => {
						throw new ProbeFailure("contender_dispatched");
					});
				} catch (error) {
					return error instanceof ComputerHostError && error.code === "desktop_busy";
				}
				return false;
			};
			const parentRefused = await refused(root!);
			const siblingRefused = await refused(sibling!);
			if (!parentRefused || !siblingRefused) throw new ProbeFailure("session_owner_not_retained");
			emit("session-contention", { parentRefused, siblingRefused }, id);
			return;
		}
		if (command === "click") {
			if (role !== "owner" || clickAttempted || !incrementToken) throw new ProbeFailure("click_not_armed");
			const token = incrementToken;
			incrementToken = undefined;
			clickAttempted = true;
			const result = await runOperation(id, "click", token);
			if (!sdk.ComputerResult.Action.instanceOf(result)) throw new ProbeFailure("wrong_action_variant");
			const action = result.inner.value;
			emit(
				"clicked",
				{
					effect: action.effect,
					route: action.route,
					delivery: action.delivery?.mode,
					deliveredCount: action.delivery?.deliveredCount,
					hasEscalation: action.escalation !== undefined,
				},
				id,
			);
			return;
		}
		if (command !== "cancel-observe" || role !== "successor") throw new ProbeFailure("unexpected_command");
		finalWork = true;
		try {
			await runOperation(id, "cancel-observe");
			emit("cancelled-observe", { outcome: "fulfilled_race" }, id);
		} catch (error) {
			if (!(error instanceof ComputerHostError) || error.code !== "cancelled") throw error;
			emit("cancelled-observe", { outcome: "cancelled" }, id);
		}
	}

	function handleLine(line: Buffer): void {
		let id: string | undefined;
		try {
			const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
			if (isRecord(value) && typeof value.id === "string" && tokenPattern.test(value.id)) id = value.id;
			if (
				!isRecord(value) ||
				!id ||
				value.nonce !== nonce ||
				Object.keys(value).length !== 3 ||
				!Object.keys(value).every((key) => ["nonce", "id", "command"].includes(key)) ||
				!commands.some((command) => value.command === command)
			)
				throw new ProbeFailure("invalid_command");
			if (ids.has(id) || ids.size >= 256) throw new ProbeFailure("duplicate_or_excessive_command");
			ids.add(id);
			const command = value.command as Command;
			if (command === "ping") {
				emit("pong", { pending: active !== undefined, operation: active?.operation }, id);
				return;
			}
			if (command === "stop") {
				const pending = active !== undefined;
				closeOnce();
				emit("stopped", { pending }, id);
				return;
			}
			if (command === "close") {
				explicitClose = true;
				requestClose(id);
				return;
			}
			if (ordinary || stopped || finalWork) throw new ProbeFailure("overlapping_or_stopped_command");
			const current = { id, command };
			ordinary = current;
			void execute(command, id).then(
				() => {
					if (ordinary === current) ordinary = undefined;
				},
				(error: unknown) => {
					if (ordinary === current) ordinary = undefined;
					fail(error, id);
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
			if (partial.length + end - offset + 1 > 1024) {
				parsingStopped = true;
				partial = Buffer.alloc(0);
				fail(new ProbeFailure("command_too_large"));
				return;
			}
			partial = Buffer.concat([partial, chunk.subarray(offset, end)]);
			if (newline < 0) return;
			handleLine(partial);
			partial = Buffer.alloc(0);
			if (parsingStopped) return;
			offset = newline + 1;
		}
	});
	process.stdin.on("end", () => {
		parsingStopped = true;
		if (partial.length) fail(new ProbeFailure("unterminated_command"));
		else if (!explicitClose) requestClose();
	});
	process.stdin.on("error", () => {
		parsingStopped = true;
		fail(new ProbeFailure("input_error"));
	});
	process.stdout.on("error", () => {
		outputAvailable = false;
		parsingStopped = true;
		process.exitCode = 1;
		requestClose();
	});
	emit("ready", { role });
}

try {
	runHost();
} catch (error) {
	process.exitCode = 1;
	emit("failed", { category: error instanceof ProbeFailure ? error.message : "startup_failure" });
}
