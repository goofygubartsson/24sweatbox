// `pnpm serve`: the production server on localhost, API and web app on one port, for a Cloudflare
// tunnel (or any reverse proxy) in front. Restarts the server if it stops; logs to var/logs.
//   node scripts/serve.mjs [--build]     --build: rebuild first (also done when no build exists)
// Windows autostart: scripts/windows/autostart.ps1 runs this at boot.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverJs = path.join(root, "apps/server/dist/index.js");
const webIndex = path.join(root, "apps/web/dist/index.html");
const logDir = path.join(root, "var/logs");
const logFile = path.join(logDir, "sweatbox.log");
const pidFile = path.join(root, "var/serve.pid");

/** PORT from the environment or .env, else the config default. */
function port() {
  if (process.env.PORT) return Number(process.env.PORT);
  try {
    const m = /^PORT=(\d+)\s*$/m.exec(fs.readFileSync(path.join(root, ".env"), "utf8"));
    if (m) return Number(m[1]);
  } catch {
    // no .env
  }
  return 3000;
}
const PORT = port();

fs.mkdirSync(logDir, { recursive: true });
if (fs.existsSync(logFile) && fs.statSync(logFile).size > 10 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
const logFd = fs.openSync(logFile, "a");
const out = (chunk) => {
  fs.writeSync(logFd, chunk);
  process.stdout.write(chunk);
};
const say = (line) => out(`${new Date().toISOString()} [serve] ${line}\n`);

/** Run node with `args`, output to the console and the log; resolves with the exit code. */
function run(args, env = process.env) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", out);
  child.stderr.on("data", out);
  return child;
}

async function build() {
  // pnpm via corepack, which ships with Node: works without pnpm on PATH (e.g. as a Windows service)
  const corepack = path.join(path.dirname(process.execPath), "node_modules/corepack/dist/corepack.js");
  say("building (pnpm build)");
  const code = await new Promise((resolve) => run([corepack, "pnpm", "build"], { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" }).on("exit", resolve));
  if (code !== 0) say(`build failed (exit ${code})${fs.existsSync(serverJs) ? "; starting the previous build" : ""}`);
}

async function alreadyRunning() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

let child = null;
let stopping = false;
let quickExits = 0;

function start() {
  const began = Date.now();
  child = run(["--enable-source-maps", serverJs], {
    ...process.env,
    NODE_ENV: "production",
    SERVE_WEB: "1", // the API process serves the web app too
    BIND_HOST: process.env.BIND_HOST || "127.0.0.1", // only the tunnel on this machine can reach it
    DEV_FAKE_USER: "",
  });
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return process.exit(0);
    if (Date.now() - began > 60_000) quickExits = 0;
    const wait = Math.min(60, 2 ** quickExits++);
    say(`server stopped (${signal ?? `exit ${code}`}); restarting in ${wait} s`);
    setTimeout(start, wait * 1000);
  });
}

for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"])
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill();
    else process.exit(0);
  });
process.on("exit", () => {
  try {
    if (fs.readFileSync(pidFile, "utf8") === String(process.pid)) fs.rmSync(pidFile);
  } catch {
    // already gone
  }
});

if (await alreadyRunning()) {
  say(`a Sweatbox server already answers on port ${PORT}; not starting a second one`);
  process.exit(0);
}
if (process.argv.includes("--build") || !fs.existsSync(serverJs) || !fs.existsSync(webIndex)) await build();
if (!fs.existsSync(serverJs) || !fs.existsSync(webIndex)) {
  say("no build to run: fix `pnpm build`, then start again");
  process.exit(1);
}
fs.writeFileSync(pidFile, String(process.pid));
say(`starting the Sweatbox on http://127.0.0.1:${PORT} (log: ${path.relative(root, logFile)})`);
start();
