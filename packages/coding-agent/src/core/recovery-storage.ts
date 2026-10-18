import { createHash } from "node:crypto";
import type { CustomEntry, FileEntry } from "./session-manager.ts";

const fields = ["prompt", "systemPrompt", "suspendedTasks"] as const;
type RecoveryField = (typeof fields)[number];
interface FieldReference {
	entryId: string;
	sha256: string;
}
type FieldReferences = Partial<Record<RecoveryField, FieldReference>>;

/** Physical JSONL metadata, never part of a logical CustomEntry or TaskRecoveryState. */
interface StoredRecoveryEntry extends CustomEntry {
	recoveryStorage?: { version: 1; refs: FieldReferences };
}

interface IndexedRecord {
	order: number;
	inline: Partial<Record<RecoveryField, string>>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isRecoveryEntry(entry: FileEntry): entry is CustomEntry {
	return entry.type === "custom" && entry.customType === "pi-task-recovery";
}

function isFieldValue(field: RecoveryField, value: unknown): boolean {
	return field === "systemPrompt" ? typeof value === "string" : Array.isArray(value);
}

function digest(serialized: string): string {
	return createHash("sha256").update(serialized).digest("hex");
}

function invalid(reason: string): never {
	throw new Error(`Invalid task recovery storage: ${reason}`);
}

/** Only IDs and hashes are retained, not historical payloads. One index belongs to one physical file. */
export class RecoveryStorageIndex {
	private readonly records = new Map<string, IndexedRecord>();
	private readonly sources = new Map<RecoveryField, Map<string, string>>(fields.map((field) => [field, new Map()]));

	/** Prepare without changing the committed dictionary. The caller registers only after durable append. */
	encode(entry: FileEntry): FileEntry {
		if ("recoveryStorage" in entry) invalid("expected logical entry, not physical metadata");
		if (!isRecoveryEntry(entry)) return entry;
		// Normalize once before hashing so optional/undefined/provider fields have ordinary JSON semantics.
		const stored = JSON.parse(JSON.stringify(entry)) as StoredRecoveryEntry;
		if (!isObject(stored.data)) return stored;
		const refs: FieldReferences = {};
		for (const field of fields) {
			const value = stored.data[field];
			if (!isFieldValue(field, value)) continue;
			const serialized = JSON.stringify(value);
			// Small arrays and short strings cost less inline than an ID + SHA-256 reference.
			const bytes = Buffer.byteLength(serialized);
			if (bytes < 512) continue;
			const sha256 = digest(serialized);
			// Cross-branch sharing substitutes identical field bytes only. The target's state,
			// parent links and provenance still decide authority; copies use a fresh index.
			const entryId = this.sources.get(field)!.get(sha256);
			if (!entryId) continue;
			const ref = { entryId, sha256 };
			// Legacy/custom IDs can be longer than generated IDs; include metadata overhead too.
			if (Buffer.byteLength(JSON.stringify(ref)) + 128 >= bytes) continue;
			refs[field] = ref;
			delete stored.data[field];
		}
		if (Object.keys(refs).length) stored.recoveryStorage = { version: 1, refs };
		return stored;
	}

	/** Validate references before admitting a physical record; all targets must already be direct inline sources. */
	register(entry: FileEntry): FieldReferences {
		if (!isRecoveryEntry(entry)) {
			if ("recoveryStorage" in entry) invalid("metadata on a non-recovery entry");
			return {};
		}
		if (this.records.has(entry.id)) invalid(`duplicate entry ${entry.id}`);
		const refs = this.references(entry, this.records.size);
		const inline: IndexedRecord["inline"] = {};
		if (isObject(entry.data)) {
			for (const field of fields) {
				const value = entry.data[field];
				if (isFieldValue(field, value)) inline[field] = digest(JSON.stringify(value));
			}
		}
		this.records.set(entry.id, { order: this.records.size, inline });
		for (const field of fields) {
			const hash = inline[field];
			if (hash && !this.sources.get(field)!.has(hash)) this.sources.get(field)!.set(hash, entry.id);
		}
		return refs;
	}

	private references(entry: CustomEntry, order: number): FieldReferences {
		if (!("recoveryStorage" in entry)) return {};
		const storage: unknown = entry.recoveryStorage;
		if (
			!isObject(storage) ||
			storage.version !== 1 ||
			Object.keys(storage).some((key) => key !== "version" && key !== "refs") ||
			!isObject(storage.refs) ||
			Object.keys(storage.refs).length === 0 ||
			!isObject(entry.data)
		)
			invalid("unsupported encoding or malformed metadata");
		for (const [name, value] of Object.entries(storage.refs)) {
			if (
				!fields.includes(name as RecoveryField) ||
				!isObject(value) ||
				typeof value.entryId !== "string" ||
				!value.entryId ||
				typeof value.sha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test(value.sha256) ||
				Object.keys(value).some((key) => key !== "entryId" && key !== "sha256") ||
				Object.hasOwn(entry.data, name)
			)
				invalid(`malformed ${name} reference`);
			const source = this.records.get(value.entryId);
			if (!source || source.order >= order || source.inline[name as RecoveryField] !== value.sha256)
				invalid(`missing, non-inline, future or mismatched ${name} source ${value.entryId}`);
		}
		return storage.refs as FieldReferences;
	}

	/** Reads at most three direct source records, never a reference chain or an execution-state ancestor. */
	decode(entry: CustomEntry, readEntry: (id: string) => CustomEntry): unknown {
		const record = this.records.get(entry.id);
		if (!record) invalid(`unregistered entry ${entry.id}`);
		const refs = this.references(entry, record.order);
		if (!Object.keys(refs).length) return entry.data;
		const data = { ...(entry.data as Record<string, unknown>) };
		const sources = new Map<string, CustomEntry>();
		for (const field of fields) {
			const ref = refs[field];
			if (!ref) continue;
			let source = sources.get(ref.entryId);
			if (!source) {
				source = readEntry(ref.entryId);
				sources.set(ref.entryId, source);
			}
			if (!isRecoveryEntry(source) || source.id !== ref.entryId || !isObject(source.data))
				invalid(`unreadable ${field} source`);
			this.references(source, this.records.get(ref.entryId)!.order);
			const value = source.data[field];
			if (!isFieldValue(field, value) || digest(JSON.stringify(value)) !== ref.sha256)
				invalid(`corrupt ${field} source ${ref.entryId}`);
			data[field] = value;
		}
		return data;
	}
}
