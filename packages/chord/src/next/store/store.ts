// The store (slice 6a §2, §3): opened over a backend, one commit queue that serializes only the commit step (the seal
// fence's admission check, `BEGIN`, the writes in rule 9's order, the outbox commit, `lastSeq`, `COMMIT`, then the
// owner's adoption), reads guarded as Durable's `GuardedStorage` guards them, and the stop after a backend error.

import { awaitWithContext, type Context } from "../../context/index.ts";
import type { SqliteDatabase, SqliteExecutor } from "../../sqlite/index.ts";
import { ChordError } from "../data/index.ts";
import type { ArchivePart } from "./archive.ts";
import type { Backend } from "./backend.ts";
import { readCatalog, type TableRecord, writeCatalog } from "./catalog.ts";
import { StoreExport } from "./export.ts";
import { OUTBOX_FORMAT, Outbox } from "./outbox.ts";
import { applyStoreSchema, type MetaRow, TABLES } from "./schema.ts";
import { type StagedWrite, Step, type WriteOrder } from "./step.ts";
import type { StoreWrite } from "./writes.ts";

/** A store as apps hold it: opened by `openStore`, owned and closed by the app. */
export interface Store {
	/** The seq of the store's last commit (0 for a new store). */
	readonly lastSeq: number;
	/** The outbox the sync layer reads; `undefined` without one. */
	readonly outbox: Outbox | undefined;
	/**
	 * The store's state after its `lastSeq` as archive parts (slice 6a §13), holding the commit queue from the first
	 * `next()` until the iteration ends, throws, is closed or `context` aborts.
	 */
	export(context: Context): AsyncIterableIterator<ArchivePart>;
	/**
	 * Closes the store: waits for a running commit step, rejects queued commits and reads `released`, closes the
	 * backend. Idempotent, also after `storage_failed`; `context` ends only this caller's wait (the close goes on).
	 */
	close(context: Context): Promise<void>;
}

/** What `openStore` takes besides the backend. */
export type StoreOptions = {
	/** Turns the outbox on (`true`) or off (`false`); omitted, the persisted setting stays (a new store: off). */
	readonly outbox?: boolean;
};

/**
 * Opens a store over `backend`: the store's schema migrations, the UTF-8 check, the metadata read once, the outbox
 * switched when asked. A failure closes the backend and rejects (rule 12).
 */
export async function openStore(backend: Backend, context: Context, options: StoreOptions = {}): Promise<Store> {
	const { db } = backend;
	try {
		context.abortSignal?.throwIfAborted();
		const meta = await switchOutbox(db, await applyStoreSchema(db), options.outbox);
		return new ChordStore(db, meta, await readCatalog(db));
	} catch (error) {
		try {
			await db.close();
		} catch {
			// The open's own failure is the one to report.
		}
		throw error;
	}
}

/** Turns the outbox on (from the current `lastSeq`) or off (its commits dropped) when `outbox` asks for the other. */
async function switchOutbox(db: SqliteDatabase, meta: MetaRow, outbox: boolean | undefined): Promise<MetaRow> {
	if (outbox === undefined || outbox === (meta.outbox === 1)) return meta;
	const floor = outbox ? meta.last_seq : 0;
	await db.transaction(async (executor) => {
		await executor.run(
			`UPDATE ${TABLES.meta} SET outbox = ?, outbox_floor = ? WHERE singleton = 1`,
			outbox ? 1 : 0,
			floor,
		);
		if (!outbox) await executor.run(`DELETE FROM ${TABLES.outbox}`);
	});
	return { ...meta, outbox: outbox ? 1 : 0, outbox_floor: floor };
}

/** The seal fence's two checks of a commit (§1.3), as the commit step calls them. */
export type CommitFence = {
	/** At the step's entry: `false` rejects the commit `released` and writes nothing. */
	admit(): boolean;
	/** After `COMMIT`: adopts the commit, `ids` being its created documents' ids in the order of their writes. */
	adopt(seq: number, ids: readonly number[]): void;
};

/** Where a store stands: open, stopped by a backend error, or closed. */
type StoreState =
	| { readonly kind: "open" }
	| { readonly kind: "failed"; readonly error: unknown }
	| { readonly kind: "closed" };

const ORDER: readonly WriteOrder[] = ["retire", "create", "write"];

const NOTHING = (): void => {};

