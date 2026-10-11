// Development-only: resolve public workspace entrypoints to the real source tree.
// Do not use tsconfig's catch-all paths or rewrite relative/external imports.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const exact = new Map();
const patterns = [];

function sourceTarget(target) {
	if (typeof target === "string") {
		return target.replace(/^(?:\.\/)?dist\//, "./src/").replace(/\.js$/, ".ts");
	}
	return sourceTarget(target.development ?? target.import ?? target.default);
}

for (const directory of [
	"permissions", "subagent", "pi-web-search", "grok-tui", "grok-tui-compat",
	"ai", "agent", "mcp", "telemetry", "coding-agent", "client", "server", "protocol",
	"tui", "session-backends/sqlite-node",
]) {
	const packageRoot = resolve(root, "packages", directory);
	const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
	// TUI has a main entrypoint rather than an exports map; only its root is public.
	const exports = manifest.exports ?? { ".": manifest.main };
	for (const [subpath, target] of Object.entries(exports)) {
		const specifier = manifest.name + (subpath === "." ? "" : subpath.slice(1));
		const path = resolve(packageRoot, sourceTarget(target));
		if (specifier.includes("*")) {
			const [prefix, suffix] = specifier.split("*");
			patterns.push({ prefix, suffix, path, packageRoot });
		} else {
			exact.set(specifier, path);
		}
	}
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		let path = exact.get(specifier);
		if (!path) {
			for (const pattern of patterns) {
				if (!specifier.startsWith(pattern.prefix) || !specifier.endsWith(pattern.suffix)) continue;
				const match = specifier.slice(pattern.prefix.length, specifier.length - pattern.suffix.length);
				if (match.split(/[\\/]/).some((part) => part === "." || part === ".." || part === "node_modules")) continue;
				const candidate = pattern.path.replace("*", match);
				const tail = relative(pattern.packageRoot, candidate);
				if (tail === ".." || tail.startsWith(`..${sep}`) || isAbsolute(tail)) continue;
				if (existsSync(candidate)) {
					path = candidate;
					break;
				}
			}
		}
		if (path && existsSync(path)) {
			return { url: pathToFileURL(realpathSync(path)).href, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
