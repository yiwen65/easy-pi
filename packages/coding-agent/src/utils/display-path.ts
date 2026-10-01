import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

/** Fit a display-only path, retaining its identifying filename/tail. Never use for filesystem access. */
export function formatDisplayPath(path: string, width: number): string {
	const columns = Math.max(0, Math.floor(width));
	if (columns === 0) return "";
	const length = visibleWidth(path);
	if (length <= columns) return path;
	return `…${sliceByColumn(path, length - columns + 1, columns - 1, true)}`;
}
