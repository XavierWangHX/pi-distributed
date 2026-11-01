// compile() and Validator: checks, errors, values, options and schemas from other sources.

import Type from "typebox";
import { describe, expect, it } from "vitest";
import { formats } from "../src/formats/index.ts";
import { compile } from "../src/index.ts";

const read = {
	type: "object",
	properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 } },
	required: ["path"],
	additionalProperties: false,
};

const block = {
	anyOf: [
		{
			type: "object",
			properties: { kind: { const: "text" }, text: { type: "string" } },
			required: ["kind", "text"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: { kind: { const: "image" }, width: { type: "integer", minimum: 0 } },
			required: ["kind", "width"],
			additionalProperties: false,
		},
	],
};

describe("errors", () => {
	it("reports a missing field and an unknown field at the field", () => {
		expect(compile(read).errors({ offset: 0, extra: true })).toEqual([
			{ path: "/path", keyword: "required", message: "missing" },
			{ path: "/offset", keyword: "minimum", message: "expected >= 1" },
			{ path: "/extra", keyword: "additionalProperties", message: "unknown field" },
		]);
	});

	it("is empty for a valid value", () => {
		expect(compile(read).errors({ path: "a.ts" })).toEqual([]);
	});

	it("reports the branch a tagged union's tag selects", () => {
		const validator = compile({ type: "array", items: block });
		expect(
			validator.errors([
				{ kind: "text", text: "a" },
				{ kind: "image", width: -1 },
			]),
		).toEqual([{ path: "/1/width", keyword: "minimum", message: "expected >= 0" }]);
		expect(validator.errors([{ kind: "video" }])).toEqual([
			{ path: "/0/kind", keyword: "anyOf", message: 'expected one of ["text","image"]' },
		]);
	});

	it("escapes ~ and / in paths as JSON Pointer does", () => {
		const validator = compile({ type: "object", properties: { "a/b~c": { type: "string" } } });
		expect(validator.errors({ "a/b~c": 1 })).toEqual([
			{ path: "/a~1b~0c", keyword: "type", message: "expected string, got integer" },
		]);
	});

	it("follows $ref into the referenced schema", () => {
		const validator = compile({
			$defs: { point: { type: "object", properties: { x: { type: "number" } }, required: ["x"] } },
			type: "array",
			items: { $ref: "#/$defs/point" },
		});
		expect(validator.errors([{ x: 1 }, {}])).toEqual([{ path: "/1/x", keyword: "required", message: "missing" }]);
	});
});

describe("values", () => {
	it("treats a property set to undefined as absent", () => {
		const validator = compile(read);
		expect(validator.check({ path: "a.ts", offset: undefined })).toBe(true);
		expect(validator.check({ path: undefined })).toBe(false);
	});

	it("checks bytes as Uint8Array with length bounds", () => {
		const validator = compile({ type: "object", properties: { data: { type: "bytes", maxLength: 4 } } });
		expect(validator.check({ data: new Uint8Array(4) })).toBe(true);
		expect(validator.check({ data: new Uint8Array(5) })).toBe(false);
		expect(validator.check({ data: [1, 2] })).toBe(false);
		expect(validator.errors({ data: new Uint8Array(5) })).toEqual([
			{ path: "/data", keyword: "maxLength", message: "expected at most 4 bytes" },
		]);
	});

	it("does not treat bytes as an object", () => {
		expect(compile({ type: "object" }).check(new Uint8Array(1))).toBe(false);
	});

	it("checks properties named like Object.prototype members as own properties", () => {
		const validator = compile({
			type: "object",
			properties: { constructor: { type: "string" }, toString: { type: "number" } },
			required: ["constructor"],
			additionalProperties: false,
		});
		expect(validator.check({})).toBe(false);
		expect(validator.check({ constructor: "a" })).toBe(true);
		expect(validator.check({ constructor: "a", toString: "b" })).toBe(false);
	});

	it("does not accept every value for a type named like an Object.prototype member", () => {
		expect(compile({ type: "constructor" }).check(1)).toBe(false);
	});

	it("checks a detached check function", () => {
		const { check } = compile(read);
		expect([{ path: "a" }, { path: 1 }].filter(check)).toEqual([{ path: "a" }]);
	});
});

describe("options", () => {
	it("treats format as an annotation unless formats are given", () => {
		const schema = { type: "string", format: "email" };
		expect(compile(schema).check("not an email")).toBe(true);
		expect(compile(schema, { formats }).check("not an email")).toBe(false);
		expect(compile(schema, { formats }).check("a@example.com")).toBe(true);
	});

	it("resolves $ref to registered documents", () => {
		const point = { type: "object", properties: { x: { type: "number" } }, required: ["x"] };
		const validator = compile(
			{ $ref: "https://example.com/point.json" },
			{ schemas: { "https://example.com/point.json": point } },
		);
		expect(validator.check({ x: 1 })).toBe(true);
		expect(validator.check({})).toBe(false);
	});

	it("throws for a $ref that names nothing", () => {
		expect(() => compile({ $ref: "https://example.com/missing.json" })).toThrow(/Unresolved \$ref/);
		expect(() => compile({ $ref: "#/$defs/missing" })).toThrow(/Unresolved \$ref/);
	});

	it("applies draft 7 semantics: $ref overrides its siblings", () => {
		const schema = { definitions: { s: { type: "string" } }, $ref: "#/definitions/s", maxLength: 1 };
		expect(compile(schema, { draft: "7" }).check("ab")).toBe(true);
		expect(compile(schema).check("ab")).toBe(false);
	});
});

describe("schemas", () => {
	it("compiles TypeBox schemas as they are", () => {
		const validator = compile(Type.Object({ name: Type.String(), tags: Type.Array(Type.String()) }));
		expect(validator.check({ name: "a", tags: [] })).toBe(true);
		expect(validator.errors({ name: "a", tags: [1] })).toEqual([
			{ path: "/tags/0", keyword: "type", message: "expected string, got integer" },
		]);
	});

	it("compiles deep-frozen schemas and never modifies a schema", () => {
		const schema = deepFreeze(structuredClone({ ...block, $defs: { s: { type: "string", pattern: "^a" } } }));
		const before = JSON.stringify(schema);
		const validator = compile(schema);
		expect(validator.check({ kind: "text", text: "x" })).toBe(true);
		expect(validator.errors({ kind: "image", width: -1 })).toHaveLength(1);
		expect(JSON.stringify(schema)).toBe(before);
	});

	it("compiles a recursive schema", () => {
		const tree = {
			type: "object",
			properties: { value: { type: "number" }, children: { type: "array", items: { $ref: "#" } } },
			required: ["value"],
		};
		const validator = compile(tree);
		expect(validator.check({ value: 1, children: [{ value: 2, children: [{ value: 3 }] }] })).toBe(true);
		expect(validator.errors({ value: 1, children: [{ value: 2, children: [{}] }] })).toEqual([
			{ path: "/children/0/children/0/value", keyword: "required", message: "missing" },
		]);
	});

	it("throws for a malformed schema", () => {
		expect(() => compile({ properties: { a: 1 } })).toThrow(/must be an object or a boolean/);
	});
});

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}
