import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { computeSessionUsageStats, formatTokens } from "../../interactive/components/footer.ts";
import type { GrokChromeTheme } from "../grok-component-factory.ts";
import { contextColorFor } from "./grok-context-meter.ts";

/** Minimal render driver so the stats bar can schedule flash fade-out repaints. */
export interface GrokRenderDriver {
	requestRender(): void;
}

const FLASH_MS = 1200;
const MIN_GAP = 2;

/**
 * Heat-map escalation for thinking levels: the more compute a level spends,
 * the hotter its color. Makes the current level distinguishable at a glance.
 * Unknown non-off levels (e.g. provider-specific "max") fall back to text.
 */
function thinkingLevelColor(level: string, theme: GrokChromeTheme): (text: string) => string {
	switch (level) {
		case "minimal":
			return theme.muted;
		case "low":
			return theme.text;
		case "medium":
			return theme.accent;
		case "high":
			return theme.warning;
		case "xhigh":
			return theme.error;
		default:
			return theme.text;
	}
}

interface StatsSegment {
	/** Stable identity used for change detection / flash. */
	key: string;
	/** Prefix rendered dim (e.g. the arrow or label). */
	symbol: string;
	/** Value rendered bright; flashes accent when it changes. */
	value: string;
	/** Segments that change continuously (context %) are excluded from flash. */
	flashable: boolean;
}

/**
 * Grok stats bar: restores the native Pi footer information (token totals,
 * cache hit rate, cost, context usage) on the left and `(provider) model •
 * thinking` on the right. Segments whose value changed since the previous
 * render briefly flash in the accent color, then fade back.
 */
export class GrokStatsBar implements Component {
	private session: AgentSession;
	private readonly footerData: ReadonlyFooterDataProvider | undefined;
	private readonly theme: GrokChromeTheme;
	private readonly ui: GrokRenderDriver | undefined;
	private autoCompactEnabled = true;
	private hasRendered = false;
	private readonly lastValues = new Map<string, string>();
	private readonly flashUntil = new Map<string, number>();
	private flashTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		session: AgentSession,
		theme: GrokChromeTheme,
		footerData?: ReadonlyFooterDataProvider,
		ui?: GrokRenderDriver,
	) {
		this.session = session;
		this.theme = theme;
		this.footerData = footerData;
		this.ui = ui;
	}

	setSession(session: AgentSession): void {
		this.session = session;
		this.hasRendered = false;
		this.lastValues.clear();
		this.flashUntil.clear();
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
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
		if (leftWidth + MIN_GAP < safeWidth) {
			const fittedRight = truncateToWidth(right, safeWidth - leftWidth - MIN_GAP, "");
			const fittedRightWidth = visibleWidth(fittedRight);
			return [left + " ".repeat(Math.max(0, safeWidth - leftWidth - fittedRightWidth)) + fittedRight];
		}
		return [truncateToWidth(left, safeWidth, this.theme.dim("…"))];
	}

	private renderLeft(): string {
		const { totals, latestCacheHitRate } = computeSessionUsageStats(this.session);
		const state = this.session.state;

		const segments: StatsSegment[] = [];
		if (totals.input) segments.push({ key: "in", symbol: "↑", value: formatTokens(totals.input), flashable: true });
		if (totals.output)
			segments.push({ key: "out", symbol: "↓", value: formatTokens(totals.output), flashable: true });
		if (totals.cacheRead)
			segments.push({ key: "R", symbol: "R", value: formatTokens(totals.cacheRead), flashable: true });
		if (totals.cacheWrite)
			segments.push({ key: "W", symbol: "W", value: formatTokens(totals.cacheWrite), flashable: true });
		if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			segments.push({ key: "CH", symbol: "CH", value: `${latestCacheHitRate.toFixed(1)}%`, flashable: true });
		}

		// Kimi Coding is subscription-backed despite using API-key authentication.
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
			: false;
		if (totals.cost || usingSubscription) {
			segments.push({
				key: "cost",
				symbol: "$",
				value: `${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`,
				flashable: true,
			});
		}

		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercent = contextUsage?.percent ?? null;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextText =
			contextPercent === null
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}${autoIndicator}`;
		segments.push({ key: "ctx", symbol: "", value: contextText, flashable: false });

		const rendered = segments.map((segment) => this.renderSegment(segment, contextPercent));
		if (areExperimentalFeaturesEnabled()) {
			rendered.push(`${this.theme.dim("•")} ${this.theme.warning("xp")}`);
		}
		this.hasRendered = true;
		return rendered.join(this.theme.dim(" "));
	}

	private renderSegment(segment: StatsSegment, contextPercent: number | null): string {
		const plain = segment.symbol + segment.value;
		const previous = this.lastValues.get(segment.key);
		this.lastValues.set(segment.key, plain);

		if (segment.key === "ctx") {
			return contextColorFor(contextPercent, this.theme)(plain);
		}

		if (segment.flashable && this.hasRendered && previous !== undefined && previous !== plain) {
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
		const modelPart = level ? `${modelName} • ${level === "off" ? "thinking off" : level}` : modelName;

		const providerCount = this.footerData?.getAvailableProviderCount() ?? 0;
		const provider = providerCount > 1 && state.model ? state.model.provider : undefined;
		const providerPrefix = provider ? `${this.theme.dim(`(${provider})`)} ` : "";

		// Flash the whole right side briefly when the model or thinking level
		// changes, then settle into the persistent per-level colors.
		const plain = `${provider ?? ""}|${modelPart}`;
		const previous = this.lastValues.get("modelThinking");
		this.lastValues.set("modelThinking", plain);
		if (this.hasRendered && previous !== undefined && previous !== plain) {
			this.flashUntil.set("modelThinking", Date.now() + FLASH_MS);
			this.scheduleFlashFade();
		}
		if ((this.flashUntil.get("modelThinking") ?? 0) > Date.now()) {
			return providerPrefix + this.theme.accent(modelPart);
		}

		if (!level) return providerPrefix + this.theme.accent(modelName);
		const levelLabel = level === "off" ? "thinking off" : level;
		const styledLevel =
			level === "off" ? this.theme.dim(levelLabel) : thinkingLevelColor(level, this.theme)(levelLabel);
		return providerPrefix + this.theme.accent(modelName) + this.theme.muted(" • ") + styledLevel;
	}
}
