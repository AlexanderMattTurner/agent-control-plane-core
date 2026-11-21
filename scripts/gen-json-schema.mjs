/**
 * Write the generated JSON Schema documents and the agent manifest under `schema/`.
 *
 * The documents are built from the contract's and the adapters' own exports, so
 * this regenerates rather than edits: change them, run `pnpm gen:schema`,
 * commit the result. `json-schema.test.mjs` regenerates in-process and
 * byte-compares, so a change landed without the regen fails there.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generatedDocuments } from "../src/agent-manifest.mjs";
import { serializeSchema } from "../src/json-schema.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

for (const [relativePath, document] of Object.entries(generatedDocuments())) {
  const target = join(ROOT, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, serializeSchema(document));
  process.stdout.write(`wrote ${relativePath}\n`);
}
