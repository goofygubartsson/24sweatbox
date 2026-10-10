// Server scenario library: data/scenarios/*.sbx. A name is only ever read after it matches
// ^[A-Za-z0-9-]+$ AND appears in the directory listing (the legacy server had a path traversal here).
import fs from "node:fs";
import path from "node:path";
import { config } from "@sweatbox/config";
import type { ScenarioInfo } from "@sweatbox/shared";

const NAME_RE = new RegExp(config.data.scenarioNameRegex);
const META_RE = new RegExp(config.data.scenarioMetaRegex);

export class ScenarioLibrary {
  constructor(private dir: string) {}

  private names(): string[] {
    try {
      return fs
        .readdirSync(this.dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".sbx"))
        .map((e) => e.name.slice(0, -4))
        .filter((n) => NAME_RE.test(n))
        .sort();
    } catch {
      return [];
    }
  }

  list(): ScenarioInfo[] {
    return this.names().map((name) => {
      const m = META_RE.exec(name);
      return m ? { name, pos: m[1]!, apt: m[2]!, rwy: m[3] ?? null } : { name, pos: null, apt: null, rwy: null };
    });
  }

  /** Script text, or null for an invalid / unknown name. */
  read(name: string): string | null {
    if (!NAME_RE.test(name)) return null;
    const entry = this.names().find((n) => n === name);
    if (!entry) return null;
    const file = path.join(this.dir, `${entry}.sbx`);
    // belt and braces: the resolved file must still be inside the scenario directory
    if (path.dirname(path.resolve(file)) !== path.resolve(this.dir)) return null;
    return fs.readFileSync(file, "utf8");
  }
}
