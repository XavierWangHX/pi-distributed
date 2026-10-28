// Archives (slice 6a §13; decisions "Export archives are operations", "Writes carry their versions; archives are
// lossless"): the parts an export yields and an import takes, their order, and the one compiled schema every
// imported part is checked against first.

import Type, { type TInteger } from "typebox";
import type { Context } from "../../context/index.ts";
import { arr, bool, int, lit, num, obj, opt, str, union, unknown } from "../contracts/index.ts";
import { invalid, validatorFor } from "../data/internal.ts";
import type { DocumentWrite } from "./engine.ts";
import type { TableWrite } from "./table-writes.ts";

/** The archive format `export` writes; `import` takes this one only. */
export const ARCHIVE_FORMAT = 1;

/** The first part: the format, the store's schema version, its `lastSeq` and the next document id (rule 24). */
export type ArchiveManifest = {
	readonly kind: "manifest";
	readonly format: number;
	readonly schema: number;
	readonly lastSeq: number;
	readonly nextDocumentId: number;
};

/**
 * One part of an archive, in this order: the manifest; per table (by SQL name) its `table` write, its `put`s and its
 * `index` writes; the live documents' `document.create`s (by id, the current value as the base); `end` with the
 * count of the parts between.
 */
export type ArchivePart =
	| ArchiveManifest
	| Extract<TableWrite, { readonly kind: "table" | "put" | "index" }>
	| Extract<DocumentWrite, { readonly kind: "document.create" }>
	| { readonly kind: "end"; readonly writes: number };

/** An integer from `min` up to 2^53 - 1: seqs, ids, versions and counts stay exact (a seq after 2^53 would repeat). */
function safe(min: number): TInteger {
	return int({ min, max: Number.MAX_SAFE_INTEGER });
}

const version = safe(1);

const column = obj({
	type: union([lit("str"), lit("int"), lit("num"), lit("bool"), lit("json")]),
	optional: opt(lit(true)),
	default: opt(union([str(), num(), bool()])),
	version: opt(version),
	fingerprint: opt(str()),
});

const PART = union([
	obj({
		kind: lit("manifest"),
		format: safe(1),
		schema: safe(1),
		lastSeq: safe(0),
		nextDocumentId: safe(1),
	}),
	obj({
		kind: lit("table"),
		table: str(),
		version,
		state: union([lit("ready"), lit("migrating")]),
		columns: Type.Record(Type.String(), column),
		key: arr(str()),
		fingerprint: str(),
	}),
	obj({
		kind: lit("put"),
		table: str(),
		row: Type.Record(Type.String(), unknown()),
		version,
		columns: Type.Record(Type.String(), version),
	}),
	obj({ kind: lit("index"), table: str(), name: str(), columns: arr(str()) }),
	obj({
		kind: lit("document.create"),
		record: obj({
			id: safe(1),
			namespace: str(),
			owner: str(),
			kind: str(),
			// Absent for a singleton.
			key: opt(str()),
			history: union([lit("latest"), lit("rewindable")]),
			createdAt: safe(1),
			meta: opt(str()),
			revision: safe(1),
			version,
			fingerprint: str(),
		}),
		base: obj({ version, fingerprint: str(), value: unknown() }),
	}),
	obj({ kind: lit("end"), writes: safe(0) }),
]);

const PART_SCHEMA = { schema: PART };

/** Checks one imported part against the archive schema (a trust boundary); `invalid/args` naming its position. */
export function checkPart(part: unknown, position: number, context: Context): ArchivePart {
	context.telemetry.metrics?.counter("chord.data.validations").add(1);
	if (!validatorFor(PART_SCHEMA, context).Check(part)) {
		throw invalid("args", `import: part ${position}: not an archive part`);
	}
	// The check above establishes the type.
	return part as ArchivePart;
}
