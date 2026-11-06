/**
 * The manifest, keyed by agent id in {@link AGENT_IDS} order.
 * @returns {Record<string, Record<string, unknown>>}
 */
export function agentManifest(): Record<string, Record<string, unknown>>;
/**
 * The manifest keyed by its package-relative path, the shape the generator
 * writes and the freshness test reads.
 * @returns {Record<string, Record<string, unknown>>}
 */
export function agentManifestDocuments(): Record<string, Record<string, unknown>>;
/** Basename of the generated manifest, beside the schema documents. */
export const AGENT_MANIFEST_FILE: "agents.json";
