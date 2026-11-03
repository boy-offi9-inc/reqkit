// Entry point for Node, Deno and Bun:
//   node smoke/run.mjs   |   deno run smoke/run.mjs   |   bun smoke/run.mjs
import * as reqkit from "../dist/reqkit.mjs";
import { runChecks } from "./checks.mjs";

const { passed, failed } = await runChecks(reqkit, console.log);
console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  if (typeof Deno !== "undefined") Deno.exit(1);
  else process.exit(1);
}
