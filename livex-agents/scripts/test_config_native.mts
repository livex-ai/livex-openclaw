import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyMergePatch } from "../../src/config/merge-patch.js";
import { validateConfigObjectWithPlugins } from "../../src/config/validation.js";
import { loadPluginMetadataSnapshot } from "../../src/plugins/plugin-metadata-snapshot.js";

// Check the real config owners without resolving credentials or starting a Gateway.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = await mkdtemp(path.join(os.tmpdir(), "oncall-config-test-"));
const priorState = process.env.OPENCLAW_STATE_DIR;
process.env.OPENCLAW_STATE_DIR = state;
try {
  const patch = JSON.parse(
    execFileSync(
      "python3",
      [
        "-B",
        path.join(root, "scripts/config.py"),
        "render",
        "--local",
        path.join(root, "config/local.example.json"),
      ],
      { encoding: "utf8" },
    ),
  );
  const base = {
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "token", token: "synthetic-test-token" },
    },
    agents: { entries: { main: { workspace: path.join(state, "main") } } },
    channels: { slack: { botToken: "synthetic-bot-token", appToken: "synthetic-app-token" } },
    logging: { level: "warn" },
  };
  const merged = applyMergePatch(base, patch);
  const result = validateConfigObjectWithPlugins(merged, {
    env: process.env,
    loadPluginMetadataSnapshot: (config) =>
      loadPluginMetadataSnapshot({
        config,
        env: process.env,
        stateDir: state,
        allowCurrent: false,
        preferPersisted: false,
      }),
  });
  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }
  const config = result.config;
  assert.equal(config.channels?.slack?.botToken, base.channels.slack.botToken);
  assert.equal(config.channels?.slack?.appToken, base.channels.slack.appToken);
  assert.equal(config.gateway?.auth?.token, base.gateway.auth.token);
  assert.equal(config.logging?.level, base.logging.level);
  assert.equal(config.agents?.entries?.main?.workspace, base.agents.entries.main.workspace);
  assert.equal(config.agents?.entries?.oncall?.workspace, path.join(root, "workspaces", "oncall"));
  assert.equal(config.channels?.slack?.requireMention, true);
  assert.deepEqual(config.channels?.slack?.allowFrom, ["U000000001"]);
  assert.equal(config.bindings?.[0]?.agentId, "oncall");
  console.log("Native configuration schema, plugin manifests, and merge preservation passed.");
  if (process.argv.includes("--slack-cutover")) {
    const input = path.join(state, "config.json");
    const output = path.join(state, "cutover");
    await writeFile(input, JSON.stringify(merged), { mode: 0o600 });
    execFileSync(
      "python3",
      [
        "-B",
        path.join(root, "slack/prepare-cutover.py"),
        "--config",
        input,
        "--output-dir",
        output,
      ],
      { encoding: "utf8" },
    );
    let candidate = merged;
    for (const step of ["account-cutover", "rollback-account-cutover"]) {
      const accountPatch = JSON.parse(
        await readFile(path.join(output, `${step}.patch.json`), "utf8"),
      );
      candidate = applyMergePatch(candidate, accountPatch);
      const checked = validateConfigObjectWithPlugins(candidate, {
        env: process.env,
        loadPluginMetadataSnapshot: (candidateConfig) =>
          loadPluginMetadataSnapshot({
            config: candidateConfig,
            env: process.env,
            stateDir: state,
            allowCurrent: false,
            preferPersisted: false,
          }),
      });
      if (!checked.ok) {
        throw new Error(JSON.stringify(checked.issues));
      }
      const next = checked.config;
      assert.equal(next.channels?.slack?.botToken, base.channels.slack.botToken);
      assert.equal(next.channels?.slack?.appToken, base.channels.slack.appToken);
      assert.deepEqual(next.agents, config.agents);
      assert.deepEqual(next.plugins, config.plugins);
      const account = step === "account-cutover" ? "oncall" : "default";
      assert.equal(next.bindings?.[0]?.match.accountId, account);
      if (account === "oncall") {
        assert.equal(next.channels?.slack?.accounts?.default?.enabled, false);
        assert.deepEqual(next.channels?.slack?.accounts?.oncall?.allowFrom, ["U000000001"]);
        assert.equal(next.channels?.slack?.accounts?.oncall?.requireMention, true);
      } else {
        assert.equal(next.channels?.slack?.accounts?.oncall, undefined);
        assert.deepEqual(next.bindings, config.bindings);
      }
    }
    console.log("Native Slack cutover and rollback schema and preservation passed.");
  }
} finally {
  if (priorState === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = priorState;
  }
  await rm(state, { recursive: true, force: true });
}
