import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ContextInspection } from "../src/core/compaction/subsystem/session-integration.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

interface ContextCommandPrototype {
	setupEditorSubmitHandler(this: unknown): void;
	handleContextCommand(this: unknown, text: string): void;
}

const prototype = InteractiveMode.prototype as unknown as ContextCommandPrototype;

function inspection(includeSystemPrompt = false): ContextInspection {
	return {
		mode: "full_pipeline",
		snapshotVersion: 2,
		projectionKind: "incremental",
		baseEventSeq: 17,
		triggerEventSeq: 23,
		tailEventCount: 4,
		toolsTokenEstimate: 30,
		tokenStats: {
			system: 20,
			tools: 30,
			contract: 10,
			snapshot: 15,
			narrative: 5,
			recall: 5,
			recentTail: 15,
			currentInput: 0,
			outputReserve: 0,
			total: 100,
		},
		projectionStats: [],
		sections: [
			{ zone: "contract", text: "CONTRACT PROJECTION", tokens: 10 },
			{ zone: "snapshot", text: "SNAPSHOT PROJECTION", tokens: 15 },
			{ zone: "recentTail", text: "RECENT TAIL PROJECTION", tokens: 15 },
		],
		recallEntries: [{ refId: "rc-123", kind: "tool_result", preview: "build log preview", eventIds: ["e-1"] }],
		...(includeSystemPrompt ? { systemPrompt: { text: "PRIVATE SYSTEM PROMPT", tokens: 20 } } : {}),
	};
}

function rendered(container: Container): string {
	return container.children
		.flatMap((child) => child.render(160))
		.join("\n")
		.replace(/\u001b\[[0-9;]*m/g, "");
}

function commandContext() {
	const inspectActiveContext = vi.fn((options?: { includeSystemPrompt?: boolean }): ContextInspection | undefined =>
		inspection(options?.includeSystemPrompt === true),
	);
	return {
		session: {
			hfCompactionHost: { inspectActiveContext },
			getActiveToolNames: () => ["read"],
			getAllTools: () => [
				{ name: "read", description: "PRIVATE TOOL DESCRIPTION", parameters: { type: "object" } },
				{ name: "write", description: "inactive", parameters: { type: "object" } },
			],
		},
		chatContainer: new Container(),
		ui: { requestRender: vi.fn() },
		showError: vi.fn(),
		showWarning: vi.fn(),
	};
}

describe("InteractiveMode /context", () => {
	beforeAll(() => initTheme("dark"));

	it("publishes autocomplete metadata and dispatches without compacting", async () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			name: "context",
			description: "Inspect the active compacted context projection",
			argumentHint: "[inspect [--full]]",
		});

		const handleContextCommand = vi.fn();
		const handleCompactCommand = vi.fn();
		const editor = { setText: vi.fn(), addToHistory: vi.fn() };
		const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
		prototype.setupEditorSubmitHandler.call({ defaultEditor, editor, handleContextCommand, handleCompactCommand });

		await defaultEditor.onSubmit?.("/context inspect");

		expect(handleContextCommand).toHaveBeenCalledWith("/context inspect");
		expect(handleCompactCommand).not.toHaveBeenCalled();
		expect(editor.setText).toHaveBeenCalledWith("");
	});

	it("renders a compact summary without dumping projection content", () => {
		const context = commandContext();
		prototype.handleContextCommand.call(context, "/context");

		const output = rendered(context.chatContainer);
		expect(output).toContain("Compacted Context");
		expect(output).toContain("Snapshot: v2");
		expect(output).toContain("Current projected tokens: 100");
		expect(output).toContain("snapshot: 15");
		expect(output).not.toContain("SNAPSHOT PROJECTION");
		expect(output).not.toContain("PRIVATE SYSTEM PROMPT");
	});

	it("renders redacted projection zones and recall metadata", () => {
		const context = commandContext();
		prototype.handleContextCommand.call(context, "/context inspect");

		const output = rendered(context.chatContainer);
		expect(output).toContain("Current compacted projection");
		expect(output).toContain("[snapshot] 15 tokens");
		expect(output).toContain("SNAPSHOT PROJECTION");
		expect(output).toContain("rc-123 [tool_result]: build log preview");
		expect(output).not.toContain("PRIVATE SYSTEM PROMPT");
		expect(output).not.toContain("PRIVATE TOOL DESCRIPTION");
	});

	it("shows system prompt and active provider-neutral tools only with --full", () => {
		const context = commandContext();
		prototype.handleContextCommand.call(context, "/context inspect --full");

		const output = rendered(context.chatContainer);
		expect(output).toContain("Sensitive diagnostic view");
		expect(output).toContain("[system] 20 tokens");
		expect(output).toContain("PRIVATE SYSTEM PROMPT");
		expect(output).toContain("PRIVATE TOOL DESCRIPTION");
		expect(output).not.toContain('"name": "write"');
	});

	it("reports missing snapshots and rejects unknown arguments", () => {
		const missing = commandContext();
		missing.session.hfCompactionHost.inspectActiveContext.mockReturnValue(undefined);
		prototype.handleContextCommand.call(missing, "/context");
		expect(missing.showWarning).toHaveBeenCalledWith("No active compacted context snapshot");

		const invalid = commandContext();
		prototype.handleContextCommand.call(invalid, "/context inspect --secret");
		expect(invalid.showError).toHaveBeenCalledWith("Usage: /context [inspect [--full]]");
	});
});
