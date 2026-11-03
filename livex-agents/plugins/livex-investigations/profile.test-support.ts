import {
  createPluginRecord,
  type createEmptyPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { PreparedCompactReport } from "../livex-oncall-reports/test-api.js";
import {
  createOncallReportProfile,
  projectCompactReport,
} from "../livex-oncall-reports/test-api.js";
type PluginRegistry = ReturnType<typeof createEmptyPluginRegistry>;

export const oncallReportProfile = createOncallReportProfile(["oncall"]);
export function withOncallReportProfile(registry: PluginRegistry): PluginRegistry {
  const record = createPluginRecord({ id: "fixture-oncall-reports" });
  registry.plugins.push(record);
  registry.reportProfiles.push({ pluginId: record.id, profile: oncallReportProfile });
  return registry;
}
export function preparedFixture(prepared: PreparedCompactReport) {
  return { ...prepared, ...projectCompactReport(prepared) };
}
