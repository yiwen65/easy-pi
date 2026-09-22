import { type Component, Loader, type TUI } from "@earendil-works/pi-tui";
import type { WorkingIndicatorOptions } from "../../../core/extensions/index.ts";
import { formatElapsedDuration } from "../../../utils/duration.ts";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { keyText } from "./keybinding-hints.ts";

export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary";

export class StatusIndicator extends Loader {
	readonly kind: StatusIndicatorKind;

	constructor(
		kind: StatusIndicatorKind,
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string,
		indicator?: WorkingIndicatorOptions,
	) {
		super(ui, spinnerColorFn, messageColorFn, message, indicator);
		this.kind = kind;
	}

	dispose(): void {
		this.stop();
	}
}

const ELAPSED_TICK_MS = 1_000;

export class WorkingStatusIndicator extends StatusIndicator {
	private baseMessage: string;
	private readonly startedAt: number;
	private elapsedTimer: ReturnType<typeof setInterval> | undefined;

	/**
	 * @param elapsedMs Time already spent working before this indicator appeared,
	 * so a mid-turn recreation keeps counting from the turn start.
	 */
	constructor(ui: TUI, message: string, indicator?: WorkingIndicatorOptions, elapsedMs = 0) {
		super(
			"working",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			message,
			indicator,
		);
		this.baseMessage = message;
		this.startedAt = Date.now() - Math.max(0, elapsedMs);
		this.applyElapsed();
		this.elapsedTimer = setInterval(() => this.applyElapsed(), ELAPSED_TICK_MS);
		(this.elapsedTimer as { unref?: () => void }).unref?.();
	}

	/** Extension working messages replace the base text; the elapsed suffix stays. */
	override setMessage(message: string): void {
		this.baseMessage = message;
		this.applyElapsed();
	}

	override dispose(): void {
		if (this.elapsedTimer) {
			clearInterval(this.elapsedTimer);
			this.elapsedTimer = undefined;
		}
		super.dispose();
	}

	private applyElapsed(): void {
		const elapsed = formatElapsedDuration(Date.now() - this.startedAt);
		super.setMessage(this.baseMessage.trim() ? `${this.baseMessage} ${elapsed}` : elapsed);
	}
}

export class RetryStatusIndicator extends StatusIndicator {
	private countdown: CountdownTimer | undefined;

	constructor(ui: TUI, attempt: number, maxAttempts: number, delayMs: number, unlimited = false) {
		const retryMessage = (seconds: number) =>
			unlimited
				? `Service unavailable; retrying (attempt ${attempt}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`
				: `Retrying (${attempt}/${maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`;
		super(
			"retry",
			ui,
			(spinner) => theme.fg("warning", spinner),
			(text) => theme.fg("muted", text),
			retryMessage(Math.ceil(delayMs / 1000)),
		);
		this.countdown = new CountdownTimer(
			delayMs,
			ui,
			(seconds) => {
				this.setMessage(retryMessage(seconds));
			},
			() => {
				this.countdown = undefined;
			},
		);
	}

	override dispose(): void {
		this.countdown?.dispose();
		this.countdown = undefined;
		super.dispose();
	}
}

export type CompactionStatusReason = "manual" | "threshold" | "overflow";

export class CompactionStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, reason: CompactionStatusReason) {
		const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
		const label =
			reason === "manual"
				? `Compacting context... ${cancelHint}`
				: `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
		super(
			"compaction",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			label,
		);
	}
}

export class BranchSummaryStatusIndicator extends StatusIndicator {
	constructor(ui: TUI) {
		super(
			"branchSummary",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
		);
	}
}

export class IdleStatus implements Component {
	invalidate(): void {
		// No cached state to invalidate.
	}

	render(width: number): string[] {
		const emptyLine = " ".repeat(width);
		return [emptyLine, emptyLine];
	}
}
