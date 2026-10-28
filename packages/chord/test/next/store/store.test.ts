// The store (slice 6a §2, §3): opening, the commit step, storage failures, one host per store (rule 7), close.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../../src/context/index.ts";
import { sqliteBackend } from "../../../src/next/store/backend.ts";
import { changeDocument, createDocument, retireDocument } from "../../../src/next/store/engine.ts";
import { importStore } from "../../../src/next/store/import.ts";
import type { StagedWrite } from "../../../src/next/store/step.ts";
import { type ChordStore, openStore, type Store } from "../../../src/next/store/store.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
import { exported, metered, rejection } from "../support.ts";

const ADDRESS = { namespace: "chord", owner: "session:app.store", kind: "notes", key: "" };
const BASE = { version: 1, fingerprint: "0000000000000000", value: { n: 0 } };

/** A store on a fresh `:memory:` database, as Chord's layers see it. */
async function memoryStore(options?: { readonly outbox?: boolean }): Promise<ChordStore> {
	return (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context, options)) as ChordStore;
}

/** A fence that admits and records what it adopted. */
function recording(adopted: [number, readonly number[]][] = []) {
	return {
		adopted,
		fence: { admit: () => true, adopt: (seq: number, ids: readonly number[]) => void adopted.push([seq, ids]) },
	};
}

/** Creates the singleton at `ADDRESS` and resolves with its id. */
async function created(store: ChordStore): Promise<number> {
	const { adopted, fence } = recording();
	await store.commit([createDocument(ADDRESS, "latest", BASE, JSON.stringify(BASE.value))], fence, context);
	return adopted[0]![1][0]!;
}

/** A staged write whose step fails in the backend. */
const BROKEN: StagedWrite = {
	order: "write",
	apply: (step) =>
		step.run("INSERT INTO no_such_table VALUES (1)").then(() => ({ kind: "document.retire", id: 0, revision: 0 })),
};

let directory: string | undefined;

afterEach(async () => {
	if (directory !== undefined) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

describe("opening", () => {
	it("creates a new store at seq 0 without an outbox, and reopens a file at its last seq and ids", async () => {
		directory = await mkdtemp(join(tmpdir(), "chord-store-"));
		const path = join(directory, "store.sqlite");
		const store = (await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context)) as ChordStore;
		expect([store.lastSeq, store.outbox]).toEqual([0, undefined]);
		expect(await created(store)).toBe(1);
		await store.close(context);
		const reopened = (await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context)) as ChordStore;
		expect(reopened.lastSeq).toBe(1);
		const { adopted, fence } = recording();
		await reopened.commit([createDocument({ ...ADDRESS, key: "b" }, "latest", BASE, "{}")], fence, context);
		expect(adopted).toEqual([[2, [2]]]);
		await reopened.close(context);
	});

	it("refuses a database that is not UTF-8, closing the backend (rule 12)", async () => {
		const db = await openNodeSqliteDatabase(":memory:");
		await db.exec('PRAGMA encoding = "UTF-16le"');
		await expect(openStore(sqliteBackend(db), context)).rejects.toThrow("not UTF-8");
		await expect(db.get("SELECT 1")).rejects.toThrow();
	});
});

describe("the commit step", () => {
	it("assigns one seq per commit, applies retirements before creations, and adopts before the next step", async () => {
		const store = await memoryStore();
		const id = await created(store);
		const events: string[] = [];
		const fence = (name: string) => ({
			admit: () => true,
			adopt: (seq: number, ids: readonly number[]) => void events.push(`${name} ${seq} ${ids}`),
		});
		const first = store.commit(
			[createDocument(ADDRESS, "latest", BASE, "{}"), retireDocument(id, 1)],
			fence("recreate"),
			context,
		);
		const second = store.commit(
			[changeDocument(2, 1, { kind: "delta", version: 1, ops: [["s", ["n"], 1]] }, '[["s",["n"],1]]')],
			fence("change"),
			context,
		);
		expect(await Promise.all([first, second])).toEqual([2, 3]);
		expect(events).toEqual(["recreate 2 2", "change 3 "]);
		expect(store.lastSeq).toBe(3);
	});

	it("rejects a commit its fence refuses at the entry released, writing nothing; an empty commit takes no seq", async () => {
		const store = await memoryStore();
		const refused = store.commit(
			[createDocument(ADDRESS, "latest", BASE, "{}")],
			{ admit: () => false, adopt: () => {} },
			context,
		);
		expect(await rejection(refused)).toMatchObject({ code: "released" });
		const { adopted, fence } = recording();
		expect(await store.commit([], fence, context)).toBe(0);
		expect(adopted).toEqual([[0, []]]);
		expect(await created(store)).toBe(1);
	});

	it("numbers up to Number.MAX_SAFE_INTEGER after an import near it, then fails storage_failed: no seq repeats", async () => {
		const [manifest, ...rest] = await exported(await memoryStore());
		const parts = [{ ...manifest!, lastSeq: Number.MAX_SAFE_INTEGER - 1 }, ...rest];
		const store = (await importStore(
			sqliteBackend(await openNodeSqliteDatabase(":memory:")),
			parts,
			context,
		)) as ChordStore;
		expect(await created(store)).toBe(1);
		expect(store.lastSeq).toBe(Number.MAX_SAFE_INTEGER);
		const refused = store.commit(
			[createDocument({ ...ADDRESS, key: "b" }, "latest", BASE, "{}")],
			recording().fence,
			context,
		);
		expect(await rejection(refused)).toMatchObject({ code: "unavailable", reason: "storage_failed" });
		expect(store.lastSeq).toBe(Number.MAX_SAFE_INTEGER);
		expect(await rejection(store.read(async () => null, context))).toMatchObject({ reason: "storage_failed" });
	});

	it("counts one commit and three statements for a delta, four with an outbox (cost guard)", async () => {
		for (const [outbox, statements] of [
			[false, 3],
			[true, 4],
		] as const) {
			const store = await memoryStore({ outbox });
			const id = await created(store);
			const telemetry = await metered();
			const ops = [["s", ["n"], 1]] as const;
			await store.commit(
				[changeDocument(id, 1, { kind: "delta", version: 1, ops }, JSON.stringify(ops))],
				recording().fence,
				telemetry.context,
			);
			expect(telemetry.counts()).toEqual({ "chord.store.commits": 1, "chord.store.statements": statements });
		}
	});
});

