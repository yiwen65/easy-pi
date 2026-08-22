import type { Terminal } from "@earendil-works/pi-tui";

export class TestTerminal implements Terminal {
	private inputHandler: ((data: string) => void) | undefined;
	private resizeHandler: (() => void) | undefined;
	private currentColumns: number;
	private currentRows: number;
	readonly writes: string[] = [];
	startCount = 0;
	stopCount = 0;

	constructor(columns = 80, rows = 24) {
		this.currentColumns = columns;
		this.currentRows = rows;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCount += 1;
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.stopCount += 1;
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	get columns(): number {
		return this.currentColumns;
	}

	get rows(): number {
		return this.currentRows;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(lines: number): void {
		this.writes.push(`[move:${lines}]`);
	}

	hideCursor(): void {
		this.writes.push("[hide-cursor]");
	}

	showCursor(): void {
		this.writes.push("[show-cursor]");
	}

	clearLine(): void {
		this.writes.push("[clear-line]");
	}

	clearFromCursor(): void {
		this.writes.push("[clear-from-cursor]");
	}

	clearScreen(): void {
		this.writes.push("[clear-screen]");
	}

	setTitle(title: string): void {
		this.writes.push(`[title:${title}]`);
	}

	setProgress(active: boolean): void {
		this.writes.push(`[progress:${active}]`);
	}

	sendInput(data: string): void {
		this.inputHandler?.(data);
	}

	resize(columns: number, rows: number): void {
		this.currentColumns = columns;
		this.currentRows = rows;
		this.resizeHandler?.();
	}

	clearWrites(): void {
		this.writes.length = 0;
	}
}
