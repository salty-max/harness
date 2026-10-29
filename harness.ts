/**
 * One door to the tools: `bun harness.ts <tool> [args…]` runs <tool>.ts beside
 * it (board, q, hooks, packet, review, each, status, usage, session, events,
 * config, doctor), its exit code kept. The tools also run on their own.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const [tool, ...rest] = process.argv.slice(2);
const file = tool ? join(import.meta.dir, `${tool}.ts`) : "";
if (!tool || !/^[a-z-]+$/.test(tool) || !existsSync(file)) {
  console.error(`usage: bun harness.ts <board|q|hooks|packet|review|each|status|usage|session|events|config|doctor> [args…]`);
  process.exit(2);
}
const p = Bun.spawnSync([process.execPath, file, ...rest], { stdio: ["inherit", "inherit", "inherit"] });
process.exit(p.exitCode ?? 1);
