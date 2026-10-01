import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function fixtureStateExpression(url) {
	const fixture = new URL(url);
	assert.ok(
		fixture.protocol === "http:" && fixture.hostname === "127.0.0.1",
		"Diagnostics require a loopback fixture",
	);
	return `(() => {
if (location.origin !== ${JSON.stringify(fixture.origin)}) return {status:'outside_fixture'};
const text = document.body?.innerText ?? '';
const rect = document.body?.getBoundingClientRect();
return {status:'observed',path:location.pathname,ready:document.readyState,
visibility:document.visibilityState,focused:document.hasFocus(),
bodyText:text.slice(0,4096),bodyTextTruncated:text.length>4096,
bodyRect:rect?[rect.x,rect.y,rect.width,rect.height]:null,
viewport:[innerWidth,innerHeight]};
})()`;
}

export async function until(check, timeout = 10_000) {
	const end = performance.now() + timeout;
	while (performance.now() < end) {
		const value = await check();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw Error("fixture condition timed out");
}

export async function connect(url) {
	const socket = new WebSocket(url);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.close();
			reject(Error("CDP connect deadline"));
		}, 10_000);
		socket.addEventListener(
			"open",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
		socket.addEventListener(
			"error",
			() => {
				clearTimeout(timer);
				reject(Error("CDP connect failed"));
			},
			{ once: true },
		);
	});
	let seq = 0;
	const pending = new Map();
	socket.addEventListener("message", ({ data }) => {
		const message = JSON.parse(data);
		const item = pending.get(message.id);
		if (!item) return;
		pending.delete(message.id);
		clearTimeout(item.timer);
		if (message.error) item.reject(Error(`CDP ${message.error.code}`));
		else item.resolve(message.result);
	});
	socket.addEventListener("close", () => {
		for (const item of pending.values()) {
			clearTimeout(item.timer);
			item.reject(Error("CDP closed"));
		}
		pending.clear();
	});
	return {
		call(method, params = {}) {
			return new Promise((resolve, reject) => {
				const id = ++seq;
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(Error(`CDP deadline: ${method}`));
				}, 10_000);
				pending.set(id, { resolve, reject, timer });
				socket.send(JSON.stringify({ id, method, params }));
			});
		},
		close() {
			socket.close();
		},
	};
}

export async function launchChrome(bundle, profile, url) {
	const executable = join(bundle, "Contents/MacOS/Google Chrome for Testing");
	assert.ok(existsSync(executable), "Use the dedicated CfT bundle, never personal Chrome");
	const child = spawn(
		executable,
		[
			`--user-data-dir=${profile}`,
			"--remote-debugging-port=0",
			"--remote-debugging-address=127.0.0.1",
			"--use-mock-keychain",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-sync",
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-extensions",
			"--window-size=1100,850",
			"--window-position=100,100",
			url,
		],
		{ detached: true, stdio: "ignore" },
	);
	const exit = new Promise((resolve, reject) => {
		child.on("exit", (code, signal) => resolve({ code, signal }));
		child.on("error", reject);
	});
	let browser;
	const close = async () => {
		assert.ok(browser, `Chrome startup incomplete; inspect owned pid ${child.pid}; no forced kill`);
		await browser.call("Browser.close").catch((error) => {
			if (error.message !== "CDP closed") throw error;
		});
		browser.close();
		let exitTimer;
		let result;
		try {
			result = await Promise.race([
				exit,
				new Promise((_, reject) => {
					exitTimer = setTimeout(
						() => reject(Error(`Chrome exit unproved; inspect owned pid ${child.pid}`)),
						10_000,
					);
				}),
			]);
		} finally {
			clearTimeout(exitTimer);
		}
		assert.equal(result.code, 0);
		await until(
			() =>
				!execFileSync("/bin/ps", ["-axo", "pgid=,stat="], { encoding: "utf8" })
					.split("\n")
					.some((line) => {
						const [group, state] = line.trim().split(/\s+/);
						return Number(group) === child.pid && !state?.startsWith("Z");
					}),
		);
		return { ...result, processGroupDrained: true, profileRetained: profile };
	};
	try {
		const portFile = join(profile, "DevToolsActivePort");
		await until(() => existsSync(portFile));
		const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
		assert.match(port, /^\d+$/);
		assert.ok(path.startsWith("/devtools/browser/"));
		browser = await connect(`ws://127.0.0.1:${port}${path}`);
		const targets = async () =>
			(await browser.call("Target.getTargets")).targetInfos.filter((row) => row.type === "page");
		const target = await until(async () => (await targets()).find((row) => row.url === url));
		const page = await connect(`ws://127.0.0.1:${port}/devtools/page/${target.targetId}`);
		const evaluate = async (expression) => {
			const result = await page.call("Runtime.evaluate", { expression, returnByValue: true });
			assert.ok(!result.exceptionDetails, "Fixture evaluation failed");
			return result.result.value;
		};
		await until(() =>
			evaluate(
				`document.readyState === 'complete' && location.href === ${JSON.stringify(url)} && document.body?.innerText.length > 0`,
			),
		);
		return {
			evaluate,
			inspectFixture: () => evaluate(fixtureStateExpression(url)),
			targets,
			version: await browser.call("Browser.getVersion"),
			async close() {
				page.close();
				return close();
			},
		};
	} catch (error) {
		if (browser) await close();
		throw error;
	}
}
