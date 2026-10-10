// `pnpm dev`: run the API (tsx watch) and the web app (Vite) together with prefixed output.
// Defaults NODE_ENV to development so the dev login works without Discord credentials.
import { spawn } from "node:child_process";

const pnpm = process.env.npm_execpath;
const run = (name, colour, args) => {
  const cmd = pnpm ? process.execPath : "pnpm";
  const argv = pnpm ? [pnpm, ...args] : args;
  const child = spawn(cmd, argv, {
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "development", FORCE_COLOR: "1" },
    shell: !pnpm,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `\x1b[${colour}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const l of lines) out.write(prefix + l + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    process.stdout.write(`${prefix}exited with ${code}\n`);
    shutdown(code ?? 0);
  });
  return child;
};

const children = [run("api", "36", ["--filter", "@sweatbox/server", "dev"]), run("web", "33", ["--filter", "@sweatbox/web", "dev"])];
let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill();
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
