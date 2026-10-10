// Re-run pnpm with the binary that is running this script, so root scripts also work when pnpm is
// only available through `corepack pnpm` (not on PATH).
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const pnpm = process.env.npm_execpath;
const r = pnpm
  ? spawnSync(process.execPath, [pnpm, ...args], { stdio: "inherit" })
  : spawnSync("pnpm", args, { stdio: "inherit", shell: true });
process.exit(r.status ?? 1);
