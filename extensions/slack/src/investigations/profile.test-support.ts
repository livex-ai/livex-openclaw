import type { PluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createPluginRecord } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { PreparedCompactReport } from "../../../../livex-agents/plugins/livex-oncall-reports/compact-report.js";
import {
  createOncallReportProfile,
  projectCompactReport,
} from "../../../../livex-agents/plugins/livex-oncall-reports/profile.js";
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
