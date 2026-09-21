/**
 * JSON Schema (draft 2020-12) for the two wire shapes, for a consumer that is
 * not JavaScript.
 *
 * A Python guardrail cannot import {@link ToolCallEvent} from this package, so
 * it hand-writes the field names it reads and drifts silently: the contract
 * renames a field, the hand-written reader sees `undefined`, and it takes its
 * no-value branch instead of failing. These documents are the machine-readable
 * form of the same contract, so that reader validates against the seam rather
 * than against its own copy.
 *
 * EVERY ENUMERATED VALUE IS DERIVED, never typed a second time — each one is
 * read off the frozen export that owns it: {@link EventKind},
 * {@link Decision}, {@link IntegrationMode}, {@link STANDARD_META_FIELDS},
 * {@link SCHEMA_VERSION}, {@link MODELED_TOOL_INPUT_KEYS}. The files under
 * `schema/` are generated output that `json-schema.test.mjs` regenerates and
 * byte-compares, not a second contract.
 *
 * FIELD NAMES ARE WRITTEN HERE, because the contract exports no list of them —
 * the root fields and the always-present `EventMeta` fields are typedefs, which
 * do not survive to runtime. So a renamed contract field is caught rather than
 * declared: `json-schema.test.mjs` re-parses every golden native payload through
 * the LIVE adapter and validates the result, and `additionalProperties: false`
 * turns the rename into a rejection. {@link VERDICT_CONTENT_FIELDS} is the one
 * list that does exist, and {@link assertVerdictFieldsDeclared} holds the
 * verdict document to it — in the ADDING direction only. `reason` is outside
 * that list (it is not probeable from one abstaining verdict), so its schema
 * here rests on the `Verdict` typedef alone.
 *
 * SCOPE — the documents describe the contract's DECLARED shapes, which `tsc`
 * checks at build time. `normalizeVerdict` re-checks only `decision` at run
 * time, so a JavaScript caller who ignores the types can hand it a numeric
 * `reason` and get one back; that value fails this document, correctly.
 *
 * A tool `input` stays unconstrained on purpose: an adapter forwards a native
 * input object verbatim, so a schema demanding a string `command` on every Bash
 * event would reject events the library legitimately emits — one golden Codex
 * fixture carries `command` as an array. The per-tool field a judge should read
 * is published beside the documents as data instead
 * ({@link MODELED_TOOL_INPUT_KEYS}, in `tool-input-keys.json`).
 */

import {
  CONTROL_PLANE_SCHEMA,
  Decision,
  EventKind,
  IntegrationMode,
  MODELED_TOOL_INPUT_KEYS,
  SCHEMA_VERSION,
  STANDARD_META_FIELDS,
  VERDICT_CONTENT_FIELDS,
} from "./control-plane.mjs";

/** The JSON Schema dialect these documents are written in. */
const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

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
export const SCHEMA_DIR = `schema/${CONTROL_PLANE_SCHEMA}`;

/** Basename of each generated document, keyed by the shape it describes. */
export const SCHEMA_FILES = Object.freeze({
  ToolCallEvent: "tool-call-event.schema.json",
  Verdict: "verdict.schema.json",
});

/**
 * Basename of the per-tool input-key map, published as plain DATA rather than
 * inside the event document. A vendor keyword there (`x-modeled-tool-input-keys`)
 * is legal JSON Schema, but ajv refuses an unknown keyword under its default
 * options, so the document a JavaScript consumer installed would not compile
 * until that consumer registered a vocabulary it has no reason to know about.
 */
export const TOOL_INPUT_KEYS_FILE = "tool-input-keys.json";

/**
 * The schema for each optional {@link Verdict} field. Kept beside the
 * assertion below rather than inlined, so a content field added to
 * {@link VERDICT_CONTENT_FIELDS} fails loud here instead of quietly dropping
 * out of the published document — a consumer would then read a field the
 * schema calls forbidden and reject a verdict this library produces.
 */
