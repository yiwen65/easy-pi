import {
	type Terminal,
	TuiAltScreen,
	type TuiAltScreenOptions,
	TuiMainScreen,
	type TuiStopOptions,
} from "@earendil-works/pi-tui";
import { ActionTerminal } from "./action-terminal.ts";
import { RuntimeController } from "./runtime-controller.ts";
import type { UiState } from "./state.ts";

export interface ActionDrivenTuiRuntime {
	readonly uiState: UiState;
	flushActions(): void;
}

export interface CreateGrokTuiRuntimeOptions {
	mode: "regular" | "fullscreen";
	terminal: Terminal;
	showHardwareCursor?: boolean;
	logDirectory?: string;
	altScreen?: TuiAltScreenOptions;
}

export class GrokTuiRuntime extends TuiMainScreen implements ActionDrivenTuiRuntime {
	private readonly controller: RuntimeController;
	private starting = false;

	constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string) {
		const actionTerminal = new ActionTerminal(terminal);
		super(actionTerminal, showHardwareCursor, logDirectory);
		this.controller = new RuntimeController(actionTerminal, {
			invalidateComponents: () => super.invalidate(),
			render: (force) => super.requestRender(force),
		});
	}

	get uiState(): UiState {
		return this.controller.state;
	}

	flushActions(): void {
		this.controller.flush();
	}

	override start(): void {
		if (this.uiState.lifecycle === "running") return;
		this.starting = true;
		try {
			super.start();
		} finally {
			this.starting = false;
		}
		this.controller.start();
	}

	override stop(options: TuiStopOptions = {}): void {
		this.controller.stop();
		super.stop(options);
	}

	override requestRender(force = false): void {
		if (this.starting) return;
		this.controller.invalidate(false, force);
	}

	override invalidate(): void {
		this.controller.invalidate(true, true);
	}
}

export class GrokViewportTuiRuntime extends TuiAltScreen implements ActionDrivenTuiRuntime {
	private readonly controller: RuntimeController;
	private starting = false;

	constructor(
		terminal: Terminal,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		options: TuiAltScreenOptions = {},
	) {
		const actionTerminal = new ActionTerminal(terminal);
		super(actionTerminal, showHardwareCursor, logDirectory, options);
		this.controller = new RuntimeController(actionTerminal, {
			invalidateComponents: () => super.invalidate(),
			render: (force) => super.requestRender(force),
		});
	}

	get uiState(): UiState {
		return this.controller.state;
	}

	flushActions(): void {
		this.controller.flush();
	}

	override start(): void {
		if (this.uiState.lifecycle === "running") return;
		this.starting = true;
		try {
			super.start();
		} finally {
			this.starting = false;
		}
		this.controller.start();
	}

	override stop(options: TuiStopOptions = {}): void {
		this.controller.stop();
		super.stop(options);
	}

	override requestRender(force = false): void {
		if (this.starting) return;
		this.controller.invalidate(false, force);
	}

	override invalidate(): void {
		this.controller.invalidate(true, true);
	}
}

export function createGrokTuiRuntime(options: CreateGrokTuiRuntimeOptions): GrokTuiRuntime | GrokViewportTuiRuntime {
	if (options.mode === "fullscreen") {
		return new GrokViewportTuiRuntime(
			options.terminal,
			options.showHardwareCursor,
			options.logDirectory,
			options.altScreen,
		);
	}
	return new GrokTuiRuntime(options.terminal, options.showHardwareCursor, options.logDirectory);
}
