import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { migrateInvestigationConfig } from "./config-migration.js";

const PLUGIN_ID = "livex-investigations";

/** Prepare discovery from an explicit snapshot; Doctor remains the migration writer. */
export function prepareInvestigationUpgrade(
  source: OpenClawConfig,
  pluginPath: string,
  options: { allowPlugin?: boolean } = {},
): { config: OpenClawConfig; changes: string[] } {
  if (!asOptionalRecord(source) || !path.isAbsolute(pluginPath)) {
    throw new Error("Supply an object snapshot and an absolute investigation plugin directory.");
  }
  const config = structuredClone(source);
  const plugins = (config.plugins ??= {});
  const load = (plugins.load ??= {});
  const paths = load.paths ?? [];
  const resolvedPath = path.resolve(pluginPath);
  const changes: string[] = [];
  if (!paths.some((entry) => path.resolve(entry) === resolvedPath)) {
    load.paths = [...paths, resolvedPath];
    changes.push("Added the investigation plugin directory to the discovery candidate.");
  }
  if (options.allowPlugin) {
    const legacy = asOptionalRecord(plugins.entries?.slack?.config)?.investigationCatalog;
    if (asOptionalRecord(legacy)?.enabled !== true) {
      throw new Error(
        "--allow-plugin is only for preserving an explicitly enabled legacy catalog.",
      );
    }
    const allow = plugins.allow;
    if (allow?.length && !allow.some((id) => id.trim().toLowerCase() === PLUGIN_ID)) {
      plugins.allow = [...allow, PLUGIN_ID];
      changes.push(
        "Added the new catalog owner to the existing allowlist; review this permission change.",
      );
    }
  }
  // Refuse conflicts and blocked activation before writing even a candidate. The
  // result is intentionally unused: only Doctor publishes canonical settings.
  migrateInvestigationConfig(config);
  return { config, changes };
}
