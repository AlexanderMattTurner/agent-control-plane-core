/**
 * The agent-id → {@link import("./control-plane.mjs").Adapter} registry — the
 * single SSOT for selecting an adapter from a launch/env signal.
 *
 * Both sides of a deployment resolve the SAME adapter from the SAME id: a host
 * that launches an in-VM agent writes an agent id into a trust anchor, and the
 * in-process dispatcher reads that id to pick the translator for the payloads it
 * will see. Keying both off one frozen map means the id vocabulary can never
 * drift between selector and dispatcher — an id one side accepts, the other
 * resolves identically, and an unknown id fails loud on both.
 *
 * Each entry's key is asserted (at import) to equal its adapter's own `AGENT`,
 * so the id a consumer passes is exactly the `AGENT` the adapter reports — there
 * is no second spelling to reconcile.
 */

import { lookup } from "./control-plane.mjs";
import { claudeAdapter } from "./adapters/claude.mjs";
import {
  codexAdapter,
  createCodexAdapter,
  OPTION_NAMES as CODEX_OPTION_NAMES,
} from "./adapters/codex.mjs";
import { ampAdapter } from "./adapters/amp.mjs";
import { geminiAdapter } from "./adapters/gemini.mjs";

/** @typedef {import("./control-plane.mjs").Adapter} Adapter */

/**
 * Every shipped adapter. Adding an adapter to the package means adding it here —
 * the registry is the enrollment point, and {@link assertRegistryConsistent}
 * (run at import and in the conformance suite) fails if a key does not equal its
 * adapter's `AGENT`, so a typo'd or mismatched id cannot ship.
 * @type {Readonly<Record<string, Adapter>>}
 */
export const ADAPTERS = Object.freeze({
  [claudeAdapter.AGENT]: claudeAdapter,
  [codexAdapter.AGENT]: codexAdapter,
  [ampAdapter.AGENT]: ampAdapter,
  [geminiAdapter.AGENT]: geminiAdapter,
});

/**
 * The canonical set of agent ids, frozen — the closed vocabulary a launch
 * signal is validated against. Derived from {@link ADAPTERS} so it cannot list
 * an id the registry does not resolve.
 * @type {readonly string[]}
 */
export const AGENT_IDS = Object.freeze(Object.keys(ADAPTERS));

/**
 * Assert every {@link ADAPTERS} key equals its adapter's own `AGENT`. A registry
 * whose id disagrees with the adapter it resolves is a latent selector/dispatcher
 * split, so this throws (fail loud) rather than resolving a surprising adapter.
 * Called at import against {@link ADAPTERS}; exported so the conformance suite can
 * drive it against a constructed-bad map too.
 * @param {Record<string, Adapter>} adapters
 */
export function assertRegistryConsistent(adapters) {
  for (const [id, adapter] of Object.entries(adapters)) {
    if (adapter.AGENT !== id)
      throw new Error(
        `registry: id ${JSON.stringify(id)} resolves adapter whose AGENT is ${JSON.stringify(adapter.AGENT)}`,
      );
  }
}

assertRegistryConsistent(ADAPTERS);

/**
 * The adapters that take launcher options, keyed by agent id: the option names
 * each reads, and its factory. Only Codex takes one: its hook stdin carries no
 * version, so the launcher pins one.
 * @type {Readonly<Record<string, Readonly<{ options: readonly string[], create: (options: any) => Adapter }>>>}
 */
const CONFIGURABLE = Object.freeze({
  [codexAdapter.AGENT]: Object.freeze({
    options: CODEX_OPTION_NAMES,
    create: createCodexAdapter,
  }),
});

/**
 * The launcher option names each agent's adapter reads, for EVERY agent id (an
 * empty list when it reads none). A launcher builds the options for any agent
 * from this instead of naming the agents that take a version.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const LAUNCHER_OPTIONS = Object.freeze(
  Object.fromEntries(
    AGENT_IDS.map((id) => [
      id,
      lookup(CONFIGURABLE, id)?.options ?? Object.freeze([]),
    ]),
  ),
);

/**
 * Resolve an agent id to its adapter. Throws (fail loud) on an unknown id — a
 * selection signal that names no shipped adapter is a misconfiguration, not a
 * reason to silently fall back to a default agent (which would run the wrong
 * translator against the payloads and mis-render every verdict).
 *
 * `options` are the launcher's settings for that adapter, named by its
 * {@link LAUNCHER_OPTIONS} row. Options for an adapter that takes none throw
 * here, and an option a configurable adapter does not read throws in its
 * factory, so a setting the launcher believes it applied is never dropped.
 * @param {string} id agent id (a {@link AGENT_IDS} member)
 * @param {Record<string, unknown>} [options]
 * @returns {Adapter}
 */
export function adapterFor(id, options) {
  const adapter = lookup(ADAPTERS, id);
  if (adapter === undefined)
    throw new Error(
      `registry: no adapter for agent id ${JSON.stringify(id)} (known: ${AGENT_IDS.join(", ")})`,
    );
  if (options === undefined) return adapter;
  const configurable = lookup(CONFIGURABLE, id);
  if (configurable === undefined)
    throw new Error(
      `registry: adapter ${JSON.stringify(id)} takes no options, got ${JSON.stringify(options)}`,
    );
  return configurable.create(options);
}
