import js from "@eslint/js";
import globals from "globals";

// A bare numeric process.argv index (argv[2], or destructuring past a couple
// of skipped slots) is fragile: it has no self-description and silently reads
// the wrong value if any argument is ever prepended to the command line — by
// us in a future edit, or by a host we don't fully control. This caught a real
// bug (dump.mjs originally read argv[2] as its capture-file target). Use
// readFlag()/isMainModule() from .github/scripts/lib/cli-args.mjs instead —
// that module carries the two sanctioned exceptions (Node's own
// "is this the entry point" idiom) via an explicit, justified disable.
const NO_POSITIONAL_ARGV = [
  "error",
  {
    selector:
      'MemberExpression[computed=true][object.object.name="process"][object.property.name="argv"]',
    message:
      "Don't index process.argv positionally — use readFlag()/isMainModule() from .github/scripts/lib/cli-args.mjs.",
  },
  {
    selector:
      'VariableDeclarator[id.type="ArrayPattern"] > MemberExpression[object.name="process"][property.name="argv"]',
    message:
      "Don't destructure process.argv positionally — use readFlag() from .github/scripts/lib/cli-args.mjs.",
  },
];

export default [
  { ignores: ["types/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-restricted-syntax": NO_POSITIONAL_ARGV,
    },
  },
];
