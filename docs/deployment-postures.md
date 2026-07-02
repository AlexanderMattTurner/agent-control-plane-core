# Deployment postures: in-glovebox vs. standalone

> Design/ops doc (patch item ⑦). Not a code change — no adapter or schema field
> is added here. The question this doc answers: the control plane's `Verdict` is
> **advisory unless the sandbox makes it a hard boundary** (`control-plane.mjs`).
> _What_ makes it a hard boundary, and _which hosts_ can supply that, splits into
> two deployment postures. This doc pins the trust model of each and maps the
> seven hosts from [`schema-fit.md`](schema-fit.md) onto them.

## Verdict up front

A `deny` the adapter can render in-band is only ever as hard as the thing
stopping the agent from removing the hook that produced it. There are exactly
two things that can stop it: **a sandbox the operator controls** (posture A), or
**the host's own managed-settings mechanism plus filesystem permissions**
(posture B). Posture A makes an enforceable `deny` a genuine hard stop and backs
the rest with the sandbox; posture B is best-effort — a `deny` is closer to
advisory because the agent may rewrite the config that registers the hook, and
any call the hook never fires on is simply ungated.

---

## A) In-glovebox — the sandbox pins everything

The guardrail runs **inside a sandbox the operator controls**. The sandbox pins,
from outside the agent's reach:

- **Pinned:** the hook binary (PATH-shadowed / read-only mounted), its config and
  registration (read-only managed-settings mount), `PATH` itself, and the
  agent's write-access to all of the above. The agent has no filesystem path to
  disable, shadow, or re-point its own guardrail.
- **Trusted:** only the sandbox boundary itself (kernel isolation, the read-only
  mounts, the network egress rule) — not the agent, and not the agent's config.

**Threat model.** The agent (or a prompt-injection riding it) is assumed hostile
and is assumed to _try_ to disable the guardrail. It cannot, because every lever
it would pull is owned by the sandbox, not the agent.

**What "deny" means.** For a call the adapter can veto in-band
(`this_call_vetoable: true`), a rendered `deny` is a **hard stop**: the hook
fires before dispatch and the agent has no way around it. For a call the hook
_cannot_ veto (`this_call_vetoable: false` — headless-mode Codex/Goose, an
opencode MCP tool the plugin never sees, a Read the host auto-approves), the
**sandbox is the backstop**: the deny degrades to advisory, and the kernel/egress
layer carries the enforcement instead. This is the posture claude-guard targets.

## B) Standalone — managed layers are the only pin

The guardrail is installed **alongside an agent on a machine the operator does
not fully control** (a developer's laptop, no sandbox).

- **Pinned:** only what the host's own managed-settings mechanism pins, and only
  as far as filesystem permissions on that file hold. A root-owned
  `/etc/…/managed-settings.json` an unprivileged agent can't write is a real (if
  narrow) pin; anything user-writable is not.
- **Trusted:** the agent not rewriting its own config, the host honoring its own
  precedence rules, and no local override path (env var, project-level negation)
  undoing the managed layer.

**Threat model.** Best-effort. The agent (or a compromised prompt) **may** be
able to rewrite the config that registers the hook, point an env var at a
different settings file, or drop a project-level override — and any call the hook
doesn't fire on is ungated with nothing behind it.

**What "deny" means.** Closer to **advisory**. Where the host has a genuinely
unprivileged-unwritable managed layer _and_ no override escape hatch, an
enforceable `deny` holds; everywhere else it is a speed bump. There is no
backstop for the calls the hook misses.

---

## Per-host support

Columns: (1) an admin/managed settings location an unprivileged agent can't
override, with the path; (2) whether standalone posture can pin the hook at all;
(3) which posture the host realistically supports today. Integration mode and the
in-band veto story are from [`schema-fit.md`](schema-fit.md).

