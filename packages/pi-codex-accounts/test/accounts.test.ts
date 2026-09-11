import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { accountProvider, addAccount, listAccounts, providerId, validateName } from "../accounts.ts";

test("aliases reject traversal, reserved/default and malformed names", () => {
	for (const value of ["../auth.json", "default", "", "a/b", "Work", "-work", "a".repeat(33)]) {
		assert.throws(() => validateName(value));
	}
	assert.equal(providerId("default"), "openai-codex");
	assert.equal(providerId("work-2"), "openai-codex-account-work-2");
});

test("aliases persist independently and duplicate adds cannot overwrite", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-codex-test-"));
	try {
		const path = join(dir, "accounts");
		assert.deepEqual(listAccounts(path), []);
		addAccount(path, "work");
		addAccount(path, "personal");
		assert.throws(() => addAccount(path, "work"));
		assert.deepEqual(listAccounts(path), ["personal", "work"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("real Codex providers expose OAuth and keep model/auth identities separate", async () => {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	for (const name of ["work", "personal"]) {
		const provider = accountProvider(name);
		assert.ok(provider.auth.oauth?.login);
		assert.ok(provider.auth.oauth?.refresh);
		assert.ok(provider.getModels().length > 0);
		assert.ok(
			provider
				.getModels()
				.every((model) => model.provider === provider.id && model.api === "openai-codex-responses"),
		);
		models.setProvider(provider);
		await credentials.modify(provider.id, async () => ({
			type: "oauth",
			access: `fake-${name}`,
			refresh: `refresh-${name}`,
			expires: Date.now() + 3600000,
		}));
	}
	assert.equal((await models.getAuth(providerId("work")))?.auth.apiKey, "fake-work");
	assert.equal((await models.getAuth(providerId("personal")))?.auth.apiKey, "fake-personal");
	await models.logout(providerId("work"));
	assert.equal(await models.getAuth(providerId("work")), undefined);
	assert.equal((await models.getAuth(providerId("personal")))?.auth.apiKey, "fake-personal");
	assert.equal(await credentials.read("openai-codex"), undefined);
});
