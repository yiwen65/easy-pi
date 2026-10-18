import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import * as os from "node:os";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { getAgentDir } from "../../../config.ts";
import { KeybindingsManager } from "../../../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../../../core/session-manager.ts";
import { forgetSessionSummary } from "../../../core/session-summary-index.ts";
import {
	assertSessionTeamDeletionUnchanged,
	deleteAssociatedSessionTeam,
	inspectSessionTeamDeletion,
	type SessionTeamDeletion,
} from "../../../core/session-team-deletion.ts";
import { canonicalizePath as _canonicalizePath } from "../../../utils/paths.ts";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, keyText, rawKeyHint } from "./keybinding-hints.ts";
import { filterAndSortSessions, hasSessionName, type NameFilter, type SortMode } from "./session-selector-search.ts";

type SessionScope = "current" | "all";

function shortenPath(path: string): string {
	const home = os.homedir();
	if (!path) return path;
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

function formatSessionDate(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

function canonicalizePath(path: string | undefined): string | undefined {
	if (!path) return path;
	return _canonicalizePath(path);
}

class SessionSelectorHeader implements Component {
	private scope: SessionScope;
	private sortMode: SortMode;
	private nameFilter: NameFilter;
	private requestRender: () => void;
	private loading = false;
	private loadProgress: { loaded: number; total: number } | null = null;
	private showPath = false;
	private confirmingDeletePath: string | null = null;
	private statusMessage: { type: "info" | "error"; message: string } | null = null;
	private statusTimeout: ReturnType<typeof setTimeout> | null = null;
	private showRenameHint = false;
	private showEmpty = false;
	private keybindings: KeybindingsManager;

	constructor(
		scope: SessionScope,
		sortMode: SortMode,
		nameFilter: NameFilter,
		requestRender: () => void,
		keybindings: KeybindingsManager,
	) {
		this.scope = scope;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.requestRender = requestRender;
		this.keybindings = keybindings;
	}

	setShowEmpty(show: boolean): void {
		this.showEmpty = show;
	}

	setScope(scope: SessionScope): void {
		this.scope = scope;
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
	}

	setLoading(loading: boolean): void {
		this.loading = loading;
		// Progress is scoped to the current load; clear whenever the loading state is set
		this.loadProgress = null;
	}

	setProgress(loaded: number, total: number): void {
		this.loadProgress = { loaded, total };
	}

	setShowPath(showPath: boolean): void {
		this.showPath = showPath;
	}

	setShowRenameHint(show: boolean): void {
		this.showRenameHint = show;
	}

	setConfirmingDeletePath(path: string | null): void {
		this.confirmingDeletePath = path;
	}

	private clearStatusTimeout(): void {
		if (!this.statusTimeout) return;
		clearTimeout(this.statusTimeout);
		this.statusTimeout = null;
	}

	setStatusMessage(msg: { type: "info" | "error"; message: string } | null, autoHideMs?: number): void {
		this.clearStatusTimeout();
		this.statusMessage = msg;
		if (!msg || !autoHideMs) return;

		this.statusTimeout = setTimeout(() => {
			this.statusMessage = null;
			this.statusTimeout = null;
			this.requestRender();
		}, autoHideMs);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const title = this.scope === "current" ? "Resume Session (Current Folder)" : "Resume Session (All)";
		const leftText = theme.bold(title);

		const sortLabel = this.sortMode === "threaded" ? "Threaded" : this.sortMode === "recent" ? "Recent" : "Fuzzy";
		const sortText = theme.fg("muted", "Sort: ") + theme.fg("accent", sortLabel);

		const nameLabel = this.nameFilter === "all" ? "All" : "Named";
		const nameText = theme.fg("muted", "Name: ") + theme.fg("accent", nameLabel);

		let scopeText: string;
		if (this.loading) {
			const progressText = this.loadProgress ? `${this.loadProgress.loaded}/${this.loadProgress.total}` : "...";
			scopeText = theme.fg("accent", `Loading ${progressText}`);
		} else if (this.scope === "current") {
			scopeText = `${theme.fg("accent", "◉ Current Folder")}${theme.fg("muted", " | ○ All")}`;
		} else {
			scopeText = `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", "◉ All")}`;
		}

		const rightText = truncateToWidth(`${scopeText}  ${nameText}  ${sortText}`, width, "");
		const availableLeft = Math.max(0, width - visibleWidth(rightText) - 1);
		const left = truncateToWidth(leftText, availableLeft, "");
		const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(rightText));

		// Build hint lines - changes based on state (all branches truncate to width)
		let hintLine1: string;
		let hintLine2: string;
		if (this.confirmingDeletePath !== null) {
			const confirmHint = `Delete session? ${keyHint("tui.select.confirm", "confirm")} · ${keyHint("tui.select.cancel", "cancel")}`;
			hintLine1 = theme.fg("error", truncateToWidth(confirmHint, width, "…"));
			hintLine2 = "";
		} else if (this.statusMessage) {
			const color = this.statusMessage.type === "error" ? "error" : "accent";
			hintLine1 = theme.fg(color, truncateToWidth(this.statusMessage.message, width, "…"));
			hintLine2 = "";
		} else {
			const pathState = this.showPath ? "(on)" : "(off)";
			const sep = theme.fg("muted", " · ");
			const hint1 =
				keyHint("tui.input.tab", "scope") +
				sep +
				rawKeyHint(
					this.keybindings.getKeys("app.session.toggleEmptyFilter").join("/"),
					`empty(${this.showEmpty ? "shown" : "hidden"})`,
				) +
				sep +
				theme.fg("muted", 're:<pattern> regex · "phrase" exact');
			const hint2Parts = [
				keyHint("app.session.toggleSort", "sort"),
				keyHint("app.session.toggleNamedFilter", "named"),
				keyHint("app.session.delete", "delete"),
				keyHint("app.session.togglePath", `path ${pathState}`),
			];
			if (this.showRenameHint) {
				hint2Parts.push(keyHint("app.session.rename", "rename"));
			}
			const hint2 = hint2Parts.join(sep);
			hintLine1 = truncateToWidth(hint1, width, "…");
			hintLine2 = truncateToWidth(hint2, width, "…");
		}

		return [`${left}${" ".repeat(spacing)}${rightText}`, hintLine1, hintLine2];
	}
}

/** A session tree node for hierarchical display */
interface SessionTreeNode {
	session: SessionInfo;
	children: SessionTreeNode[];
	latestActivity: number;
}

/** Flattened node for display with tree structure info */
interface FlatSessionNode {
	session: SessionInfo;
	depth: number;
	isLast: boolean;
	/** For each ancestor level, whether there are more siblings after it */
	ancestorContinues: boolean[];
}

/**
 * Build a tree structure from sessions based on parentSessionPath.
 * Returns root nodes sorted by modified date (descending).
 */
function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
	const byPath = new Map<string, SessionTreeNode>();

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path) ?? session.path;
		byPath.set(sessionPath, { session, children: [], latestActivity: session.modified.getTime() });
	}

	const roots: SessionTreeNode[] = [];

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path) ?? session.path;
		const node = byPath.get(sessionPath)!;
		const parentPath = canonicalizePath(session.parentSessionPath);

		if (parentPath && byPath.has(parentPath)) {
			byPath.get(parentPath)!.children.push(node);
		} else {
			roots.push(node);
		}
	}

	const updateLatestActivity = (node: SessionTreeNode): number => {
		let latestActivity = node.session.modified.getTime();
		for (const child of node.children) {
			latestActivity = Math.max(latestActivity, updateLatestActivity(child));
		}
		node.latestActivity = latestActivity;
		return latestActivity;
	};

	for (const root of roots) {
		updateLatestActivity(root);
	}

	// Sort children and roots by latest activity in each subtree (descending)
	const sortNodes = (nodes: SessionTreeNode[]): void => {
		nodes.sort((a, b) => b.latestActivity - a.latestActivity);
		for (const node of nodes) {
			sortNodes(node.children);
		}
	};
	sortNodes(roots);

	return roots;
}

