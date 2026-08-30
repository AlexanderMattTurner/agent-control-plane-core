# agent-control-plane-core

**One shape for "a coding agent is about to run a tool" and "here's what my
guardrail decided" — so you write your tool once and it works across every
agent.**

## The problem this solves

Coding agents — Claude Code, Codex, Gemini CLI, opencode, Amp, and friends — all
let you hook into their tool-call loop: before a shell command runs, after a file
is written, when a prompt is submitted. That's where you'd plug in a security
guardrail, an audit log, a secret redactor, a policy engine.

But **every agent speaks its own protocol.** One sends you `tool_name` +
`tool_input` on stdin and wants `{"permissionDecision":"deny"}` back plus exit
code 2. Another names the fields differently, blocks by throwing inside a plugin,
or can only _observe_ and not veto. The field names differ, the "block this"
signal differs, and each one drifts on its own release cadence.

So if you build a tool that touches more than one agent, you end up writing and
maintaining **N copies of the same logic** — one per agent — and re-testing all
of them every time an agent ships a new field. That's the tax this package
removes.

## What it gives you

- **`ToolCallEvent`** — one normalized, agent-agnostic view of "an agent event"
  (a tool about to run, a tool that just ran, a prompt, a session start).
- **`Verdict`** — one normalized way to say what your guardrail decided:
  `allow` / `deny` / `ask`, optionally with a rewritten input or extra context.
- **Adapters** — a thin `{ parse, render }` translator per agent, plus the
  declaration of what that agent's transport cannot carry. `parse` turns that
  agent's raw hook payload into a `ToolCallEvent`; `render` turns your `Verdict`
  back into the **real** native signal that agent enforces (the right JSON body,
  exit code, or thrown error — not just a print).

You write your logic **once** against the normalized types. Adding support for a
new agent is a new adapter (~one file + fixtures), not a rewrite of your tool.
The agent-specific field names live **only** inside that agent's adapter.

## Who wants this

Anyone building a tool that sits in the tool-call loop of **more than one**
coding agent, and doesn't want to fork it per agent:

- **Security guardrails** — deny-listers, command/path sanitizers, permission gates.
- **Observability & audit** — log or replay every tool call in a uniform shape.
- **Redaction / DLP** — strip secrets from tool inputs or outputs before they move.
- **Policy engines** — one rule set enforced identically no matter which agent runs.

If you only ever target a single agent, you don't need this — just use that
agent's native hooks. The value is entirely in the _N-agents_ case.

> **Not a security boundary.** A `Verdict` is advisory: a useful first filter,
> never the last line of defense. Some agents can't enforce a `deny` at all (the
> adapter marks those `observe_only`), so a real deployment still needs a sandbox
> underneath. Treat the control plane as a policy layer on top of isolation, not
> a replacement for it.

## Install

```bash
pnpm add agent-control-plane-core
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

An **Adapter** is `{ AGENT, COVERAGE, UNRENDERED_FIELDS, parse, render }`:

```js
parse(nativeEvent) -> ToolCallEvent      // never throws on unknown input
render(verdict, event) -> nativeResponse // the agent's native shape

// Which Verdict content fields this host has NO native channel for, per event
// kind. Every EventKind needs a row: an omission would read as "every field
// reaches a channel here", which is the reverse of the truth on a transport
// that carries none.
UNRENDERED_FIELDS = Object.freeze({
  [EventKind.PRE_TOOL]: readonlySet(["mutated_output"]),
  [EventKind.POST_TOOL]: readonlySet(["mutated_output"]),
  [EventKind.PROMPT_SUBMIT]: UNRENDERED_ON_UNKNOWN,
  [EventKind.SESSION_START]: UNRENDERED_ON_UNKNOWN,
  [EventKind.UNKNOWN]: UNRENDERED_ON_UNKNOWN,
})
```

`readonlySet([])` is the row for a kind that carries all three;
`UNRENDERED_ON_UNKNOWN` is the row for one that carries none. Both come from
`agent-control-plane-core/contract`. Build every row with `readonlySet` — a
plain `Set` exposes `clear()`, so a consumer could empty a declaration after
conformance certified it, and `Object.freeze` does not stop that. Freeze the map
itself too: an immutable row still leaves a consumer free to swap a whole row
for one claiming another channel. A render that ships a field the row
declares dropped fails conformance, and so does a row that declares a channel
the render does not carry.

## Usage

```js
import { claudeAdapter } from "agent-control-plane-core/claude";

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

The core contract and every adapter (`claude`, `codex`, `amp`, `gemini`) are
also on the default entry:

```js
import {
  EventKind,
  Decision,
  claudeAdapter,
  codexAdapter,
  ampAdapter,
  geminiAdapter,
  runAdapterConformance,
} from "agent-control-plane-core";
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
import { runAdapterConformance } from "agent-control-plane-core/conformance";
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
4. Every `Verdict` content field either reaches this host's wire or is declared
   in `UNRENDERED_FIELDS` for that event kind, checked both ways on a
   synthesized verdict — so an adapter with no channel for a field must say so,
   and a declared drop that still ships the value fails. Set the optional
   `NATIVE_EVENT_FOR` to have a kind your fixtures skip probed on its real
   native event rather than on your unrecognized-event branch.
5. A deny the adapter cannot enforce (`this_call_vetoable: false`) must render as
   something OTHER than that host's allow signal — an ask, or an advisory body.
   The harness probes this itself on a non-vetoable variant of every pre-tool
   fixture event, so an adapter that collapses the objection onto "run it" fails
   even with no non-vetoable fixture of its own. `observe_only` renders are
   exempt: that transport has no pre-emption channel to differ in.

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
