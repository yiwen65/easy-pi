import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";

const neverAbortedSignal = new AbortController().signal;

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function createAccessToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64");
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": {
				chatgpt_account_id: accountId,
			},
		}),
	).toString("base64");
	return `${header}.${payload}.signature`;
}

function deviceAuthPendingResponse(): Response {
	return jsonResponse(
		{
			error: {
				message: "Device authorization is pending. Please try again.",
				type: "invalid_request_error",
				param: null,
				code: "deviceauth_authorization_pending",
			},
		},
		403,
	);
}

function loginOpenAICodexDeviceCodeForTest(options: {
	onDeviceCode(info: {
		userCode: string;
		verificationUri: string;
		intervalSeconds?: number;
		expiresInSeconds?: number;
	}): void;
	signal?: AbortSignal;
}) {
	return openaiCodexOAuth.login({
		signal: options.signal ?? neverAbortedSignal,
		prompt: async (prompt) => {
			if (prompt.type !== "select") throw new Error(`Unexpected prompt: ${prompt.type}`);
			return "device_code";
		},
		notify: (event) => {
			if (event.type === "device_code") {
				const { type: _, ...info } = event;
				options.onDeviceCode(info);
			}
		},
	});
}

describe("OpenAI Codex OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("logs in with the OpenAI Codex device code flow", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-05-20T00:00:00Z");
		vi.setSystemTime(startTime);

		const accessToken = createAccessToken("account-123");
		const deviceInfos: Array<{
			userCode: string;
			verificationUri: string;
			instructions?: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
		}> = [];
		const pollTimes: number[] = [];
		const pollResponses = [
			deviceAuthPendingResponse(),
			jsonResponse({
				authorization_code: "oauth-code",
				code_challenge: "device-code-challenge",
				code_verifier: "device-code-verifier",
			}),
		];

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
				expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
				return jsonResponse({
					device_auth_id: "device-auth-id",
					user_code: "ABCD-1234",
					interval: "5",
				});
			}

			if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
				pollTimes.push(Date.now());
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
				expect(JSON.parse(String(init?.body))).toEqual({
					device_auth_id: "device-auth-id",
					user_code: "ABCD-1234",
				});
				const response = pollResponses.shift();
				if (!response) {
					throw new Error("Unexpected extra device auth poll");
				}
				return response;
			}

			if (url === "https://auth.openai.com/oauth/token") {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("authorization_code");
				expect(params.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
				expect(params.get("code")).toBe("oauth-code");
				expect(params.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
				expect(params.get("code_verifier")).toBe("device-code-verifier");
				return jsonResponse({
					access_token: accessToken,
					refresh_token: "refresh-token",
					expires_in: 3600,
				});
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const credentialsPromise = loginOpenAICodexDeviceCodeForTest({
			onDeviceCode: (info) => deviceInfos.push(info),
		});

		for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(deviceInfos).toEqual([
			{
				userCode: "ABCD-1234",
				verificationUri: "https://auth.openai.com/codex/device",
				intervalSeconds: 5,
				expiresInSeconds: 900,
			},
		]);
		expect(pollTimes).toEqual([startTime.getTime()]);

		await vi.advanceTimersByTimeAsync(4999);
		expect(pollTimes).toEqual([startTime.getTime()]);

		await vi.advanceTimersByTimeAsync(1);
		await expect(credentialsPromise).resolves.toMatchObject({
			access: accessToken,
			refresh: "refresh-token",
			expires: startTime.getTime() + 5000 + 3600 * 1000,
			accountId: "account-123",
		});
		expect(pollTimes).toEqual([startTime.getTime(), startTime.getTime() + 5000]);
	});

	it("offers browser login first and uses the selected OpenAI Codex device code flow", async () => {
		const accessToken = createAccessToken("account-456");
		const selectPrompts: Array<{
			message: string;
			options: readonly { id: string; label: string }[];
		}> = [];
		const deviceInfos: Array<{
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
		}> = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "WXYZ-7890",
						interval: "5",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					return jsonResponse({
						authorization_code: "oauth-code",
						code_challenge: "device-code-challenge",
						code_verifier: "device-code-verifier",
					});
				}
				if (url === "https://auth.openai.com/oauth/token") {
					return jsonResponse({
						access_token: accessToken,
						refresh_token: "refresh-token",
						expires_in: 3600,
					});
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		await expect(
			openaiCodexOAuth.login({
				signal: neverAbortedSignal,
				prompt: async (prompt) => {
					if (prompt.type !== "select") throw new Error("Text prompt should not be used");
					selectPrompts.push(prompt);
					return "device_code";
				},
				notify: (event) => {
					if (event.type === "auth_url") throw new Error("Browser login should not start");
					if (event.type === "device_code") {
						const { type: _, ...info } = event;
						deviceInfos.push(info);
					}
				},
			}),
		).resolves.toMatchObject({
			type: "oauth",
			access: accessToken,
			refresh: "refresh-token",
			accountId: "account-456",
		});

		expect(selectPrompts).toEqual([
			{
				type: "select",
				message: "Select OpenAI Codex login method:",
				options: [
					{ id: "browser", label: "Browser login (default)" },
					{ id: "device_code", label: "Device code login (headless)" },
				],
			},
		]);
		expect(deviceInfos).toEqual([
			{
				userCode: "WXYZ-7890",
				verificationUri: "https://auth.openai.com/codex/device",
				intervalSeconds: 5,
				expiresInSeconds: 900,
			},
		]);
	});

	it("cancels when OpenAI Codex login method selection is cancelled", async () => {
		await expect(
			openaiCodexOAuth.login({
				signal: neverAbortedSignal,
				prompt: async () => {
					throw new Error("Login cancelled");
				},
				notify: () => {},
			}),
		).rejects.toThrow("Login cancelled");
	});

	it("cancels the OpenAI Codex device code flow while waiting", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const pollTimes: number[] = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "ABCD-1234",
						interval: "5",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					pollTimes.push(Date.now());
					return deviceAuthPendingResponse();
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialsPromise = loginOpenAICodexDeviceCodeForTest({
			onDeviceCode: () => {},
			signal: controller.signal,
		});
		const rejectionPromise = credentialsPromise.then(
			() => new Error("Expected login to fail"),
			(error: unknown) => error,
		);

		for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(pollTimes).toHaveLength(1);

		controller.abort();
		const rejection = await rejectionPromise;
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toBe("Login cancelled");
	});

	it("times out the OpenAI Codex device code flow after 15 minutes", async () => {
		vi.useFakeTimers();
		const pollTimes: number[] = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "ABCD-1234",
						interval: "60",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					pollTimes.push(Date.now());
					return deviceAuthPendingResponse();
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialsPromise = loginOpenAICodexDeviceCodeForTest({
			onDeviceCode: () => {},
		});
		const rejectionPromise = credentialsPromise.then(
			() => new Error("Expected login to fail"),
			(error: unknown) => error,
		);

		for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(pollTimes).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
		const rejection = await rejectionPromise;
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toBe("Device flow timed out");
	});

	it("treats OpenAI Codex device auth 403 and 404 responses as pending", async () => {
		vi.useFakeTimers();
		const accessToken = createAccessToken("account-403-404");
		const pollTimes: number[] = [];
		const pollResponses = [
			jsonResponse({ error: "access_denied", error_description: "denied" }, 403),
			new Response("not ready", { status: 404, headers: { "Content-Type": "text/plain" } }),
			jsonResponse({
				authorization_code: "oauth-code",
				code_challenge: "device-code-challenge",
				code_verifier: "device-code-verifier",
			}),
		];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "ABCD-1234",
						interval: "1",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					pollTimes.push(Date.now());
					const response = pollResponses.shift();
					if (!response) {
						throw new Error("Unexpected extra device auth poll");
					}
					return response;
				}
				if (url === "https://auth.openai.com/oauth/token") {
					return jsonResponse({
						access_token: accessToken,
						refresh_token: "refresh-token",
						expires_in: 3600,
					});
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialsPromise = loginOpenAICodexDeviceCodeForTest({
			onDeviceCode: () => {},
		});

		for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1000);

		await expect(credentialsPromise).resolves.toMatchObject({
			access: accessToken,
			refresh: "refresh-token",
			accountId: "account-403-404",
		});
		expect(pollTimes).toHaveLength(3);
	});

	it.each(["string", "nested"] as const)(
		"preserves %s pending and slow_down responses before a successful device login",
		async (shape) => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const pollTimes: number[] = [];
			const errorBody = (code: string) => ({ error: shape === "string" ? code : { code } });
			const responses = [
				jsonResponse(errorBody("deviceauth_authorization_pending"), 400),
				jsonResponse(errorBody("slow_down"), 429),
				jsonResponse({ authorization_code: "synthetic-code", code_verifier: "synthetic-verifier" }),
			];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: unknown): Promise<Response> => {
					const url = getUrl(input);
					if (url.endsWith("/deviceauth/usercode"))
						return jsonResponse({
							device_auth_id: "synthetic-device",
							user_code: "synthetic-user-code",
							interval: 1,
						});
					if (url.endsWith("/deviceauth/token")) {
						pollTimes.push(Date.now());
						const response = responses.shift();
						if (!response) throw new Error("Unexpected poll");
						return response;
					}
					if (url === "https://auth.openai.com/oauth/token")
						return jsonResponse({
							access_token: createAccessToken("test-account"),
							refresh_token: "synthetic-refresh",
							expires_in: 3600,
						});
					throw new Error("Unexpected request");
				}),
			);
			const login = loginOpenAICodexDeviceCodeForTest({ onDeviceCode: () => {} });
			await vi.advanceTimersByTimeAsync(0);
			expect(pollTimes).toEqual([0]);
			await vi.advanceTimersByTimeAsync(1000);
			expect(pollTimes).toEqual([0, 1000]);
			await vi.advanceTimersByTimeAsync(5999);
			expect(pollTimes).toEqual([0, 1000]);
			await vi.advanceTimersByTimeAsync(1);
			await expect(login).resolves.toMatchObject({ accountId: "test-account", refresh: "synthetic-refresh" });
			expect(pollTimes).toEqual([0, 1000, 7000]);
		},
	);

	it("preserves cancellation of the token exchange after successful device authorization", async () => {
		const controller = new AbortController();
		let markExchangeStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markExchangeStarted = resolve;
		});
		let exchangeSignal: AbortSignal | null | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);
				if (url.endsWith("/deviceauth/usercode"))
					return jsonResponse({
						device_auth_id: "synthetic-device",
						user_code: "synthetic-user-code",
						interval: 1,
					});
				if (url.endsWith("/deviceauth/token"))
					return jsonResponse({ authorization_code: "synthetic-code", code_verifier: "synthetic-verifier" });
				if (url === "https://auth.openai.com/oauth/token") {
					exchangeSignal = init?.signal;
					return new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(init?.signal?.reason), { once: true });
						markExchangeStarted();
					});
				}
				throw new Error("Unexpected request");
			}),
		);
		const login = loginOpenAICodexDeviceCodeForTest({ onDeviceCode: () => {}, signal: controller.signal });
		const rejected = expect(login).rejects.toThrow("Login cancelled");
		await started;
		expect(exchangeSignal).toBe(controller.signal);
		controller.abort();
		await rejected;
	});

	it("keeps the HTTP status without response bodies in OpenAI Codex device auth poll failures", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "ABCD-1234",
						interval: "5",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					return jsonResponse({ error: "server_error", error_description: "try again later" }, 500);
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		await expect(
			loginOpenAICodexDeviceCodeForTest({
				onDeviceCode: () => {},
			}),
		).rejects.toThrow("OpenAI Codex device auth failed with status 500");
	});

	it("does not write token refresh failures to stderr", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => {
				return new Response(
					JSON.stringify({
						error: {
							message: "Could not validate your token. Please try signing in again.",
							type: "invalid_request_error",
						},
					}),
					{ status: 401, statusText: "Unauthorized", headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		await expect(
			openaiCodexOAuth.refresh(
				{
					type: "oauth",
					access: "invalid-access-token",
					refresh: "invalid-refresh-token",
					expires: 0,
				},
				neverAbortedSignal,
			),
		).rejects.toThrow("OpenAI Codex token refresh failed (401)");
		expect(consoleError).not.toHaveBeenCalled();
	});
});
