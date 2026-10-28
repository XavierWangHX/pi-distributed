// The documents engine (S13, slice 6a §8): one record per incarnation of an address, revisions made of a base and
// later deltas; its writes inside the commit step, checked by the writes themselves (the partial unique index on the
// live address, the counted conditional `UPDATE` on the record's revision), and its plain reads.

import { apply, type Op } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import type { SqliteExecutor } from "../../sqlite/index.ts";
import { TABLES } from "./schema.ts";
import type { StagedWrite, Step } from "./step.ts";

/**
 * A document's address: the adapter's namespace, the owner string, the definition's name and, for a keyed document, its
 * key; a singleton has none (as Durable's addresses). The column keeps `""` for it, which a keyed document's empty key
 * shares (its definition says which it is): a record read back gives no key for either.
 */
export type DocumentAddress = {
	readonly namespace: string;
	readonly owner: string;
	readonly kind: string;
	readonly key?: string;
};

/** A stored record: one incarnation of an address. Chord keeps only the latest revision (`history: "latest"`). */
export type DocumentRecord = DocumentAddress & {
	readonly id: number;
	readonly history: "latest" | "rewindable";
	/** The seq that created it. */
	readonly createdAt: number;
	readonly meta?: string;
	/** Counts its changes: a change names the revision it was prepared on. */
	readonly revision: number;
	/** The version and schema fingerprint of its current base. */
	readonly version: number;
	readonly fingerprint: string;
};

/** A base: a whole value at a version. */
export type DocumentBase = { readonly version: number; readonly fingerprint: string; readonly value: JsonValue };

/** A change's content: a new base, or a delta on the current base's version. */
export type DocumentContent =
	| ({ readonly kind: "base" } & DocumentBase)
	| { readonly kind: "delta"; readonly version: number; readonly ops: readonly Op[] };

/** The engine's writes as the outbox and archives record them. */
export type DocumentWrite =
	| { readonly kind: "document.create"; readonly record: DocumentRecord; readonly base: DocumentBase }
	| {
			readonly kind: "document.change";
			readonly id: number;
			readonly revision: number;
			readonly content: DocumentContent;
	  }
	| { readonly kind: "document.retire"; readonly id: number; readonly revision: number };

/** A loaded document: its record and its value (base plus deltas applied once). */
export type StoredDocument = {
	readonly record: DocumentRecord;
	readonly value: JsonValue;
	/** The deltas stored after its base (what `checkpointWhen` sees). */
	readonly deltasSinceBase: number;
};

/**
 * Stages the creation of a document at `address` with `base`; its id comes from the step. `text` is the base's value
 * serialized before the queue (rule 8).
 */
export function createDocument(
	address: DocumentAddress,
	history: "latest" | "rewindable",
	base: DocumentBase,
	text: string,
): StagedWrite {
	return {
		order: "create",
		apply: async (step) => {
			// The next id is stored too: it stays in the safe range, or ids would stop counting exactly and repeat.
			if (step.nextDocumentId >= Number.MAX_SAFE_INTEGER) {
				throw new Error("store: no document id past Number.MAX_SAFE_INTEGER");
			}
			const id = step.nextDocumentId++;
			step.created.push(id);
			const { version, fingerprint } = base;
			const record: DocumentRecord = {
				id,
				...address,
				history,
				createdAt: step.seq,
				revision: 1,
				version,
				fingerprint,
			};
			await insertDocument(step, record, text);
			return { kind: "document.create", record, base };
		},
	};
}

/**
 * Inserts `record` as it is (id, `createdAt`, revision kept: a creation, or an import) with its base, `text` being
 * the base's value serialized.
 */