/**
 * Flatten tree into display list with tree structure metadata.
 */
function flattenSessionTree(roots: SessionTreeNode[]): FlatSessionNode[] {
	const result: FlatSessionNode[] = [];

	const walk = (node: SessionTreeNode, depth: number, ancestorContinues: boolean[], isLast: boolean): void => {
		result.push({ session: node.session, depth, isLast, ancestorContinues });

		for (let i = 0; i < node.children.length; i++) {
			const childIsLast = i === node.children.length - 1;
			// Only show continuation line for non-root ancestors
			const continues = depth > 0 ? !isLast : false;
			walk(node.children[i]!, depth + 1, [...ancestorContinues, continues], childIsLast);
		}
	};

	for (let i = 0; i < roots.length; i++) {
		walk(roots[i]!, 0, [], i === roots.length - 1);
	}

	return result;
}

/**
 * Custom session list component with multi-line items and search
 */
class SessionList implements Component, Focusable {
	public getSelectedSessionPath(): string | undefined {
		const selected = this.filteredSessions[this.selectedIndex];
		return selected?.session.path;
	}
	private allSessions: SessionInfo[] = [];
	private filteredSessions: FlatSessionNode[] = [];
	private selectedIndex: number = 0;
	private selectionTouched = false;
	private searchInput: Input;
	private showCwd = false;
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private showEmpty = false;
	private loading = false;
	private keybindings: KeybindingsManager;
	private showPath = false;
	private confirmingDeletePath: string | null = null;
	private currentSessionCanonicalPath?: string;
	public onSelect?: (sessionPath: string) => void;
	public onCancel?: () => void;
	public onExit: () => void = () => {};
	public onToggleScope?: () => void;
	public onToggleSort?: () => void;
	public onToggleNameFilter?: () => void;
	public onToggleEmptyFilter?: () => void;
	public onTogglePath?: (showPath: boolean) => void;
	public onDeleteConfirmationChange?: (path: string | null) => void;
	public onDeleteSession?: (sessionPath: string) => Promise<void>;
	public onRenameSession?: (sessionPath: string) => void;
	public onError?: (message: string) => void;
	private maxVisible: number = 10; // Max sessions visible (one line each)

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		sessions: SessionInfo[],
		showCwd: boolean,
		sortMode: SortMode,
		nameFilter: NameFilter,
		keybindings: KeybindingsManager,
		currentSessionFilePath?: string,
	) {
		this.allSessions = sessions;
		this.filteredSessions = [];
		this.searchInput = new Input();
		this.showCwd = showCwd;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.keybindings = keybindings;
		this.currentSessionCanonicalPath = canonicalizePath(currentSessionFilePath);
		this.filterSessions("");

		// Handle Enter in search input - select current item
		this.searchInput.onSubmit = () => {
			if (this.filteredSessions[this.selectedIndex]) {
				const selected = this.filteredSessions[this.selectedIndex];
				if (this.onSelect) {
					this.onSelect(selected.session.path);
				}
			}
		};
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
		this.filterSessions(this.searchInput.getValue());
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
		this.filterSessions(this.searchInput.getValue());
	}

	setShowEmpty(show: boolean): void {
		this.showEmpty = show;
		this.filterSessions(this.searchInput.getValue());
	}

	setLoading(loading: boolean): void {
		this.loading = loading;
	}

	setSessions(sessions: SessionInfo[], showCwd: boolean): void {
		this.allSessions = sessions;
		this.showCwd = showCwd;
		this.filterSessions(this.searchInput.getValue());
	}

	private filterSessions(query: string): void {
		const selectedPath = this.selectionTouched ? this.getSelectedSessionPath() : undefined;
		const trimmed = query.trim();
		const nameFiltered = this.allSessions.filter(
			(session) =>
				(this.showEmpty || session.isMetadataOnly !== true || hasSessionName(session)) &&
				(this.nameFilter === "all" || hasSessionName(session)),
		);

		if (this.sortMode === "threaded" && !trimmed) {
			// Threaded mode without search: show tree structure
			const roots = buildSessionTree(nameFiltered);
			this.filteredSessions = flattenSessionTree(roots);
		} else {
			// Other modes or with search: flat list
			const filtered = filterAndSortSessions(nameFiltered, query, this.sortMode, "all");
			this.filteredSessions = filtered.map((session) => ({
				session,
				depth: 0,
				isLast: true,
				ancestorContinues: [],
			}));
		}
		const selectedIndex = this.filteredSessions.findIndex((node) => node.session.path === selectedPath);
		this.selectedIndex =
			selectedIndex >= 0
				? selectedIndex
				: this.selectionTouched
					? Math.max(0, Math.min(this.selectedIndex, this.filteredSessions.length - 1))
					: 0;
	}

	private setConfirmingDeletePath(path: string | null): void {
		this.confirmingDeletePath = path;
		this.onDeleteConfirmationChange?.(path);
	}

	private startDeleteConfirmationForSelectedSession(): void {
		const selected = this.filteredSessions[this.selectedIndex];
		if (!selected) return;

		// Prevent deleting current session
		if (this.isCurrentSessionPath(selected.session.path)) {
			this.onError?.("Cannot delete the currently active session");
			return;
		}

		this.setConfirmingDeletePath(selected.session.path);
	}

	private isCurrentSessionPath(path: string): boolean {
		if (!this.currentSessionCanonicalPath) return false;
		return (canonicalizePath(path) ?? path) === this.currentSessionCanonicalPath;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		// Render search input
		lines.push(...this.searchInput.render(width));
		lines.push(""); // Blank line after search

		if (this.filteredSessions.length === 0) {
			let emptyMessage: string;
			if (this.loading) {
				emptyMessage = "  Loading sessions...";
			} else if (this.nameFilter === "named") {
				const toggleKey = keyText("app.session.toggleNamedFilter");
				if (this.showCwd) {
					emptyMessage = `  No named sessions found. Press ${toggleKey} to show all.`;
				} else {
					emptyMessage = `  No named sessions in current folder. Press ${toggleKey} to show all, or Tab to view all.`;
				}
			} else if (
				!this.showEmpty &&
				this.allSessions.some((session) => session.isMetadataOnly === true && !hasSessionName(session))
			) {
				const toggleKey = this.keybindings.getKeys("app.session.toggleEmptyFilter").join("/");
				emptyMessage = `  No matching visible sessions. Press ${toggleKey} to show empty sessions.`;
			} else if (this.showCwd) {
				// "All" scope - no sessions anywhere that match filter
				emptyMessage = "  No sessions found";
			} else {
				// "Current folder" scope - hint to try "all"
				emptyMessage = "  No sessions in current folder. Press Tab to view all.";
			}
			lines.push(theme.fg("muted", truncateToWidth(emptyMessage, width, "…")));
			return lines;
		}

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredSessions.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredSessions.length);

		// Render visible sessions (one line each with tree structure)
		for (let i = startIndex; i < endIndex; i++) {
			const node = this.filteredSessions[i]!;
			const session = node.session;
			const isSelected = i === this.selectedIndex;
			const isConfirmingDelete = session.path === this.confirmingDeletePath;
			const isCurrent = this.isCurrentSessionPath(session.path);

			// Build tree prefix
			const prefix = this.buildTreePrefix(node);

			// Session display text (name or first message)
			const hasName = !!session.name;
			let displayText = session.name ?? session.firstMessage;
			if (!hasSessionName(session) && session.firstMessage === "(no messages)") {
				if (session.isMetadataOnly === true) displayText = "(not started)";
				else if (session.messageCount > 0) displayText = "(no user text)";
				else if (session.isMetadataOnly === false) displayText = "(session state)";
			}
			const normalizedMessage = displayText.replace(/[\x00-\x1f\x7f]/g, " ").trim();

			// Right side: message count and age
			const age = formatSessionDate(session.modified);
			const msgCount = String(session.messageCount);
			let rightPart = `${msgCount} ${age}`;
			if (this.showCwd && session.cwd) {
				rightPart = `${shortenPath(session.cwd)} ${rightPart}`;
			}
			if (this.showPath) {
				rightPart = `${shortenPath(session.path)} ${rightPart}`;
			}

			// Cursor
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";

			// Calculate available width for message
			const prefixWidth = visibleWidth(prefix);
			const rightWidth = visibleWidth(rightPart) + 2; // +2 for spacing
			const availableForMsg = width - 2 - prefixWidth - rightWidth; // -2 for cursor

			const truncatedMsg = truncateToWidth(normalizedMessage, Math.max(10, availableForMsg), "…");

			// Style message
			let messageColor: "error" | "warning" | "accent" | null = null;
			if (isConfirmingDelete) {
				messageColor = "error";
			} else if (isCurrent) {
				messageColor = "accent";
			} else if (hasName) {
				messageColor = "warning";
			}
			let styledMsg = messageColor ? theme.fg(messageColor, truncatedMsg) : truncatedMsg;
			if (isSelected) {
				styledMsg = theme.bold(styledMsg);
			}

			// Build line
			const leftPart = cursor + theme.fg("dim", prefix) + styledMsg;
			const leftWidth = visibleWidth(leftPart);
			const spacing = Math.max(1, width - leftWidth - visibleWidth(rightPart));
			const styledRight = theme.fg(isConfirmingDelete ? "error" : "dim", rightPart);

			let line = leftPart + " ".repeat(spacing) + styledRight;
			if (isSelected) {
				line = theme.bg("selectedBg", line);
			}
			lines.push(truncateToWidth(line, width));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredSessions.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredSessions.length})`;
			const scrollInfo = theme.fg("muted", truncateToWidth(scrollText, width, ""));
			lines.push(scrollInfo);
		}

		return lines;
	}

	private buildTreePrefix(node: FlatSessionNode): string {
		if (node.depth === 0) {
			return "";
		}

		const parts = node.ancestorContinues.map((continues) => (continues ? "│  " : "   "));
		const branch = node.isLast ? "└─ " : "├─ ";
		return parts.join("") + branch;
	}

	handleInput(keyData: string): void {
		this.selectionTouched = true;
		const kb = getKeybindings();

		// Handle delete confirmation state first - intercept all keys
		if (this.confirmingDeletePath !== null) {
			if (kb.matches(keyData, "tui.select.confirm")) {
				const pathToDelete = this.confirmingDeletePath;
				this.setConfirmingDeletePath(null);
				void this.onDeleteSession?.(pathToDelete);
				return;
			}
			if (kb.matches(keyData, "tui.select.cancel")) {
				this.setConfirmingDeletePath(null);
				return;
			}
			// Ignore all other keys while confirming
			return;
		}

		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.onToggleScope) {
				this.onToggleScope();
			}
			return;
		}

		if (kb.matches(keyData, "app.session.toggleSort")) {
			this.onToggleSort?.();
			return;
		}

		if (this.keybindings.matches(keyData, "app.session.toggleNamedFilter")) {
			this.onToggleNameFilter?.();
			return;
		}

		if (this.keybindings.matches(keyData, "app.session.toggleEmptyFilter")) {
			this.onToggleEmptyFilter?.();
			return;
		}

		// Ctrl+P: toggle path display
		if (kb.matches(keyData, "app.session.togglePath")) {
			this.showPath = !this.showPath;
			this.onTogglePath?.(this.showPath);
			return;
		}

		// Ctrl+D: initiate delete confirmation (useful on terminals that don't distinguish Ctrl+Backspace from Backspace)
		if (kb.matches(keyData, "app.session.delete")) {
			this.startDeleteConfirmationForSelectedSession();
			return;
		}

		// Rename selected session
		if (kb.matches(keyData, "app.session.rename")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected) {
				this.onRenameSession?.(selected.session.path);
			}
			return;
		}

		// Ctrl+Backspace: non-invasive convenience alias for delete
		// Only triggers deletion when the query is empty; otherwise it is forwarded to the input
		if (kb.matches(keyData, "app.session.deleteNoninvasive")) {
			if (this.searchInput.getValue().length > 0) {
				this.searchInput.handleInput(keyData);
				this.filterSessions(this.searchInput.getValue());
				return;
			}

			this.startDeleteConfirmationForSelectedSession();
			return;
		}

		// Up arrow
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		}
		// Down arrow
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + 1);
		}
		// Page up - jump up by maxVisible items
		else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
		}
		// Page down - jump down by maxVisible items
		else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + this.maxVisible);
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.session.path);
			}
		}
		// Escape - cancel
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterSessions(this.searchInput.getValue());
		}
	}
}

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

type ScopeLoadState = {
	seq: number;
	sessions: SessionInfo[] | null;
	loading: boolean;
	progress: { loaded: number; total: number } | null;
	pending: readonly SessionInfo[] | null;
	timer: ReturnType<typeof setTimeout> | null;
};

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink
 */
async function deleteSessionFile(
	sessionPath: string,
): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
	// Try `trash` first (if installed)
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) {
			parts.push(trashResult.error.message);
		}
		const stderr = trashResult.stderr?.trim();
		if (stderr) {
			parts.push(stderr.split("\n")[0] ?? stderr);
		}
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" · ").slice(0, 200)}`;
	};

	// If trash reports success, or the file is gone afterwards, treat it as successful
	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return { ok: true, method: "trash" };
	}

	// Fallback to permanent deletion
	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, method: "unlink", error };
	}
}

