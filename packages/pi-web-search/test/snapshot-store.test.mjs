import assert from "node:assert/strict";
import { test } from "node:test";
import { SnapshotPool, SnapshotStore, snapshotsEnabled, snapshotStore } from "../src/snapshot-store.ts";

assert.equal(
	process.env.PI_WEB_SEARCH_OFFLINE,
	"1",
	"Use node test/run.mjs; do not run this file in your normal environment.",
);

const content = (overrides = {}) => ({
	text: "captured text",
	requestedUrl: "https://docs.python.org/3/",
	url: "https://docs.python.org/3/",
	title: "Python docs",
	capturedAt: "2026-10-13T00:00:00.000Z",
	format: "text",
	scanComplete: true,
	captureTruncated: false,
	incompleteReasons: [],
	warnings: [],
	contentStatus: "content",
	...overrides,
});

/** Every store in these tests owns a private pool, so counts and bytes are local by construction. */
function isolated(options = {}) {
	return new SnapshotStore({ pool: new SnapshotPool(), ...options });
}

test("S01 snapshots are readable only by the owning host object", () => {
	const pool = new SnapshotPool();
	const first = new SnapshotStore({ pool });
	const second = new SnapshotStore({ pool });
	const owner = { session: "owner" };
	const stranger = { session: "stranger" };
	const id = first.put(owner, content());
	assert.equal(typeof id, "string");
	assert.equal(first.get(owner, id)?.text, "captured text");
	assert.equal(first.get(stranger, id), undefined, "a known id is not authorization");
	assert.equal(second.get(stranger, id), undefined, "another store cannot read it either");
	assert.equal(second.get(owner, id), undefined, "a store is bound to the owner object of its first write");
	assert.equal(second.put(stranger, content({ text: "stranger text" })) !== undefined, true);
	assert.equal(second.get(stranger, "missing"), undefined, "unknown ids look exactly like unauthorized ones");
});

test("S02 TTL is absolute and reads never extend it", () => {
	let clock = 1_000;
	let sequence = 0;
	const pool = new SnapshotPool();
	const store = new SnapshotStore({ pool, now: () => clock, ttlMs: 100, idFactory: () => `id-${++sequence}` });
	const owner = {};
	const id = store.put(owner, content());
	assert.ok(id);
	clock = 1_050;
	assert.equal(store.get(owner, id)?.text, "captured text", "valid before the deadline");
	clock = 1_099;
	assert.equal(store.get(owner, id)?.text, "captured text", "a read must not extend the lifetime");
	clock = 1_100;
	assert.equal(store.get(owner, id), undefined, "expires at exactly storedAt + ttl");
	assert.equal(pool.count, 0, "an expired entry is removed, not merely hidden");
	assert.equal(pool.bytes, 0);
	const replacement = store.put(owner, content({ text: "replacement" }));
	assert.equal(store.get(owner, replacement)?.text, "replacement", "the owner can still store a new snapshot");
});

test("S03 per-owner count and byte caps evict the least recently used entry", () => {
	let sequence = 0;
	const pool = new SnapshotPool();
	const store = new SnapshotStore({ pool, maxPerOwner: 2, idFactory: () => `id-${++sequence}` });
	const owner = {};
	const first = store.put(owner, content({ text: "first" }));
	const second = store.put(owner, content({ text: "second" }));
	assert.equal(store.get(owner, first)?.text, "first", "touch the oldest entry so `second` becomes the LRU one");
	const third = store.put(owner, content({ text: "third" }));
	assert.equal(store.get(owner, first)?.text, "first");
	assert.equal(store.get(owner, second), undefined, "the least recently used entry is the victim");
	assert.equal(store.get(owner, third)?.text, "third");
	assert.equal(pool.count, 2);

	const tight = isolated({ maxOwnerBytes: 200 });
	const large = tight.put(owner, content({ text: "x".repeat(300) }));
	assert.equal(large, undefined, "an entry larger than the per-owner byte budget is refused");
	assert.equal(tight.size, 0);
	const accounting = isolated({ maxOwnerBytes: 4_000 });
	const metadata = content({ text: "ok", warnings: Array.from({ length: 8 }, () => "w".repeat(40)) });
	const stored = accounting.put(owner, metadata);
	assert.equal(typeof stored, "string");
	assert.ok(
		accounting.bytes > 320,
		`metadata is accounted for, not only the text: ${accounting.bytes}`,
	);
});

