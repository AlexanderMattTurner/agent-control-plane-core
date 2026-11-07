/**
 * The per-agent manifest: what each agent's hook transport does, published as
 * plain JSON at `schema/control-plane/v1/agents.json`.
 *
 * PROBLEM CLASS — a consumer that cannot call these adapters (a bash hook
 * wrapper, a Python validator) re-types each agent's rules by hand: which exit
 * code blocks, whether a block needs a reason, whether an `ask` has a tier.
 * Each copy is one more place an agent's next release has to be chased into.
 * `agents.json` is the copy they read instead, generated from the adapters'
 * exports, so an adapter change reaches them on the next `pnpm gen:schema`.
 *
 * `pnpm gen:schema` writes every {@link generatedDocuments} entry, and
 * `json-schema.test.mjs` regenerates each in-process and byte-compares.
 */

import { EventKind, blockTransportFor, lookup } from "./control-plane.mjs";
import { jsonSchemaDocuments, SCHEMA_DIR } from "./json-schema.mjs";
import { ADAPTERS, AGENT_IDS } from "./registry.mjs";
import { HOST_FAILURE } from "./runtime.mjs";

/**
 * One agent's manifest row. Each field is read from the export it names:
 * - `integration_mode`: the adapter's `INTEGRATION_MODE`.
 * - `native_ask_tier`: `NATIVE_ASK_TIER`. `false` means an `ask` the host
 *   receives does not stop the call, so a consumer must block instead.
 * - `block`: the `BLOCK_TRANSPORT` row: the exit code the host blocks on, the
 *   stream it reads the reason from, and whether an empty reason runs the call.
 * - `host_failure`: the `HOST_FAILURE` row, the hook entry's DEFAULT response
 *   when the hook breaks (exit 0 runs the call; amp's exit 1 asks the human).
 *   `ACP_FAIL_CLOSED=1` replaces it with `block`.
 * - `coverage`: `COVERAGE`, per call class.
 * - `unrendered_fields_on_allow`: `UNRENDERED_FIELDS`, each set as a sorted
 *   list. It describes the allow path on each kind's `NATIVE_EVENT_FOR` event
 *   only: a deny, or another native event of that kind, can drop more.
 * - `pre_tool_filing`: `PRE_TOOL_FILING`, how the pre-tool hook files a model
 *   tool call, in the mini-language the `PreToolFiling` typedef specifies.
 * - `pre_tool_response`: `PRE_TOOL_RESPONSE`, the top-level and
 *   `hookSpecificOutput` keys the host reads on an exit-0 pre-tool answer, each
 *   list with its fail-open bit, as the `PreToolResponse` typedef specifies.
 * @param {string} id
 * @returns {Record<string, unknown>}
 */
function manifestRow(id) {
  const adapter = ADAPTERS[id];
  const failure = HOST_FAILURE[id];
  return {
    integration_mode: adapter.INTEGRATION_MODE,
    native_ask_tier: adapter.NATIVE_ASK_TIER,
    block: blockTransportFor(id),
    host_failure: { exit_code: failure.exit_code, enforced: failure.enforced },
    coverage: adapter.COVERAGE,
    unrendered_fields_on_allow: Object.fromEntries(
      // The conformance harness refuses an adapter missing a row, and spreading
      // a missing one throws here, so a gap never publishes as "every field renders".
      Object.values(EventKind).map((kind) => [
        kind,
        [
          .../** @type {ReadonlySet<string>} */ (
            lookup(adapter.UNRENDERED_FIELDS, kind)
          ),
        ].sort(),
      ]),
    ),
    pre_tool_filing: adapter.PRE_TOOL_FILING,
    pre_tool_response: {
      ...adapter.PRE_TOOL_RESPONSE,
      hook_specific_output_keys: [
        ...adapter.PRE_TOOL_RESPONSE.hook_specific_output_keys,
      ].sort(),
      top_level_keys: [...adapter.PRE_TOOL_RESPONSE.top_level_keys].sort(),
    },
  };
}

/**
 * Every generated file, keyed by its package-relative path: the JSON Schema
 * documents and their data maps, plus `agents.json`, keyed by agent id in
 * {@link AGENT_IDS} order. The SSOT the generator writes and the freshness test
 * reads, so neither carries its own list of filenames.
 * @returns {Record<string, Record<string, unknown>>}
 */
export function generatedDocuments() {
  return {
    ...jsonSchemaDocuments(),
    [`${SCHEMA_DIR}/agents.json`]: Object.fromEntries(
      AGENT_IDS.map((id) => [id, manifestRow(id)]),
    ),
  };
}
