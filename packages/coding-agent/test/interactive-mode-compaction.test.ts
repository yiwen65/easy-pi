import type { Usage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("InteractiveMode compaction events", () => {
	test("contains asynchronous event rendering failures at the UI subscription boundary", async () => {
		const sourceEvent = { type: "agent_settled" } as const;
		const fakeThis = {
			handleEvent: vi.fn().mockRejectedValue(new Error("render failed")),
			showError: vi.fn(),
		};
		const handleEventSafely = Reflect.get(InteractiveMode.prototype, "handleEventSafely") as (
			this: typeof fakeThis,
			event: typeof sourceEvent,
		) => void;

		handleEventSafely.call(fakeThis, sourceEvent);
		await vi.waitFor(() => expect(fakeThis.showError).toHaveBeenCalledOnce());

		expect(fakeThis.showError).toHaveBeenCalledWith("Unable to render agent_settled: render failed");
	});

	test("uses the cache miss notice setting for compaction and branch summary costs", () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		const addCompactionCostNotice = Reflect.get(InteractiveMode.prototype, "addCompactionCostNotice") as (
			this: { chatContainer: Container; settingsManager: { getShowCacheMissNotices(): boolean } },
			notice: {
				type: "compaction_cost";
				kind: "compaction" | "branch_summary";
				usage: Usage;
			},
		) => void;

		initTheme("dark");
		const enabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
		};
		addCompactionCostNotice.call(enabled, { type: "compaction_cost", kind: "compaction", usage });
		addCompactionCostNotice.call(enabled, {
			type: "compaction_cost",
			kind: "branch_summary",
			usage,
		});
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		expect(output).toContain("Compaction: 100 tokens billed (~$0.13)");
		expect(output).toContain("Branch summary: 100 tokens billed (~$0.13)");

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
		};
		addCompactionCostNotice.call(disabled, { type: "compaction_cost", kind: "compaction", usage });
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	test("renders each compaction cost after its summary", () => {
		const currentUsage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
		};
		const previousUsage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
		};
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "current",
				parentId: "previous",
				timestamp: "2025-01-02T00:00:00Z",
				summary: "current summary",
				firstKeptEntryId: "kept",
				tokensBefore: 200,
				usage: currentUsage,
			},
			{
				type: "compaction",
				id: "previous",
				parentId: null,
				timestamp: "2025-01-01T00:00:00Z",
				summary: "previous summary",
				firstKeptEntryId: "kept",
				tokensBefore: 100,
				usage: previousUsage,
			},
		];
		const fakeThis = { renderSessionItems: vi.fn() };
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof fakeThis,
			entries: SessionEntry[],
		) => void;

		renderSessionEntries.call(fakeThis, entries);

		expect(fakeThis.renderSessionItems).toHaveBeenCalledWith(
			[
				expect.objectContaining({ role: "compactionSummary", summary: "current summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: currentUsage },
				expect.objectContaining({ role: "compactionSummary", summary: "previous summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: previousUsage },
			],
			{},
		);
	});

	test("renders the persisted modern checkpoint handoff at its transcript position", () => {
		const checkpoint: SessionEntry = {
			type: "compaction",
			id: "checkpoint",
			parentId: "previous",
			timestamp: "2025-01-02T00:00:00Z",
			tokensBefore: 1_000,
			replacementHistory: [
				{ role: "user", content: "latest goal", timestamp: 1 },
				{
					role: "compactionSummary",
					summary: "Persisted handoff details",
					tokensBefore: 1_000,
					timestamp: 2,
				},
			],
		};
		const fakeThis = { renderSessionItems: vi.fn() };
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof fakeThis,
			entries: SessionEntry[],
		) => void;

		renderSessionEntries.call(fakeThis, [checkpoint]);

		expect(fakeThis.renderSessionItems).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					role: "compactionSummary",
					summary: "Persisted handoff details",
					tokensBefore: 1_000,
				}),
			],
			{},
		);
	});

	test("keeps handoff details collapsed until transcript expansion is enabled", () => {
		initTheme("dark");
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "EXPANDABLE_HANDOFF_DETAILS",
			tokensBefore: 1_000,
			timestamp: 1,
		});

		const collapsed = stripAnsi(component.render(100).join("\n"));
		expect(collapsed).toContain("Compacted from 1,000 tokens");
		expect(collapsed).toContain("to expand");
		expect(collapsed).not.toContain("EXPANDABLE_HANDOFF_DETAILS");

		component.setExpanded(true);
		expect(stripAnsi(component.render(100).join("\n"))).toContain("EXPANDABLE_HANDOFF_DETAILS");
	});

	test("renders retained entries and appends the latest summary cost at the bottom", async () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		const latestCompaction: SessionEntry = {
			type: "compaction",
			id: "latest",
			parentId: "previous",
			timestamp: "2025-01-02T00:00:00Z",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 123,
			usage,
		};
		const previousCompaction: SessionEntry = {
			type: "compaction",
			id: "previous",
			parentId: null,
			timestamp: "2025-01-01T00:00:00Z",
			summary: "previous summary",
			firstKeptEntryId: "kept",
			tokensBefore: 100,
			usage,
		};
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			sessionManager: { buildContextEntries: vi.fn().mockReturnValue([latestCompaction, previousCompaction]) },
			renderSessionEntries: vi.fn(),
			addMessageToChat: vi.fn(),
			addCompactionCostNotice: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string; usage?: Usage } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
				usage,
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.renderSessionEntries).toHaveBeenCalledWith([previousCompaction]);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
			}),
		);
		expect(fakeThis.addCompactionCostNotice).toHaveBeenCalledWith({
			type: "compaction_cost",
			kind: "compaction",
			usage,
		});
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("keeps the transcript when modern checkpoint compaction is persisted", async () => {
		const checkpointEntry: SessionEntry = {
			type: "compaction",
			id: "checkpoint",
			parentId: null,
			timestamp: "2025-01-01T00:00:00Z",
			tokensBefore: 1_000,
			replacementHistory: [
				{
					role: "compactionSummary",
					summary: "HF checkpoint activated",
					tokensBefore: 1_000,
					timestamp: 1,
				},
			],
		};
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			sessionManager: { buildContextEntries: vi.fn().mockReturnValue([checkpointEntry]) },
			renderSessionEntries: vi.fn(),
			addMessageToChat: vi.fn(),
			addCompactionCostNotice: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string; usage?: Usage } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await expect(
			handleEvent.call(fakeThis, {
				type: "compaction_end",
				reason: "threshold",
				result: { tokensBefore: 1_000, summary: "HF snapshot activated" },
				aborted: false,
				willRetry: false,
			}),
		).resolves.toBeUndefined();

		expect(fakeThis.chatContainer.clear).not.toHaveBeenCalled();
		expect(fakeThis.renderSessionEntries).not.toHaveBeenCalled();
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({ role: "compactionSummary", summary: "HF snapshot activated" }),
		);
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("uses the transcript projection when rebuilding a resumed session", () => {
		const visibleEntries: SessionEntry[] = [
			{
				type: "message",
				id: "visible-history",
				parentId: null,
				timestamp: "2025-01-01T00:00:00Z",
				message: { role: "user", content: "still visible", timestamp: 1 },
			},
		];
		const fakeThis = {
			sessionManager: {
				buildTranscriptEntries: vi.fn().mockReturnValue(visibleEntries),
				getEntries: vi.fn().mockReturnValue([]),
			},
			renderSessionEntries: vi.fn(),
			renderProjectTrustWarningIfNeeded: vi.fn(),
			showStatus: vi.fn(),
		};
		const renderInitialMessages = Reflect.get(InteractiveMode.prototype, "renderInitialMessages") as (
			this: typeof fakeThis,
		) => void;

		renderInitialMessages.call(fakeThis);

		expect(fakeThis.sessionManager.buildTranscriptEntries).toHaveBeenCalledOnce();
		expect(fakeThis.renderSessionEntries).toHaveBeenCalledWith(visibleEntries, {
			updateFooter: true,
			populateHistory: true,
		});
	});

	test("preserves steering behavior when flushing into an active agent run", async () => {
		const fakeThis = {
			compactionQueuedMessages: [{ text: "change direction", mode: "steer" as const }],
			session: {
				clearQueue: vi.fn(),
				prompt: vi.fn().mockResolvedValue(undefined),
				steer: vi.fn().mockResolvedValue(undefined),
				followUp: vi.fn().mockResolvedValue(undefined),
			},
			isExtensionCommand: vi.fn().mockReturnValue(false),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};

		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("change direction", { streamingBehavior: "steer" });
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});
