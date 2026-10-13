import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dns from "node:dns/promises";
import { existsSync, readdirSync } from "node:fs";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { isFakeIpAddress, isPublicAddress } from "../src/network.ts";

// Explicit opt-in live acceptance for the snapshot path: a real public page, the real loader and
// the real isolated browser. Mirrors live-child.mjs isolation; never part of an offline suite.
assert.equal(process.env.PI_WEB_FETCH_LIVE, "1", "Use test/live-snapshot.mjs, not a normal user environment.");
assert.deepEqual(
	Object.keys(process.env).filter((name) => /KEY|TOKEN|SECRET|AUTH|PROXY|^NODE_(OPTIONS|PATH)$/.test(name)),
	[],
);
const env = process.env;
const url = process.argv[2];
const pageChars = Number(process.argv[3] ?? 200);
assert.ok(url && Number.isInteger(pageChars) && pageChars > 0, "node test/live-snapshot.mjs <public-url> [max-chars]");

let keyReads = 0;
let fetchCalls = 0;
let connections = 0;
const browsers = [];
const snapshots = new Map();
const sockets = [];
const originalSpawn = childProcess.spawn;
const originalConnect = net.connect;
const originalLookup = dns.lookup;
dns.lookup = async (host, options) => {
	assert.equal(options.all, true);
	const addresses = await originalLookup(host, options);
	snapshots.set(host, addresses);
	return addresses;
};
childProcess.spawn = (file, args, options) => {
	assert.ok(args.includes("--remote-debugging-pipe"));
	assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "LANG", "PATH", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]);
	const child = originalSpawn(file, args, options);
	browsers.push({ child, root: options.cwd });
	return child;
};
net.connect = (options) => {
	assert.equal(typeof options.lookup, "function");
	assert.equal(options.autoSelectFamily, true);
	const approved = snapshots.get(options.host);
	assert.ok(approved?.length, "Every dialled host must come from the read's own vetted DNS snapshot");
	const fakeIp = approved.filter(({ address }) => isFakeIpAddress(address));
	const publicIp = approved.filter(({ address }) => isPublicAddress(address));
	assert.ok(
		fakeIp.length === approved.length || publicIp.length === approved.length,
		`A DNS snapshot must be all public or all fake-ip, got ${JSON.stringify(approved)}`,
	);
	const socket = originalConnect(options);
	sockets.push(socket);
	socket.on("connectionAttempt", (address, port, family) => {
		assert.ok(approved.some((item) => item.address === address && item.family === family));
		assert.ok([80, 443].includes(port));
		connections++;
	});
	return socket;
};
globalThis.fetch = () => {
	fetchCalls++;
	throw new Error("Node fetch/Tavily is forbidden in this live browser-only check.");
};
process.env = new Proxy(env, {
	get(target, key) {
		if (key === "TAVILY_API_KEY") {
			keyReads++;
			throw new Error("web_fetch must not read Tavily credentials");
		}
		return Reflect.get(target, key);
	},
});

const chunks = (text) => Array.from(text);
const summary = { url, pageChars, pages: [], checks: [], markdown: {}, isolation: {} };
const checks = summary.checks;
const check = (name, condition, detail) => {
	assert.ok(condition, `${name}: ${detail ?? ""}`);
	checks.push(name);
};

