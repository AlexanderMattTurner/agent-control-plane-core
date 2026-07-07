/**
 * Assert every {@link ADAPTERS} key equals its adapter's own `AGENT`. A registry
 * whose id disagrees with the adapter it resolves is a latent selector/dispatcher
 * split, so this throws (fail loud) rather than resolving a surprising adapter.
 * Called at import against {@link ADAPTERS}; exported so the conformance suite can
 * drive it against a constructed-bad map too.
 * @param {Record<string, Adapter>} adapters
 */
export function assertRegistryConsistent(adapters: Record<string, Adapter>): void;
/**
 * Resolve an agent id to its adapter. Throws (fail loud) on an unknown id — a
 * selection signal that names no shipped adapter is a misconfiguration, not a
 * reason to silently fall back to a default agent (which would run the wrong
 * translator against the payloads and mis-render every verdict).
 * @param {string} id agent id (a {@link AGENT_IDS} member)
 * @returns {Adapter}
 */
export function adapterFor(id: string): Adapter;
/** @typedef {import("./control-plane.mjs").Adapter} Adapter */
/**
 * Every shipped adapter. Adding an adapter to the package means adding it here —
 * the registry is the enrollment point, and {@link assertRegistryConsistent}
 * (run at import and in the conformance suite) fails if a key does not equal its
 * adapter's `AGENT`, so a typo'd or mismatched id cannot ship.
 * @type {Readonly<Record<string, Adapter>>}
 */
export const ADAPTERS: Readonly<Record<string, Adapter>>;
/**
 * The canonical set of agent ids, frozen — the closed vocabulary a launch
 * signal is validated against. Derived from {@link ADAPTERS} so it cannot list
 * an id the registry does not resolve.
 * @type {readonly string[]}
 */
export const AGENT_IDS: readonly string[];
export type Adapter = import("./control-plane.mjs").Adapter;
