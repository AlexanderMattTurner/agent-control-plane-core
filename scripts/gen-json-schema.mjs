/**
 * Write the generated JSON Schema documents and the agent manifest under `schema/`.
 *
 * The documents are built from `control-plane.mjs`'s own exports, so this
 * regenerates rather than edits: change the contract, run `pnpm gen:schema`,
 * commit the result. `json-schema.test.mjs` regenerates in-process and
 * byte-compares (`agent-manifest.test.mjs` does the same for the manifest), so
 * a contract change landed without the regen fails there.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { agentManifestDocuments } from "../src/agent-manifest.mjs";
import { jsonSchemaDocuments, serializeSchema } from "../src/json-schema.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const documents = { ...jsonSchemaDocuments(), ...agentManifestDocuments() };
for (const [relativePath, document] of Object.entries(documents)) {
  const target = join(ROOT, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, serializeSchema(document));
  process.stdout.write(`wrote ${relativePath}\n`);
}
