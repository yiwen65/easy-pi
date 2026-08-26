import { createHash } from "node:crypto";

export function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			if (record[key] !== undefined) sorted[key] = canonicalize(record[key]);
		}
		return sorted;
	}
	return value;
}

export function hashPayload(value: unknown): string {
	if (typeof value === "string" || value instanceof Uint8Array) return sha256Hex(value);
	return sha256Hex(canonicalJson(value));
}