export async function insertDocument(step: Step, record: DocumentRecord, text: string): Promise<void> {
	const { id, namespace, owner, kind, key, history, createdAt, meta, revision, version, fingerprint } = record;
	await step.run(
		`INSERT INTO ${TABLES.documents}
			(id, namespace, owner, kind, key, history, created_at, meta, revision, version, fingerprint)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		namespace,
		owner,
		kind,
		key ?? "",
		history,
		createdAt,
		meta ?? null,
		revision,
		version,
		fingerprint,
	);
	await insertRevision(step, id, "base", version, text);
}

/**
 * Stages a change of document `id` prepared on `revision`: a delta on the current base's version, or a new base
 * (which prunes the older revisions of a `latest` record). `text` is the content serialized before the queue.
 */
export function changeDocument(id: number, revision: number, content: DocumentContent, text: string): StagedWrite {
	const write: DocumentWrite = { kind: "document.change", id, revision, content };
	return {
		order: "write",
		apply: async (step) => {
			// As ids: a revision past the safe range would stop counting exactly.
			if (revision >= Number.MAX_SAFE_INTEGER) throw new Error(`document ${id}: no revision past the safe range`);
			await insertRevision(step, id, content.kind, content.version, text);
			const changed =
				content.kind === "delta"
					? await step.runCounted(
							`UPDATE ${TABLES.documents} SET revision = revision + 1
								WHERE id = ? AND revision = ? AND version = ? AND retired_at IS NULL`,
							id,
							revision,
							content.version,
						)
					: await step.runCounted(
							`UPDATE ${TABLES.documents} SET revision = revision + 1, version = ?, fingerprint = ?
								WHERE id = ? AND revision = ? AND retired_at IS NULL`,
							content.version,
							content.fingerprint,
							id,
							revision,
						);
			// Memory and disk disagree: the step fails, which stops the store (Durable's rule).
			if (changed !== 1) throw new Error(`document ${id}: not live at revision ${revision}`);
			if (content.kind === "base") {
				await step.run(`DELETE FROM ${TABLES.revisions} WHERE document_id = ? AND seq < ?`, id, step.seq);
			}
			return write;
		},
	};
}

/** Stages the retirement of `latest` document `id` at `revision`: its record and revisions go (rule 19). */
export function retireDocument(id: number, revision: number): StagedWrite {
	const write: DocumentWrite = { kind: "document.retire", id, revision };
	return {
		order: "retire",
		apply: async (step) => {
			const deleted = await step.runCounted(
				`DELETE FROM ${TABLES.documents} WHERE id = ? AND revision = ? AND retired_at IS NULL`,
				id,
				revision,
			);
			if (deleted !== 1) throw new Error(`document ${id}: not live at revision ${revision}`);
			await step.run(`DELETE FROM ${TABLES.revisions} WHERE document_id = ?`, id);
			return write;
		},
	};
}

type RecordRow = {
	readonly id: number;
	readonly namespace: string;
	readonly owner: string;
	readonly kind: string;
	readonly key: string;
	readonly history: "latest" | "rewindable";
	readonly created_at: number;
	readonly meta: string | null;
	readonly revision: number;
	readonly version: number;
	readonly fingerprint: string;
};

const RECORD_COLUMNS = "id, namespace, owner, kind, key, history, created_at, meta, revision, version, fingerprint";

/** The live record at `address`, if any. */
export async function findDocument(
	executor: SqliteExecutor,
	address: DocumentAddress,
): Promise<DocumentRecord | undefined> {
	const row = await executor.get<RecordRow>(
		`SELECT ${RECORD_COLUMNS} FROM ${TABLES.documents}
			WHERE namespace = ? AND owner = ? AND kind = ? AND key = ? AND retired_at IS NULL`,
		address.namespace,
		address.owner,
		address.kind,
		address.key ?? "",
	);
	return row === undefined ? undefined : recordOf(row);
}

type RevisionRow = {
	readonly seq: number;
	readonly kind: "base" | "delta";
	readonly version: number;
	readonly content: string;
};

/** Loads the live document `record` found: its latest base and the deltas after it, applied once. */
export async function loadDocument(executor: SqliteExecutor, record: DocumentRecord): Promise<StoredDocument> {
	const revisions = await executor.all<RevisionRow>(
		`SELECT seq, kind, version, content FROM ${TABLES.revisions} WHERE document_id = ? AND seq >= (
			SELECT max(seq) FROM ${TABLES.revisions} WHERE document_id = ? AND kind = 'base') ORDER BY seq`,
		record.id,
		record.id,
	);
	const [base, ...deltas] = revisions;
	if (base === undefined || base.kind !== "base") throw new Error(`document ${record.id}: no base`);
	let value = JSON.parse(base.content) as JsonValue;
	for (const delta of deltas) {
		if (delta.version !== base.version) throw new Error(`document ${record.id}: a delta crosses a version`);
		value = apply(value, JSON.parse(delta.content) as Op[]);
	}
	return { record, value, deltasSinceBase: deltas.length };
}

/** Up to `limit` keys of live documents of `kind` under `owner` after `after` (from the first), in code point order. */
export async function listDocumentKeys(
	executor: SqliteExecutor,
	address: Omit<DocumentAddress, "key">,
	after: string | undefined,
	limit: number,
): Promise<string[]> {
	// The first page has no lower bound: `""` is a key too.
	const from = after === undefined ? "" : " AND key > ?";
	const rows = await executor.all<{ readonly key: string }>(
		`SELECT key FROM ${TABLES.documents} WHERE namespace = ? AND owner = ? AND kind = ?${from}
			AND retired_at IS NULL ORDER BY key LIMIT ?`,
		address.namespace,
		address.owner,
		address.kind,
		...(after === undefined ? [] : [after]),
		limit,
	);
	return rows.map(({ key }) => key);
}

/** Up to `limit` live records with ids above `after`, by id (an export's pages). */
export async function listDocuments(executor: SqliteExecutor, after: number, limit: number): Promise<DocumentRecord[]> {
	const rows = await executor.all<RecordRow>(
		`SELECT ${RECORD_COLUMNS} FROM ${TABLES.documents} WHERE id > ? AND retired_at IS NULL ORDER BY id LIMIT ?`,
		after,
		limit,
	);
	return rows.map(recordOf);
}

function recordOf(row: RecordRow): DocumentRecord {
	const { id, namespace, owner, kind, key, history, created_at, meta, revision, version, fingerprint } = row;
	return {
		id,
		namespace,
		owner,
		kind,
		...(key === "" ? {} : { key }),
		history,
		createdAt: created_at,
		...(meta === null ? {} : { meta }),
		revision,
		version,
		fingerprint,
	};
}

function insertRevision(step: Step, id: number, kind: "base" | "delta", version: number, text: string): Promise<void> {
	return step.run(
		`INSERT INTO ${TABLES.revisions} (document_id, seq, kind, version, content) VALUES (?, ?, ?, ?, ?)`,
		id,
		step.seq,
		kind,
		version,
		text,
	);
}