| Host            | Managed/admin settings location (unprivileged-unwritable?)                                                                                                                                                                                                                                                         | Standalone can pin the hook?                                                                                                                                                                                                                                                                                      | Realistic posture today                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Claude Code** | **Yes** — `/etc/claude-code/managed-settings.json` (Linux), `/Library/Application Support/ClaudeCode/managed-settings.json` (macOS), `C:\Program Files\ClaudeCode\managed-settings.json` (Win); "cannot be overridden by user or project settings" ([docs](https://code.claude.com/docs/en/settings))              | **Yes** — registers the hook + `permissions.deny`; root-owned file holds against an unprivileged agent                                                                                                                                                                                                            | **Both.** Strongest standalone story; in-glovebox by read-only mounting the same file                                          |
| **Codex CLI**   | **Yes** — `/etc/codex/requirements.toml` with top-level `allow_managed_hooks_only = true` + `[hooks] managed_dir`; `%ProgramData%\OpenAI\Codex\requirements.toml` (Win) ([docs](https://developers.openai.com/codex/enterprise/managed-configuration))                                                             | **Partial** — `requirements.toml` pins the hook _config_, but Codex does **not** ship the scripts in `managed_dir`; MDM/endpoint tooling must install them, and the script files must themselves be unwritable                                                                                                    | **Both**, with the script-delivery caveat; version-gated (`schema-fit.md`)                                                     |
| **Amp**         | **Yes** — `/etc/ampcode/managed-settings.json` (Linux), `/Library/Application Support/ampcode/managed-settings.json` (macOS), `%ProgramData%\ampcode\managed-settings.json` (Win); overrides user + workspace settings ([docs](https://ampcode.com/news/enterprise-managed-settings))                              | **Partial** — managed settings pin `amp.permissions` and the delegate-binary path; the delegate binary on disk must also be unwritable                                                                                                                                                                            | **Both**; delegate transport means the binary, not just the config, needs pinning                                              |
| **opencode**    | **Yes** — system managed-config dir (drop an `opencode.json`/`.jsonc`), "requires admin/root access to write… override[s] everything"; macOS also via the `ai.opencode.managed` MDM preference domain ([docs](https://opencode.ai/docs/config/), [issue #6358](https://github.com/anomalyco/opencode/issues/6358)) | **Partial** — managed config can set `permission` deny + the plugin list, but the plugin is `in_process` and **MCP-sourced tool calls never reach `tool.execute.before`** ([#2319](https://github.com/sst/opencode/issues/2319)) — a `config_deny` wildcard is _also_ needed and still leaves MCP paths uncovered | **A preferred; B partial.** The MCP hole means the sandbox must backstop even with a pinned managed config                     |
| **Gemini CLI**  | **Yes, with an escape hatch** — `/etc/gemini-cli/settings.json` (system, top precedence) + `system-defaults.json`; **but** `GEMINI_CLI_SYSTEM_SETTINGS_PATH` can be re-pointed by a user unless an enforced wrapper/alias pins it ([docs](https://geminicli.com/docs/cli/enterprise/))                             | **Weak** — the env-var override is exactly the lever a hostile agent pulls; a standalone pin holds only if the env var is _also_ locked (wrapper, or the sandbox)                                                                                                                                                 | **A preferred.** Standalone needs the env-var override closed off; version-gated v0.26+ (`schema-fit.md`)                      |
| **OpenHands**   | **No OS-level managed layer.** The security analyzer / confirmation policy is set **programmatically by the embedding host process** (`set_security_analyzer` / `set_confirmation_policy`, `schema-fit.md`) — there is no `/etc` file a separate installed agent could override                                    | **N/A** — no "installed agent a user configures" surface to pin; the host process _is_ the config                                                                                                                                                                                                                 | **A only.** In-glovebox works because the operator writes the host process; two-call protocol gap unresolved (`schema-fit.md`) |
| **Goose**       | **No admin lock.** `~/.config/goose/.gooseignore` is user-editable, a **local `.gooseignore` can negate the global one**, and it gates **file access only**, not tool calls broadly ([docs](https://goose-docs.ai/docs/guides/using-gooseignore/)); `GOOSE_MODE`/`permission.yaml` are user config                 | **No** — no supported extension point to register a decision-maker (`schema-fit.md`), and the ignore file is agent-writable                                                                                                                                                                                       | **Neither reliably.** `observe_only` at best; the sandbox must carry all enforcement                                           |

---

## How the schema expresses the split

The contract already carries the posture distinction in three places — no new
field is needed to describe either posture, only to _act_ on them:

- **`integration_mode`** (`EventMeta.integration_mode`, `control-plane.mjs`) sets
  the ceiling on what a pin can buy. An `external_hook` host is pinnable from
  _outside_ the agent (PATH-shadow the binary, read-only mount the managed
  config) — so in-glovebox turns its `deny` into a hard stop, and even standalone
  gets a real pin when the managed file is root-owned. An `in_process` host
  (opencode, OpenHands, Goose) is pinned only if the sandbox owns the whole
  process and its config, because the decision-maker lives inside the agent
  process. `observe_only` never pre-empts, so its `Verdict` is advisory in **both**
  postures by construction.

- **`this_call_vetoable`** (`ToolCallEvent`) marks the residual the pin can't
  close in _either_ posture. When it is `false`, a render "stays advisory (never
  `enforced`)" regardless of how well the hook is pinned — the hook simply never
  fires on that call. In-glovebox, the sandbox carries these; standalone, they are
  the ungated calls with nothing behind them. The flag is what tells the monitor
  to auto-degrade `deny` → notify rather than believe it enforced.

- **`ConfigFallback`** (`NativeResponse.fallback`) is the machine-readable form of
  each posture's out-of-band requirement:
  - **`external_pin`** _is_ posture A's contract: "the sandbox must pin it from
    OUTSIDE (read-only config mount / PATH-shadow)." In standalone it maps onto
    the host's managed-settings file if one exists and is unwritable (Claude Code,
    Codex, Amp, opencode) — and is unsatisfiable where none does (Goose) or where
    an env var undoes it (Gemini CLI unless the env var is also locked).
  - **`config_deny`** is the only enforcement left for calls the in-process hook
    never sees — a config-level deny-by-name wildcard (e.g. opencode's MCP-tool
    hole). Its `uncovered` list names the paths even that wildcard can't reach; in
    posture B those paths are simply open, and in posture A the sandbox is what
    closes them.

## Bottom line, per posture

- **In-glovebox:** rely on the control plane for every `this_call_vetoable: true`
  call on an `external_hook`/pinned-`in_process` host; the sandbox must carry the
  `false` calls and everything on Goose/observe-only.
- **Standalone:** rely on the control plane only where the host has an
  unprivileged-unwritable managed layer with no override escape hatch (Claude
  Code, and Codex/Amp/opencode with their binary/script/MCP caveats closed);
  everywhere else treat `deny` as advisory and assume the calls the hook misses
  are ungated.
