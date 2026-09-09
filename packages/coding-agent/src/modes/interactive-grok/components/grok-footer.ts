import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { GrokChromeTheme } from "../grok-component-factory.ts";

/**
 * Grok footer: renders extension-provided statuses only. It renders nothing
 * when there are no statuses, and hides entirely while an extension custom
 * footer replaces it.
 */
export class GrokFooter implements Component {
	private readonly footerData: ReadonlyFooterDataProvider | undefined;
	private readonly theme: GrokChromeTheme;
	private visible = true;

	constructor(theme: GrokChromeTheme, footerData?: ReadonlyFooterDataProvider) {
		this.theme = theme;
		this.footerData = footerData;
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
	}

	invalidate(): void {
		// The component has no render cache.
	}

	render(width: number): string[] {
		if (!this.visible) return [];
		const safeWidth = Math.max(1, Math.floor(width));
		const statuses = this.footerData?.getExtensionStatuses();
		if (!statuses || statuses.size === 0) return [];
		const status = Array.from(statuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text))
			.filter(Boolean)
			.join("  ");
		return status ? wrapTextWithAnsi(this.theme.muted(status), safeWidth) : [];
	}
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}
