# @earendil-works/pi-schema

JSON Schema builders and validation without `eval`. A schema compiles once into plain closures, so it checks values
about as fast as validators that generate code, also under a strict Content Security Policy, and needs no
dependencies.

- Drafts 2020-12 and 7. Passes 2,222 of the 2,223 core tests of the official
  [JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite).
- Builders return plain JSON Schema typed with the values it accepts; a compiled check narrows to that type.
- Errors as JSON Pointer paths. A missing or unknown field is reported at the field.
- Never modifies a schema; frozen schemas work.
- 8.5 KB minified and gzipped. Format checks are an optional import.

## Installation

```bash
npm install @earendil-works/pi-schema
```

## Usage

```typescript
import { compile, int, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";

const Read = obj({
	path: str({ description: "Path to the file", minLength: 1 }),
	offset: opt(int({ minimum: 1 })),
	mode: oneOf(["text", "binary"]),
});
type Read = Static<typeof Read>; // { path: string; mode: "text" | "binary"; offset?: number }

const read = compile(Read);
if (read.check(value)) value.path; // value: Read

read.errors({ offset: 0, extra: true });
// [
//   { path: "/path", keyword: "required", message: "missing" },
//   { path: "/mode", keyword: "required", message: "missing" },
//   { path: "/offset", keyword: "minimum", message: "expected >= 1" },
//   { path: "/extra", keyword: "additionalProperties", message: "unknown field" },
// ]
```

`Read` is plain JSON Schema (`{ type: "object", properties: {...}, required: ["path", "mode"], additionalProperties:
false }`), ready for a tool definition or `JSON.stringify`. `compile` takes any JSON Schema, built with the builders
or not.

`check(value)` is the fast path: a boolean, no allocations for most schemas, and a plain function you can pass
around. `errors(value)` explains a failure and returns `[]` for a valid value. It is built on the first failure and
kept, so a schema whose values always pass never pays for it.

### Builders

| builder | schema | type |
|---|---|---|
| `str({ minLength, maxLength, pattern, format })` | `{ type: "string", ... }` | `string` |
| `num({ minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf })`, `int(...)` | `{ type: "number" }`, `{ type: "integer" }` | `number` |
| `bool()`, `nul()`, `unknown()` | `{ type: "boolean" }`, `{ type: "null" }`, `{}` | `boolean`, `null`, `unknown` |
| `lit(value)` | `{ const: value }` | the literal |
| `oneOf(["a", "b"])` | `{ enum: [...] }` | `"a" \| "b"` |
| `obj({ a: str(), b: opt(num()) }, { open })` | closed object; `open: true` allows other properties | `{ a: string; b?: number }` |
| `arr(items, { minItems, maxItems, uniqueItems })` | `{ type: "array", items }` | `T[]` |
| `tuple([str(), num()])` | `prefixItems`, no more items | `[string, number]` |
| `map(value)` | `{ type: "object", additionalProperties: value }` | `Record<string, T>` |
| `union([...])` | `{ anyOf: [...] }` | the union |
| `nullable(schema)` | `{ anyOf: [schema, { type: "null" }] }` | `T \| null` |
| `bytes({ minLength, maxLength })` | `{ type: "bytes", ... }` | `Uint8Array` |

Every builder also takes `title`, `description`, `examples`, `deprecated` and `default`. A `default` is an annotation;
validation never inserts it.

A union of objects tagged by a `lit()` property checks and reports by the tag: only the branch the tag selects runs.

```typescript
const Block = union([obj({ kind: lit("text"), text: str() }), obj({ kind: lit("image"), width: int({ minimum: 0 }) })]);
compile(Block).errors({ kind: "video" });
// [{ path: "/kind", keyword: "anyOf", message: 'expected one of ["text","image"]' }]
```

### Options

```typescript
import { formats } from "@earendil-works/pi-schema/formats";

const validator = compile(schema, {
	draft: "7", // "2020-12" (default) or "7"
	formats, // check `format`; without it `format` is an annotation, as 2020-12 specifies
	schemas: { "https://example.com/point.json": point }, // documents for $refs to other documents, by URI
});
```

`formats` has every format 2020-12 defines (`date-time`, `email`, `uri`, `uuid`, `ipv6`, ...). Pass your own map to
check fewer formats, or custom ones. A `$ref` that names nothing throws when the schema compiles.

### TypeBox schemas

TypeBox 1.x schemas are JSON Schema, so they compile as they are:

