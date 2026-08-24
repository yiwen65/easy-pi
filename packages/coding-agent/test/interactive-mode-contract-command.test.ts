import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ReconciliationReport } from "../src/core/compaction/subsystem/reconciliation.ts";
import type { PendingGoalChange } from "../src/core/compaction/subsystem/task-ledger.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

interface ContractCommandPrototype {
	setupEditorSubmitHandler(this: unknown): void;
	handleContractCommand(this: unknown, text: string): void;
	canMutateTaskContract(this: unknown): boolean;
	resolvePendingGoalChangeSelector(this: unknown, selector: string): string;
	formatPendingGoalChanges(this: unknown, pending: PendingGoalChange[]): string[];
	showPendingGoalChanges(this: unknown): void;
	formatReconciliationReport(this: unknown, report: ReconciliationReport): string[];
	showReconciliationReport(this: unknown, report: ReconciliationReport): void;
	showTaskContract(this: unknown): void;
}

const prototype = InteractiveMode.prototype as unknown as ContractCommandPrototype;

function rendered(container: Container): string {
	return container.children
		.flatMap((child) => child.render(160))
		.join("\n")
		.replace(/\u001b\[[0-9;]*m/g, "");
}

function commandContext(session: Record<string, unknown>) {
	return {
		session,
		chatContainer: new Container(),
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		canMutateTaskContract: prototype.canMutateTaskContract,
		resolvePendingGoalChangeSelector: prototype.resolvePendingGoalChangeSelector,
		formatPendingGoalChanges: prototype.formatPendingGoalChanges,
		showPendingGoalChanges: prototype.showPendingGoalChanges,
		formatReconciliationReport: prototype.formatReconciliationReport,
		showReconciliationReport: prototype.showReconciliationReport,
		showTaskContract: prototype.showTaskContract,
	};
}

describe("InteractiveMode /contract", () => {
	beforeAll(() => initTheme("dark"));

	it("publishes built-in autocomplete metadata and dispatches the command", async () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			name: "contract",
			description: "Show or manage the task contract and task ledger",
			argumentHint:
				"[set <goal>|confirm|pending|reconcile|accept <number-or-P-id> [task-id]|reject <number-or-P-id>]",
		});

		const handleContractCommand = vi.fn();
		const editor = { setText: vi.fn(), addToHistory: vi.fn() };
		const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
		const context = { defaultEditor, editor, handleContractCommand };
		prototype.setupEditorSubmitHandler.call(context);

		await defaultEditor.onSubmit?.("/contract pending");

		expect(handleContractCommand).toHaveBeenCalledWith("/contract pending");
		expect(editor.setText).toHaveBeenCalledWith("");
	});

	it("renders the authoritative contract, derived goal, ledger, open tasks, and pending changes", () => {
		const session = {
			getTaskContract: () => ({
				contractId: "C1",
				version: 3,
				goal: "Ship the contract command",
				derivedGoal: { text: "Implement and test /contract" },
				acceptanceCriteria: ["Focused tests pass"],
				constraints: [{ id: "C-1", kind: "negative", text: "Do not edit AgentSession" }],
				permissions: { allow: ["edit"], deny: [], approvalRequired: [] },
				budgets: {},
				outputContract: undefined,
			}),
			getTaskLedgerState: () => ({
				branchId: "branch-1",
				ledgerVersion: 8,
				focusTaskId: "T1",
				tasks: [
					{ taskId: "T1", status: "active", goal: { normalized: "Implement command" } },
					{ taskId: "T2", status: "completed", goal: { normalized: "Write design" } },
				],
				pending: [
					{
						pendingChangeId: "P4",
						ambiguous: true,
						reason: "May apply to either task",
						candidateTaskIds: ["T1", "T2"],
						operations: [{ operation: "REFINE_TASK", taskId: "T1" }],
					},
				],
			}),
			getLatestTaskReconciliation: () => ({
				reportId: "recon-1",
				findings: [{ findingId: "rf-1" }],
			}),
		};
		const context = commandContext(session);

		prototype.handleContractCommand.call(context, "/contract");

		const output = rendered(context.chatContainer);
		expect(output).toContain("Global contract goal (legacy, non-authoritative): Ship the contract command");
		expect(output).toContain("Derived goal: Implement and test /contract");
		expect(output).toContain("Ledger version: 8");
		expect(output).toContain("Focus task: T1 [active] Implement command");
		expect(output).toContain("- T1 [active] Implement command");
		expect(output).not.toContain("- T2 [completed] Write design");
		expect(output).toContain("P4 [ambiguous]: May apply to either task");
		expect(output).toContain("Branch: branch-1");
		expect(output).toContain("recon-1: 1 finding(s)");
	});

	it("forces and renders a read-only reconciliation report", async () => {
		const report: ReconciliationReport = {
			reportId: "recon-1",
			sessionId: "s-1",
			branchId: "branch-1",
			taskRef: "task://T1/v2",
			taskVersion: 2,
			ledgerVersion: 2,
			fromEventSeq: 1,
			toEventSeq: 8,
			evaluatorPolicyVersion: "test",
			findings: [
				{
					findingId: "rf-1",
					kind: "missing_delta",
					severity: "warning",
					message: "README exclusion is missing",
					sourceEventIds: ["ev-2"],
					suggestedOperations: [{ operation: "PATCH_TASK_CONTRACT", taskId: "T1" }],
				},
			],
			reportHash: "hash",
			checkedAt: "2026-08-24T00:00:00.000Z",
		};
		const reconcileTaskContract = vi.fn(async () => report);
		const context = commandContext({ isIdle: true, isCompacting: false, reconcileTaskContract });

		prototype.handleContractCommand.call(context, "/contract reconcile");
		await vi.waitFor(() => expect(reconcileTaskContract).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(rendered(context.chatContainer)).toContain("README exclusion is missing"));
		expect(context.showStatus).toHaveBeenCalledWith("Reconciling task contract...");
		expect(rendered(context.chatContainer)).toContain("Suggestions: PATCH_TASK_CONTRACT");
	});

	it("sets the authoritative focused-task goal", () => {
		const setCurrentTaskGoal = vi.fn(() => ({ taskId: "T1", version: 2 }));
		const context = commandContext({ isIdle: true, isCompacting: false, setCurrentTaskGoal });
		prototype.handleContractCommand.call(context, "/contract set Use the explicit goal");
		expect(setCurrentTaskGoal).toHaveBeenCalledWith("Use the explicit goal");
		expect(context.showStatus).toHaveBeenCalledWith("Focus task T1 updated to v2");
	});

	it("confirms a derived goal and surfaces the no-derived error", () => {
		const confirmDerivedGoal = vi.fn();
		const successContext = commandContext({ isIdle: true, isCompacting: false, confirmDerivedGoal });
		prototype.handleContractCommand.call(successContext, "/contract confirm");
		expect(confirmDerivedGoal).toHaveBeenCalledOnce();
		expect(successContext.showStatus).toHaveBeenCalledWith("Derived goal confirmed");

		const errorContext = commandContext({
			isIdle: true,
			isCompacting: false,
			confirmDerivedGoal: () => {
				throw new Error("No derived goal to confirm");
			},
		});
		prototype.handleContractCommand.call(errorContext, "/contract confirm");
		expect(errorContext.showError).toHaveBeenCalledWith("No derived goal to confirm");
	});

	it("renders pending changes and parses numeric and stable selectors for accept and reject", () => {
		const pending = [
			{
				pendingChangeId: "P7",
				ambiguous: false,
				reason: "first",
				candidateTaskIds: ["T1"],
				operations: [{ operation: "REFINE_TASK", taskId: "T1" }],
			},
			{
				pendingChangeId: "P9",
				ambiguous: true,
				reason: "second",
				candidateTaskIds: ["T2", "T3"],
				operations: [{ operation: "CREATE_SUBTASK" }],
			},
		];
		const acceptPendingGoalChange = vi.fn();
		const rejectPendingGoalChange = vi.fn();
		const session = {
			isIdle: true,
			isCompacting: false,
			getTaskLedgerState: () => ({ ledgerVersion: 1, focusTaskId: "T1", tasks: [], pending }),
			acceptPendingGoalChange,
			rejectPendingGoalChange,
		};
		const context = commandContext(session);

		prototype.handleContractCommand.call(context, "/contract pending");
		expect(rendered(context.chatContainer)).toContain("2. P9 [ambiguous]: second");

		prototype.handleContractCommand.call(context, "/contract accept 2 T3");
		expect(acceptPendingGoalChange).toHaveBeenCalledWith("P9", "T3");

		prototype.handleContractCommand.call(context, "/contract reject P7");
		expect(rejectPendingGoalChange).toHaveBeenCalledWith("P7");
	});

	it("surfaces ambiguous ledger errors and guards all mutations while busy or compacting", () => {
		const ambiguousContext = commandContext({
			isIdle: true,
			isCompacting: false,
			acceptPendingGoalChange: () => {
				throw new Error("Pending goal change P2 is ambiguous; candidateTaskId is required");
			},
		});
		prototype.handleContractCommand.call(ambiguousContext, "/contract accept P2");
		expect(ambiguousContext.showError).toHaveBeenCalledWith(
			"Pending goal change P2 is ambiguous; candidateTaskId is required",
		);

		for (const session of [
			{ isIdle: false, isCompacting: false },
			{ isIdle: false, isCompacting: true },
		]) {
			const guarded = {
				...session,
				getTaskContract: vi.fn(),
				setCurrentTaskGoal: vi.fn(),
				confirmDerivedGoal: vi.fn(),
				acceptPendingGoalChange: vi.fn(),
				rejectPendingGoalChange: vi.fn(),
			};
			const context = commandContext(guarded);
			for (const command of [
				"/contract set blocked",
				"/contract confirm",
				"/contract accept P1",
				"/contract reject P1",
			]) {
				prototype.handleContractCommand.call(context, command);
			}
			expect(guarded.setCurrentTaskGoal).not.toHaveBeenCalled();
			expect(guarded.confirmDerivedGoal).not.toHaveBeenCalled();
			expect(guarded.acceptPendingGoalChange).not.toHaveBeenCalled();
			expect(guarded.rejectPendingGoalChange).not.toHaveBeenCalled();
			expect(context.showWarning).toHaveBeenCalledTimes(4);
		}
	});
});
