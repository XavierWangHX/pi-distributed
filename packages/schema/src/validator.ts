// compile(): a schema to a Validator, whose `check` is the fast boolean path and whose `errors` explains failures.

import type { Static } from "./builders.ts";
import { Compiler, RESTART } from "./compiler.ts";
import { Explainer } from "./explain.ts";
import type { Check, CompileOptions, JsonSchema, ValidationError } from "./types.ts";

/**
 * Compiles `schema` into a Validator. Throws if the schema is malformed or a `$ref` names nothing (register other
 * documents with `options.schemas`). The schema is read, never modified.
 */
export function compile<S extends JsonSchema>(schema: S, options: CompileOptions = NO_OPTIONS): Validator<Static<S>> {
	return new Validator(schema, options, compileCheck(schema, options));
}

const NO_OPTIONS: CompileOptions = Object.freeze({});

/** A compiled schema whose valid values have type `T` (`unknown` unless the schema was built with the builders). */
export class Validator<T = unknown> {
	/** Whether `value` is valid. A plain function: it may be passed around without its validator. */
	readonly check: (value: unknown) => value is T;
	private readonly schema: JsonSchema;
	private readonly options: CompileOptions;
	private explainer: Explainer | undefined = undefined;

	constructor(schema: JsonSchema, options: CompileOptions, check: Check) {
		// A compiled check is exactly the test that a value has the schema's static type.
		this.check = check as (value: unknown) => value is T;
		this.schema = schema;
		this.options = options;
	}

	/**
	 * Why `value` is invalid: one error per failing keyword, `[]` when it is valid. Built on the first failure and
	 * kept, so a validator whose values always pass never pays for it.
	 */
	errors(value: unknown): ValidationError[] {
		if (this.check(value)) return [];
		this.explainer ??= new Explainer(compiler(this.schema, this.options), this.schema);
		return this.explainer.errors(value);
	}
}

function compileCheck(schema: JsonSchema, options: CompileOptions): Check {
	return compiler(schema, options).root();
}

// Most schemas compile without tracking the dynamic scope; one with a bookended $dynamicRef compiles again with it.
function compiler(schema: JsonSchema, options: CompileOptions): Compiler {
	const plain = new Compiler(schema, options, false);
	try {
		plain.root();
		return plain;
	} catch (error) {
		if (error !== RESTART) throw error;
		return new Compiler(schema, options, true);
	}
}
