// The applier (slice 6a §13): recorded writes applied as they were recorded, inside a backend transaction, checked
// against the store's own records (a trust boundary: archives, later a replica's batches). One code path for import,
// bootstrap and, from slice 6b, batch apply; 6a applies the kinds an archive holds.

import type { SqliteValue } from "../../sqlite/index.ts";
import { checkName } from "../contracts/internal.ts";
import { invalid } from "../data/internal.ts";
import type { ArchivePart } from "./archive.ts";
import type { TableRecord } from "./catalog.ts";
import { COLUMN_NAME, type ColumnRecord } from "./columns.ts";
import { insertDocument } from "./engine.ts";
import { checkScalar, ROW_VERSION, toSqlite, versionColumn } from "./rows.ts";
import { recordedPut } from "./sql.ts";
import type { Step } from "./step.ts";
import { INDEX_NAME } from "./table.ts";
import { applyIndex, applyTable, type TableWrite } from "./table-writes.ts";

/** A recorded write the applier takes: the writes of an archive. */
export type AppliedWrite = Exclude<ArchivePart, { readonly kind: "manifest" | "end" }>;

/** Applies `write` in `step`; a write the records refuse throws `invalid/args` (`what` names its place). */
export async function applyWrite(step: Step, write: AppliedWrite, what: string): Promise<void> {
	switch (write.kind) {
		case "table":
			checkTable(write, what);
			await applyTable(step, write);
			return;
		case "index":
			checkIndex(recordOf(step, write.table, what), write, what);
			await applyIndex(step, write);
			return;
		case "put": {
			const record = recordOf(step, write.table, what);
			const { sql, physical } = recordedPut(write.table, record.columns);
			await step.run(sql, ...putParams(record, write, physical, what));
			return;
		}
		case "document.create": {
			let text: string;
			try {
				text = JSON.stringify(write.base.value);
			} catch (error) {
				throw invalid("args", `${what}: the base is not JSON (${String(error)})`);
			}
			await insertDocument(step, write.record, text);
			return;
		}
	}
}

/** A recorded table's SQL name (three names joined by `:`), columns, key and json versions, by the name rules. */
function checkTable(write: Extract<TableWrite, { readonly kind: "table" }>, what: string): void {
	const parts = write.table.split(":");
	if (parts.length !== 3) throw invalid("args", `${what}: table ${JSON.stringify(write.table)}: not kind:type:table`);
	try {
		for (const part of parts) checkName(part, `${what}: table name part`);
	} catch (error) {
		// `checkName` throws plain Errors.
		throw invalid("args", (error as Error).message);
	}
	const folded = new Set<string>();
	for (const [name, column] of Object.entries(write.columns)) {
		const where = `${what}: column ${JSON.stringify(name)}`;
		if (!COLUMN_NAME.test(name) || folded.has(name.toLowerCase()))
			throw invalid("args", `${where}: not a column name`);
		folded.add(name.toLowerCase());
		checkColumn(column, where);
	}
	if (write.key.length === 0) throw invalid("args", `${what}: the key has no column`);
	checkOrderColumns(write.columns, write.key, `${what}: the key`);
}

function checkColumn(column: ColumnRecord, what: string): void {
	const json = column.type === "json";
	if (json !== (column.version !== undefined) || json !== (column.fingerprint !== undefined)) {
		throw invalid("args", `${what}: a json(...) column has a version and a fingerprint, no other column has`);
	}
	if (column.default === undefined) return;
	if (json || column.optional) throw invalid("args", `${what}: only a non-opt scalar column has a default`);
	checkScalar(column.type, column.default, `${what}: the default`);
}

/** `names` are distinct, recorded, non-`opt` `str` or `int` columns. */
function checkOrderColumns(
	columns: { readonly [name: string]: ColumnRecord },
	names: readonly string[],
	what: string,
): void {
	if (new Set(names).size !== names.length) throw invalid("args", `${what}: a column occurs twice`);
	for (const name of names) {
		const column = Object.hasOwn(columns, name) ? columns[name] : undefined;
		if (column === undefined || column.optional || (column.type !== "str" && column.type !== "int")) {
			throw invalid("args", `${what}: ${JSON.stringify(name)} is not a non-opt str or int column`);
		}
	}
}

function checkIndex(record: TableRecord, write: Extract<TableWrite, { readonly kind: "index" }>, what: string): void {
	if (!INDEX_NAME.test(write.name) || Object.hasOwn(record.indexes, write.name)) {
		throw invalid("args", `${what}: index ${JSON.stringify(write.name)}: not a new index name`);
	}
	checkOrderColumns(record.columns, write.columns, `${what}: index ${write.name}`);
}

/** The record of `table` in `step`; a write for a table not recorded is refused. */
function recordOf(step: Step, table: string, what: string): TableRecord {
	const record = step.table(table);
	if (record === undefined) throw invalid("args", `${what}: table ${JSON.stringify(table)} is not recorded`);
	return record;
}

/**
 * The parameters of a `put` in `physical` order, checked against the recorded columns: every non-`opt` column, no
 * other field, values of their types, `json(...)` cells as JSON (no plugin code runs) with a version up to the
 * column's, and `version` up to the table's.
 */
function putParams(
	record: TableRecord,
	write: Extract<TableWrite, { readonly kind: "put" }>,
	physical: readonly string[],
	what: string,
): SqliteValue[] {
	const { row, columns: versions, version } = write;
	for (const field of Object.keys(row)) {
		if (!Object.hasOwn(record.columns, field))
			throw invalid("args", `${what}: unknown column ${JSON.stringify(field)}`);
	}
	for (const field of Object.keys(versions)) {
		if (record.columns[field]?.type !== "json" || !Object.hasOwn(row, field)) {
			throw invalid(
				"args",
				`${what}: a version for ${JSON.stringify(field)}, which is no json(...) cell of the row`,
			);
		}
	}
	if (version > record.version) {
		throw invalid("args", `${what}: version ${version} is newer than the table's version ${record.version}`);
	}
	const cells = new Map<string, SqliteValue>();
	for (const [name, column] of Object.entries(record.columns)) {
		const where = `${what}: column ${JSON.stringify(name)}`;
		const value = row[name];
		// A row has no explicit `null`: an absent field is `NULL`; a `json(...)` cell's `null` is the JSON value.
		if (column.type === "json" ? !Object.hasOwn(row, name) : value === undefined) {
			if (!column.optional) throw invalid("args", `${where} is missing`);
			cells.set(name, null);
			continue;
		}
		if (column.type !== "json") {
			cells.set(name, toSqlite(checkScalar(column.type, value, where)));
			continue;
		}
		const version = versions[name];
		if (version === undefined || version > column.version!) throw invalid("args", `${where}: no readable version`);
		try {
			cells.set(name, JSON.stringify(value));
		} catch (error) {
			throw invalid("args", `${where}: not JSON (${String(error)})`);
		}
		cells.set(versionColumn(name), version);
	}
	return physical.map((name) => (name === ROW_VERSION ? version : (cells.get(name) ?? null)));
}
