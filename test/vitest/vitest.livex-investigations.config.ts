import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export default createScopedVitestConfig(
  [
    "livex-agents/plugins/livex-investigations/**/*.test.ts",
    "livex-agents/plugins/livex-oncall-reports/**/*.test.ts",
  ],
  {
    name: "livex-investigations",
    includeOpenClawRuntimeSetup: false,
    // Preserve the original Slack suite process boundary for managed runtime/SQLite owners.
    pool: "forks",
    setupFiles: ["test/setup.extensions.ts"],
  },
);
