/**
 * Assert every content field the contract models has a schema above. Throws
 * (fail loud) on the first that does not: `additionalProperties: false` makes an
 * undeclared field a REJECTION rather than an omission, so a consumer would
 * refuse a verdict this library produces. Called at import against the live
 * {@link VERDICT_CONTENT_FIELDS}; exported so a test can drive both branches.
 * @param {readonly string[]} fields
 * @param {Record<string, unknown>} declared
 */
export function assertVerdictFieldsDeclared(fields: readonly string[], declared: Record<string, unknown>): void;
/**
 * The document describing a normalized {@link ToolCallEvent}.
 *
 * `additionalProperties: false` is honest here rather than strict: `makeEvent`
 * builds every event, and the unmodelled remainder of a native payload lands in
 * `meta.passthrough`, so an extra key at the root is a hand-rolled event, not a
 * newer library's.
 * @returns {Record<string, unknown>}
 */
export function toolCallEventSchema(): Record<string, unknown>;
/**
 * The document describing a normalized {@link Verdict}. Only `decision` is
 * required; `normalizeVerdict` emits the optional fields only when present.
 * @returns {Record<string, unknown>}
 */
export function verdictSchema(): Record<string, unknown>;
/**
 * Every generated file, keyed by its package-relative path — the SSOT the
 * generator writes and the freshness test reads, so neither carries its own
 * list of filenames. The two `.schema.json` entries are JSON Schema documents;
 * `tool-input-keys.json` is the data map {@link TOOL_INPUT_KEYS_FILE} describes.
 * @returns {Record<string, Record<string, unknown>>}
 */
export function jsonSchemaDocuments(): Record<string, Record<string, unknown>>;
/**
 * The bytes a generated file is written as: 2-space JSON with a trailing newline.
 * This is NOT Prettier's rendering — Prettier collapses a short array onto one
 * line — so `schema/` is in `.prettierignore` and this function owns the bytes
 * the freshness test compares. A formatter allowed to rewrite them would red
 * that test on a change to nothing.
 * @param {Record<string, unknown>} document
 * @returns {string}
 */
export function serializeSchema(document: Record<string, unknown>): string;
/**
 * Package-relative directory the generated files live in, versioned by the WIRE
 * version. A breaking shape change bumps {@link CONTROL_PLANE_SCHEMA} and so
 * writes a new directory, leaving the previous one in place for a consumer
 * still on it.
 *
 * A document is THIS RELEASE's rendering of that wire version, not a statement
 * about every release that will carry it. Adding an optional field is
 * backward-compatible and stays at v1 (see the README's Versioning section), so
 * the next release's document may carry a property this one does not. That is
 * why the files ship inside the package: a consumer reads the schema from the
 * same installed version that produced the event, and the two move together.
 * Validate against the installed file, never a copy pinned by hand.
 *
 * Neither document carries an `$id`. A URL naming a mutable branch would resolve
 * to whatever the contract says LATER, and two installed versions declaring one
 * `$id` collide inside a single validator instance. `$ref` here is
 * document-relative, so nothing needs one.
 */
export const SCHEMA_DIR: "schema/control-plane/v1";
/** Basename of each generated document, keyed by the shape it describes. */
export const SCHEMA_FILES: Readonly<{
    ToolCallEvent: "tool-call-event.schema.json";
    Verdict: "verdict.schema.json";
}>;
/**
 * Basename of the per-tool input-key map, published as plain DATA rather than
 * inside the event document. A vendor keyword there (`x-modeled-tool-input-keys`)
 * is legal JSON Schema, but ajv refuses an unknown keyword under its default
 * options, so the document a JavaScript consumer installed would not compile
 * until that consumer registered a vocabulary it has no reason to know about.
 */
export const TOOL_INPUT_KEYS_FILE: "tool-input-keys.json";
