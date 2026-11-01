# Changelog

## [Unreleased]

### Added

- Initial release: `compile(schema, options)` validates JSON Schema drafts 2020-12 and 7 without `eval` or `new Function`, compiling a schema once into plain closures. `Validator.check` is the boolean check (a type guard for schemas built with the builders), `Validator.errors` reports each failure with a JSON Pointer path. Format checks are in the optional `@earendil-works/pi-schema/formats` entry point.
- Schema builders (`str`, `num`, `int`, `bool`, `nul`, `unknown`, `lit`, `oneOf`, `obj`, `opt`, `arr`, `tuple`, `map`, `union`, `nullable`, `bytes`) that return plain JSON Schema typed with the values it accepts (`Static<typeof schema>`).
- `npm run bench` compares conformance, speed, setup cost, memory and bundle size with TypeBox, @cfworker/json-schema and omptype.
