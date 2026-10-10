// Convert old-layout sweatbox files ("0 SPAWN …" lines) to the current [sweatbox] layout, in place.
//   pnpm sbx:convert data/scenarios/*.sbx
// The originals are kept next to them as <name>.sbx.old.
import fs from "node:fs";
import path from "node:path";
import { parseScript } from "../packages/shared/src/script";
import { convertLegacyScript } from "../packages/shared/src/scriptLegacy";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: pnpm sbx:convert <file.sbx> [more.sbx …]");
  process.exit(2);
}
let failed = 0;
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  if (parseScript(text).ok) {
    console.log(`${file}: already in the current layout`);
    continue;
  }
  try {
    const { text: out, notes } = convertLegacyScript(text, path.basename(file, path.extname(file)));
    const check = parseScript(out);
    if (!check.ok) throw new Error(check.errors.join("\n"));
    fs.writeFileSync(`${file}.old`, text);
    fs.writeFileSync(file, out);
    console.log(`${file}: converted${notes.length ? ` (${notes.length} note${notes.length > 1 ? "s" : ""} in the file)` : ""}`);
  } catch (e) {
    failed++;
    console.error(`${file}: not converted\n${(e as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
