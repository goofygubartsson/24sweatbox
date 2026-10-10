// Public subset of the config. In Node (server, tests) it is computed from the full config; in the
// browser build Vite replaces this module with a JSON copy made at build time (apps/web/vite.config.ts).
import raw from "../../../sweatbox.config";
import { validateConfig } from "./schema";
import { toPublicConfig, type PublicConfig } from "./publicSubset";

const publicConfig: PublicConfig = toPublicConfig(validateConfig(raw));
export default publicConfig;
export type { PublicConfig };