/** The store behind `Store`, with what Chord's layers use: commits, guarded reads, the host's failure listener. */
export class ChordStore implements Store {
	readonly #db: SqliteDatabase;
	#lastSeq: number;
	#nextDocumentId: number;
	#outbox: Outbox | undefined;
	#state: StoreState = { kind: "open" };
	/** The commit queue's tail: each step starts after the one before it settled. */
	#tail: Promise<void> = Promise.resolve();
	/** Reads underway, which `close` waits for. */
	readonly #underway = new Set<Promise<unknown>>();
	/** The open host's listener for `storage_failed`, told once; one host per store (rule 7). */
	#listener: ((error: unknown) => void) | undefined;
	#closing: Promise<void> | undefined;
	/** The recorded tables, by SQL name; changed only after a step's `COMMIT`. */
	readonly #catalog: Map<string, TableRecord>;
	/** The ends of the exports holding the queue or waiting for it, which closing the store calls. */
	readonly #held = new Set<() => void>();

	constructor(db: SqliteDatabase, meta: MetaRow, catalog: Map<string, TableRecord>) {
		this.#db = db;
		this.#catalog = catalog;
		this.#lastSeq = meta.last_seq;
		this.#nextDocumentId = meta.next_document_id;
		this.#outbox = meta.outbox === 1 ? new Outbox(this, meta.outbox_floor) : undefined;
	}

	get lastSeq(): number {
		return this.#lastSeq;
	}

	get outbox(): Outbox | undefined {
		return this.#outbox;
	}

	/** The id the next created document gets. */
	get nextDocumentId(): number {
		return this.#nextDocumentId;
	}

	/** Every recorded table, by SQL name, as of the last commit. */
	get tables(): ReadonlyMap<string, TableRecord> {
		return this.#catalog;
	}

	export(context: Context): AsyncIterableIterator<ArchivePart> {
		this.assertUsable();
		return new StoreExport(this, context);
	}

