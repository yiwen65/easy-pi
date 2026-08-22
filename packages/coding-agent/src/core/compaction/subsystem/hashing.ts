/**
 * Shared hashing and canonical serialization for the compaction subsystem.
 */

import { createHash } from "node:crypto";

export function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * Deterministic JSON serialization: object keys sorted recursively so equal
 * content always produces equal bytes (and therefore equal hashes).
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			const v = record[key];
			if (v !== undefined) {
				sorted[key] = canonicalize(v);
			}
		}
		return sorted;
	}
	return value;
}

export function hashPayload(value: unknown): string {
	if (typeof value === "string") return sha256Hex(value);
	if (value instanceof Uint8Array) return sha256Hex(value);
	return sha256Hex(canonicalJson(value));
}
