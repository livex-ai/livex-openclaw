import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
import { investigationCatalogSettingsSchema } from "./config-schema.js";

const PLUGIN_ID = "livex-investigations";
const TOOL_NAME = "slack_investigation_record";

// Plugin denials match owner IDs with anchored `*` globs; owner grants are exact.
// Keep that distinction when transferring this one tool out of the Slack owner.
function deniesLegacySlackOwner(pattern: string): boolean {
  const normalized = pattern.trim().toLowerCase();
  return new RegExp(`^${escapeRegExp(normalized).replaceAll("\\*", ".*")}$`).test("slack");
}

function migrateToolPolicy(policy: unknown, changes: string[], policyPath: string): void {
  const record = asOptionalRecord(policy);
  if (!record) {
    return;
  }
  for (const key of ["allow", "alsoAllow", "deny"] as const) {
    const names = record[key];
    if (
      Array.isArray(names) &&
      names.some(
        (name) =>
          typeof name === "string" &&
          (key === "deny" ? deniesLegacySlackOwner(name) : name.trim().toLowerCase() === "slack"),
      ) &&
      !names.some((name) => typeof name === "string" && name.trim().toLowerCase() === TOOL_NAME)
    ) {
      record[key] = [...names, TOOL_NAME];
      changes.push(`Preserved the Slack investigation tool policy in ${policyPath}.${key}.`);
    }
  }
}

function migrateTools(tools: unknown, changes: string[], policyPath: string): void {
  const record = asOptionalRecord(tools);
  if (!record) {
    return;
  }
  migrateToolPolicy(record, changes, policyPath);
  for (const key of ["byProvider", "toolsBySender"] as const) {
    for (const [name, policy] of Object.entries(asOptionalRecord(record[key]) ?? {})) {
      migrateToolPolicy(policy, changes, `${policyPath}.${key}.${name}`);
    }
  }
  for (const key of ["sandbox", "subagents"] as const) {
    migrateToolPolicy(asOptionalRecord(record[key])?.tools, changes, `${policyPath}.${key}.tools`);
  }
}

function migrateSlackPolicies(value: unknown, changes: string[], policyPath: string): void {
  const record = asOptionalRecord(value);
  if (!record) {
    return;
  }
  migrateToolPolicy(record.tools, changes, `${policyPath}.tools`);
  for (const [sender, policy] of Object.entries(asOptionalRecord(record.toolsBySender) ?? {})) {
    migrateToolPolicy(policy, changes, `${policyPath}.toolsBySender.${sender}`);
  }
  for (const key of ["accounts", "channels", "dms"] as const) {
    for (const [name, child] of Object.entries(asOptionalRecord(record[key]) ?? {})) {
      migrateSlackPolicies(child, changes, `${policyPath}.${key}.${name}`);
    }
  }
}

/** Doctor owns publication; this hook only transforms its private candidate. */
export function migrateInvestigationConfig(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} | null {
  const legacy = asOptionalRecord(config.plugins?.entries?.slack?.config);
  if (!legacy || !Object.hasOwn(legacy, "investigationCatalog")) {
    return null;
  }
  const parsed = investigationCatalogSettingsSchema.safeParse(legacy.investigationCatalog);
  if (!parsed.success) {
    throw new Error("Legacy Slack investigationCatalog is invalid; repair it before migration.");
  }
  const destination = config.plugins?.entries?.[PLUGIN_ID];
  const destinationConfig = asOptionalRecord(destination?.config);
  if (destinationConfig && Object.hasOwn(destinationConfig, "investigationCatalog")) {
    const current = investigationCatalogSettingsSchema.safeParse(
      destinationConfig.investigationCatalog,
    );
    if (!current.success || !isDeepStrictEqual(parsed.data, current.data)) {
      throw new Error(
        "Slack and livex-investigations catalog settings conflict; choose one explicitly before migration.",
      );
    }
  }
  if (parsed.data.enabled === true) {
    const denied = config.plugins?.deny?.some((id) => id.trim().toLowerCase() === PLUGIN_ID);
    const allow = config.plugins?.allow;
    if (denied || destination?.enabled === false) {
      throw new Error(
        "The enabled legacy catalog cannot move to a denied or disabled livex-investigations plugin; resolve the explicit policy first.",
      );
    }
    if (allow?.length && !allow.some((id) => id.trim().toLowerCase() === PLUGIN_ID)) {
      throw new Error(
        "Allow livex-investigations explicitly before migrating the enabled legacy catalog; prepare-upgrade.mts --allow-plugin creates a reviewable candidate.",
      );
    }
  }
  const next = structuredClone(config);
  const plugins = (next.plugins ??= {});
  const entries = (plugins.entries ??= {});
  const oldEntry = entries.slack!;
  const oldConfig = { ...oldEntry.config };
  delete oldConfig.investigationCatalog;
  oldEntry.config = oldConfig;
  const newEntry = (entries[PLUGIN_ID] ??= {});
  newEntry.config = {
    ...newEntry.config,
    investigationCatalog: structuredClone(
      destinationConfig?.investigationCatalog ?? legacy.investigationCatalog,
    ),
  };
  const changes = [
    "Moved plugins.entries.slack.config.investigationCatalog to plugins.entries.livex-investigations.config.investigationCatalog.",
  ];
  migrateTools(next.tools, changes, "tools");
  for (const [id, agent] of Object.entries(next.agents?.entries ?? {})) {
    migrateTools(agent.tools, changes, `agents.entries.${id}.tools`);
  }
  // Doctor can invoke plugin repairs before converting a legacy agent roster.
  const agents = asOptionalRecord(next.agents);
  if (Array.isArray(agents?.list)) {
    agents.list.forEach((agent, index) => {
      migrateTools(asOptionalRecord(agent)?.tools, changes, `agents.list.${index}.tools`);
    });
  }
  migrateSlackPolicies(next.channels?.slack, changes, "channels.slack");
  return { config: next, changes };
}
