import type { Terminal } from "@earendil-works/pi-tui";
import type { UiAction } from "./actions.ts";

export class ActionTerminal implements Terminal {
	private readonly inner: Terminal;
	private actionSink: ((action: UiAction) => void) | undefined;
	private inputReceiver: ((data: string) => void) | undefined;
	private resizeReceiver: (() => void) | undefined;

	constructor(inner: Terminal) {
		this.inner = inner;
	}

	setActionSink(actionSink: (action: UiAction) => void): void {
		this.actionSink = actionSink;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputReceiver = onInput;
		this.resizeReceiver = onResize;
		this.inner.start(
			(data) => this.actionSink?.({ type: "terminal.input", data }),
			() =>
				this.actionSink?.({
					type: "terminal.resized",
					dimensions: { columns: this.inner.columns, rows: this.inner.rows },
				}),
		);
	}

	stop(): void {
		this.inner.stop();
		this.inputReceiver = undefined;
		this.resizeReceiver = undefined;
	}

	deliverInput(data: string): void {
		this.inputReceiver?.(data);
	}

	deliverResize(): void {
		this.resizeReceiver?.();
	}

	drainInput(maxMs?: number, idleMs?: number): Promise<void> {
		return this.inner.drainInput(maxMs, idleMs);
	}

	write(data: string): void {
		this.inner.write(data);
	}

	get columns(): number {
		return this.inner.columns;
	}

	get rows(): number {
		return this.inner.rows;
	}

	get kittyProtocolActive(): boolean {
		return this.inner.kittyProtocolActive;
	}

	moveBy(lines: number): void {
		this.inner.moveBy(lines);
	}

	hideCursor(): void {
		this.inner.hideCursor();
	}

	showCursor(): void {
		this.inner.showCursor();
	}

	clearLine(): void {
		this.inner.clearLine();
	}

	clearFromCursor(): void {
		this.inner.clearFromCursor();
	}

	clearScreen(): void {
		this.inner.clearScreen();
	}

	setTitle(title: string): void {
		this.inner.setTitle(title);
	}

	setProgress(active: boolean): void {
		this.inner.setProgress(active);
	}
}
