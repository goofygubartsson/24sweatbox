import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// relative imports so Vite bundles them into the config (the browser never sees the full config)
import rawConfig from "../../sweatbox.config";
import { validateConfig } from "../../packages/config/src/schema";
import { toPublicConfig } from "../../packages/config/src/publicSubset";

const full = validateConfig(rawConfig);
const publicConfig = toPublicConfig(full);

/**
 * "@sweatbox/config/public" becomes a JSON copy of the public subset, made at build time.
 * Importing the full "@sweatbox/config" from browser code fails the build.
 */
function sweatboxConfig(): Plugin {
  const PUBLIC = "\0sweatbox-public-config";
  return {
    name: "sweatbox-public-config",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "@sweatbox/config/public") return PUBLIC;
      if (source === "@sweatbox/config")
        this.error(`${importer ?? "a module"} imports the full server config; browser code must use "@sweatbox/config/public"`);
      return null;
    },
    load(id) {
      if (id === PUBLIC) return `export default ${JSON.stringify(publicConfig)};`;
      return null;
    },
  };
}

const api = `http://127.0.0.1:${process.env.PORT || full.app.port}`;

export default defineConfig({
  plugins: [sweatboxConfig(), react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      [full.app.apiBase]: { target: api, ws: true },
      [full.app.authCallbackPath]: { target: api },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
});
