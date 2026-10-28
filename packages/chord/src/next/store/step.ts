// The commit step's working state (slice 6a §3) and the shape every write takes into it: a write staged before the
// queue (serialized, rule 8), applied inside the step in rule 9's order.

import type { SqliteExecutor, SqliteValue } from "../../sqlite/index.ts";
import type { TableRecord } from "./catalog.ts";
import type { StoreWrite } from "./writes.ts";

/** Where a staged write goes in its commit (rule 9): retirements, creations, then everything else in order. */
export type WriteOrder = "retire" | "create" | "write";

/** A write staged for the commit step: its order and what it does there, returning the write as recorded. */
export type StagedWrite = {
	readonly order: WriteOrder;
	/** Applies the write inside the step's backend transaction; resolves with the write as the outbox records it. */
	apply(step: Step): Promise<StoreWrite>;
};

/**
 * One commit step: its backend transaction, its seq, the document ids it assigns (S10, monotonic with seq), the table
 * records it changed (the store's catalog takes them after `COMMIT`) and the statements it ran
 * (`chord.store.statements`).
 */
export class Step {
	readonly executor: SqliteExecutor;
	readonly seq: number;
	/** The next document id; the store adopts it after `COMMIT`. */
	nextDocumentId: number;
	/** The ids of the commit's created documents, in the order of their writes. */
	readonly created: number[] = [];
	/** The table records this step changed, by SQL name. */
	readonly tables = new Map<string, TableRecord>();
	readonly #catalog: ReadonlyMap<string, TableRecord>;
	statements = 0;

	constructor(
		executor: SqliteExecutor,
		seq: number,
		nextDocumentId: number,
		catalog: ReadonlyMap<string, TableRecord>,
	) {
		this.executor = executor;
		this.seq = seq;
		this.nextDocumentId = nextDocumentId;
		this.#catalog = catalog;
	}

	/** The record of table `name` as this step leaves it so far. */
	table(name: string): TableRecord | undefined {
		return this.tables.get(name) ?? this.#catalog.get(name);
	}

	/** Runs one statement. */
	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		this.statements++;
		return this.executor.run(sql, ...params);
	}

	/** Runs one statement and resolves with the rows it changed. */
	runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
		this.statements++;
		return this.executor.runCounted(sql, ...params);
	}

	/** Runs one query. */
	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		this.statements++;
		return this.executor.all<T>(sql, ...params);
	}
}