test("S03 process-wide byte and count caps evict across owners deterministically", () => {
	let first = 0;
	let second = 0;
	const pool = new SnapshotPool({ maxCount: 3 });
	const one = new SnapshotStore({ pool, idFactory: () => `a-${++first}` });
	const two = new SnapshotStore({ pool, idFactory: () => `b-${++second}` });
	const ownerOne = {};
	const ownerTwo = {};
	const a1 = one.put(ownerOne, content({ text: "a1" }));
	const b1 = two.put(ownerTwo, content({ text: "b1" }));
	const a2 = one.put(ownerOne, content({ text: "a2" }));
	const b2 = two.put(ownerTwo, content({ text: "b2" }));
	assert.equal(pool.count, 3, "the process-wide count cap holds");
	assert.equal(one.get(ownerOne, a1), undefined, "the globally oldest entry is evicted first");
	assert.equal(one.get(ownerOne, a2)?.text, "a2");
	assert.equal(two.get(ownerTwo, b1)?.text, "b1");
	assert.equal(two.get(ownerTwo, b2)?.text, "b2");

	const bytePool = new SnapshotPool({ maxBytes: 4_000 });
	const bytes = new SnapshotStore({ pool: bytePool, maxPerOwner: 8, idFactory: () => `c-${++first}` });
	const owner = {};
	const kept = bytes.put(owner, content({ text: "k".repeat(1_000) }));
	for (let index = 0; index < 3; index++) bytes.put(owner, content({ text: "z".repeat(1_000) }));
	assert.ok(bytePool.bytes <= 4_000, `process byte budget respected: ${bytePool.bytes}`);
	assert.equal(bytes.get(owner, kept), undefined, "byte pressure evicts the oldest entries");
	assert.equal(bytes.put(owner, content({ text: "q".repeat(9_000) })), undefined, "an entry over the pool cap is refused");
});

test("S04 returned content and stored input are detached from the caller", () => {
	const store = isolated();
	const owner = {};
	const reasons = ["frame_incomplete"];
	const id = store.put(owner, content({ incompleteReasons: reasons, warnings: ["scan bound"] }));
	reasons.push("injected-after-put");
	const page = store.get(owner, id);
	assert.ok(page);
	assert.ok(Object.isFrozen(page), "the returned result is frozen");
	assert.ok(Object.isFrozen(page.incompleteReasons) && Object.isFrozen(page.warnings), "its lists are frozen too");
	assert.throws(() => {
		page.text = "polluted";
	});
	assert.throws(() => {
		page.incompleteReasons.push("injected");
	});
	assert.deepEqual(store.get(owner, id).incompleteReasons, ["frame_incomplete"]);
	assert.equal(store.get(owner, id).text, "captured text");
	assert.deepEqual(page.warnings, ["scan bound"]);
});

test("S05 a fresh store starts empty and expiry releases budget", () => {
	let clock = 5_000;
	const pool = new SnapshotPool();
	const store = new SnapshotStore({ pool, now: () => clock, ttlMs: 50, idFactory: () => "stable-id" });
	const owner = {};
	const id = store.put(owner, content());
	assert.equal(pool.count, 1);
	const restarted = new SnapshotStore({ pool: new SnapshotPool(), idFactory: () => "stable-id" });
	assert.equal(restarted.get(owner, id), undefined, "no snapshot survives a new store (process restart)");
	clock = 5_050;
	assert.equal(store.get(owner, id), undefined);
	assert.equal(pool.count, 0);
	assert.equal(pool.bytes, 0);
});

test("S06 refused puts never fabricate a handle", () => {
	const owner = {};
	const large = isolated({ maxOwnerBytes: 64 });
	assert.equal(large.put(owner, content({ text: "x".repeat(200) })), undefined);
	assert.equal(large.size, 0);
	assert.equal(large.bytes, 0);
	const broken = isolated({ idFactory: () => "" });
	assert.equal(broken.put(owner, content()), undefined, "an unusable id generator stores nothing");
	assert.equal(broken.size, 0);
	const collision = isolated({ idFactory: () => "same-id" });
	assert.equal(typeof collision.put(owner, content({ text: "kept" })), "string");
	assert.equal(collision.put(owner, content({ text: "overwritten" })), undefined, "a colliding id is refused");
	assert.equal(collision.get(owner, "same-id")?.text, "kept");
});

