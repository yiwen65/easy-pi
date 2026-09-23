import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type * as CuaSdk from "@trycua/cua-driver";
import { ComputerHost } from "../../../../packages/coding-agent/src/core/computer/host.ts";
import { ControlledComputerRuntime, type NativeOperation, type NativeSession } from "../../controlled/adapter.ts";
import type { DesktopInput } from "../contracts.ts";
import { createDesktopTool } from "../tool.ts";
import { candidateSdk } from "./sdk.ts";

const enabled = process.env.ALLOW_NATIVE_LOAD_TESTS === "true";
const api = enabled ? candidateSdk() : undefined;
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
export function fixture(
	options: {
		mode?: "partial" | "lost" | "paused" | "confirmed" | "prepared" | "confirmed_boundary";
		hold?: "segment" | "capture" | "pair_capture";
		terminalFailure?: boolean;
		failCapture?: number;
		windowIds?: readonly bigint[];
	} = {},
) {
	assert.ok(api);
	const sdk = api;
	const events: string[] = [];
	const segments: CuaSdk.ComputerSegment[] = [];
	const dragPeers: NativeSession[] = [];
	const captures: number[] = [];
	const closed: number[] = [];
	const held = deferred<void>();
	const entered = deferred<void>();
	let reads = 0;
	let serial = 0;
	function native(): NativeSession {
		const index = serial++;
		const child = index > 0;
		const windowId = options.windowIds?.[index - 1] ?? 1n;
		return {
			revoke() {
				events.push("revoke");
			},
			async close() {
				events.push("close");
				closed.push(index);
			},
			newOperation(): NativeOperation {
				let crossDrag = false;
				const result = deferred<CuaSdk.ComputerResult>();
				const terminal = deferred<CuaSdk.ComputerTerminal>();
				const done = (name: string, value: CuaSdk.ComputerResult | Error, committed = false) => {
					events.push(name);
					if (value instanceof Error) result.reject(value);
					else result.resolve(value);
					const proof = () => {
						events.push(`${name}:terminal`);
						if (name === "segment" && options.terminalFailure)
							terminal.reject(new Error("PRIVATE terminal error"));
						else terminal.resolve({ operationId: name, cancelled: false, inputCommitted: committed });
					};
					if (
						(options.hold === name && (name !== "capture" || segments.length > 0)) ||
						(options.hold === "pair_capture" && name === "capture" && captures.length === 2)
					) {
						entered.resolve();
						void held.promise.then(proof);
					} else proof();
				};
				const forbidden = () => {
					throw new Error("Unexpected native route");
				};
				return {
					result: () => result.promise,
					terminal: () => terminal.promise,
					cancel() {
						events.push("cancel");
					},
					startListWindows() {
						done(
							"discover",
							new sdk.ComputerResult.Windows({
								windows: [
									{
										reference: "window",
										appName: "fixture",
										title: "fixture",
										bounds: { x: 0, y: 0, width: 2, height: 3 },
										isOnScreen: true,
									},
								],
								omittedWindows: 0,
							}),
						);
					},
					startSelectWindow() {
						done("select", new sdk.ComputerResult.WindowSelected({ session: native() }));
					},
					startObserve() {
						assert.ok(child);
						done(
							"observe",
							new sdk.ComputerResult.Observation({
								value: {
									pid: 1,
									windowId,
									snapshotId: `snapshot-${++reads}`,
									images: [],
									elementsComplete: false,
									truncated: true,
									elements: [
										{
											elementIndex: 0n,
											depth: 0,
											role: "AXTextField",
											label: "Name",
											identifier: "name-id",
											elementToken: "field",
											inWebContent: true,
										},
									],
								},
							}),
						);
					},
					startCapture() {
						assert.ok(child);
						captures.push(index);
						if (options.failCapture === captures.length) {
							done("capture", new Error("PRIVATE capture failure"));
							return;
						}
						const png = new ArrayBuffer(33);
						const b = Buffer.from(png);
						b.set([137, 80, 78, 71, 13, 10, 26, 10]);
						b.writeUInt32BE(13, 8);
						b.write("IHDR", 12);
						b.writeUInt32BE(2, 16);
						b.writeUInt32BE(3, 20);
						done(
							"capture",
							new sdk.ComputerResult.Image({
								value: {
									imageId: `image-${++reads}`,
									pid: 1,
									windowId,
									png,
									geometry: {
										desktopX: 0,
										desktopY: 0,
										windowWidth: 2,
										windowHeight: 3,
										sourceWidth: 2,
										sourceHeight: 3,
										cropX: 0,
										cropY: 0,
										cropWidth: 2,
										cropHeight: 3,
										outputWidth: 2,
										outputHeight: 3,
									},
								},
							}),
						);
					},
					startCrossWindowDrag(peer, segment) {
						crossDrag = true;
						dragPeers.push(peer);
						this.startSegment(segment);
					},
					startSegment(segment) {
						assert.ok(child, "segment uses selected child");
						segments.push(segment);
						if (options.mode === "lost") {
							done("segment", new Error("PRIVATE lost result"), true);
							return;
						}
						const partial = options.mode === "partial";
						const paused = options.mode === "paused" || options.mode === "prepared";
						const confirmed = options.mode === "confirmed" || options.mode === "confirmed_boundary";
						let value = sdk.ComputerSegmentResult.create({
							status: confirmed
								? sdk.ComputerSegmentStatus.Confirmed
								: options.mode === "paused"
									? sdk.ComputerSegmentStatus.Paused
									: partial
										? sdk.ComputerSegmentStatus.OutcomeUnknown
										: sdk.ComputerSegmentStatus.NeedsObservation,
							actions: paused
								? [
										{
											index: 0,
											dispatch: sdk.ComputerDispatch.NotDispatched,
											code: options.mode === "prepared" ? "drag_foreground_prepared" : "target_missing",
										},
									]
								: partial
									? [{ index: 0, dispatch: sdk.ComputerDispatch.Unknown, code: "outcome_unknown" }]
									: segment.actions.map((_, index) => ({
											index,
											dispatch: sdk.ComputerDispatch.Dispatched,
											action: {
												effect: sdk.ActionEffect.Unverifiable,
												route: crossDrag ? sdk.ActionRoute.GlobalInput : sdk.ActionRoute.SyntheticEvents,
												delivery: { mode: sdk.ActionDeliveryMode.Foreground, deliveredCount: 1 },
											},
										})),
							condition: confirmed ? sdk.ComputerCondition.Satisfied : sdk.ComputerCondition.Unknown,
							...(partial || paused ? { firstUnfinishedAction: 0 } : {}),
							recoveryAttempts: paused ? Math.min(segments.length, 2) : 0,
							elapsedMs: 7n,
						});
						if (options.mode === "confirmed_boundary") {
							assert.ok(segment.actions.length > 1);
							const index = segment.actions.length - 1;
							value = sdk.ComputerSegmentResult.create({
								...value,
								firstUnfinishedAction: index,
								actions: [
									...value.actions.slice(0, index),
									{ index, dispatch: sdk.ComputerDispatch.NotDispatched, code: "segment_boundary_required" },
								],
							});
						}
						sdk.validateComputerSegmentResult(segment, value); // Test-only genuine validator, no host.
						done("segment", new sdk.ComputerResult.Segment({ value }), !paused || options.mode === "prepared");
					},
					startPlan: forbidden,
					startClick: forbidden,
					startImageClick: forbidden,
					startImageKey: forbidden,
					startImageScroll: forbidden,
					startNavigate: forbidden,
					startPrepare: forbidden,
				};
			},
		};
	}
	const host = new ComputerHost({
		desktopId: "segment-fixture",
		createRuntime: () =>
			new ControlledComputerRuntime(
				{
					host: { openSession: native, revoke() {}, async close() {} },
					destroy() {
						events.push("destroy");
					},
				},
				native,
			),
	});
	const session = host.openSession();
	const desktop = createDesktopTool(session, () => sdk);
	const messages: ToolResultMessage[] = [];
	let calls = 0;
	async function call(request: DesktopInput["request"], signal?: AbortSignal) {
		const id = `call-${++calls}`;
		const result = await desktop.tool.execute(id, { request }, signal);
		messages.push({
			role: "toolResult",
			toolName: "computer",
			toolCallId: id,
			content: result.content,
			isError: false,
			timestamp: 1,
		});
		desktop.observeContext(true, messages);
		return result;
	}
	async function setup(image = false) {
		await call({ op: "discover" });
		await call({ op: "select", ref: "window" });
		await call(image ? { op: "capture", maxDimension: 512 } : { op: "observe" });
	}
	return {
		host,
		session,
		desktop,
		messages,
		call,
		setup,
		events,
		segments,
		dragPeers,
		captures,
		closed,
		held,
		entered,
	};
}
