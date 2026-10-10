import { defineConfig } from "tsup";

// Bundle the server, the workspace packages, the central config and the generated data JSON into
// dist/index.js. Real npm dependencies stay external (better-sqlite3 is native).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  noExternal: [/^@sweatbox\//],
});
