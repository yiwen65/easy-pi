import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { fauxProvider } from "../src/providers/faux.ts";

const servers = vi.hoisted(() => ({ opened: 0, closed: 0 }));
vi.mock("node:http", () => ({
	createServer: () => {
		servers.opened++;
		const server = {
			on: () => server,
			listen: (_port: number, _host: string, callback: () => void) => {
				callback();
				return server;
			},
			close: () => {
				servers.closed++;
			},
		};
		return server;
	},
}));

const secret = "synthetic-token-must-not-appear";
const previous: OAuthCredential = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0 };
const invalidResponses = [
	{ name: "missing refresh", body: JSON.stringify({ access_token: secret, expires_in: 3600 }), status: 200 },
	{
		name: "wrong token type",
		body: JSON.stringify({ access_token: { secret }, refresh_token: secret, expires_in: 3600 }),
		status: 200,
	},
	{
		name: "empty token",
		body: JSON.stringify({ access_token: "", refresh_token: secret, expires_in: 3600 }),
		status: 200,
	},
	{
		name: "wrong expiry type",
		body: JSON.stringify({ access_token: secret, refresh_token: secret, expires_in: "3600" }),
		status: 200,
	},
	{
		name: "nonfinite expiry",
		body: `{"access_token":"${secret}","refresh_token":"${secret}","expires_in":1e999}`,
		status: 200,
	},
	{
		name: "overflowed expiry",
		body: JSON.stringify({ access_token: secret, refresh_token: secret, expires_in: 1e308 }),
		status: 200,
	},
	{
		name: "negative expiry",
		body: JSON.stringify({ access_token: secret, refresh_token: secret, expires_in: -1 }),
		status: 200,
	},
	{ name: "malformed JSON", body: `{"access_token":"${secret}",`, status: 200 },
	{ name: "HTTP error", body: JSON.stringify({ access_token: secret, error: secret }), status: 401 },
];

describe("Codex device login diagnostic boundaries (T-153)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const artifacts = {
		device_auth_id: "D153X",
		user_code: "U153X",
		authorization_code: "A153X",
		code_verifier: "V153X",
		arbitrary_token: "T153X",
	};
	const cases = [
		{
			phase: "startup",
			name: "HTTP failure",
			status: 401,
			body: JSON.stringify(artifacts),
			diagnostic: "status 401",
		},
		{
			phase: "startup",
			name: "invalid fields",
			status: 200,
			body: JSON.stringify({ ...artifacts, interval: "invalid" }),
			diagnostic: "device_auth_id",
		},
		{
			phase: "startup",
			name: "malformed JSON",
			status: 200,
			body: `T153X ${JSON.stringify(artifacts)}`,
			diagnostic: "JSON",
		},
		{ phase: "poll", name: "HTTP failure", status: 500, body: JSON.stringify(artifacts), diagnostic: "status 500" },
		{
			phase: "poll",
			name: "malformed HTTP error",
			status: 500,
			body: `T153X ${JSON.stringify(artifacts)}`,
			diagnostic: "status 500",
		},
		{
			phase: "poll",
			name: "invalid fields",
			status: 200,
			body: JSON.stringify({ ...artifacts, code_verifier: null, detail: artifacts }),
			diagnostic: "code_verifier",
		},
		{
			phase: "poll",
			name: "malformed JSON",
			status: 200,
			body: `T153X ${JSON.stringify(artifacts)}`,
			diagnostic: "JSON",
		},
	];

	it.each(cases)(
		"does not expose artifacts in $phase $name public login errors",
		async ({ phase, status, body, diagnostic }) => {
			const response = new Response(body, { status });
			const fetch = vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.endsWith("/deviceauth/usercode")) {
					return phase === "startup"
						? response
						: new Response(
								JSON.stringify({
									device_auth_id: "synthetic-device",
									user_code: "synthetic-code",
									interval: 1,
								}),
							);
				}
				if (phase === "poll" && url.endsWith("/deviceauth/token")) return response;
				throw new Error("Unexpected token exchange");
			});
			vi.stubGlobal("fetch", fetch);
			const error = await openaiCodexOAuth
				.login({
					signal: new AbortController().signal,
					prompt: async () => "device_code",
					notify: () => {},
				})
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).toContain(diagnostic);
			for (const marker of Object.values(artifacts)) expect.soft(String(error)).not.toContain(marker);
			expect(response.bodyUsed).toBe(true);
			expect(fetch).toHaveBeenCalledTimes(phase === "startup" ? 1 : 2);
		},
	);
});

