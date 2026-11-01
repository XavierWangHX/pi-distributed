// The validators the benchmarks compare, each behind the same interface: compile a schema, then check values.
// Every library is used through its fastest boolean path and keeps the object it returns, as an application would.

import { Validator as CfValidator } from "@cfworker/json-schema";
import { fromJsonSchema } from "@oh-my-pi/omptype";
import { Compile } from "typebox/compile";
import { ResetExternal, ResetFunctions } from "typebox/schema";
import { Settings } from "typebox/system";
import { compile, type FormatCheck, type JsonSchema } from "../../src/index.ts";

/** How a benchmark compiles a schema. */
export interface PrepareOptions {
	readonly draft: "2020-12" | "7";
	readonly schemas?: Readonly<Record<string, JsonSchema>>;
	readonly formats?: Readonly<Record<string, FormatCheck>>;
}

/** A compiled schema: its boolean check and the object the library returned (kept alive by the caller). */
export interface Prepared {
	readonly check: (value: unknown) => boolean;
	readonly validator: unknown;
}

/** A library under comparison. */
export interface Candidate {
	readonly name: string;
	readonly prepare: (schema: JsonSchema, options: PrepareOptions) => Prepared;
}

/** Whether this process runs with code generation from strings disabled, as under a strict CSP. */
export const noEval = process.execArgv.includes("--disallow-code-generation-from-strings");

const piSchema: Candidate = {
	name: "pi-schema",
	prepare(schema, options) {
		const validator = compile(schema, options);
		return { check: validator.check, validator };
	},
};

// TypeBox keeps its last build in module-level accumulators; reset them so no build state is retained between schemas.
function typeboxCompile(schema: JsonSchema, options: PrepareOptions, accelerate: boolean) {
	Settings.Set({ useAcceleration: accelerate });
	try {
		return Compile((options.schemas ?? {}) as never, schema as never);
	} finally {
		ResetFunctions();
		ResetExternal();
		Settings.Set({ useAcceleration: true });
	}
}

const typebox: Candidate = {
	name: noEval ? "typebox (no eval: interpreter)" : "typebox",
	prepare(schema, options) {
		const validator = typeboxCompile(schema, options, true);
		return { check: (v) => validator.Check(v), validator };
	},
};

const typeboxInterpreter: Candidate = {
	name: "typebox interpreter",
	prepare(schema, options) {
		const validator = typeboxCompile(schema, options, false);
		return { check: (v) => validator.Check(v), validator };
	},
};

const cfworker: Candidate = {
	name: "cfworker",
	prepare(schema, options) {
		const validator = new CfValidator(schema as never, options.draft, true);
		for (const [uri, remote] of Object.entries(options.schemas ?? {})) validator.addSchema(remote as never, uri);
		return { check: (v) => validator.validate(v).valid, validator };
	},
};

// omptype compiles with new Function on the first allows() call. Without eval that call throws EvalError once per
// schema; omptype then keeps validating through its interpreter, so the benchmark absorbs that one throw.
const omptype: Candidate = {
	name: noEval ? "omptype (no eval: interpreter)" : "omptype",
	prepare(schema) {
		const validator = fromJsonSchema(schema);
		if (noEval) {
			try {
				validator.allows(null);
			} catch (error) {
				if (!(error instanceof EvalError)) throw error;
			}
		}
		return { check: (v) => validator.allows(v), validator };
	},
};

/** Every candidate, ours first. */
export const candidates: readonly Candidate[] = [piSchema, typebox, cfworker, omptype];

/** Candidates by name, including TypeBox's interpreter (what TypeBox runs when eval is unavailable). */
export const byName: ReadonlyMap<string, Candidate> = new Map(
	[...candidates, typeboxInterpreter].map((c) => [c.name.split(" (")[0], c]),
);