test("S07 the host can disable snapshots without creating a shared fallback store", () => {
	const previous = process.env.PI_WEB_FETCH_SNAPSHOTS;
	try {
		delete process.env.PI_WEB_FETCH_SNAPSHOTS;
		assert.equal(snapshotsEnabled(), true);
		const owner = {};
		const enabled = snapshotStore(owner);
		assert.ok(enabled instanceof SnapshotStore);
		assert.equal(snapshotStore(owner), enabled, "one store per owner object");
		assert.notEqual(snapshotStore({}), enabled, "different owners never share a store");
		assert.equal(snapshotStore(null), undefined);
		assert.equal(snapshotStore("owner"), undefined);
		const id = enabled.put(owner, content());
		process.env.PI_WEB_FETCH_SNAPSHOTS = "0";
		assert.equal(snapshotsEnabled(), false);
		assert.equal(snapshotStore(owner), undefined, "disabled creates no new snapshot and no shared cache");
		assert.equal(snapshotStore({}), undefined);
		assert.equal(enabled.get(owner, id)?.text, "captured text", "the private store is unchanged, just unreachable");
	} finally {
		if (previous === undefined) delete process.env.PI_WEB_FETCH_SNAPSHOTS;
		else process.env.PI_WEB_FETCH_SNAPSHOTS = previous;
	}
});

test("S08 ids are unpredictable and never derived from the capture", () => {
	const store = isolated();
	const owner = {};
	const one = store.put(owner, content());
	const two = store.put(owner, content());
	assert.match(one, /^[0-9a-f]{32}$/);
	assert.notEqual(one, two);
	assert.equal(one.includes("docs.python.org"), false);
});

test("S09 malformed captures are refused without touching stored state", () => {
	const store = isolated();
	const owner = {};
	const invalid = [
		null,
		undefined,
		"text",
		{},
		content({ text: "" }),
		content({ format: "html" }),
		content({ requestedUrl: undefined }),
		content({ url: "x".repeat(2049) }),
		content({ title: "t".repeat(513) }),
		content({ capturedAt: "" }),
		content({ contentStatus: undefined }),
		content({ scanComplete: "yes" }),
		content({ captureTruncated: 0 }),
		content({ warnings: "warning" }),
		content({ incompleteReasons: ["ok", 3] }),
		content({ warnings: Array.from({ length: 65 }, () => "w") }),
	];
	for (const value of invalid) {
		assert.equal(store.put(owner, value), undefined, `refused: ${JSON.stringify(value)?.slice(0, 60)}`);
	}
	assert.equal(store.size, 0);
	assert.equal(store.bytes, 0);
	assert.equal(typeof store.put(owner, content()), "string", "a valid capture still works afterwards");
});

// WF08 additions: the capture-time counters, the structure of the stored text and the per-frame
// provenance are stored with the capture, counted like every other stored byte, and detached.
const captureMeta = (overrides = {}) => ({
	framesRead: 3,
	scrollSteps: 12,
	blockedRequests: 1,
	dnsMode: "local_fake_ip_client",
	stabilized: true,
	ambiguities: ["structure_truncated"],
	...overrides,
});
const structure = [
	{ type: "heading", start: 0, end: 5, level: 1, frame: 0, id: "f0b0" },
	{
		type: "link",
		start: 6,
		end: 12,
		frame: 0,
		id: "f0b1",
		links: [{ start: 6, end: 12, href: "https://page.public.org/a", title: "a", allowed: true }],
	},
];
const provenance = [{ url: "https://page.public.org/a", status: "complete", reasons: [], role: "main" }];

test("S10 WF08: capture-time counters, structure and provenance are stored and detached", () => {
	const store = isolated();
	const owner = {};
	const id = store.put(owner, content({ meta: captureMeta(), blocks: structure, frames: provenance }));
	assert.equal(typeof id, "string");
	const page = store.get(owner, id);
	assert.equal(page.meta.framesRead, 3);
	assert.equal(page.meta.scrollSteps, 12);
	assert.equal(page.meta.blockedRequests, 1);
	assert.equal(page.meta.dnsMode, "local_fake_ip_client");
	assert.equal(page.meta.stabilized, true);
	assert.deepEqual(page.meta.ambiguities, ["structure_truncated"]);
	assert.equal(page.blocks.length, 2);
	assert.equal(page.blocks[0].level, 1);
	assert.equal(page.blocks[1].links[0].href, "https://page.public.org/a");
	assert.equal(page.blocks[1].links[0].allowed, true);
	assert.equal(page.frames[0].role, "main");
	assert.equal(page.frames[0].url, "https://page.public.org/a");
	assert.ok(Object.isFrozen(page.meta) && Object.isFrozen(page.meta.ambiguities));
	assert.ok(Object.isFrozen(page.blocks) && Object.isFrozen(page.blocks[0]));
	assert.ok(Object.isFrozen(page.frames) && Object.isFrozen(page.frames[0].reasons));
	assert.throws(() => {
		page.meta.framesRead = 99;
	});
	assert.throws(() => {
		page.blocks.push({ type: "other", start: 0, end: 1 });
	});
	assert.throws(() => {
		page.frames[0].reasons.push("injected");
	});
	const again = store.get(owner, id);
	assert.equal(again.meta.framesRead, 3);
	assert.equal(again.blocks.length, 2);
	assert.equal(again.frames[0].reasons.length, 0);
});

