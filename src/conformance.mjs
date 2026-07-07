import {
  CALL_CLASSES,
  TOOL_ALIASES,
  canonicalTool,
  coverageAllowsVeto,
  isCoverageStatus,
} from "./control-plane.mjs";

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
export function assertCoverageWellFormed(adapter, assert) {
  assert.ok(
    adapter.COVERAGE && typeof adapter.COVERAGE === "object",
    `adapter '${adapter.AGENT}' declares no COVERAGE matrix`,
  );
  const declared = Object.keys(adapter.COVERAGE).sort();
  assert.deepEqual(
    declared,
    [...CALL_CLASSES].sort(),
    `adapter '${adapter.AGENT}' COVERAGE must classify exactly the call classes ${JSON.stringify([...CALL_CLASSES])}`,
  );
  for (const cls of CALL_CLASSES) {
    assert.ok(
      isCoverageStatus(adapter.COVERAGE[cls]),
      `adapter '${adapter.AGENT}' COVERAGE.${cls} is not a valid coverage status: ${JSON.stringify(adapter.COVERAGE[cls])}`,
    );
  }
}

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
export function assertToolAliasesCovered(
  fixturesList,
  assert,
  adapterAliases = {},
) {
  /** @type {Map<string, Map<string, Set<string>>>} agent → native tool name → canonical names seen */
  const witnessedByAgent = new Map();
  for (const fixtures of fixturesList) {
    let witnessed = witnessedByAgent.get(fixtures.agent);
    if (witnessed === undefined)
      witnessedByAgent.set(fixtures.agent, (witnessed = new Map()));
    const scopedMap = adapterAliases[fixtures.agent] ?? {};
    for (const testCase of fixtures.cases) {
      const nativeTool = testCase.event?.meta?.native_tool;
      if (typeof nativeTool !== "string") continue;
      const canon = testCase.event.tool;
      const allowed = new Set([canonicalTool(nativeTool)]);
      if (scopedMap[nativeTool] !== undefined)
        allowed.add(scopedMap[nativeTool]);
      assert.ok(
        allowed.has(canon),
        `fixture '${testCase.name}' (${fixtures.agent}): native_tool ${JSON.stringify(nativeTool)} normalized to ${JSON.stringify(canon)}, but only ${JSON.stringify([...allowed])} are valid canonicalizations for this agent`,
      );
      let canons = witnessed.get(nativeTool);
      if (canons === undefined) witnessed.set(nativeTool, (canons = new Set()));
      canons.add(canon);
    }
  }
  /** @type {(nativeName: string, canonical: string) => boolean} */
  const witnessedAnywhere = (nativeName, canonical) =>
    [...witnessedByAgent.values()].some((w) =>
      w.get(nativeName)?.has(canonical),
    );
  for (const [nativeName, canonical] of Object.entries(TOOL_ALIASES)) {
    assert.ok(
      witnessedAnywhere(nativeName, canonical),
      `tool alias ${JSON.stringify(nativeName)} -> ${JSON.stringify(canonical)} is not witnessed by any conformance fixture — add a golden case whose native tool is ${JSON.stringify(nativeName)}`,
    );
  }
  for (const [agent, scopedMap] of Object.entries(adapterAliases)) {
    for (const [nativeName, canonical] of Object.entries(scopedMap)) {
      assert.ok(
        witnessedByAgent.get(agent)?.get(nativeName)?.has(canonical),
        `adapter-scoped tool alias ${JSON.stringify(nativeName)} -> ${JSON.stringify(canonical)} (${agent}) is not witnessed by a '${agent}' conformance fixture — add a golden ${agent} case whose native tool is ${JSON.stringify(nativeName)}`,
      );
    }
  }
}

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
export function runAdapterConformance({ adapter, fixtures, assert }) {
  assert.equal(
    adapter.AGENT,
    fixtures.agent,
    `adapter AGENT '${adapter.AGENT}' does not match fixtures.agent '${fixtures.agent}'`,
  );

  assertCoverageWellFormed(adapter, assert);

  /** @type {Set<string>} */
  const decisionsSeen = new Set();
  /** @type {Set<string>} call classes exercised by a tagged fixture case */
  const coverageClassesChecked = new Set();
  let mutationSeen = false;
  let enforcedDenySeen = false;
  let renders = 0;

  for (const testCase of fixtures.cases) {
    const parsed = adapter.parse(testCase.native);
    assert.deepEqual(
      parsed,
      testCase.event,
      `parse mismatch: ${testCase.name}`,
    );

    if (testCase.call_class !== undefined) {
      assert.ok(
        CALL_CLASSES.includes(testCase.call_class),
        `unknown call_class '${testCase.call_class}': ${testCase.name}`,
      );
      if (!coverageAllowsVeto(adapter.COVERAGE[testCase.call_class])) {
        assert.equal(
          parsed.this_call_vetoable,
          false,
          `call_class '${testCase.call_class}' is ${adapter.COVERAGE[testCase.call_class]} (no veto) but parsed this_call_vetoable !== false: ${testCase.name}`,
        );
      }
      coverageClassesChecked.add(testCase.call_class);
    }

    for (const [scenario, raw] of Object.entries(testCase.render)) {
      const spec = /** @type {{ verdict: any, native: any }} */ (raw);
      const rendered = adapter.render(spec.verdict, parsed);
      assert.deepEqual(
        rendered,
        spec.native,
        `render mismatch: ${testCase.name} / ${scenario}`,
      );
      if (rendered.enforced) {
        assert.ok(
          rendered.exit_code !== 0,
          `enforced deny carries no block signal: ${testCase.name} / ${scenario}`,
        );
        enforcedDenySeen = true;
      }
      if (parsed.this_call_vetoable === false) {
        assert.equal(
          rendered.enforced,
          false,
          `non-vetoable call rendered as enforced: ${testCase.name} / ${scenario}`,
        );
      }
      if (spec.verdict.decision === "allow") {
        assert.equal(
          rendered.enforced,
          false,
          `allow rendered as enforced: ${testCase.name} / ${scenario}`,
        );
        assert.equal(
          rendered.exit_code,
          0,
          `allow rendered a non-zero exit_code: ${testCase.name} / ${scenario}`,
        );
      }
      decisionsSeen.add(spec.verdict.decision);
      if (spec.verdict.mutated_input !== undefined) mutationSeen = true;
      renders += 1;
    }
  }

  for (const decision of ["allow", "deny", "ask"]) {
    assert.ok(
      decisionsSeen.has(decision),
      `conformance fixtures never render a '${decision}' verdict — the suite is vacuous`,
    );
  }
  assert.ok(
    mutationSeen,
    "conformance fixtures never render a mutated_input verdict — mutation is untested",
  );
  assert.ok(
    enforcedDenySeen,
    "no enforced deny rendered — enforcement honesty is untested",
  );
  assert.ok(renders > 0, "conformance fixtures render nothing");

  return {
    cases: fixtures.cases.length,
    renders,
    decisionsSeen,
    mutationSeen,
    enforcedDenySeen,
    coverageClassesChecked,
  };
}
