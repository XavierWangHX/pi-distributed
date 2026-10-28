// The engine (slice 6a §10, §11): persisted documents as bases and deltas, their keys in code point order, retirement.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import type { Op } from "../../../src/delta/index.ts";
import type { ArchivePart } from "../../../src/next/store/archive.ts";
import { sqliteBackend } from "../../../src/next/store/backend.ts";
import {
	changeDocument,
	createDocument,
	type DocumentAddress,
	findDocument,
	listDocumentKeys,
	loadDocument,
	retireDocument,
} from "../../../src/next/store/engine.ts";
import { importStore } from "../../../src/next/store/import.ts";
import { TABLES } from "../../../src/next/store/schema.ts";
import type { StagedWrite } from "../../../src/next/store/step.ts";
import { type ChordStore, openStore } from "../../../src/next/store/store.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
import { exported, rejection } from "../support.ts";

const OWNER = { namespace: "chord", owner: "session:app.store", kind: "notes" };

/** A store on `:memory:` (or `on`) and a commit helper resolving with the created ids. */
async function engine(on?: ChordStore) {
	const store =
		on ?? ((await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)) as ChordStore);
	const commit = async (...writes: StagedWrite[]): Promise<readonly number[]> => {
		let created: readonly number[] = [];
		await store.commit(
			writes,
			{
				admit: () => true,
				adopt: (_seq, ids) => {
					created = ids;
				},
			},
			context,
		);
		return created;
	};
	const at = (key: string): DocumentAddress => ({ ...OWNER, key });
	const base = (value: object, version = 1) => ({
		version,
		fingerprint: `f${version}`.padEnd(16, "0"),
		value: value as never,
	});
	const create = (key: string, value: object) => createDocument(at(key), "latest", base(value), JSON.stringify(value));
	const delta = (id: number, revision: number, ops: Op[]) =>
		changeDocument(id, revision, { kind: "delta", version: 1, ops }, JSON.stringify(ops));
	const read = <T>(fn: Parameters<ChordStore["read"]>[0]) => store.read(fn, context) as Promise<T>;
	return { store, commit, at, base, create, delta, read };
}

/** `store`'s archive with `edit` applied to its parts, imported into a fresh `:memory:` store. */
async function reimported(store: ChordStore, edit: (parts: ArchivePart[]) => unknown[]): Promise<ChordStore> {
	const parts = edit(await exported(store));
	return (await importStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), parts, context)) as ChordStore;
}

const LIMIT = Number.MAX_SAFE_INTEGER;

describe("documents", () => {
	it("load as their base with the deltas after it applied; a new base prunes the older revisions", async () => {
		const { commit, at, base, create, delta, read } = await engine();
		const [id] = await commit(create("a", { n: 0 }));
		await commit(delta(id!, 1, [["s", ["n"], 1]]));
		await commit(delta(id!, 2, [["s", ["n"], 2]]));
		const record = (await read<Awaited<ReturnType<typeof findDocument>>>((e) => findDocument(e, at("a"))))!;
		expect(record).toMatchObject({ id, revision: 3, version: 1, history: "latest", createdAt: 1 });
		expect(await read((e) => loadDocument(e, record))).toMatchObject({ value: { n: 2 }, deltasSinceBase: 2 });
		const next = base({ m: 9 }, 2);
		await commit(changeDocument(id!, 3, { kind: "base", ...next }, JSON.stringify(next.value)));
		const rebased = (await read<Awaited<ReturnType<typeof findDocument>>>((e) => findDocument(e, at("a"))))!;
		expect(rebased).toMatchObject({ revision: 4, version: 2, fingerprint: next.fingerprint });
		expect(await read((e) => loadDocument(e, rebased))).toMatchObject({ value: { m: 9 }, deltasSinceBase: 0 });
		expect(await read((e) => e.all(`SELECT seq FROM ${TABLES.revisions}`))).toEqual([{ seq: 4 }]);
	});

	it("list live keys in code point order, paging after a key", async () => {
		const { commit, create, read } = await engine();
		await commit(create("\u{1F600}", {}), create("\uFF5E", {}), create("b", {}), create("a", {}));
		expect(await read((e) => listDocumentKeys(e, OWNER, undefined, 10))).toEqual(["a", "b", "\uFF5E", "\u{1F600}"]);
		expect(await read((e) => listDocumentKeys(e, OWNER, "b", 1))).toEqual(["\uFF5E"]);
	});

	it("retire a latest record with its revisions (rule 19); the address takes a new incarnation", async () => {
		const { commit, at, create, read } = await engine();
		const [id] = await commit(create("a", { n: 0 }));
		const [next] = await commit(retireDocument(id!, 1), create("a", { n: 1 }));
		expect(next).toBe(2);
		expect(await read((e) => e.all(`SELECT id FROM ${TABLES.documents}`))).toEqual([{ id: 2 }]);
		expect(await read((e) => e.all(`SELECT document_id FROM ${TABLES.revisions}`))).toEqual([{ document_id: 2 }]);
		expect(await read((e) => findDocument(e, at("a")))).toMatchObject({ id: 2 });
	});

	it("refuse two live records at one address and a delta on another version: storage_failed", async () => {
		const first = await engine();
		await first.commit(first.create("a", {}));
		expect(await rejection(first.commit(first.create("a", {})))).toMatchObject({ reason: "storage_failed" });
		const second = await engine();
		const [id] = await second.commit(second.create("a", {}));
		const crossing = changeDocument(id!, 1, { kind: "delta", version: 2, ops: [] }, "[]");
		expect(await rejection(second.commit(crossing))).toMatchObject({ reason: "storage_failed" });
	});
});

describe("counters at the safe-integer limit", () => {
	it("allocate document ids up to the safe range after an import near it; past it a commit fails storage_failed", async () => {
		const { store: source } = await engine();
		const near = (next: number) =>
			reimported(source, ([manifest, ...rest]) => [{ ...manifest, nextDocumentId: next }, ...rest]);
		const { store, commit, create } = await engine(await near(LIMIT - 1));
		expect(await commit(create("a", { n: 0 }))).toEqual([LIMIT - 1]);
		expect(store.nextDocumentId).toBe(LIMIT);
		expect(await rejection(commit(create("b", { n: 0 })))).toMatchObject({ reason: "storage_failed" });
		// Two creations in one commit where only one id is left: nothing of it is written.
		const both = await engine(await near(LIMIT - 1));
		expect(await rejection(both.commit(both.create("a", { n: 0 }), both.create("b", { n: 0 })))).toMatchObject({
			reason: "storage_failed",
		});
		expect([both.store.lastSeq, both.store.nextDocumentId]).toEqual([0, LIMIT - 1]);
	});

	it("count revisions up to the safe range after an import near it; a change past it fails storage_failed", async () => {
		const { store: source, commit: seed, create } = await engine();
		await seed(create("a", { n: 0 }));
		const store = await reimported(source, (parts) =>
			parts.map((part) =>
				part.kind === "document.create" ? { ...part, record: { ...part.record, revision: LIMIT - 1 } } : part,
			),
		);
		const { commit, delta, read, at } = await engine(store);
		const record = (await read<Awaited<ReturnType<typeof findDocument>>>((e) => findDocument(e, at("a"))))!;
		await commit(delta(record.id, LIMIT - 1, [["s", ["n"], 1]]));
		expect(await rejection(commit(delta(record.id, LIMIT, [["s", ["n"], 2]])))).toMatchObject({
			reason: "storage_failed",
		});
	});
});
