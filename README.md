# agent-control-plane

A **vendor-neutral control-plane contract** for coding agents. It defines one
normalized shape for "an agent is about to run / just ran a tool" and one for
"the guardrail decided X", plus per-agent **adapters** that translate a specific
agent's native hook/tool-call protocol to and from those shapes.

Write your monitor, deny-matcher, redactor, or sanitizer once against the
normalized types; add a thin adapter per agent (Claude Code, Codex, …) and it
works everywhere. The agent-specific field names live **only** inside that
agent's adapter.

## Install

```bash
pnpm add agent-control-plane
```

## The model

```js
// ToolCallEvent — a normalized, agent-agnostic view of one agent event.
{
  schema_version: 1,
  event: "pre_tool" | "post_tool" | "prompt_submit" | "session_start" | "unknown",
  tool: string | null,              // "Bash" | "Edit" | "Write" | "Read" | "WebFetch" | <passthrough> | null
  input: object,                    // tool input; a submitted prompt folds into input.prompt
  response?: unknown,               // post_tool only
  this_call_vetoable: boolean,      // false ⇒ a deny here is advisory only; the guardrail cannot block THIS call
  meta: {
    agent: string,                  // "claude" | "codex" | …
    native_event: string,           // original native event name, preserved verbatim
    session_id?, cwd?, permission_mode?, transcript_path?,
    passthrough: object,            // every unmodelled native top-level field, verbatim
  }
}

// Verdict — a normalized guardrail decision.
{
  decision: "allow" | "deny" | "ask",
  mutated_input?: object,           // replacement tool input
  additional_context?: string,      // extra context to splice into the agent's stream
  reason?: string,                  // shown on deny/ask
}
```

An **Adapter** is a pair `{ AGENT, parse, render }`:

```js
parse(nativeEvent) -> ToolCallEvent      // never throws on unknown input
render(verdict, event) -> nativeResponse // the agent's native shape
```

## Usage

```js
import { claudeAdapter } from "agent-control-plane/claude";

// 1. Normalize the agent's raw hook payload.
const event = claudeAdapter.parse(rawHookJson);

// 2. Your guardrail decides, using only the normalized types.
const verdict =
  event.tool === "Bash" && /rm -rf/.test(String(event.input.command))
    ? { decision: "deny", reason: "destructive command blocked" }
    : { decision: "allow" };

// 3. Render back to the agent's native response.
process.stdout.write(JSON.stringify(claudeAdapter.render(verdict, event)));
```

The core contract and both adapters are also on the default entry:

```js
import {
  EventKind,
  Decision,
  claudeAdapter,
  codexAdapter,
  runAdapterConformance,
} from "agent-control-plane";
```

## Drift discipline (the point of the seam)

Agent protocols drift **additively and independently** — N agents, N release
cadences. So `parse` **never throws** on an event type or tool-input field it
does not model: an unrecognized event becomes `EventKind.UNKNOWN` with its native
name kept in `meta.native_event`, and every unmodelled field survives in `input`
or `meta.passthrough`. An additive upstream change is a **no-op**, not an outage.

The core models only the stable middle — four event kinds, three decisions, and
the `Bash`/`Edit`/`Write`/`Read`/`WebFetch` tool inputs (`MODELED_TOOLS`). Exotic
per-agent tools pass through untouched.

## Writing a new adapter

An adapter for cursor/cline/gemini-cli/aider is a thin, independently-pinned
translator with its own golden fixtures. It must pass the conformance suite:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAdapterConformance } from "agent-control-plane/conformance";
import { myAdapter } from "./my-adapter.mjs";
import fixtures from "./fixtures/my-agent.json" with { type: "json" };

test("my adapter conforms", () => {
  runAdapterConformance({ adapter: myAdapter, fixtures, assert });
});
```

The harness pins both directions and rejects a vacuous suite:

1. `parse(native)` deep-equals the fixture's golden `event`.
2. `render(verdict, event)` deep-equals the fixture's golden native response, for
   each verdict scenario.
3. The fixture set collectively renders an `allow`, a `deny`, an `ask`, **and** a
   `mutated_input` — so a suite can't pass while skipping a decision the contract
   requires every adapter to express.

See `src/fixtures/claude.json` and `src/fixtures/codex.json` for the format.

## Versioning

`src/control-plane.mjs` is the frozen contract and its own single source of
truth. `SCHEMA_VERSION` / `CONTROL_PLANE_SCHEMA` are pinned by a test. **Adding**
an optional field or a modeled tool is backward-compatible and stays at v1;
**renaming/removing** a field or changing a decision/event vocabulary is breaking
and bumps the version.

## Development

```bash
./setup.sh          # install deps + git hooks
pnpm test           # node --test
pnpm test:coverage  # c8, 100% lines/branches/functions per file
pnpm check          # tsc --noEmit (JSDoc types)
pnpm lint           # eslint
pnpm build          # emit .d.mts declarations into types/
```

## License

MIT
