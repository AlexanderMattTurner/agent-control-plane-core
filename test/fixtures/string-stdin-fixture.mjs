/**
 * Child process for the string-mode `readStdin` regression test.
 *
 * Setting an encoding on stdin makes its `data` events carry STRINGS, which is
 * what a consumer does when it reads the payload itself before handing over.
 * `Buffer.concat` throws on a string, and that throw leaves the stream's own
 * callback rather than the promise, so the process would die with no response
 * at all — the failure this fixture exists to observe.
 */
import { readStdin } from "../../src/runtime.mjs";

process.stdin.setEncoding("utf8");
process.stdout.write(await readStdin());
