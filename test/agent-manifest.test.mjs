import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  AGENT_MANIFEST_FILE,
  agentManifest,
  agentManifestDocuments,
} from "../src/agent-manifest.mjs";
import { EventKind, renderEscalated } from "../src/control-plane.mjs";
import { serializeSchema, SCHEMA_DIR } from "../src/json-schema.mjs";
import { ADAPTERS, AGENT_IDS, adapterFor } from "../src/registry.mjs";
import { failurePosture } from "../src/runtime.mjs";

const ROOT = new URL("../", import.meta.url);
const PUBLISHED_PATH = `${SCHEMA_DIR}/${AGENT_MANIFEST_FILE}`;
const published = JSON.parse(
  readFileSync(fileURLToPath(new URL(PUBLISHED_PATH, ROOT)), "utf8"),
);

describe("the published agent manifest is fresh", () => {
  it(`${PUBLISHED_PATH} is byte-identical to a fresh render`, () => {
    const documents = Object.entries(agentManifestDocuments());
    assert.deepEqual(
      documents.map(([path]) => path),
      [PUBLISHED_PATH],
    );
    assert.equal(
      readFileSync(fileURLToPath(new URL(PUBLISHED_PATH, ROOT)), "utf8"),
      serializeSchema(documents[0][1]),
      `${PUBLISHED_PATH} is stale — run \`pnpm gen:schema\` and commit the result`,
    );
  });

  it("carries a row for every registered agent, in registry order", () => {
    assert.deepEqual(Object.keys(published), [...AGENT_IDS]);
  });

  it("carries an unrendered-fields row for every event kind", () => {
    for (const id of AGENT_IDS)
      assert.deepEqual(
        Object.keys(published[id].unrendered_fields),
        Object.values(EventKind),
        `${id} is missing an event kind`,
      );
  });
});

// A consumer reads the manifest INSTEAD of calling the adapter, so each row
// must predict what the adapter actually does. These drive the real adapters
// and compare their output against what the published row says.
describe("each manifest row predicts its adapter's real behaviour", () => {
  /** A vetoable pre-tool shell call for `id`, parsed by its own adapter. */
  const vetoablePreTool = (id) => {
    const adapter = adapterFor(
      id,
      published[id].launcher_options.includes("version")
        ? { version: "99.0.0" }
        : undefined,
    );
    const native = {
      hook_event_name: published[id].native_event_for.pre_tool,
      tool_name: "Bash",
      tool: "Bash",
      tool_input: { command: "ls" },
      input: { command: "ls" },
    };
    const event = adapter.parse(native);
    assert.equal(
      event.event,
      EventKind.PRE_TOOL,
      `${id} probe is not pre_tool`,
    );
    assert.equal(event.this_call_vetoable, true, `${id} probe is not vetoable`);
    return { adapter, event };
  };

  for (const id of AGENT_IDS) {
    it(`${id}: an enforced deny exits with the row's block code and reason stream`, () => {
      const { adapter, event } = vetoablePreTool(id);
      const response = renderEscalated(adapter, { decision: "deny" }, event);
      const { block } = published[id];
      assert.equal(response.enforced, true);
      assert.equal(response.exit_code, block.exit_code);
      assert.ok(
        typeof response[block.reason_stream] === "string" &&
          response[block.reason_stream].trim() !== "",
        `${id} wrote no reason on ${block.reason_stream}`,
      );
    });

    it(`${id}: an ask stops the call by the route native_ask_tier names`, () => {
      const { adapter, event } = vetoablePreTool(id);
      const raw = adapter.render({ decision: "ask" }, event);
      // No ask tier: the escalated render must be the host's block. An ask
      // tier: the render itself is the ask, left unescalated.
      const escalated = renderEscalated(adapter, { decision: "ask" }, event);
      assert.equal(ADAPTERS[id].NATIVE_ASK_TIER, published[id].native_ask_tier);
      if (published[id].native_ask_tier) assert.deepEqual(escalated, raw);
      else assert.equal(escalated.exit_code, published[id].block.exit_code);
    });

    it(`${id}: host_failure is the response the entry gives on a broken hook`, () => {
      const response = failurePosture(id, {});
      assert.deepEqual(published[id].host_failure, {
        exit_code: response.exit_code,
        blocks: response.enforced,
      });
    });
  }
});

describe("agentManifest", () => {
  it("returns a fresh object each call, so a consumer cannot poison the next", () => {
    const first = agentManifest();
    first.claude.block.exit_code = 99;
    assert.equal(agentManifest().claude.block.exit_code, 2);
  });
});