describe("OAuth token response boundaries", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	for (const [name, oauth] of [
		["anthropic", anthropicOAuth],
		["openai-codex", openaiCodexOAuth],
	] as const) {
		it.each(invalidResponses)(
			`${name} rejects $name without exposing tokens or overwriting stored credentials`,
			async ({ body, status }) => {
				const responses: Response[] = [];
				vi.stubGlobal(
					"fetch",
					vi.fn(async () => {
						const response = new Response(body, { status });
						responses.push(response);
						return response;
					}),
				);
				const directError = await oauth.refresh(previous, new AbortController().signal).then(
					() => undefined,
					(error: unknown) => error,
				);
				expect.soft(directError).toBeInstanceOf(Error);
				expect.soft(String(directError)).not.toContain(secret);

				const credentials = new InMemoryCredentialStore();
				await credentials.modify(name, async () => previous);
				const faux = fauxProvider({ provider: name });
				const models = createModels({ credentials });
				models.setProvider({ ...faux.provider, auth: { oauth } });
				const result = await models.completeSimple(faux.getModel(), { messages: [] });
				expect.soft(result.stopReason).toBe("error");
				expect.soft(result.errorMessage).toContain("OAuth refresh failed");
				expect.soft(result.errorMessage).not.toContain(secret);
				expect.soft(await credentials.read(name)).toEqual(previous);
				expect(faux.state.callCount).toBe(0);
				expect(responses).toHaveLength(2);
				for (const response of responses) expect(response.bodyUsed).toBe(true);
			},
		);

		it(`${name} rejects incomplete login responses without exposing token bodies`, async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(JSON.stringify({ access_token: secret, expires_in: 3600 }))),
			);
			const error = await oauth
				.login({
					signal: new AbortController().signal,
					notify: () => {},
					prompt: async (prompt) => (prompt.type === "select" ? "browser" : "synthetic-code"),
				})
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).not.toContain(secret);
		});

		it.each(
			[true, false].flatMap((cooperates) =>
				Array.from({ length: 10 }, (_, iteration) => ({ cooperates, iteration })),
			),
		)(
			`${name} closes the callback server on operation abort (prompt cooperates=$cooperates, run=$iteration)`,
			async ({ cooperates }) => {
				const fetch = vi.fn(async () => {
					throw new Error("token exchange must not start");
				});
				vi.stubGlobal("fetch", fetch);
				const controller = new AbortController();
				const reason = new Error("cancel login");
				let markPromptStarted!: () => void;
				const started = new Promise<void>((resolve) => {
					markPromptStarted = resolve;
				});
				let finishPrompt!: (error: unknown) => void;
				let promptSignal: AbortSignal | undefined;
				const beforeOpened = servers.opened;
				const beforeClosed = servers.closed;
				let settled = false;
				const result = oauth
					.login({
						signal: controller.signal,
						notify: () => {},
						prompt: async (prompt) => {
							if (prompt.type === "select") return "browser";
							promptSignal = prompt.signal;
							return new Promise<string>((_resolve, reject) => {
								finishPrompt = reject;
								if (cooperates)
									prompt.signal?.addEventListener("abort", () => reject(prompt.signal?.reason), {
										once: true,
									});
								markPromptStarted();
							});
						},
					})
					.then(
						() => {
							settled = true;
							return undefined;
						},
						(error: unknown) => {
							settled = true;
							return error;
						},
					);
				await started;
				expect(servers.opened - beforeOpened).toBe(1);
				controller.abort(reason);
				await setImmediate();
				try {
					expect.soft(promptSignal?.aborted).toBe(true);
					expect.soft(settled).toBe(true);
					expect.soft(servers.closed - beforeClosed).toBe(1);
					if (settled) expect(await result).toBe(reason);
					expect(fetch).not.toHaveBeenCalled();
				} finally {
					finishPrompt(reason);
					await result;
				}
			},
		);
	}
});
