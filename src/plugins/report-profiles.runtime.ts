import type { PluginRegistry } from "./registry-types.js";
import type { AgentReportProfile } from "./report-profile.types.js";
import { getPluginRegistryForContext } from "./runtime/gateway-request-scope.js";

/** Resolves only admitted registrations for the trusted route, without loading plugins. */
export function resolveReportProfileFromRegistry(
  registry: PluginRegistry,
  agentId: string,
  channel: string,
): AgentReportProfile | undefined {
  const active = registry.reportProfiles.filter((entry) => {
    const owner = registry.plugins.find((plugin) => plugin.id === entry.pluginId);
    return owner?.enabled && owner.status === "loaded";
  });
  const matches = active.filter(
    (entry) => entry.profile.agentIds.includes(agentId) && entry.profile.channels.includes(channel),
  );
  const selected = matches.length === 1 ? matches[0]?.profile : undefined;
  return selected && active.filter((entry) => entry.profile.id === selected.id).length === 1
    ? selected
    : undefined;
}

export function resolveAgentReportProfile(
  agentId: string,
  channel: string,
): AgentReportProfile | undefined {
  const registry = getPluginRegistryForContext();
  return registry ? resolveReportProfileFromRegistry(registry, agentId, channel) : undefined;
}
