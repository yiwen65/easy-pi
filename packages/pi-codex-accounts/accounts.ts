import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createProvider } from "@earendil-works/pi-ai";

// Native ESM bridge avoids Pi 0.84.2 Jiti's prefix alias for pi-ai subpaths.
const { openaiCodexProvider } = createRequire(import.meta.url)("./codex-provider.mjs") as
  typeof import("@earendil-works/pi-ai/providers/openai-codex");

export const PREFIX = "openai-codex-account-";
export const DEFAULT = "default";

export function validateName(name: string): void {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || name === DEFAULT) {
    throw new Error("账号别名须为 1–32 位小写英文字母、数字或连字符，以字母开头；default 为原有账号保留。");
  }
}

export function providerId(name: string): string {
  if (name === DEFAULT) return "openai-codex";
  validateName(name);
  return PREFIX + name;
}

// Empty directories are atomic, additive metadata: no tokens and no shared JSON rewrite.
export function listAccounts(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isDirectory()) return false;
        try { validateName(entry.name); return true; } catch { return false; }
      })
      .map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function addAccount(directory: string, name: string): void {
  validateName(name);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(join(directory, name), { mode: 0o700 });
}

export function accountProvider(name: string) {
  validateName(name);
  const base = openaiCodexProvider();
  const id = providerId(name);
  return createProvider({
    id,
    name: `OpenAI Codex [${name}]`,
    baseUrl: base.baseUrl,
    auth: base.auth,
    models: base.getModels().map((model) => ({ ...model, provider: id })),
    api: base,
  });
}