describe("storage failures", () => {
	it("stop the store: the commit rejects storage_failed, later commits and reads too; the host is told once", async () => {
		const store = await memoryStore();
		const told: unknown[] = [];
		store.attach((error) => told.push(error));
		expect(await rejection(store.commit([BROKEN], recording().fence, context))).toMatchObject({
			code: "unavailable",
			reason: "storage_failed",
		});
		expect(await rejection(store.commit([BROKEN], recording().fence, context))).toMatchObject({
			reason: "storage_failed",
		});
		expect(await rejection(store.read(async () => 1, context))).toMatchObject({ reason: "storage_failed" });
		expect(told.length).toBe(1);
		expect(store.lastSeq).toBe(0);
		await store.close(context);
		await store.close(context);
	});

	it("include an adopt that throws and a conditional update that finds another revision", async () => {
		const store = await memoryStore();
		const id = await created(store);
		const throwing = {
			admit: () => true,
			adopt: () => {
				throw new Error("adopt threw");
			},
		};
		expect(await rejection(store.commit([retireDocument(id, 1)], throwing, context))).toMatchObject({
			reason: "storage_failed",
		});
		// An empty commit's adopt too.
		const empty = await memoryStore();
		expect(await rejection(empty.commit([], throwing, context))).toMatchObject({ reason: "storage_failed" });
		expect(await rejection(empty.read(async () => 1, context))).toMatchObject({ reason: "storage_failed" });
		const other = await memoryStore();
		const otherId = await created(other);
		const stale = changeDocument(otherId, 7, { kind: "delta", version: 1, ops: [] }, "[]");
		expect(await rejection(other.commit([stale], recording().fence, context))).toMatchObject({
			reason: "storage_failed",
		});
		expect(other.lastSeq).toBe(1);
	});

	it("spare a read whose context was aborted (aborted), and reject a read that settles after the stop", async () => {
		const store = await memoryStore();
		const cancel = withCancel(context);
		cancel.cancel();
		const failing = store.read(() => Promise.reject(new Error("backend")), cancel.context);
		expect(await rejection(failing)).toMatchObject({ code: "aborted" });
		const gate = Promise.withResolvers<number>();
		const late = store.read(() => gate.promise, context);
		await rejection(store.commit([BROKEN], recording().fence, context));
		gate.resolve(1);
		expect(await rejection(late)).toMatchObject({ reason: "storage_failed" });
	});
});

describe("one host per store (rule 7)", () => {
	it("refuses a second listener until the first detaches", async () => {
		const store = await memoryStore();
		store.attach(() => {});
		expect(() => store.attach(() => {})).toThrow("already attached");
		store.detach();
		store.attach(() => {});
	});
});

describe("close", () => {
	it("waits for the running step, rejects queued commits and later reads released, and closes the backend", async () => {
		const store = await memoryStore();
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const create = createDocument(ADDRESS, "latest", BASE, "{}");
		const held: StagedWrite = {
			order: "create",
			apply: async (step) => {
				entered.resolve();
				await gate.promise;
				return create.apply(step);
			},
		};
		const running = store.commit([held], recording().fence, context);
		await entered.promise;
		const queued = store.commit(
			[createDocument({ ...ADDRESS, key: "q" }, "latest", BASE, "{}")],
			recording().fence,
			context,
		);
		const closed = (store as Store).close(context);
		gate.resolve();
		expect(await running).toBe(1);
		expect(await rejection(queued)).toMatchObject({ code: "released" });
		await closed;
		expect(await rejection(store.read(async () => 1, context))).toMatchObject({ code: "released" });
	});
});
