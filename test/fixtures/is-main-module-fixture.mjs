// Fixture for cli-args.test.mjs: a real script invoked directly, to prove
// isMainModule() returns true for the actual entry point (not just false for
// everything, which a broken implementation could satisfy vacuously).
import { isMainModule } from "../../.github/scripts/lib/cli-args.mjs";

process.stdout.write(String(isMainModule(import.meta.url)));
