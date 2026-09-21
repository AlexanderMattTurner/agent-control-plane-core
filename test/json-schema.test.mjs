import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import {
  Decision,
  EventKind,
  IntegrationMode,
  SCHEMA_VERSION,
  STANDARD_META_FIELDS,
  VERDICT_CONTENT_FIELDS,
  makeEvent,
  normalizeVerdict,
} from "../src/control-plane.mjs";
import { canonicalTool } from "../src/control-plane.mjs";
import {
  SCHEMA_DIR,
  SCHEMA_FILES,
  TOOL_INPUT_KEYS_FILE,
  assertVerdictFieldsDeclared,
  jsonSchemaDocuments,
  serializeSchema,
} from "../src/json-schema.mjs";
import { AGENT_IDS, adapterFor } from "../src/registry.mjs";

const ROOT = new URL("../", import.meta.url);

/**
 * Read a generated file back off disk, the way a consumer reads it.
 * @param {string} basename
 * @returns {any}
 */
const published = (basename) =>
  JSON.parse(readFileSync(new URL(`${SCHEMA_DIR}/${basename}`, ROOT), "utf8"));

// Compiled from the PUBLISHED bytes, not from the in-memory builder: those are
// what a consumer installs, and only the freshness cases below tie the two
// together. Default options throughout — a document that needs a configured
// validator is one an installing consumer cannot compile, so `addVocabulary`
// and a relaxed `strict` are both off deliberately. `allErrors` only widens the
// report.
const ajv = new Ajv2020({ allErrors: true });
const eventDocument = published(SCHEMA_FILES.ToolCallEvent);
const validateEvent = ajv.compile(eventDocument);
const validateVerdict = ajv.compile(published(SCHEMA_FILES.Verdict));

/** The golden fixtures for every shipped adapter. */
const FIXTURES = AGENT_IDS.map((agent) => ({
  agent,
  ...JSON.parse(
    readFileSync(new URL(`src/fixtures/${agent}.json`, ROOT), "utf8"),
  ),
}));

/**
 * Assert `value` satisfies `validate`, reporting ajv's own errors — a bare
 * "expected true" does not say which field the schema rejected.
 * @param {import("ajv").ValidateFunction} validate
 * @param {unknown} value
 * @param {string} label
 */
function assertValid(validate, value, label) {
  assert.ok(
    validate(value),
    `${label} failed validation: ${ajv.errorsText(validate.errors)}`,
  );
}

/** A minimal valid event, for a case to vary one field of. */
const validEvent = () => ({
  schema_version: SCHEMA_VERSION,
  event: EventKind.PRE_TOOL,
  tool: "Bash",
  input: {},
  this_call_vetoable: true,
  meta: {
    agent: "claude",
    native_event: "PreToolUse",
    integration_mode: IntegrationMode.EXTERNAL_HOOK,
    primary_gate_present: false,
    passthrough: {},
  },
});

describe("the committed files are the generated ones", () => {
  const documents = Object.entries(jsonSchemaDocuments());

  it("generates at least one file", () => {
    assert.ok(documents.length > 0, "every freshness case below is vacuous");
  });

  for (const [relativePath, document] of documents)
    it(`${relativePath} is byte-identical to a fresh render`, () => {
      assert.equal(
        readFileSync(fileURLToPath(new URL(relativePath, ROOT)), "utf8"),
        serializeSchema(document),
        `${relativePath} is stale — run \`pnpm gen:schema\` and commit the result`,
      );
    });
});

// The published documents must compile under a validator nobody configured:
// that is the whole claim of shipping them. A vendor keyword or a mistyped
// subschema fails HERE, loudly, instead of failing inside a consumer's install.
describe("a consumer compiles the published documents unconfigured", () => {
  for (const basename of Object.values(SCHEMA_FILES))
    it(`compiles ${basename} with default options`, () => {
      assert.doesNotThrow(() => new Ajv2020().compile(published(basename)));
    });

  // The per-tool input key is data beside the documents, so a consumer looks it
  // up by the `tool` the event carries. That only works while every key is
  // already canonical — an alias here (`bash`, `str_replace_editor`) would never
  // match a normalized event, and the lookup would silently miss.
  const toolKeys = Object.entries(published(TOOL_INPUT_KEYS_FILE));

  it("publishes a non-empty input-key map", () => {
    assert.ok(toolKeys.length > 0, "every key case below is vacuous");
  });

  for (const [tool, key] of toolKeys)
    it(`${tool} is the name an event carries`, () => {
      assert.equal(canonicalTool(tool), tool);
      assert.equal(typeof key, "string");
    });
});