const VERDICT_FIELD_SCHEMAS = Object.freeze({
  mutated_input: {
    type: "object",
    description:
      "Replacement tool input (pre_tool). A data channel, carried verbatim.",
  },
  mutated_output: {
    description:
      "Replacement tool output (post_tool): a string or the tool's structured output, verbatim. Any JSON value.",
  },
  additional_context: {
    type: "string",
    description: "Extra context to splice into the agent's stream.",
  },
  reason: {
    type: "string",
    description: "Human-readable rationale, shown on deny and ask.",
  },
});

/**
 * Assert every content field the contract models has a schema above. Throws
 * (fail loud) on the first that does not: `additionalProperties: false` makes an
 * undeclared field a REJECTION rather than an omission, so a consumer would
 * refuse a verdict this library produces. Called at import against the live
 * {@link VERDICT_CONTENT_FIELDS}; exported so a test can drive both branches.
 * @param {readonly string[]} fields
 * @param {Record<string, unknown>} declared
 */
export function assertVerdictFieldsDeclared(fields, declared) {
  for (const field of fields)
    if (!Object.hasOwn(declared, field))
      throw new Error(
        `json-schema: verdict content field ${JSON.stringify(field)} has no declared schema — add one to VERDICT_FIELD_SCHEMAS`,
      );
}

assertVerdictFieldsDeclared(VERDICT_CONTENT_FIELDS, VERDICT_FIELD_SCHEMAS);

/**
 * The `EventMeta` subschema. The optional string fields are
 * {@link STANDARD_META_FIELDS} plus `native_tool`; `string` is not a guess for
 * them, it is what `baseMeta` enforces (a non-string value leaves the field
 * absent rather than stamping a number onto a field consumers read as text).
 * @returns {Record<string, unknown>}
 */
function eventMetaSchema() {
  /** @type {Record<string, unknown>} */
  const properties = {
    agent: {
      type: "string",
      description: 'Producing agent id ("claude", "codex", …).',
    },
    native_event: {
      type: "string",
      description: "Original native event name, preserved verbatim.",
    },
    integration_mode: {
      enum: Object.values(IntegrationMode),
      description: "How the guardrail attaches to the host.",
    },
    primary_gate_present: {
      type: "boolean",
      description:
        "The agent's own native gate already ran, so this verdict is a second opinion.",
    },
    passthrough: {
      type: "object",
      description: "Unmodelled native top-level fields, verbatim.",
    },
    native_tool: {
      type: "string",
      description:
        "Original native tool name, present iff the event carries a tool.",
    },
  };
  for (const field of STANDARD_META_FIELDS)
    properties[field] = { type: "string" };
  return {
    type: "object",
    required: [
      "agent",
      "native_event",
      "integration_mode",
      "primary_gate_present",
      "passthrough",
    ],
    properties,
    additionalProperties: false,
  };
}

/**
 * The document describing a normalized {@link ToolCallEvent}.
 *
 * `additionalProperties: false` is honest here rather than strict: `makeEvent`
 * builds every event, and the unmodelled remainder of a native payload lands in
 * `meta.passthrough`, so an extra key at the root is a hand-rolled event, not a
 * newer library's.
 * @returns {Record<string, unknown>}
 */