const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
try {
	const { loadExtensions } = await import(pathToFileURL(env.PI_EXTENSION_LOADER).href);
	const loaded = await loadExtensions([env.PI_WEB_SEARCH_EXTENSION], process.cwd());
	assert.deepEqual(loaded.errors, []);
	const tool = loaded.extensions[0].tools.get("web_fetch").definition;
	const ownerA = { liveOwner: "a" };
	const ownerB = { liveOwner: "b" };
	const call = (params, ctx) => tool.execute("live-snapshot", params, controller.signal, undefined, ctx);

	// 1. One real capture, then every continuation must come from memory only.
	const first = await call({ url, max_chars: pageChars }, { sessionManager: ownerA });
	const current = (result) => result.structuredContent;
	check("capture-creates-snapshot", typeof current(first).snapshot_id === "string", "capture returned no handle");
	check("capture-provider", first.details.provider === "browser", `provider ${first.details.provider}`);
	check("capture-format", current(first).format === "text", `format ${current(first).format}`);
	check("capture-total", current(first).total_chars > 0, "capture has no text");
	const spawnsAfterCapture = browsers.length;
	check("capture-used-one-browser", spawnsAfterCapture === 1, `${spawnsAfterCapture} browsers`);
	const snapshotId = current(first).snapshot_id;
	const total = current(first).total_chars;
	summary.totalChars = total;
	summary.snapshotId = snapshotId;
	summary.firstPage = { offset: current(first).offset, next: current(first).next_offset, chars: chunks(current(first).text).length };
	summary.pages.push({ offset: current(first).offset, end: current(first).offset + chunks(current(first).text).length });

	// A second window over the same snapshot must agree character for character.
	const wide = await call({ snapshot_id: snapshotId, offset: 0, max_chars: Math.min(16000, total) }, { sessionManager: ownerA });
	check(
		"window-consistency",
		chunks(wide.structuredContent.text).slice(0, pageChars).join("") === current(first).text,
		"a wider window over the same snapshot disagreed with the first page",
	);

	let offset = current(first).next_offset;
	let guard = 0;
	while (offset !== null && guard++ < 200) {
		const page = await call({ snapshot_id: snapshotId, offset, max_chars: pageChars }, { sessionManager: ownerA });
		const data = current(page);
		check(`continuation-${guard}-provider`, page.details.provider === "snapshot", `provider ${page.details.provider}`);
		check(`continuation-${guard}-consistent`, data.pagination_consistent === true, "continuation not marked consistent");
		check(`continuation-${guard}-capture-time`, data.captured_at === current(first).captured_at, "captured_at changed");
		check(`continuation-${guard}-offset`, data.offset === offset, `offset ${data.offset} != ${offset}`);
		const length = chunks(data.text).length;
		check(`continuation-${guard}-bounded`, length <= pageChars, `page size ${length} > ${pageChars}`);
		check(
			`continuation-${guard}-cursor`,
			data.next_offset === null || data.next_offset === offset + length,
			`next_offset ${data.next_offset} does not advance by ${length}`,
		);
		summary.pages.push({ offset: data.offset, end: data.offset + length });
		offset = data.next_offset;
	}
	check("continuations-reach-eof", offset === null, "pagination did not reach the end within 200 pages");
	const eof = await call({ snapshot_id: snapshotId, offset: total, max_chars: pageChars }, { sessionManager: ownerA });
	check("eof-page-empty", current(eof).text === "" && current(eof).next_offset === null, "offset == total is not an explicit empty end page");
	await assert.rejects(
		call({ snapshot_id: snapshotId, offset: total + 1 }, { sessionManager: ownerA }),
		(error) => {
			check("beyond-end-rejected", error.code === "invalid-arguments", `code ${error.code}`);
			return true;
		},
	);
	check("continuations-used-no-browser", browsers.length === spawnsAfterCapture, `${browsers.length} browsers after continuations`);

	// 2. Machine-readable contract over a real page.
	check("structured-text-matches-content", first.content[0].text.endsWith(current(first).text), "content does not end with the page text");
	check("structured-dns-mode", current(first).dns_mode === "local_fake_ip_client" || current(first).dns_mode === "pinned_public_ip", `dns_mode ${current(first).dns_mode}`);
	check("frames-provenance", Array.isArray(first.details.frames) && first.details.frames.length >= 1, "no frame provenance");
	check("blocks-provenance", Array.isArray(first.details.blocks?.items), "no block provenance for the current page");

	// 3. Markdown over the same real page, and the fixed-format rule.
	const markdown = await call({ url, format: "markdown", max_chars: 4000 }, { sessionManager: ownerA });
	const markdownData = current(markdown);
	check("markdown-format", markdownData.format === "markdown", `format ${markdownData.format}`);
	check("markdown-handle", typeof markdownData.snapshot_id === "string", "markdown capture returned no handle");
	summary.markdown = {
		chars: chunks(markdownData.text).length,
		blocks: markdown.details.blocks?.items?.length ?? 0,
		links: (markdown.details.blocks?.items ?? []).flatMap((block) => block.links ?? []).length,
		preview: markdownData.text.slice(0, 240),
	};
	await assert.rejects(
		call({ snapshot_id: markdownData.snapshot_id, format: "text" }, { sessionManager: ownerA }),
		(error) => {
			check("format-mismatch-rejected", error.code === "format-mismatch", `code ${error.code}`);
			return true;
		},
	);
	const markdownAgain = await call({ snapshot_id: markdownData.snapshot_id, offset: 0, max_chars: 200 }, { sessionManager: ownerA });
	check("markdown-continuation", markdownAgain.structuredContent.format === "markdown", "continuation lost the capture format");

	// 4. A random handle, another session's handle and the capture of another owner are indistinguishable.
	for (const [label, ctx, id] of [
		["unknown-handle", { sessionManager: ownerA }, "00000000000000000000000000000000"],
		["other-owner-handle", { sessionManager: ownerB }, snapshotId],
	]) {
		await assert.rejects(
			call({ snapshot_id: id }, ctx),
			(error) => {
				check(`${label}-refused`, error.code === "snapshot-unavailable", `code ${error.code}`);
				check(`${label}-opaque`, !String(error.message).includes(id.slice(0, 8)), "the error leaked the handle");
				return true;
			},
		);
	}
	const spawnsBeforeIsolationChecks = browsers.length;
	check("isolation-checks-used-no-browser", browsers.length === spawnsBeforeIsolationChecks, "a refused handle started work");
	check("isolation-no-browser", browsers.length === 1 || browsers.length === 2, `unexpected browser count ${browsers.length}`);

	// Cleanup assertions: the same guarantees as the single-page live check.
	check("no-credential-reads", keyReads === 0, "Tavily key was read");
	check("no-node-fetch", fetchCalls === 0, "Node fetch was used");
	check("public-tcp-only", connections > 0, "no vetted TCP connection was made");
	check("sockets-closed", sockets.every((socket) => socket.destroyed), "a socket stayed open");
	check(
		"profiles-removed",
		readdirSync(env.TMPDIR).filter((name) => name.startsWith("pi-web-fetch-")).length === 0,
		"a temporary profile was left behind",
	);
	check(
		"browsers-exited",
		browsers.every(({ child, root }) => !existsSync(root) && (child.exitCode !== null || child.signalCode !== null)),
		"a browser process or its directory survived",
	);

	console.log(JSON.stringify({ passed: true, entry: env.PI_WEB_SEARCH_EXTENSION, summary }, null, 2));
} finally {
	process.env = env;
	childProcess.spawn = originalSpawn;
	net.connect = originalConnect;
	dns.lookup = originalLookup;
}
