/**
 * Assert an adapter's {@link import("./control-plane.mjs").Adapter.COVERAGE}
 * hook-coverage matrix is well-formed: it classifies EXACTLY the canonical
 * {@link CALL_CLASSES} (no class missing, none unknown) and every value is a
 * valid coverage status. This is the SSOT gate — adding a new call class to the
 * contract fails every adapter until it declares that class, so a coverage hole
 * can't be introduced by omission.
 * @param {import("./control-plane.mjs").Adapter} adapter
 * @param {any} assert node:assert/strict (injected)
 */
export function assertCoverageWellFormed(adapter: import("./control-plane.mjs").Adapter, assert: any): void;
/**
 * Assert every tool alias — the global {@link TOOL_ALIASES} entries AND each
 * adapter-scoped alias map — is WITNESSED by a golden fixture: a case whose
 * native tool name equals the alias key and whose normalized `event.tool`
 * equals the canonical target. This is what ties the alias SSOTs to the
 * fixtures: an alias added without a golden payload that exercises it fails
 * here, so an alias "a new judge keys on" can't ship unproven. A global alias
 * may be witnessed by any agent's fixtures; an adapter-scoped alias must be
 * witnessed by THAT agent's fixtures (another agent's payload proves nothing
 * about the scoping adapter's parse). Also cross-checks each witnessed pair:
 * `event.tool` must be either the global {@link canonicalTool} result or the
 * owning adapter's scoped target, so a fixture that preserved `native_tool` but
 * mis-normalized `event.tool` is caught — including a scoped alias applied by
 * the wrong agent's fixtures.
 * @param {any[]} fixturesList the golden fixtures for every shipped adapter
 * @param {any} assert node:assert/strict (injected)
 * @param {Record<string, Record<string, string>>} [adapterAliases] agent id → that adapter's scoped alias map (e.g. `{ gemini: GEMINI_TOOL_ALIASES }`)
 */
export function assertToolAliasesCovered(fixturesList: any[], assert: any, adapterAliases?: Record<string, Record<string, string>>): void;
/**
 * Assert that every case whose tool name was ALIASED carries the canonical
 * tool's input key.
 *
 * Renaming a native tool to a {@link MODELED_TOOLS} name tells every consumer
 * "this is a Read, read it like one" — the README's whole "write your logic
 * once against the normalized types" promise. An adapter that renames the name
 * but forwards the native input dialect makes that promise false in the one
 * direction nobody checks: the judge reads the canonical field, gets
 * `undefined`, and allows. A native-NAMED tool promises nothing and is left
 * alone; this fires only where the adapter itself claimed the schema.
 *
 * The remedy for a failure is a real choice, not a fixture edit: rename the
 * input keys too when the mapping is a pure rename, or drop the alias when it
 * is not (a URL buried in a prose `prompt` cannot be renamed into a `url`
 * without inventing it, and an invented target is worse than a visible gap).
 * @param {any[]} fixturesList the golden fixtures for every shipped adapter
 * @param {any} assert node:assert/strict (injected)
 */
export function assertAliasedInputsCanonical(fixturesList: any[], assert: any): void;
/**
 * The control-plane conformance harness.
 *
 * Any adapter — the reference claude one, codex, or a future
 * cursor/cline/gemini-cli/aider translator — must pass this against its own
 * golden fixtures. It pins the two directions of the contract:
 *
 *   1. parse is golden: adapter.parse(native) deep-equals the fixture's
 *      normalized `event` (and never throws — an adapter that threw would fail
 *      here rather than in production).
 *   2. render is golden: for each verdict scenario, adapter.render(verdict,
 *      parsedEvent) deep-equals the fixture's native response. An `allow` with
 *      the unmutated input renders to the agent's native allow; deny/ask/mutation
 *      each render to their native shape.
 *   3. non-vacuity: the fixture set collectively renders an allow, a deny, an
 *      ask, AND a mutated_input, so a suite can't pass while silently skipping a
 *      decision the contract requires every adapter to express.
 *   4. enforcement honesty: an enforceable deny (`rendered.enforced === true`)
 *      MUST carry a real block signal — a non-zero `exit_code` — not just a JSON
 *      body the agent is free to ignore. At least one enforced deny must appear,
 *      so the honesty check is never vacuous.
 *   5. vetoability honesty, BOTH directions. When the parsed event's
 *      `this_call_vetoable` is false, EVERY render for that case must be
 *      `enforced === false` — a guardrail that cannot veto this call must never
 *      render as if it did. And when it is true, a `deny` verdict MUST render
 *      `enforced === true` with a non-zero `exit_code`: where the host can be
 *      stopped, a deny has to stop it. Without the forward half the whole
 *      deny-must-block property rests on each fixture's golden `deepEqual`, so
 *      an adapter that renders a vetoable deny as exit 0 passes as long as its
 *      own fixture was written to match — which is the one bug this harness
 *      exists to make impossible. Item ④'s enforced-deny requirement keeps this
 *      non-vacuous: a suite that never enforces anything fails there.
 *   6. allow = abstain: by default (no `soleGate` opt-in) every `allow` render
 *      is `enforced === false` AND `exit_code === 0` — an "I have no objection"
 *      verdict never renders as a block, on any adapter. At least one `allow`
 *      must be rendered, so this is never vacuous.
 *   7. coverage honesty: the adapter's COVERAGE matrix is well-formed (item ③),
 *      and a fixture case tagged with a `call_class` whose coverage does NOT
 *      permit a veto (uncovered/unknown — an ❓ is treated as ❌) MUST parse to
 *      `this_call_vetoable: false`. An adapter cannot claim a class is un-gated
 *      while parsing its calls as vetoable.
 *   8. unenforceable deny ≠ allow: for every pre-tool fixture event, rendering a
 *      DENY over a non-vetoable variant of that event must produce a response
 *      that differs from the same adapter's abstaining `allow` render. Rule ⑤
 *      only says such a deny is not `enforced`; without this, an adapter is free
 *      to collapse it onto the host's literal "run it" signal (Amp's exit 0),
 *      throwing away the objection entirely. The strongest honest signal a
 *      transport has left — an ask, an advisory body — must survive. An
 *      OBSERVE_ONLY render is exempt: it has no pre-emption channel to differ in.
 *
 * `assert` is injected (node:assert/strict) so the harness stays test-framework
 * neutral; it throws on the first mismatch. Returns a summary the caller can
 * assert further on.
 *
 * @param {{ adapter: import("./control-plane.mjs").Adapter, fixtures: any, assert: any }} args
 * @returns {{ cases: number, renders: number, decisionsSeen: Set<string>, mutationSeen: boolean, enforcedDenySeen: boolean, vetoableDenySeen: boolean, unknownKindSeen: boolean, coverageClassesChecked: Set<string>, unenforceableDenyChecks: number }}
 */
export function runAdapterConformance({ adapter, fixtures, assert }: {
    adapter: import("./control-plane.mjs").Adapter;
    fixtures: any;
    assert: any;
}): {
    cases: number;
    renders: number;
    decisionsSeen: Set<string>;
    mutationSeen: boolean;
    enforcedDenySeen: boolean;
    vetoableDenySeen: boolean;
    unknownKindSeen: boolean;
    coverageClassesChecked: Set<string>;
    unenforceableDenyChecks: number;
};