	/**
	 * Takes the commit queue (an export): resolves once every earlier commit settled, with the release that lets the
	 * later ones run (idempotent). Closing the store calls `end` (from the call on, also while waiting, and at once for a
	 * store closed before the call took the queue), which must release.
	 */
	take(end: () => void): Promise<() => void> {
		const held = Promise.withResolvers<void>();
		const release = (): void => {
			this.#held.delete(end);
			held.resolve();
		};
		this.#held.add(end);
		const taken = this.#tail.then(() => {
			// A store closed meanwhile (also before the export's first `next()`) holds nothing: the export ends.
			if (this.#state.kind === "closed") {
				release();
				end();
			}
			return release;
		});
		this.#tail = taken.then(() => held.promise);
		return taken;
	}

	/** The recorded table `name` (its SQL name), as of the last commit. */
	table(name: string): TableRecord | undefined {
		return this.#catalog.get(name);
	}

	/** Attaches the open host's `storage_failed` listener; a store attached to an open host is refused (rule 7). */
	attach(listener: (error: unknown) => void): void {
		if (this.#listener !== undefined) {
			throw new ChordError({ code: "invalid", reason: "args", message: "store: already attached to an open host" });
		}
		this.#listener = listener;
	}

	/** The host closed: the store may serve another one. */
	detach(): void {
		this.#listener = undefined;
	}

	/**
	 * Commits `writes` as one seq when the commit queue reaches it: `fence.admit()` at the step's entry, the writes in
	 * rule 9's order (retirements, creations, the rest), the outbox commit, `lastSeq`, `COMMIT`, then `fence.adopt`
	 * before the next step starts. Resolves with the seq. A backend error or a throwing `adopt` stops the store
	 * (`storage_failed`); a refused admission rejects `released`. `context` counts the step (no abort once queued).
	 */
	commit(writes: readonly StagedWrite[], fence: CommitFence, context: Context): Promise<number> {
		try {
			this.assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		const step = this.#tail.then(() => this.#step(writes, fence, context));
		this.#tail = step.then(NOTHING, NOTHING);
		return step;
	}

	/**
	 * Runs `read` on the backend under the guard (rule 11, Durable's `GuardedStorage`): refused once the store stopped
	 * or closed; a backend error fails the store unless `context` was aborted (then `aborted`); a read settling after
	 * the store stopped rejects `unavailable/storage_failed`.
	 */
	async read<T>(read: (executor: SqliteExecutor) => Promise<T>, context: Context): Promise<T> {
		this.assertUsable();
		const call = (async () => read(this.#db))();
		this.#underway.add(call);
		let result: T;
		try {
			result = await call;
		} catch (error) {
			this.assertUsable();
			const signal = context.abortSignal;
			if (signal?.aborted)
				throw new ChordError({ code: "aborted", message: "store: read aborted" }, { cause: signal.reason });
			throw this.#fail(error);
		} finally {
			this.#underway.delete(call);
		}
		this.assertUsable();
		return result;
	}

	/**
	 * Runs `write` on the backend outside the commit queue (the outbox's `trim`), in a backend transaction, guarded as
	 * a read without a context: any error stops the store.
	 */
	async maintain(write: (executor: SqliteExecutor) => Promise<void>): Promise<void> {
		this.assertUsable();
		const call = this.#db.transaction(write);
		this.#underway.add(call);
		try {
			await call;
		} catch (error) {
			this.assertUsable();
			throw this.#fail(error);
		} finally {
			this.#underway.delete(call);
		}
	}

	close(context: Context): Promise<void> {
		this.#closing ??= this.#close();
		return awaitWithContext(this.#closing, context);
	}

	async #close(): Promise<void> {
		this.#state = { kind: "closed" };
		for (const end of [...this.#held]) end();
		await this.#tail;
		await Promise.allSettled([...this.#underway]);
		await this.#db.close();
	}

	async #step(writes: readonly StagedWrite[], fence: CommitFence, context: Context): Promise<number> {
		this.assertUsable();
		if (!fence.admit()) {
			throw new ChordError({ code: "released", reason: "discarded", message: "store: the commit's attempt ended" });
		}
		if (writes.length === 0) {
			// An empty commit takes no seq; a throwing `adopt` stops the store as for any commit.
			try {
				fence.adopt(this.#lastSeq, []);
			} catch (error) {
				throw this.#fail(error);
			}
			return this.#lastSeq;
		}
		const seq = this.#lastSeq + 1;
		// Past the safe range seqs stop counting exactly (a later one would repeat): the store cannot number further.
		if (seq > Number.MAX_SAFE_INTEGER) throw this.#fail(new Error("store: no seq past Number.MAX_SAFE_INTEGER"));
		const outbox = this.#outbox !== undefined;
		let step: Step;
		try {
			step = await this.#db.transaction(async (executor) => {
				const step = new Step(executor, seq, this.#nextDocumentId, this.#catalog);
				const recorded: StoreWrite[] | undefined = outbox ? [] : undefined;
				for (const order of ORDER) {
					for (const write of writes) {
						if (write.order !== order) continue;
						const done = await write.apply(step);
						recorded?.push(done);
					}
				}
				await writeCatalog(step);
				if (recorded !== undefined) {
					await step.run(
						`INSERT INTO ${TABLES.outbox} (seq, format, writes) VALUES (?, ?, ?)`,
						seq,
						OUTBOX_FORMAT,
						JSON.stringify(recorded),
					);
				}
				await step.run(
					`UPDATE ${TABLES.meta} SET last_seq = ?, next_document_id = ? WHERE singleton = 1`,
					seq,
					step.nextDocumentId,
				);
				return step;
			});
		} catch (error) {
			throw this.#fail(error);
		}
		// `COMMIT` returned: the commit is durable, and memory follows.
		this.#lastSeq = seq;
		this.#nextDocumentId = step.nextDocumentId;
		for (const [name, record] of step.tables) this.#catalog.set(name, record);
		const metrics = context.telemetry.metrics;
		metrics?.counter("chord.store.commits").add(1);
		metrics?.counter("chord.store.statements").add(step.statements);
		try {
			fence.adopt(seq, step.created);
		} catch (error) {
			throw this.#fail(error);
		}
		return seq;
	}

	/** Throws `unavailable/storage_failed` once the store stopped, `released` once it closed. */
	assertUsable(): void {
		const state = this.#state;
		if (state.kind === "failed") throw storageFailed(state.error);
		if (state.kind === "closed")
			throw new ChordError({ code: "released", reason: "closed", message: "store: closed" });
	}

	/** Stops the store after `error` (once; its host is told once); returns the error the caller rejects with. */
	#fail(error: unknown): ChordError {
		if (this.#state.kind === "open") {
			this.#state = { kind: "failed", error };
			this.#listener?.(error);
		}
		return storageFailed(error);
	}
}

/** The `unavailable/storage_failed` error of a stopped store, its backend error as the cause. */
function storageFailed(error: unknown): ChordError {
	return new ChordError(
		{ code: "unavailable", reason: "storage_failed", message: "store: storage failed" },
		{ cause: error },
	);
}