// Driven per MEMBER off the contract's own frozen sets, not by comparing the
// schema's enum to the same set it was built from. A member the document failed
// to publish is rejected by the real validator here; an equality assertion
// between two `Object.values` calls would agree with itself either way.
describe("the documents admit every value the contract models", () => {
  for (const kind of Object.values(EventKind))
    it(`admits the ${kind} event kind`, () => {
      assertValid(
        validateEvent,
        // An UNKNOWN event is never vetoable — `makeEvent` throws on one, and
        // the document says so too, so the case must not claim it here.
        {
          ...validEvent(),
          event: kind,
          this_call_vetoable: kind !== EventKind.UNKNOWN,
        },
        `${kind} event`,
      );
    });

  for (const mode of Object.values(IntegrationMode))
    it(`admits the ${mode} integration mode`, () => {
      const event = validEvent();
      event.meta.integration_mode = mode;
      // A transcript reader cannot pre-empt a call, so the document refuses a
      // vetoable event on one; the case must not claim it here.
      event.this_call_vetoable = mode !== IntegrationMode.OBSERVE_ONLY;
      assertValid(validateEvent, event, `${mode} meta`);
    });

  for (const field of STANDARD_META_FIELDS)
    it(`admits meta.${field}`, () => {
      const event = validEvent();
      event.meta[field] = "value";
      assertValid(validateEvent, event, `meta.${field}`);
    });

  for (const decision of Object.values(Decision))
    it(`admits the ${decision} decision`, () => {
      assertValid(validateVerdict, { decision }, `${decision} verdict`);
    });

  // The load-time guard behind the cases below. A content field added to the
  // contract with no schema declared would otherwise drop out of the document
  // silently, and `additionalProperties: false` would turn that omission into a
  // rejection of a verdict this library produces.
  it("refuses a content field with no declared schema", () => {
    assert.throws(
      () => assertVerdictFieldsDeclared(["mutated_input", "notified"], {}),
      /verdict content field "mutated_input" has no declared schema/u,
    );
    assert.doesNotThrow(() =>
      assertVerdictFieldsDeclared(["reason"], { reason: {} }),
    );
  });

  // `additionalProperties: false` makes a content field the document forgot a
  // REJECTION, not an omission: the consumer refuses a verdict this library
  // produces. Each field is driven separately so the failure names which one.
  for (const field of VERDICT_CONTENT_FIELDS)
    it(`admits verdict.${field}`, () => {
      const carried = {
        mutated_input: { command: "ls" },
        mutated_output: "redacted",
        additional_context: "context",
      }[field];
      assertValid(
        validateVerdict,
        { decision: Decision.DENY, [field]: carried },
        `verdict.${field}`,
      );
    });
});

describe("every event this library produces validates", () => {
  const cases = FIXTURES.flatMap((fixtures) =>
    fixtures.cases.map((testCase) => ({ ...testCase, agent: fixtures.agent })),
  );

  it("reads golden cases from every shipped adapter", () => {
    assert.ok(cases.length > 0, "every fixture case below is vacuous");
    assert.deepEqual(
      [...new Set(cases.map((c) => c.agent))].sort(),
      [...AGENT_IDS].sort(),
    );
  });

  for (const testCase of cases)
    it(`${testCase.agent}: ${testCase.name}`, () => {
      assertValid(validateEvent, testCase.event, testCase.name);
    });

  // The stored `event` is a golden file, so validating it alone would miss an
  // adapter that stamps a meta key the fixtures predate — and
  // `additionalProperties: false` turns exactly that into a rejection of a real
  // event. Re-parsing the native payload puts the LIVE adapter output through
  // the same schema, for every adapter the registry ships.
  for (const testCase of cases)
    it(`${testCase.agent}: ${testCase.name} (live parse)`, () => {
      assertValid(
        validateEvent,
        adapterFor(testCase.agent).parse(testCase.native),
        `${testCase.name} live parse`,
      );
    });

  // The fixtures are JSON on disk. This drives the live constructor, so a
  // change to what `makeEvent` stamps reds here even with the fixtures stale.
  it("accepts a live makeEvent result", () => {
    assertValid(
      validateEvent,
      makeEvent({
        event: EventKind.PRE_TOOL,
        tool: "Bash",
        input: { command: "ls" },
        this_call_vetoable: true,
        meta: {
          agent: "claude",
          native_event: "PreToolUse",
          integration_mode: IntegrationMode.EXTERNAL_HOOK,
          primary_gate_present: false,
          passthrough: {},
        },
      }),
      "makeEvent result",
    );
  });
});

