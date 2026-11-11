import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { prepareInvestigationUpgrade } from "./upgrade.js";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    output: { type: "string" },
    "allow-plugin": { type: "boolean", default: false },
  },
});
if (!values.source || !values.output) {
  throw new Error(
    "Usage: prepare-upgrade.mts --source <reviewed-snapshot.json> --output <new-candidate.json> [--allow-plugin]",
  );
}
const source: OpenClawConfig = JSON.parse(await readFile(values.source, "utf8"));
const pluginPath = path.dirname(fileURLToPath(import.meta.url));
const prepared = prepareInvestigationUpgrade(source, pluginPath, {
  allowPlugin: values["allow-plugin"],
});
await writeFile(values.output, JSON.stringify(prepared.config, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
console.log(
  "Wrote a discovery candidate only. Review it, then run the candidate OpenClaw Doctor on an isolated copy before any separately authorized deployment.",
);
for (const change of prepared.changes) {
  console.log(change);
}