```typescript
import Type from "typebox";

const user = compile(Type.Object({ name: Type.String(), tags: Type.Array(Type.String()) }));
```

TypeBox's JavaScript-only types (`BigInt`, `Undefined`, `Function`, ...), refinements and codecs are not JSON Schema
and are not supported.

### Values

- A property whose value is `undefined` counts as absent, as in TypeBox.
- `{ type: "bytes", minLength, maxLength }` matches a `Uint8Array` of that length, an extension for values that never
  pass through JSON.

## Supported keywords

- Every validation keyword of drafts 2020-12 and 7, including draft 7's `dependencies` and `items` arrays with
  `additionalItems`.
- `$id`, `$anchor`, `$ref` (local, by anchor, relative and remote), `$dynamicRef` and `$dynamicAnchor`.
- `unevaluatedProperties` and `unevaluatedItems`.
- `pattern` and `patternProperties` are ECMAScript regular expressions with the `u` flag.
- Not supported: meta-schemas that switch vocabularies on or off (`$vocabulary`), `contentMediaType` and
  `contentEncoding` assertions (optional in the spec), and draft 2019-09's `$recursiveRef`.

## Benchmarks

Node 24.4.1 on one core of an i9-13900, against TypeBox 1.3.27, @cfworker/json-schema 4.1.1 and @oh-my-pi/omptype
18.13.3 (`fromJsonSchema`).

| test suite (tests passed) | pi-schema | TypeBox | cfworker | omptype |
|---|---:|---:|---:|---:|
| draft 2020-12 core (1,298) | 1,297 | 1,276 | 1,249 | 863 |
| draft 7 core (925) | 925 | 924 | 918 | 659 |
| draft 2020-12 format (895), with `formats` | 895 | 895 | 740 | 412 |

| check, valid value | pi-schema | TypeBox | cfworker | omptype |
|---|---:|---:|---:|---:|
| nested object with tagged unions | 409 ns | 474 ns | 44 µs | 689 ns |
| union of 5 messages | 89 ns | 95 ns | 10 µs | 93 ns |
| tool schema (read) | 31 ns | 9 ns | 1.9 µs | 9 ns |
| MCP tool schema with `$ref` | 162 ns | 89 ns | 13 µs | 1.8 µs |
| recursive `$ref` schema | 753 ns | 1.2 µs | 41 µs | 7.4 µs |

| same, without eval (strict CSP) | pi-schema | TypeBox | cfworker | omptype |
|---|---:|---:|---:|---:|
| nested object with tagged unions | 407 ns | 42 µs | 43 µs | 2.6 µs |
| MCP tool schema with `$ref` | 162 ns | 36 µs | 12 µs | 2.0 µs |
| recursive `$ref` schema | 750 ns | 124 µs | 41 µs | 9.0 µs |

| cost | pi-schema | TypeBox | cfworker | omptype |
|---|---:|---:|---:|---:|
| compile a new schema | 21 µs | 203 µs | 20 µs | 26 µs + 106 µs on its first check |
| memory, 3,200 distinct schemas | 7.1 MB | 54.7 MB | 7.6 MB | 20.0 MB |
| bundle, minified + gzip | 8.5 KB | 35.2 KB | 5.8 KB | 38.8 KB |

Reproduce with `npm run bench` in `packages/schema` (about 5 minutes). It runs every library through its fastest
boolean path and keeps the object each returns. The scripts are in `test/bench/`.

- **conformance:** every library on the vendored test suite, with the remote documents and meta-schemas the tests
  reference.
- **speed:** realistic schemas, in ns per check after warm-up; the median of 15 rounds, with the libraries'
  order rotated in each round.
- **speed without eval:** the same, run with `--disallow-code-generation-from-strings`.
- **setup:** compiling 1,000 schemas a library has not seen, and their first checks.
- **memory:** 3,200 distinct tool-like schemas, each library in its own process.
- **size:** esbuild bundles of what a validator needs, minified and gzipped.

Where code generation is unavailable, TypeBox falls back to its interpreter, and omptype throws `EvalError` once per
schema, then validates through its interpreter.

Flat objects of simple types check in 13–80 ns, against 7–15 ns for TypeBox. Without code generation, reading a
property whose name comes from a list costs a few nanoseconds.

## Development

`npm test` runs the official test suite (drafts 2020-12 and 7, including the optional and format tests, vendored in
`test/fixtures/`) and the package's own tests.

The format checks are adapted from TypeBox 1.3.27 (MIT); its license is in `LICENSES/`.
