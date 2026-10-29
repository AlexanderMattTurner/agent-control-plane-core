import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK_TRANSPORT,
  Decision,
  renderEscalated,
} from "../src/control-plane.mjs";
import { claudeAdapter } from "../src/adapters/claude.mjs";
import { createCodexAdapter } from "../src/adapters/codex.mjs";
import { ampAdapter } from "../src/adapters/amp.mjs";
import { geminiAdapter } from "../src/adapters/gemini.mjs";

const { ALLOW, ASK, DENY } = Decision;

// One vetoable pre-tool shell call per host, from that host's native payload.
const HOSTS = {
  claude: {
    adapter: claudeAdapter,
    native: {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    },
  },
  codex: {
    adapter: createCodexAdapter({ version: "0.163.0" }),
    native: {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    },
  },
  amp: {
    adapter: ampAdapter,
    native: { tool: "Bash", input: { command: "ls" } },
  },
  gemini: {
    adapter: geminiAdapter,
    native: {
      hook_event_name: "BeforeTool",
      tool_name: "run_shell_command",
      tool_input: { command: "ls" },
    },
  },
};

// The decision each host must end up rendering, for a vetoable call. An ask
// stays an ask only where the host suspends the call itself; everywhere else it
// becomes a deny. A non-vetoable call always keeps its own decision.
const VETOABLE_RENDERS = {
  claude: { [ALLOW]: ALLOW, [ASK]: ASK, [DENY]: DENY },
  codex: { [ALLOW]: ALLOW, [ASK]: DENY, [DENY]: DENY },
  amp: { [ALLOW]: ALLOW, [ASK]: ASK, [DENY]: DENY },
  gemini: { [ALLOW]: ALLOW, [ASK]: DENY, [DENY]: DENY },
};

describe("renderEscalated: escalates only what the host would let run", () => {
  for (const [agent, { adapter, native }] of Object.entries(HOSTS)) {
    const vetoable = adapter.parse(native);
    const events = {
      vetoable,
      "non-vetoable": { ...vetoable, this_call_vetoable: false },
    };
    it(`${agent}: the fixture call is vetoable`, () => {
      assert.equal(vetoable.this_call_vetoable, true);
    });
    for (const [label, event] of Object.entries(events))
      for (const decision of [ALLOW, ASK, DENY]) {
        const expected =
          label === "vetoable" ? VETOABLE_RENDERS[agent][decision] : decision;
        it(`${agent}: ${decision} on a ${label} call renders as ${expected}`, () => {
          const out = renderEscalated(
            adapter,
            { decision, reason: "r" },
            event,
          );
          assert.deepEqual(
            out,
            adapter.render({ decision: expected, reason: "r" }, event),
          );
          assert.equal(out.enforced, label === "vetoable" && expected === DENY);
        });
      }
  }

  it("passes soleGate through to render", () => {
    const event = claudeAdapter.parse(HOSTS.claude.native);
    const gated = renderEscalated(claudeAdapter, { decision: ALLOW }, event, {
      soleGate: true,
    });
    assert.deepEqual(
      gated,
      claudeAdapter.render({ decision: ALLOW }, event, { soleGate: true }),
    );
    assert.notDeepEqual(
      gated,
      claudeAdapter.render({ decision: ALLOW }, event),
    );
  });

  it("throws on a decision outside allow/deny/ask", () => {
    const event = claudeAdapter.parse(HOSTS.claude.native);
    assert.throws(
      () =>
        renderEscalated(
          claudeAdapter,
          /** @type {any} */ ({ decision: "denied" }),
          event,
        ),
      /invalid verdict decision/u,
    );
  });
});

describe("renderEscalated: a payload that names no event", () => {
  // Amp's payload carries no event name, so its adapter always stamps one.
  const NAMELESS = { claude: {}, codex: {}, gemini: {} };
  for (const [agent, native] of Object.entries(NAMELESS)) {
    const { adapter } = HOSTS[agent];
    const event = adapter.parse(native);
    it(`${agent}: the fixture names no event`, () => {
      assert.equal(event.meta.native_event, "");
    });
    for (const decision of [ASK, DENY])
      it(`${agent}: ${decision} blocks through the host's block transport`, () => {
        assert.deepEqual(
          renderEscalated(adapter, { decision, reason: "r" }, event),
          {
            transport: adapter.INTEGRATION_MODE,
            exit_code: BLOCK_TRANSPORT[agent].exit_code,
            enforced: true,
            stderr: "r",
          },
        );
      });
    it(`${agent}: allow renders as the adapter renders it`, () => {
      assert.deepEqual(
        renderEscalated(adapter, { decision: ALLOW }, event),
        adapter.render({ decision: ALLOW }, event),
      );
    });
  }

  it("leaves a named but unmodelled event to the adapter's render", () => {
    // A block on Claude Code's Stop keeps the agent running, so a deny there
    // must not take the block transport.
    const event = claudeAdapter.parse({ hook_event_name: "Stop" });
    const out = renderEscalated(claudeAdapter, { decision: DENY }, event);
    assert.deepEqual(out, claudeAdapter.render({ decision: DENY }, event));
    assert.equal(out.exit_code, 0);
  });
});
