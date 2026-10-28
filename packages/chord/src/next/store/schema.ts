// The store's own SQL schema (slice 6a §2): its metadata, the recorded table definitions, the documents engine's
// records and revisions, and the outbox; versioned by `applySqliteMigrations`. Declared tables are named
// `"<host kind>:<object type>:<table>"`, so no name here can meet one of them.

import { applySqliteMigrations, type SqliteDatabase, type SqliteMigration } from "../../sqlite/index.ts";

/** The store's tables. */
export const TABLES = {
	meta: "chord_meta",
	tables: "chord_tables",
	documents: "chord_documents",
	revisions: "chord_revisions",
	outbox: "chord_outbox",
} as const;

/**
 * The schema history; never change an entry, append one. `chord_meta` is one row: `last_seq`, the next document id
 * (S10), and the outbox setting with its floor (the seq it starts after, advanced by `trim`). A document record keeps
 * its current base's version and fingerprint and a `revision` counter for the conditional `UPDATE`; the partial
 * unique index refuses two live records at one address.
 */
const MIGRATIONS: readonly SqliteMigration[] = [
	{
		version: 1,
		statements: [
			`CREATE TABLE ${TABLES.meta} (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				last_seq INTEGER NOT NULL,
				next_document_id INTEGER NOT NULL,
				outbox INTEGER NOT NULL CHECK (outbox IN (0, 1)),
				outbox_floor INTEGER NOT NULL
			) STRICT`,
			`INSERT INTO ${TABLES.meta} (singleton, last_seq, next_document_id, outbox, outbox_floor) VALUES (1, 0, 1, 0, 0)`,
			`CREATE TABLE ${TABLES.tables} (name TEXT PRIMARY KEY, definition TEXT NOT NULL) STRICT, WITHOUT ROWID`,
			`CREATE TABLE ${TABLES.documents} (
				id INTEGER PRIMARY KEY,
				namespace TEXT NOT NULL,
				owner TEXT NOT NULL,
				kind TEXT NOT NULL,
				key TEXT NOT NULL,
				history TEXT NOT NULL CHECK (history IN ('latest', 'rewindable')),
				created_at INTEGER NOT NULL,
				retired_at INTEGER,
				meta TEXT,
				revision INTEGER NOT NULL,
				version INTEGER NOT NULL,
				fingerprint TEXT NOT NULL
			) STRICT`,
			`CREATE UNIQUE INDEX chord_documents_live ON ${TABLES.documents} (namespace, owner, kind, key)
				WHERE retired_at IS NULL`,
			`CREATE TABLE ${TABLES.revisions} (
				document_id INTEGER NOT NULL,
				seq INTEGER NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
				version INTEGER NOT NULL,
				content TEXT NOT NULL,
				PRIMARY KEY (document_id, seq)
			) STRICT, WITHOUT ROWID`,
			`CREATE TABLE ${TABLES.outbox} (seq INTEGER PRIMARY KEY, format INTEGER NOT NULL, writes TEXT NOT NULL) STRICT`,
		],
	},
];

/** The store's schema version: the newest entry of its history (archives carry it). */
export const STORE_SCHEMA = MIGRATIONS.at(-1)!.version;

/** The store's metadata row, as `openStore` reads it once. */
export type MetaRow = {
	readonly last_seq: number;
	readonly next_document_id: number;
	readonly outbox: number;
	readonly outbox_floor: number;
};

/**
 * Brings `db` to the store's newest schema (one transaction) and checks that it stores text as UTF-8 (the store
 * compares text by its bytes); returns the metadata row.
 */
export async function applyStoreSchema(db: SqliteDatabase): Promise<MetaRow> {
	const encoding = await db.get<{ readonly encoding: string }>("PRAGMA encoding");
	if (encoding?.encoding !== "UTF-8")
		throw new Error(`store: the database encoding is ${encoding?.encoding}, not UTF-8`);
	await applySqliteMigrations(db, MIGRATIONS, { table: "chord_store_schema" });
	const meta = await db.get<MetaRow>(
		`SELECT last_seq, next_document_id, outbox, outbox_floor FROM ${TABLES.meta} WHERE singleton = 1`,
	);
	if (meta === undefined) throw new Error("store: the metadata row is missing");
	return meta;
}
