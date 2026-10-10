// Full (server-side) config. The web app must import "@sweatbox/config/public" instead; Vite aliases
// this entry point to an error module so the full config can never end up in the browser bundle.
import raw from "../../../sweatbox.config";
import { validateConfig } from "./schema";

export const config = validateConfig(raw);
export default config;

export { ConfigSchema, validateConfig } from "./schema";
export type { SweatboxConfig, SweatboxConfigInput } from "./schema";
export { toPublicConfig } from "./publicSubset";
export type { PublicConfig } from "./publicSubset";