test("S10 WF08: stored structure and metadata count toward the byte budget", () => {
	const metadataOnly = isolated({ maxOwnerBytes: 4_000 });
	const owner = {};
	assert.equal(typeof metadataOnly.put(owner, content({ text: "x".repeat(100), meta: captureMeta() })), "string");
	const plainBytes = Buffer.byteLength(JSON.stringify(content({ text: "x".repeat(100) })));
	assert.ok(metadataOnly.bytes > plainBytes, `metadata is accounted for: ${metadataOnly.bytes} > ${plainBytes}`);
	const withStructure = isolated({ maxOwnerBytes: 20_000 });
	const structureStore = { blocks: Array.from({ length: 200 }, (_, index) => ({ type: "paragraph", start: index * 2, end: index * 2 + 1, frame: 0, id: `f0b${index}` })), frames: provenance };
	const stored = withStructure.put(owner, content({ text: "x".repeat(100), ...structureStore }));
	assert.equal(typeof stored, "string");
	const structureBytes = withStructure.bytes;
	assert.ok(structureBytes > metadataOnly.bytes, `structure and provenance are accounted for: ${structureBytes}`);
	const tight = isolated({ maxOwnerBytes: 2_000 });
	const refusingOwner = {};
	assert.equal(typeof tight.put(refusingOwner, content({ text: "x".repeat(100) })), "string");
	assert.equal(
		tight.put(refusingOwner, content({ text: "x".repeat(100), blocks: Array.from({ length: 2_000 }, (_, index) => ({ type: "paragraph", start: index * 2, end: index * 2 + 1, frame: 0 })) })),
		undefined,
		"structure over the byte budget is refused, never silently truncated",
	);
});

test("S10 WF08: malformed counters, structure or provenance are refused", () => {
	const store = isolated();
	const owner = {};
	const invalid = [
		content({ meta: captureMeta({ dnsMode: "unknown-mode" }) }),
		content({ meta: captureMeta({ framesRead: -1 }) }),
		content({ meta: captureMeta({ framesRead: 1.5 }) }),
		content({ meta: captureMeta({ scrollSteps: Number.NaN }) }),
		content({ meta: captureMeta({ stabilized: "yes" }) }),
		content({ meta: captureMeta({ ambiguities: "structure_truncated" }) }),
		content({ meta: captureMeta({ ambiguities: Array.from({ length: 65 }, () => "x") }) }),
		content({ blocks: [{ type: "banner", start: 0, end: 4 }] }),
		content({ blocks: [{ type: "heading", start: 5, end: 5 }] }),
		content({ blocks: [{ type: "heading", start: 5, end: 4 }] }),
		content({ blocks: [{ type: "heading", start: 0, end: 4, level: 7 }] }),
		content({ blocks: [{ type: "heading", start: 0.5, end: 4 }] }),
		content({ blocks: [{ type: "link", start: 0, end: 4, links: [{ start: 0, end: 4, href: "" }] }] }),
		content({ blocks: [{ type: "link", start: 0, end: 4, links: [{ start: 0, end: 9, href: "https://page.public.org/a" }] }] }),
		content({ blocks: [{ type: "frame", start: 0, end: 4, frame: "0" }] }),
		content({ frames: [{ url: "https://page.public.org/a", status: "complete", reasons: [], role: "unknown" }] }),
		content({ frames: [{ url: "https://page.public.org/a", status: "complete", reasons: [1], role: "main" }] }),
		content({ blocks: "structure" }),
		content({ frames: "provenance" }),
	];
	for (const value of invalid) {
		assert.equal(store.put(owner, value), undefined, `refused: ${JSON.stringify(value)?.slice(0, 90)}`);
	}
	assert.equal(store.size, 0);
	assert.equal(store.bytes, 0);
	// A capture written without the new fields stays readable, exactly as before WF08.
	const legacy = store.put(owner, content());
	assert.equal(typeof legacy, "string");
	const page = store.get(owner, legacy);
	assert.equal(page.meta, undefined);
	assert.equal(page.blocks, undefined);
	assert.equal(page.frames, undefined);
});
