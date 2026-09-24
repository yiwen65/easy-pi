import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type * as CuaSdk from "@trycua/cua-driver";
import { ComputerHost } from "../../../../packages/coding-agent/src/core/computer/host.ts";
import {
	ControlledComputerRuntime,
	type NativeHost,
	type NativeOperation,
	type NativeSession,
} from "../../controlled/adapter.ts";
import { createDesktopTool } from "../tool.ts";
import { candidateSdk } from "./sdk.ts";

const allowed = process.env.ALLOW_NATIVE_LOAD_TESTS === "true";
if (allowed) {
	assert.equal(process.env.ALLOW_GUI_TESTS, "false");
	assert.equal(process.env.ALLOW_REAL_APIS, "false");
	assert.ok(process.env.CUA_DRIVER_TYPESCRIPT_DIR);
}
const sdk = allowed ? candidateSdk() : undefined;

function fixture(refuse = false, nativeFilteredOut = 0, onObserve?: () => void) {
	assert.ok(sdk);
	const api = sdk;
	const events: string[] = [];
	const queries: unknown[] = [];
	let creates = 0;
	let sessions = 0;
	function nativeSession(): NativeSession {
		const serial = ++sessions;
		return {
			revoke() {
				events.push("revoke");
			},
			async close() {
				events.push("close");
			},
			newOperation(): NativeOperation {
				let resolve!: (result: CuaSdk.ComputerResult) => void;
				let reject!: (error: unknown) => void;
				let proof!: (receipt: CuaSdk.ComputerTerminal) => void;
				const result = new Promise<CuaSdk.ComputerResult>((accept, decline) => {
					resolve = accept;
					reject = decline;
				});
				const terminal = new Promise<CuaSdk.ComputerTerminal>((accept) => {
					proof = accept;
				});
				const finish = (value: CuaSdk.ComputerResult, name: string, committed = false) => {
					events.push(name);
					resolve(value);
					proof({ operationId: name, cancelled: false, inputCommitted: committed });
				};
				const forbidden = () => {
					throw new Error("Unexpected native route");
				};
				const action = () =>
					finish(
						new api.ComputerResult.Action({
							value: { effect: api.ActionEffect.Unverifiable, route: api.ActionRoute.Accessibility },
						}),
						"input",
						true,
					);
				return {
					result: () => result,
					terminal: () => terminal,
					cancel() {
						events.push("cancel");
					},
					startListWindows(query?: unknown) {
						queries.push(query);
						if (refuse) {
							reject(new api.ComputerError.Refused({ reason: "discovery_changed" }));
							proof({ operationId: "refused", cancelled: false, inputCommitted: false });
							return;
						}
						finish(
							new api.ComputerResult.Windows({
								windows: [
									{
										reference: "window",
										appName: "Fixture",
										title: "Test",
										bounds: { x: 0, y: 0, width: 2, height: 3 },
										isOnScreen: true,
									},
								],
								omittedWindows: 0,
								filteredOut: nativeFilteredOut,
							}),
							"discover",
						);
					},
					startSelectWindow(ref) {
						assert.equal(ref, "window");
						finish(new api.ComputerResult.WindowSelected({ session: nativeSession() }), "select");
					},
					startCapture() {
						const png = new ArrayBuffer(33);
						const b = Buffer.from(png);
						b.set([137, 80, 78, 71, 13, 10, 26, 10]);
						b.writeUInt32BE(13, 8);
						b.write("IHDR", 12);
						b.writeUInt32BE(2, 16);
						b.writeUInt32BE(3, 20);
						finish(
							new api.ComputerResult.Image({
								value: {
									imageId: "image",
									pid: 1,
									windowId: 1n,
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
							"capture",
						);
					},
					startImageClick: action,
					startImageKey: action,
					startImageScroll: action,
					startClick: forbidden,
					startSegment: forbidden,
					startCrossWindowDrag: forbidden,
					startObserve() {
						assert.equal(serial, 2, "semantic observation must use the selected child");
						onObserve?.();
						finish(
							new api.ComputerResult.Observation({
								value: {
									pid: 1,
									windowId: 1n,
									snapshotId: "snapshot",
									images: [],
									elementsComplete: true,
									truncated: false,
									degraded: false,
									elements: [
										{
											elementIndex: 0n,
											depth: 0,
											role: "AXTextField",
											label: "Field",
											value: "",
											enabled: true,
											inWebContent: false,
											elementToken: "field",
										},
									],
								},
							}),
							"observe",
						);
					},
					startPlan(plan) {
						assert.equal(serial, 2, "semantic plan must use the selected child");
						finish(
							new api.ComputerResult.Plan({
								value: {
									status: api.ComputerPlanStatus.Completed,
									completedSteps: plan.steps.length,
									elapsedMs: 1n,
									steps: plan.steps.map((_, index) => ({
										index,
										dispatch: api.ComputerDispatch.NotDispatched,
										condition: api.ComputerCondition.Satisfied,
										elapsedMs: 1n,
									})),
								},
							}),
							"plan",
						);
					},
					startNavigate: forbidden,
					startPrepare: forbidden,
				};
			},
		};
	}
	const native: NativeHost = { openSession: nativeSession, revoke() {}, async close() {} };
	const host = new ComputerHost({
		desktopId: "desktop-test",
		createRuntime() {
			creates++;
			return new ControlledComputerRuntime({ host: native, destroy() {} }, () => nativeSession());
		},
	});
	const session = host.openSession();
	const desktop = createDesktopTool(session, () => api);
	const messages: ToolResultMessage[] = [];
	async function publish(id: string, result: Awaited<ReturnType<typeof desktop.tool.execute>>) {
		messages.push({
			role: "toolResult",
			toolName: "computer",
			toolCallId: id,
			content: result.content,
			isError: false,
			timestamp: 1,
		});
		desktop.observeContext(true, messages);
	}
	async function select() {
		await publish("discover", await desktop.tool.execute("discover", { request: { op: "discover" } }));
		await desktop.tool.execute("select", { request: { op: "select", ref: "window" } });
	}
	return {
		host,
		session,
		desktop,
		messages,
		publish,
		select,
		events,
		queries,
		get creates() {
			return creates;
		},
	};
}

test("discovery forwards bounded metadata narrowing before native catalog admission", { skip: !allowed }, async () => {
	const f = fixture(false, 400);
	try {
		const result = await f.desktop.tool.execute("filtered", {
			request: { op: "discover", app: "fixture", title: "TEST", focused: true },
		});
		assert.deepEqual(result.details, { status: "discovered", omittedWindows: 0, filteredOut: 401 });
		assert.deepEqual(f.queries, [{ app: "fixture", title: "TEST", focused: true }]);
		await f.desktop.tool.execute("unfiltered", { request: { op: "discover" } });
		assert.deepEqual(f.queries[1], { focused: false });
	} finally {
		await f.host.close();
	}
});

test("select with observe returns usable child evidence in one tool round", { skip: !allowed }, async () => {
	const f = fixture();
	try {
		await f.publish("discover", await f.desktop.tool.execute("discover", { request: { op: "discover" } }));
		const result = await f.desktop.tool.execute("select", {
			request: { op: "select", ref: "window", observe: true },
		});
		assert.deepEqual(f.events, ["discover", "select", "observe"]);
		assert.match(JSON.stringify(result.details), /"observationRef":"snapshot"/);
		await f.publish("select", result);
		await f.desktop.tool.execute("plan", {
			request: {
				op: "execute",
				ref: "snapshot",
				steps: [{ op: "assert_value", selector: { role: "AXTextField", label: "Field" }, value: "" }],
			},
		});
		assert.equal(f.events.filter((event) => event === "plan").length, 1);
	} finally {
		await f.host.close();
	}
});

test("retired combined selection does not start observation or grant late evidence", { skip: !allowed }, async () => {
	const f = fixture();
	try {
		await f.publish("discover", await f.desktop.tool.execute("discover", { request: { op: "discover" } }));
		const selecting = f.desktop.tool.execute("select", { request: { op: "select", ref: "window", observe: true } });
		f.desktop.clear();
		await assert.rejects(selecting, /stale_observation/);
		assert.ok(!f.events.includes("observe"));
	} finally {
		await f.host.close();
	}
});

test(
	"retirement during combined observation prevents its late evidence from authorizing input",
	{ skip: !allowed },
	async () => {
		const f = fixture(false, 0, () => f.desktop.clear());
		try {
			await f.publish("discover", await f.desktop.tool.execute("discover", { request: { op: "discover" } }));
			await f.publish(
				"select",
				await f.desktop.tool.execute("select", {
					request: { op: "select", ref: "window", observe: true },
				}),
			);
			await assert.rejects(
				f.desktop.tool.execute("plan", {
					request: {
						op: "execute",
						ref: "snapshot",
						steps: [{ op: "assert_value", selector: { role: "AXTextField", label: "Field" }, value: "" }],
					},
				}),
				/stale_observation/,
			);
			assert.ok(!f.events.includes("plan"));
		} finally {
			await f.host.close();
		}
	},
);

test(
	"semantic plans reuse the selected child and require the actual visible observation",
	{ skip: !allowed },
	async () => {
		const f = fixture();
		try {
			await f.select();
			await f.publish("observe", await f.desktop.tool.execute("observe", { request: { op: "observe" } }));
			const request = {
				op: "execute" as const,
				ref: "snapshot",
				steps: [{ op: "assert_value" as const, selector: { role: "AXTextField", label: "Field" }, value: "" }],
			};
			const result = await f.desktop.tool.execute("plan", { request });
			assert.match(JSON.stringify(result.details), /completed/);
			await f.publish("observe2", await f.desktop.tool.execute("observe2", { request: { op: "observe" } }));
			f.desktop.observeContext(true, []);
			await assert.rejects(f.desktop.tool.execute("omitted", { request }), /stale_observation/);
			assert.equal(f.events.filter((event) => event === "plan").length, 1);
		} finally {
			await f.host.close();
		}
	},
);

test("proved no-input refusal is paused rather than host-native-fault unknown", { skip: !allowed }, async () => {
	const f = fixture(true);
	try {
		await assert.rejects(
			f.desktop.tool.execute("discover", { request: { op: "discover" } }),
			/Computer native_refused/,
		);
	} finally {
		await f.host.close();
	}
});

test("desktop composition is lazy; visible discovery selects a runtime-owned child", { skip: !allowed }, async () => {
	const f = fixture();
	assert.equal(f.creates, 0);
	await f.select();
	assert.equal(f.creates, 1);
	await f.host.close();
	assert.equal(f.events.filter((event) => event === "close").length, 2);
});

test(
	"capture is encoded into model content and exactly one visible-image input is admitted",
	{ skip: !allowed },
	async () => {
		const f = fixture();
		try {
			await f.select();
			const image = await f.desktop.tool.execute("capture", { request: { op: "capture", maxDimension: 512 } });
			assert.equal(image.content[1]?.type, "image");
			await f.publish("capture", image);
			await f.desktop.tool.execute("key", { request: { op: "key", ref: "image", key: "Tab" } });
			await assert.rejects(
				f.desktop.tool.execute("reuse", { request: { op: "key", ref: "image", key: "Tab" } }),
				/stale_image/,
			);
			assert.equal(f.events.filter((event) => event === "input").length, 1);
		} finally {
			await f.host.close();
		}
	},
);

test("retirement while capture is pending prevents late result publication", { skip: !allowed }, async () => {
	const f = fixture();
	try {
		await f.select();
		const capturing = f.desktop.tool.execute("capture", { request: { op: "capture", maxDimension: 512 } });
		f.desktop.clear();
		await f.publish("capture", await capturing);
		await assert.rejects(
			f.desktop.tool.execute("key", { request: { op: "key", ref: "image", key: "Tab" } }),
			/stale_image/,
		);
		assert.ok(!f.events.includes("input"));
	} finally {
		await f.host.close();
	}
});

test(
	"filtered capture refuses input before native dispatch and cannot be restored from history",
	{ skip: !allowed },
	async () => {
		const f = fixture();
		try {
			await f.select();
			await f.publish(
				"capture",
				await f.desktop.tool.execute("capture", { request: { op: "capture", maxDimension: 512 } }),
			);
			f.desktop.observeContext(false, f.messages);
			f.desktop.observeContext(true, f.messages);
			await assert.rejects(
				f.desktop.tool.execute("key", { request: { op: "key", ref: "image", key: "Return" } }),
				/stale_image/,
			);
			assert.ok(!f.events.includes("input"));
		} finally {
			await f.host.close();
		}
	},
);
