import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import { computeSessionUsageStats, formatTokens } from "../../interactive/components/footer.ts";
import type { GrokChromeTheme } from "../grok-component-factory.ts";

/** Minimal render driver so the stats bar can schedule flash fade-out repaints. */
export interface GrokRenderDriver {
	requestRender(): void;
}

const FLASH_MS = 1200;
const MIN_GAP = 2;

interface StatsSegment {
	/** Stable identity used for change detection / flash. */
	key: string;
	/** Prefix rendered dim (e.g. the arrow or label). */
	symbol: string;
	/** Value rendered bright; flashes accent when it changes. */
	value: string;
}

/**
 * Grok stats bar: restores the native Pi footer information (token totals,
 * latest cache-read ratio, cost) on the left and `model • effort` on the right. Usage segments may briefly flash when they
 * change; model and thinking colors update immediately without a fade repaint.
 */
export class GrokStatsBar implements Component {
	private session: AgentSession;
	private readonly theme: GrokChromeTheme;
	private readonly ui: GrokRenderDriver | undefined;
	private hasRendered = false;
	private readonly lastValues = new Map<string, string>();
	private readonly flashUntil = new Map<string, number>();
	private flashTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(session: AgentSession, theme: GrokChromeTheme, ui?: GrokRenderDriver) {
		this.session = session;
		this.theme = theme;
		this.ui = ui;
	}

	setSession(session: AgentSession): void {
		this.session = session;
		this.hasRendered = false;
		this.lastValues.clear();
		this.flashUntil.clear();
	}

	dispose(): void {
		if (this.flashTimer) {
			clearTimeout(this.flashTimer);
			this.flashTimer = undefined;
		}
	}

	invalidate(): void {
		// Stats are recomputed from the session on every render.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const left = this.renderLeft();
		const right = this.renderRight();
		const leftWidth = visibleWidth(left);
		const rightWidth = visibleWidth(right);

		if (leftWidth + MIN_GAP + rightWidth <= safeWidth) {
			return [left + " ".repeat(safeWidth - leftWidth - rightWidth) + right];
		}
		return wrapTextWithAnsi(left ? `${left}${" ".repeat(MIN_GAP)}${right}` : right, safeWidth);
	}

	private renderLeft(): string {
		const { totals, latestCacheReadRatio } = computeSessionUsageStats(this.session);
		const state = this.session.state;

		const segments: StatsSegment[] = [];
		if (totals.input) segments.push({ key: "in", symbol: "↑", value: formatTokens(totals.input) });
		if (totals.output) segments.push({ key: "out", symbol: "↓", value: formatTokens(totals.output) });
		if (totals.cacheRead) segments.push({ key: "R", symbol: "R", value: formatTokens(totals.cacheRead) });
		if (totals.cacheWrite) segments.push({ key: "W", symbol: "W", value: formatTokens(totals.cacheWrite) });
		if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheReadRatio !== undefined) {
			segments.push({ key: "CR", symbol: "CR", value: `${latestCacheReadRatio.toFixed(1)}%` });
		}

		// Kimi Coding is subscription-backed despite using API-key authentication.
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
			: false;
		if (totals.cost || usingSubscription) {
			segments.push({
				key: "cost",
				symbol: "$",
				value: totals.cost.toFixed(3),
			});
		}

		const rendered = segments.map((segment) => this.renderSegment(segment));
		if (areExperimentalFeaturesEnabled()) {
			rendered.push(`${this.theme.dim("•")} ${this.theme.warning("xp")}`);
		}
		this.hasRendered = true;
		return rendered.join(this.theme.dim(" "));
	}

	private renderSegment(segment: StatsSegment): string {
		const plain = segment.symbol + segment.value;
		const previous = this.lastValues.get(segment.key);
		this.lastValues.set(segment.key, plain);

		if (this.hasRendered && previous !== undefined && previous !== plain) {
			this.flashUntil.set(segment.key, Date.now() + FLASH_MS);
			this.scheduleFlashFade();
		}

		const flashing = (this.flashUntil.get(segment.key) ?? 0) > Date.now();
		const valueStyle = flashing ? this.theme.accent : this.theme.text;
		return this.theme.dim(segment.symbol) + valueStyle(segment.value);
	}

	private scheduleFlashFade(): void {
		if (this.flashTimer || !this.ui) return;
		this.flashTimer = setTimeout(() => {
			this.flashTimer = undefined;
			this.ui?.requestRender();
		}, FLASH_MS + 50);
		this.flashTimer.unref?.();
	}

	private renderRight(): string {
		const state = this.session.state;
		const modelName = state.model?.id || "no-model";
		const level = state.model?.reasoning ? state.thinkingLevel || "off" : "";

		if (!level) return this.theme.accent(modelName);
		const styledLevel = level === "off" ? this.theme.dim(level) : this.theme.thinkingLevel(level, level);
		return this.theme.accent(modelName) + this.theme.muted(" • ") + styledLevel;
	}
}