/**
 * Component that renders a session selector
 */
export class SessionSelectorComponent extends Container implements Focusable {
	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.mode === "rename") {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.select.cancel")) {
				this.exitRenameMode();
				return;
			}
			this.renameInput.handleInput(data);
			return;
		}

		if (this.mode === "delete") {
			this.deleteChoice?.handleInput(data);
			return;
		}
		if (this.mode === "deleting") return;
		this.sessionList.handleInput(data);
	}

	private canRename = true;
	private sessionList: SessionList;
	private header: SessionSelectorHeader;
	private keybindings: KeybindingsManager;
	private scope: SessionScope = "current";
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private showEmpty = false;
	private disposed = false;
	private loads: Record<SessionScope, ScopeLoadState> = {
		current: { seq: 0, sessions: null, loading: false, progress: null, pending: null, timer: null },
		all: { seq: 0, sessions: null, loading: false, progress: null, pending: null, timer: null },
	};
	private currentSessionsLoader: SessionsLoader;
	private allSessionsLoader: SessionsLoader;
	private requestRender: () => void;
	private renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;

	private mode: "list" | "rename" | "delete" | "deleting" = "list";
	private deleteChoice?: SelectList;
	private agentDir: string;
	private renameInput = new Input();
	private renameTargetPath: string | null = null;

	// Focusable implementation - propagate to sessionList for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.sessionList.focused = value;
		this.renameInput.focused = value;
		if (value && this.mode === "rename") {
			this.renameInput.focused = true;
		}
	}

	private buildBaseLayout(content: Component, options?: { showHeader?: boolean }): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));
		if (options?.showHeader ?? true) {
			this.addChild(this.header);
			this.addChild(new Spacer(1));
		}
		this.addChild(content);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
	}

	constructor(
		currentSessionsLoader: SessionsLoader,
		allSessionsLoader: SessionsLoader,
		onSelect: (sessionPath: string) => void,
		onCancel: () => void,
		onExit: () => void,
		requestRender: () => void,
		options?: {
			/** Team storage is separate from the session directory. */
			agentDir?: string;
			renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
			showRenameHint?: boolean;
			keybindings?: KeybindingsManager;
		},
		currentSessionFilePath?: string,
	) {
		super();
		this.keybindings = options?.keybindings ?? KeybindingsManager.create();
		this.agentDir = options?.agentDir ?? getAgentDir();
		this.currentSessionsLoader = currentSessionsLoader;
		this.allSessionsLoader = allSessionsLoader;
		this.requestRender = () => {
			if (!this.disposed) requestRender();
		};
		this.header = new SessionSelectorHeader(
			this.scope,
			this.sortMode,
			this.nameFilter,
			this.requestRender,
			this.keybindings,
		);
		const renameSession = options?.renameSession;
		this.renameSession = renameSession;
		this.canRename = !!renameSession;
		this.header.setShowRenameHint(options?.showRenameHint ?? this.canRename);

		// Create session list (starts empty, will be populated after load)
		this.sessionList = new SessionList(
			[],
			false,
			this.sortMode,
			this.nameFilter,
			this.keybindings,
			currentSessionFilePath,
		);

		this.buildBaseLayout(this.sessionList);

		this.renameInput.onSubmit = (value) => {
			void this.confirmRename(value);
		};

		this.sessionList.onSelect = (sessionPath) => {
			if (this.disposed) return;
			this.dispose();
			onSelect(sessionPath);
		};
		this.sessionList.onCancel = () => {
			if (this.disposed) return;
			this.dispose();
			onCancel();
		};
		this.sessionList.onExit = () => {
			if (this.disposed) return;
			this.dispose();
			onExit();
		};
		this.sessionList.onToggleScope = () => this.toggleScope();
		this.sessionList.onToggleSort = () => this.toggleSortMode();
		this.sessionList.onToggleNameFilter = () => this.toggleNameFilter();
		this.sessionList.onToggleEmptyFilter = () => {
			this.showEmpty = !this.showEmpty;
			this.header.setShowEmpty(this.showEmpty);
			this.sessionList.setShowEmpty(this.showEmpty);
			this.requestRender();
		};
		this.sessionList.onRenameSession = (sessionPath) => {
			if (!renameSession) return;
			if (this.loads[this.scope].loading) return;

			const sessions = this.loads[this.scope].sessions ?? [];
			const session = sessions.find((s) => s.path === sessionPath);
			this.enterRenameMode(sessionPath, session?.name);
		};

		// Sync list events to header
		this.sessionList.onTogglePath = (showPath) => {
			this.header.setShowPath(showPath);
			this.requestRender();
		};
		this.sessionList.onDeleteConfirmationChange = (path) => {
			this.header.setConfirmingDeletePath(path);
			this.requestRender();
		};
		this.sessionList.onError = (msg) => {
			this.header.setStatusMessage({ type: "error", message: msg }, 3000);
			this.requestRender();
		};

		// Handle session deletion
		this.sessionList.onDeleteSession = async (sessionPath: string) => {
			try {
				const selected = inspectSessionTeamDeletion(sessionPath, this.agentDir);
				if (selected.team.owner === "live") throw new Error("Another live process owns this session's team");
				if (selected.team.state === "missing" || selected.team.state === "deleted") {
					await this.performDeletion(selected, false);
				} else {
					this.chooseDeletionScope(selected);
				}
			} catch (error) {
				this.header.setStatusMessage({
					type: "error",
					message: `Deletion refused: ${error instanceof Error ? error.message : String(error)}`,
				});
				this.requestRender();
			}
		};

		// Start loading current sessions immediately
		this.loadCurrentSessions();
	}

	private chooseDeletionScope(selected: SessionTeamDeletion): void {
		this.mode = "delete";
		const team = selected.team;
		const panel = new Container();
		panel.addChild(new Text(theme.bold("Delete session: choose history scope"), 1, 0));
		panel.addChild(
			new Text(
				`${team.agentCount ?? "Unknown"} children · ${team.bytes} known team bytes${team.incomplete ? " (incomplete scan)" : ""}\n${team.pendingMessages ?? "Unknown"} pending messages · ${team.unfinishedTurns ?? "Unknown"} unfinished · ${team.interruptedTurns ?? "Unknown"} interrupted turns.\nTeam deletion is permanent; workspace files and referenced artifacts are never deleted.`,
				1,
				0,
			),
		);
		panel.addChild(new Spacer(1));
		const choices = new SelectList(
			[
				{ value: "cancel", label: "Cancel", description: "Keep the session and team history" },
				{
					value: "team",
					label: "Delete session and team",
					description: "Permanently delete all child history and results; retryable if interrupted",
				},
				{
					value: "session",
					label: "Delete session only",
					description: "Keep team data on disk; inspect it later with /agents storage",
				},
			],
			3,
			getSelectListTheme(),
		);
		const cancel = () => {
			this.mode = "list";
			this.deleteChoice = undefined;
			this.buildBaseLayout(this.sessionList);
			this.requestRender();
		};
		choices.onCancel = cancel;
		choices.onSelect = (item) => {
			if (item.value === "cancel") cancel();
			else void this.performDeletion(selected, item.value === "team");
		};
		this.deleteChoice = choices;
		panel.addChild(choices);
		this.buildBaseLayout(panel, { showHeader: false });
		this.requestRender();
	}

	private async performDeletion(selected: SessionTeamDeletion, includeTeam: boolean): Promise<void> {
		this.mode = "deleting";
		this.deleteChoice = undefined;
		try {
			assertSessionTeamDeletionUnchanged(selected);
			if (includeTeam) deleteAssociatedSessionTeam(selected);
			assertSessionTeamDeletionUnchanged(selected);
			const result = await deleteSessionFile(selected.path);
			if (!result.ok) throw new Error(result.error ?? "Session file deletion failed; team deletion can be retried");
			forgetSessionSummary(selected.path, { dev: selected.dev, ino: selected.ino });
			if (this.disposed) return;
			for (const state of Object.values(this.loads)) {
				if (state.sessions) state.sessions = state.sessions.filter((entry) => entry.path !== selected.path);
			}
			this.header.setStatusMessage(
				{
					type: "info",
					message: includeTeam
						? "Session and team history deleted"
						: `${result.method === "trash" ? "Session moved to trash" : "Session deleted"}; team history retained when present`,
				},
				3000,
			);
			await this.refreshSessionsAfterMutation();
		} catch (error) {
			this.header.setStatusMessage({
				type: "error",
				message: `Deletion incomplete: ${error instanceof Error ? error.message : String(error)}`,
			});
		} finally {
			if (!this.disposed) {
				this.mode = "list";
				this.buildBaseLayout(this.sessionList);
				this.requestRender();
			}
		}
	}

	private loadCurrentSessions(): void {
		void this.loadScope("current");
	}

	private enterRenameMode(sessionPath: string, currentName: string | undefined): void {
		this.mode = "rename";
		this.renameTargetPath = sessionPath;
		this.renameInput.setValue(currentName ?? "");
		this.renameInput.focused = true;

		const panel = new Container();
		panel.addChild(new Text(theme.bold("Rename Session"), 1, 0));
		panel.addChild(new Spacer(1));
		panel.addChild(this.renameInput);
		panel.addChild(new Spacer(1));
		panel.addChild(
			new Text(
				theme.fg("muted", `${keyText("tui.select.confirm")} to save · ${keyText("tui.select.cancel")} to cancel`),
				1,
				0,
			),
		);

		this.buildBaseLayout(panel, { showHeader: false });
		this.requestRender();
	}

	private exitRenameMode(): void {
		this.mode = "list";
		this.renameTargetPath = null;

		this.buildBaseLayout(this.sessionList);

		this.requestRender();
	}

	private async confirmRename(value: string): Promise<void> {
		const next = value.trim();
		if (!next) return;
		const target = this.renameTargetPath;
		if (!target) {
			this.exitRenameMode();
			return;
		}

		// Find current name for callback
		const renameSession = this.renameSession;
		if (!renameSession) {
			this.exitRenameMode();
			return;
		}

		try {
			await renameSession(target, next);
			await this.refreshSessionsAfterMutation();
		} finally {
			if (!this.disposed) this.exitRenameMode();
		}
	}

	private clearPendingLoad(state: ScopeLoadState): void {
		if (state.timer !== null) clearTimeout(state.timer);
		state.timer = null;
		state.pending = null;
	}

	private dispose(): void {
		this.disposed = true;
		this.header.setStatusMessage(null);
		for (const state of Object.values(this.loads)) {
			state.seq++;
			this.clearPendingLoad(state);
		}
	}

	private showScope(): void {
		const state = this.loads[this.scope];
		this.header.setScope(this.scope);
		this.header.setLoading(state.loading);
		if (state.progress) this.header.setProgress(state.progress.loaded, state.progress.total);
		this.sessionList.setLoading(state.loading);
		this.sessionList.setSessions(state.sessions ?? [], this.scope === "all");
		this.requestRender();
	}

	private publishProgress(scope: SessionScope): void {
		const state = this.loads[scope];
		const pending = state.pending;
		state.pending = null;
		if (pending !== null) state.sessions = [...pending];
		if (scope !== this.scope) return;
		if (state.progress) this.header.setProgress(state.progress.loaded, state.progress.total);
		if (pending !== null) this.sessionList.setSessions(state.sessions ?? [], scope === "all");
		this.requestRender();
	}

	private async loadScope(scope: SessionScope): Promise<void> {
		if (this.disposed) return;
		const state = this.loads[scope];
		this.clearPendingLoad(state);
		const seq = ++state.seq;
		state.loading = true;
		state.progress = null;
		if (scope === this.scope) this.showScope();

		const isActive = () => !this.disposed && seq === state.seq && state.loading;
		const onProgress: SessionListProgress = (loaded, total, sessions?: readonly SessionInfo[]) => {
			if (!isActive()) return;
			state.progress = { loaded, total };
			if (sessions !== undefined) state.pending = sessions;
			// Publish the first result immediately, then coalesce bursts rather than
			// rebuilding the session tree for every file in a large directory.
			if (state.timer !== null) return;
			this.publishProgress(scope);
			state.timer = setTimeout(() => {
				state.timer = null;
				if (isActive()) this.publishProgress(scope);
			}, 50);
		};

		try {
			const sessions = await (scope === "current"
				? this.currentSessionsLoader(onProgress)
				: this.allSessionsLoader(onProgress));
			if (!isActive()) return;
			this.clearPendingLoad(state);
			state.sessions = sessions;
			state.loading = false;
			state.progress = null;
			if (scope === this.scope) this.showScope();
		} catch (err) {
			if (!isActive()) return;
			this.publishProgress(scope);
			this.clearPendingLoad(state);
			state.loading = false;
			state.progress = null;
			if (scope !== this.scope) return;
			this.showScope();
			const message = err instanceof Error ? err.message : String(err);
			this.header.setStatusMessage({ type: "error", message: `Failed to load sessions: ${message}` }, 4000);
			this.requestRender();
		}
	}

	private toggleSortMode(): void {
		// Cycle: threaded -> recent -> relevance -> threaded
		this.sortMode = this.sortMode === "threaded" ? "recent" : this.sortMode === "recent" ? "relevance" : "threaded";
		this.header.setSortMode(this.sortMode);
		this.sessionList.setSortMode(this.sortMode);
		this.requestRender();
	}

	private toggleNameFilter(): void {
		this.nameFilter = this.nameFilter === "all" ? "named" : "all";
		this.header.setNameFilter(this.nameFilter);
		this.sessionList.setNameFilter(this.nameFilter);
		this.requestRender();
	}

	private async refreshSessionsAfterMutation(): Promise<void> {
		if (this.disposed) return;
		// A rename/delete invalidates both projections, including inactive requests.
		for (const [scope, state] of Object.entries(this.loads)) {
			state.seq++;
			this.clearPendingLoad(state);
			state.loading = false;
			state.progress = null;
			if (scope !== this.scope) state.sessions = null;
		}
		await this.loadScope(this.scope);
	}

	private toggleScope(): void {
		if (this.disposed) return;
		this.scope = this.scope === "current" ? "all" : "current";
		const state = this.loads[this.scope];
		if (state.pending !== null) {
			state.sessions = [...state.pending];
			state.pending = null;
		}
		if (state.sessions === null && !state.loading) {
			void this.loadScope(this.scope);
		} else {
			this.showScope();
		}
	}

	getSessionList(): SessionList {
		return this.sessionList;
	}
}
