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
 *      MUST carry a real block signal — a non-zero `exit_code` or a `throw_` —
 *      not just a JSON body the agent is free to ignore. At least one enforced
 *      deny must appear, so the honesty check is never vacuous.
 *   5. non-vetoable honesty: when the parsed event's `this_call_vetoable` is
 *      false, EVERY render for that case must be `enforced === false` — a
 *      guardrail that cannot veto this call must never render as if it did.
 *   6. allow = abstain: by default (no `soleGate` opt-in) every `allow` render
 *      is `enforced === false` AND `exit_code === 0` — an "I have no objection"
 *      verdict never renders as a block, on any adapter. At least one `allow`
 *      must be rendered, so this is never vacuous.
 *   7. coverage honesty: the adapter's COVERAGE matrix is well-formed (item ③),
 *      and a fixture case tagged with a `call_class` whose coverage does NOT
 *      permit a veto (uncovered/unknown — an ❓ is treated as ❌) MUST parse to
 *      `this_call_vetoable: false`. An adapter cannot claim a class is un-gated
 *      while parsing its calls as vetoable.
 *
 * `assert` is injected (node:assert/strict) so the harness stays test-framework
 * neutral; it throws on the first mismatch. Returns a summary the caller can
 * assert further on.
 *
 * @param {{ adapter: import("./control-plane.mjs").Adapter, fixtures: any, assert: any }} args
 * @returns {{ cases: number, renders: number, decisionsSeen: Set<string>, mutationSeen: boolean, enforcedDenySeen: boolean, coverageClassesChecked: Set<string> }}
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
    coverageClassesChecked: Set<string>;
};