export function toolCallEventSchema() {
  return {
    $schema: JSON_SCHEMA_DIALECT,
    title: "ToolCallEvent",
    description: `A normalized, agent-agnostic view of one agent event (${CONTROL_PLANE_SCHEMA}).`,
    type: "object",
    required: [
      "schema_version",
      "event",
      "tool",
      "input",
      "this_call_vetoable",
      "meta",
    ],
    properties: {
      schema_version: { const: SCHEMA_VERSION },
      event: { enum: Object.values(EventKind) },
      tool: {
        type: ["string", "null"],
        description:
          "Canonical tool name; null for prompt and session events. The raw native name is on meta.native_tool.",
      },
      input: {
        type: "object",
        description:
          "Passthrough tool input, verbatim; a submitted prompt is folded into input.prompt.",
      },
      response: {
        description: "Tool output, post_tool only: any JSON value, verbatim.",
      },
      this_call_vetoable: {
        type: "boolean",
        description:
          "false ⇒ the guardrail cannot veto THIS call, so a deny must degrade to a notification.",
      },
      meta: { $ref: "#/$defs/EventMeta" },
    },
    additionalProperties: false,
    // Two claims a producer must not make, both the same fail-open: a veto the
    // host will never perform, read downstream as a block that happened.
    //
    // An event the adapter could not name has no host response to veto, so a
    // vetoable UNKNOWN is that claim. `makeEvent` throws on one. An OBSERVE_ONLY
    // transport reads a transcript and cannot pre-empt anything, so a vetoable
    // event on one is the same claim by a different route — every shipped
    // adapter derives both flags from one "can this host enforce" answer, but
    // `makeEvent` does NOT refuse it, so this document is the only place a
    // producer is held to it.
    allOf: [
      vetoImpossibleWhen({ event: { const: EventKind.UNKNOWN } }),
      vetoImpossibleWhen({
        meta: {
          required: ["integration_mode"],
          properties: {
            integration_mode: { const: IntegrationMode.OBSERVE_ONLY },
          },
        },
      }),
    ],
    $defs: { EventMeta: eventMetaSchema() },
  };
}

/**
 * A conditional subschema forcing `this_call_vetoable: false` wherever `match`
 * holds. `required` names every key `match` constrains, because an absent key
 * satisfies a bare `properties` and would leave the `then` branch dead.
 * @param {Record<string, unknown>} match
 * @returns {Record<string, unknown>}
 */
function vetoImpossibleWhen(match) {
  return {
    if: { required: Object.keys(match), properties: match },
    then: { properties: { this_call_vetoable: { const: false } } },
  };
}

/**
 * The document describing a normalized {@link Verdict}. Only `decision` is
 * required; `normalizeVerdict` emits the optional fields only when present.
 * @returns {Record<string, unknown>}
 */
export function verdictSchema() {
  /** @type {Record<string, unknown>} */
  const properties = { decision: { enum: Object.values(Decision) } };
  // Cloned, not aliased. `Object.freeze` on VERDICT_FIELD_SCHEMAS freezes the
  // outer object only, so assigning the nested `{type, description}` objects
  // hands every caller the same two levels down: a consumer that tightens
  // `properties.reason` on the document it was given would silently retighten
  // every document produced afterwards. The other builders return fresh
  // structures already.
  for (const [field, schema] of Object.entries(VERDICT_FIELD_SCHEMAS))
    properties[field] = structuredClone(schema);
  return {
    $schema: JSON_SCHEMA_DIALECT,
    title: "Verdict",
    description: `A normalized guardrail decision (${CONTROL_PLANE_SCHEMA}).`,
    type: "object",
    required: ["decision"],
    properties,
    additionalProperties: false,
  };
}

/**
 * Every generated file, keyed by its package-relative path — the SSOT the
 * generator writes and the freshness test reads, so neither carries its own
 * list of filenames. The two `.schema.json` entries are JSON Schema documents;
 * `tool-input-keys.json` is the data map {@link TOOL_INPUT_KEYS_FILE} describes.
 * @returns {Record<string, Record<string, unknown>>}
 */
export function jsonSchemaDocuments() {
  return {
    [`${SCHEMA_DIR}/${SCHEMA_FILES.ToolCallEvent}`]: toolCallEventSchema(),
    [`${SCHEMA_DIR}/${SCHEMA_FILES.Verdict}`]: verdictSchema(),
    [`${SCHEMA_DIR}/${TOOL_INPUT_KEYS_FILE}`]: { ...MODELED_TOOL_INPUT_KEYS },
  };
}

/**
 * The bytes a generated file is written as: 2-space JSON with a trailing newline.
 * This is NOT Prettier's rendering — Prettier collapses a short array onto one
 * line — so `schema/` is in `.prettierignore` and this function owns the bytes
 * the freshness test compares. A formatter allowed to rewrite them would red
 * that test on a change to nothing.
 * @param {Record<string, unknown>} document
 * @returns {string}
 */
export function serializeSchema(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}