describe("every verdict this library normalizes validates", () => {
  const verdicts = FIXTURES.flatMap((fixtures) =>
    fixtures.cases.flatMap((testCase) =>
      Object.entries(testCase.render ?? {}).map(([decision, rendered]) => ({
        label: `${fixtures.agent}: ${testCase.name} (${decision})`,
        verdict: rendered.verdict,
      })),
    ),
  );

  it("reads rendered verdicts from the fixtures", () => {
    assert.ok(verdicts.length > 0, "every verdict case below is vacuous");
  });

  for (const { label, verdict } of verdicts)
    it(label, () => {
      assertValid(validateVerdict, verdict, label);
    });

  it("accepts a live normalizeVerdict carrying every modeled field", () => {
    assertValid(
      validateVerdict,
      normalizeVerdict({
        decision: Decision.DENY,
        mutated_input: { command: "ls" },
        mutated_output: "redacted",
        additional_context: "context",
        reason: "because",
      }),
      "normalized deny",
    );
  });
});

describe("the documents reject what the contract refuses", () => {
  it("holds the baseline valid", () => {
    assertValid(validateEvent, validEvent(), "baseline event");
  });

  const eventRejections = {
    "an unmodelled event kind": { event: "pre-tool" },
    "a wrong schema version": { schema_version: SCHEMA_VERSION + 1 },
    "a misspelled root field": { this_call_veto: true },
    "a non-boolean vetoable flag": { this_call_vetoable: "yes" },
    "a numeric tool name": { tool: 7 },
    "a non-object input": { input: "ls" },
  };
  for (const [label, override] of Object.entries(eventRejections))
    it(`rejects ${label}`, () => {
      assert.ok(!validateEvent({ ...validEvent(), ...override }));
    });

  // Driven off the fields the CONSTRUCTOR always stamps, never off the
  // document's own `required` list — a case list read from the subject shrinks
  // with it, so a dropped `required` entry would delete its own case and pass.
  // Dropping a field must reject: a reader that treats an absent
  // `this_call_vetoable` as vetoable is the same fail-open the conditionals
  // below refuse outright.
  const alwaysStamped = Object.keys(
    makeEvent({
      event: EventKind.PRE_TOOL,
      tool: null,
      input: {},
      this_call_vetoable: false,
      meta: validEvent().meta,
    }),
  );

  it("stamps a field on every event", () => {
    assert.ok(alwaysStamped.length > 0, "every omission case below is vacuous");
  });

  for (const field of alwaysStamped)
    it(`rejects an event with no ${field}`, () => {
      const event = validEvent();
      delete event[field];
      assert.ok(!validateEvent(event));
    });

  // Two renders of one fail-open: a veto reported for a call the host will not
  // stop. `makeEvent` throws on the first — an event the adapter could not name
  // has no host response to veto. It does NOT refuse the second, so this
  // document is the only place a producer on a transcript-reading transport is
  // held to it. Each case pairs with the non-vetoable variant, so a conditional
  // that rejected BOTH would not read as the invariant holding.
  const vetoImpossible = {
    "an unknown event": { event: EventKind.UNKNOWN },
    "an observe_only transport": {
      meta: {
        ...validEvent().meta,
        integration_mode: IntegrationMode.OBSERVE_ONLY,
      },
    },
  };
  for (const [label, override] of Object.entries(vetoImpossible)) {
    it(`rejects a vetoable call on ${label}`, () => {
      assert.ok(
        !validateEvent({
          ...validEvent(),
          ...override,
          this_call_vetoable: true,
        }),
      );
    });

    it(`admits a non-vetoable call on ${label}`, () => {
      assertValid(
        validateEvent,
        { ...validEvent(), ...override, this_call_vetoable: false },
        label,
      );
    });
  }

  /** @type {Record<string, (meta: Record<string, unknown>) => void>} */
  const metaRejections = {
    "a missing required meta field": (meta) => delete meta.agent,
    "a non-string permission_mode": (meta) => (meta.permission_mode = 1),
    "an unmodelled meta field": (meta) => (meta.session = "s1"),
    "an unmodelled integration mode": (meta) => (meta.integration_mode = "rpc"),
  };
  for (const [label, spoil] of Object.entries(metaRejections))
    it(`rejects ${label}`, () => {
      const event = validEvent();
      spoil(event.meta);
      assert.ok(!validateEvent(event));
    });

  it("holds a minimal verdict valid", () => {
    assertValid(validateVerdict, { decision: Decision.ALLOW }, "minimal");
  });

  const verdictRejections = {
    "a decision outside allow/deny/ask": { decision: "notify" },
    "a missing decision": {},
    "a misspelled field": { decision: Decision.DENY, mutated_inputs: {} },
    "a non-string reason": { decision: Decision.DENY, reason: 7 },
  };
  for (const [label, verdict] of Object.entries(verdictRejections))
    it(`rejects ${label}`, () => {
      assert.ok(!validateVerdict(verdict));
    });
});
