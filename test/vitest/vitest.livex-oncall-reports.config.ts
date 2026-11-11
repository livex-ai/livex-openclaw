import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
export default createScopedVitestConfig(
  ["livex-agents/plugins/livex-oncall-reports/**/*.test.ts"],
  {
    dir: "livex-agents/plugins/livex-oncall-reports",
    name: "livex-oncall-reports",
    includeOpenClawRuntimeSetup: false,
    setupFiles: ["test/setup.extensions.ts"],
  },
);
