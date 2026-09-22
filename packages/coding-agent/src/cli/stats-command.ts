import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import chalk from "chalk";
import { APP_NAME, ENV_SESSION_DIR, expandTildePath, getAgentDir, getSessionsDir, getStatsWebDir } from "../config.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { buildSnapshot } from "../core/stats/aggregate.ts";
import { scanSessions } from "../core/stats/scan.ts";
import { DEFAULT_STATS_PORT, startStatsServer } from "../core/stats/server.ts";
import { openBrowser } from "../utils/open-browser.ts";

export class StatsCommandError extends Error {}

export interface StatsCommandOptions {
	/** Session roots to scan; empty means "use the default agent sessions directory". */
	dirs: string[];
	/** Initial range for the panel, in local calendar days; `null` means "all time". */
	days: number | null;
	/** Include test/temporary sessions. */
	includeAll: boolean;
	/** Print the aggregate snapshot as JSON instead of serving the panel. */
	json: boolean;
	/** Open the panel in the browser once the server is listening. */
	open: boolean;
	/** Requested port; `null` keeps the default (with fallback to a free port). */
	port: number | null;
}

const STATS_COMMAND_HELP = `Usage:
  ${APP_NAME} stats [options]

Serve a local, read-only token usage panel for this machine's session files.
The panel binds 127.0.0.1 and prints the URL to open.

Options:
  --port <port>   Port for the panel (default: ${DEFAULT_STATS_PORT}; a busy port falls back to a free one)
  --dir <path>    Session directory to scan (repeatable; default: the session storage directory)
  --days <days>   Initial range in days: 7, 30, 90, or 0 for all time (default: 30)
  --all           Include test/temporary sessions (default: excluded)
  --json          Print the aggregate snapshot as JSON and exit (no server)
  --no-open       Do not open the browser
  -h, --help      Show this help`;

/**
 * Default scan roots, resolved the same way the session machinery resolves its storage
 * directory: `EASY_PI_CODING_AGENT_SESSION_DIR`, then the configured `sessionDir`, then
 * `<agent dir>/sessions`.
 */
export function defaultStatsRoots(settingsDir?: string | null, env: NodeJS.ProcessEnv = process.env): string[] {
	const fromEnv = env[ENV_SESSION_DIR];
	if (fromEnv !== undefined && fromEnv.trim().length > 0) return [fromEnv];
	if (settingsDir !== undefined && settingsDir !== null && settingsDir.trim().length > 0) return [settingsDir];
	return [getSessionsDir()];
}

/** Expand `~`, make absolute, drop duplicates and roots nested inside another root. */
export function normalizeStatsRoots(dirs: readonly string[]): string[] {
	const resolved: string[] = [];
	const seen = new Set<string>();
	for (const dir of dirs) {
		const path = resolve(expandTildePath(dir));
		if (seen.has(path)) continue;
		seen.add(path);
		resolved.push(path);
	}
	// A root already covered by another root would count the same files twice.
	return resolved.filter((root) => !resolved.some((other) => other !== root && isParentPath(other, root)));
}

function isParentPath(parent: string, child: string): boolean {
	const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
	return child.startsWith(prefix);
}

/** Report scan roots that cannot contribute sessions (missing or not a directory). */
export function describeMissingRoots(roots: readonly string[]): string[] {
	const problems: string[] = [];
	for (const root of roots) {
		if (!existsSync(root)) {
			problems.push(`Warning: session directory not found: ${root}`);
			continue;
		}
		try {
			if (!statSync(root).isDirectory()) {
				problems.push(`Warning: not a directory, skipping: ${root}`);
			}
		} catch {
			problems.push(`Warning: cannot read session directory: ${root}`);
		}
	}
	return problems;
}

/** Configured `sessionDir` (settings), then the env/agent-dir defaults. */
function resolveDefaultRoots(): string[] {
	try {
		const settingsDir = SettingsManager.create(process.cwd(), getAgentDir(), {
			projectTrusted: false,
		}).getSessionDir();
		return defaultStatsRoots(settingsDir);
	} catch {
		return defaultStatsRoots(null);
	}
}

export function isStatsCommandHelp(args: string[]): boolean {
	return args[0] === "stats" && (args[1] === "help" || args.includes("--help") || args.includes("-h"));
}

export function printStatsCommandHelp(): void {
	console.log(STATS_COMMAND_HELP);
}

/**
 * Parse `<app> stats ...`. Returns `undefined` when the arguments are not a stats command,
 * so callers can fall through to the normal CLI parsing.
 */
