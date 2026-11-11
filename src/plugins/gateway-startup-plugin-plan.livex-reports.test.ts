import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "./gateway-startup-plugin-plan.js";
import { createInstalledPluginIndexFixture } from "./gateway-startup.test-helpers.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { loadPluginManifest } from "./manifest.js";

const rootDir = fileURLToPath(
  new URL("../../livex-agents/plugins/livex-oncall-reports/", import.meta.url),
);
const loaded = loadPluginManifest(rootDir);
if (!loaded.ok) {
  throw new Error(loaded.error);
}
const manifest = loaded.manifest;
const manifestRegistry: PluginManifestRegistry = {
  plugins: [
    {
      origin: "global",
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      rootDir,
      source: `${rootDir}/index.ts`,
      manifestPath: `${rootDir}/openclaw.plugin.json`,
      ...manifest,
    },
  ],
  diagnostics: [],
};

describe("configured LiveX report profile startup", () => {
  it.each([
    { name: "enabled", enabled: true, denied: false, allowed: true, starts: true },
    { name: "disabled", enabled: false, denied: false, allowed: true, starts: false },
    { name: "denied", enabled: true, denied: true, allowed: true, starts: false },
    { name: "not allowlisted", enabled: true, denied: false, allowed: false, starts: false },
  ])("plans the actual report plugin when $name", ({ enabled, denied, allowed, starts }) => {
    const config: OpenClawConfig = {
      plugins: {
        allow: allowed ? [manifest.id] : ["other"],
        deny: denied ? [manifest.id] : [],
        load: { paths: [rootDir] },
        entries: {
          [manifest.id]: { enabled, config: { agentProfiles: { oncall: "compact-v1" } } },
        },
      },
    };
    const plan = resolveGatewayStartupPluginPlanFromRegistry({
      config,
      activationSourceConfig: config,
      env: {},
      index: createInstalledPluginIndexFixture(manifestRegistry),
      manifestRegistry,
    });
    expect(plan.pluginIds).toEqual(starts ? [manifest.id] : []);
  });
});