export function parseStatsCommand(args: string[]): StatsCommandOptions | undefined {
	if (args[0] !== "stats") return undefined;

	const options: StatsCommandOptions = {
		dirs: [],
		days: 30,
		includeAll: false,
		json: false,
		open: true,
		port: null,
	};
	let daysSeen = false;

	for (let index = 1; index < args.length; index++) {
		const arg = args[index];
		switch (arg) {
			case "help":
				continue;
			case "--json":
				options.json = true;
				continue;
			case "--all":
				options.includeAll = true;
				continue;
			case "--no-open":
				options.open = false;
				continue;
			case "--port":
			case "--dir":
			case "--days": {
				const value = args[index + 1];
				if (value === undefined || value.startsWith("--")) {
					throw new StatsCommandError(`Missing value for ${arg}.`);
				}
				index++;
				if (arg === "--port") {
					const port = Number.parseInt(value, 10);
					if (!/^\d+$/.test(value) || port < 1 || port > 65_535) {
						throw new StatsCommandError(
							`--port must be an integer between 1 and 65535, got ${JSON.stringify(value)}.`,
						);
					}
					options.port = port;
				} else if (arg === "--dir") {
					if (value.trim().length === 0) throw new StatsCommandError("--dir must not be empty.");
					options.dirs.push(value);
				} else {
					const days = Number.parseInt(value, 10);
					if (!/^\d+$/.test(value) || days < 0) {
						throw new StatsCommandError(`--days must be a non-negative integer, got ${JSON.stringify(value)}.`);
					}
					options.days = days;
					daysSeen = true;
				}
				continue;
			}
			default:
				throw new StatsCommandError(`Unknown option ${arg}.`);
		}
	}

	if (!daysSeen) options.days = 30;
	return options;
}

/** Local calendar-day range ending today, or `null` bounds for all time. */
export function statsRangeForDays(days: number | null, now = new Date()): { from: string | null; to: string | null } {
	if (days === null || days <= 0) return { from: null, to: null };
	const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - (days - 1));
	return { from: localDay(from), to: localDay(to) };
}

/** Panel URL with the CLI-selected initial view applied. */
export function statsPanelUrl(baseUrl: string, options: StatsCommandOptions): string {
	const params = new URLSearchParams();
	if (options.days !== null) params.set("days", String(options.days));
	if (options.includeAll) params.set("includeAll", "1");
	const query = params.toString();
	return query.length > 0 ? `${baseUrl}?${query}` : baseUrl;
}

function localDay(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function waitForShutdown(): Promise<void> {
	return new Promise((resolve) => {
		const stop = () => {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
			resolve();
		};
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
	});
}

/**
 * Handle `stats` before normal argument parsing. Returns `true` when the arguments were
 * consumed (including errors and `--help`), `false` when the caller should keep parsing.
 */
export async function handleStatsCommand(args: string[]): Promise<boolean> {
	if (isStatsCommandHelp(args)) {
		printStatsCommandHelp();
		return true;
	}

	let options: StatsCommandOptions | undefined;
	try {
		options = parseStatsCommand(args);
	} catch (error) {
		const message = error instanceof StatsCommandError ? error.message : "Failed to parse stats command.";
		console.error(chalk.red(`Error: ${message}`));
		console.error(chalk.dim(`Use "${APP_NAME} stats --help".`));
		process.exitCode = 1;
		return true;
	}
	if (!options) return false;

	const roots =
		options.dirs.length > 0 ? normalizeStatsRoots(options.dirs) : normalizeStatsRoots(resolveDefaultRoots());
	for (const problem of describeMissingRoots(roots)) {
		console.error(chalk.yellow(problem));
	}

	if (options.json) {
		try {
			const range = statsRangeForDays(options.days);
			const snapshot = buildSnapshot(scanSessions({ roots }), {
				from: range.from,
				to: range.to,
				includeAll: options.includeAll,
			});
			console.log(JSON.stringify(snapshot, null, 2));
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to scan sessions";
			console.error(chalk.red(`Error: ${message}`));
			process.exitCode = 1;
		}
		return true;
	}

	let handle: Awaited<ReturnType<typeof startStatsServer>>;
	try {
		handle = await startStatsServer({
			roots,
			webDir: getStatsWebDir(),
			...(options.port === null ? {} : { port: options.port }),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to start the stats server";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}

	const url = statsPanelUrl(handle.url, options);
	console.log(`Token usage panel: ${url}`);
	console.log(chalk.dim(`Scanning ${roots.join(", ")}. Press Ctrl+C to stop.`));
	if (options.open) openBrowser(url);

	await waitForShutdown();
	await handle.close();
	return true;
}
