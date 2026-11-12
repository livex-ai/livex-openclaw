import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const nativeDir = fileURLToPath(new URL("../", import.meta.url));
const applyPath = fileURLToPath(new URL("./apply.mjs", import.meta.url));
const json5From =
  process.env.LIVEX_JSON5_FROM ?? fileURLToPath(new URL("../../package.json", import.meta.url));
const json5 = createRequire(json5From)("json5");
const slackSpec = fs
  .readFileSync(path.join(nativeDir, "deploy", "versions.env"), "utf8")
  .match(/^SLACK_PLUGIN_SPEC=(.+)$/m)[1];

function slackRoute(agentId, peerId = "*") {
  return {
    agentId,
    match: { channel: "slack", accountId: "default", peer: { kind: "channel", id: peerId } },
  };
}

// Stock entry from PR #50 at 33ec93cf, plus its installed workspace path.
function priorOncall(workspace) {
  return {
    name: "LiveX Debugger",
    identity: { name: "LiveX Reporting · Debugger" },
    description:
      "Mention-triggered production investigations with reviewed local execution and evidence-backed next actions.",
    model: "openai/gpt-6-astra",
    skills: [
      "investigate-alerts",
      "debug",
      "systematic-debugging",
      "verification-before-completion",
    ],
    tools: {
      profile: "full",
      allow: ["read", "skills_read", "message", "livex_gcp_logs_read", "livex_repository_read"],
      message: { actions: { allow: ["read", "reactions"] } },
      exec: { mode: "ask" },
      elevated: { enabled: false },
      fs: { workspaceOnly: true },
    },
    workspace,
  };
}

function fixture(t, { includeOncall = false, stockSlack = false } = {}) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "livex-apply-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const configPath = path.join(state, "openclaw.json");
  const oncallWorkspace = path.join(state, "workspace-oncall");
  const cli = path.join(state, "fake-openclaw");
  const pinnedSlack = slackSpec.split("@").at(-1);
  const tarball = path.join(state, "slack.tgz");
  const installRecord = path.join(state, "slack-integrity");
  const releaseBytes = "fixture Slack release archive";
  const integrity = `sha512-${createHash("sha512").update(releaseBytes).digest("base64")}`;
  fs.writeFileSync(tarball, releaseBytes);
  fs.writeFileSync(installRecord, stockSlack ? "stock archive integrity" : integrity);
  fs.writeFileSync(
    cli,
    `#!/usr/bin/env node
    const fs = require("node:fs");
    const args = process.argv.slice(2).join(" ");
    const version = ${JSON.stringify(pinnedSlack)};
    const installRecord = ${JSON.stringify(installRecord)};
    if (args === "plugins list --json") {
      console.log(JSON.stringify({ plugins: [{ id: "codex" }, { id: "slack", version }] }));
    } else if (args === "plugins inspect slack --json") {
      console.log(JSON.stringify({
        plugin: { version },
        install: { integrity: fs.readFileSync(installRecord, "utf8") },
        capabilities: [{ kind: "channel", ids: ["slack"] }],
      }));
    } else if (args === ${JSON.stringify(`plugins install npm-pack:${tarball} --force --accept-capabilities`)}) {
      if (fs.readFileSync(installRecord, "utf8") === ${JSON.stringify(integrity)}) process.exit(76);
      fs.writeFileSync(installRecord, ${JSON.stringify(integrity)});
    } else {
      process.exit(75);
    }
  `,
    { mode: 0o700 },
  );

  let releaseDir = nativeDir;
  if (includeOncall) {
    releaseDir = path.join(state, "release");
    fs.mkdirSync(path.join(releaseDir, "config"), { recursive: true });
    fs.symlinkSync(path.join(nativeDir, "agents"), path.join(releaseDir, "agents"));
    const fragment = json5.parse(
      fs.readFileSync(path.join(nativeDir, "config", "openclaw.fragment.json5"), "utf8"),
    );
    fragment.agents.entries.oncall = { name: "LiveX OnCall" };
    fragment.bindings.push(slackRoute("oncall", "C0OPTIN"));
    fs.writeFileSync(
      path.join(releaseDir, "config", "openclaw.fragment.json5"),
      JSON.stringify(fragment),
    );
  }

  const env = {
    LIVEX_NATIVE_DIR: releaseDir,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    LIVEX_JSON5_FROM: json5From,
    LIVEX_RELEASE_SHA: "regression",
    LIVEX_OPENCLAW_CMD: "fake-openclaw",
    PATH: [state, path.dirname(process.execPath), process.env.PATH ?? ""].join(path.delimiter),
    SLACK_PLUGIN_SPEC: slackSpec,
    LIVEX_SLACK_TARBALL: tarball,
  };
  const run = () => spawnSync(process.execPath, [applyPath], { env, encoding: "utf8" });
  const read = () => fs.readFileSync(configPath, "utf8");
  const seed = (config) => fs.writeFileSync(configPath, JSON.stringify(config));
  const applyTwice = () => {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const config = read();
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(read(), config, "same-release retry should keep config identical");
    return JSON.parse(config);
  };
  return { state, configPath, oncallWorkspace, run, read, seed, applyTwice };
}

test("replaces same-version stock Slack with the release archive once", (t) => {
  const { run } = fixture(t, { stockSlack: true });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /plugin slack: installing .* from the release tarball/);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stdout, /plugin slack: installing/);
});

function markPriorWorkspace(workspace) {
  const skills = path.join(workspace, "skills");
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(
    path.join(skills, ".livex-shipped"),
    "debug\ninvestigate-alerts\nsystematic-debugging\nverification-before-completion\n",
  );
}

function priorConfig(entry, bindings = [slackRoute("oncall")]) {
  return {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "oncall" }, authInheritance: { agentId: "oncall" } },
      entries: { oncall: entry, debugger: { name: "LiveX Deep Debugger" } },
    },
    bindings,
  };
}

test("fresh install registers the Debugger route and enables its Slack summary", (t) => {
  const { applyTwice } = fixture(t);
  const config = applyTwice();
  assert.deepEqual(Object.keys(config.agents.entries), ["debugger"]);
  assert.equal(config.agents.entries.debugger.name, "LiveX Debugger");
  assert.equal(config.agents.defaults.systemAgent.agentId, "debugger");
  assert.deepEqual(config.bindings, [slackRoute("debugger")]);
  assert.ok(config.plugins.allow.includes("livex-slack-summary"));
  assert.equal(config.plugins.entries["livex-slack-summary"].enabled, true);
  assert.deepEqual(config.plugins.load.paths, [
    path.join(nativeDir, "plugins", "livex-gcp-readonly"),
    path.join(nativeDir, "plugins", "livex-slack-summary"),
  ]);
});

test("upgrade retires the stock wildcard while preserving OnCall references, operator routes, and state", (t) => {
  const { state, configPath, oncallWorkspace, read, seed, applyTwice } = fixture(t);
  const discord = { agentId: "debugger", match: { channel: "discord", accountId: "ops" } };
  const alternateSlack = slackRoute("debugger");
  alternateSlack.match.accountId = "sandbox";
  const operatorBindings = [
    slackRoute("debugger", "C0DEBUGGER"),
    slackRoute("other", "C0OTHER"),
    discord,
    alternateSlack,
  ];
  const config = priorConfig(priorOncall(oncallWorkspace), [
    slackRoute("oncall"),
    ...operatorBindings,
  ]);
  config.agents.entries.other = { name: "Operator Agent" };
  config.agents.defaults.heartbeat = { agentId: "oncall" };
  config.talk = { agentId: "oncall" };
  const operatorPlugin = path.join(state, "plugins", "operator-plugin");
  config.plugins = {
    load: {
      paths: [
        "/old/plugins/livex-gcp-readonly",
        operatorPlugin,
        "/old/plugins/livex-slack-summary",
      ],
    },
  };
  markPriorWorkspace(oncallWorkspace);
  const botToken = { source: "env", provider: "default", id: "CUSTOM_SLACK_BOT" };
  const appToken = { source: "env", provider: "default", id: "CUSTOM_SLACK_APP" };
  config.channels = {
    slack: { botToken, appToken, channels: { C0OTHER: { requireMention: false } } },
  };
  seed(config);
  const before = read();
  const retainedFiles = {
    "workspace-oncall/AGENTS.md": "fixture workspace",
    "workspace-oncall/memory/operator.md": "fixture memory",
    "agents/oncall/agent/auth-profiles.json": "fixture auth",
    "agents/oncall/sessions/sessions.json": "fixture sessions",
    "agents/debugger/agent/auth-profiles.json": "fixture debugger auth",
    "cron/jobs.json": JSON.stringify({ version: 1, jobs: [{ agentId: "oncall", enabled: false }] }),
  };
  for (const [file, contents] of Object.entries(retainedFiles)) {
    const target = path.join(state, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  const next = applyTwice();
  assert.equal(next.agents.defaults.systemAgent.agentId, "debugger");
  assert.deepEqual(next.agents.defaults.authInheritance, { agentId: "oncall" });
  assert.deepEqual(next.agents.defaults.heartbeat, { agentId: "oncall" });
  assert.deepEqual(next.talk, { agentId: "oncall" });
  assert.deepEqual(next.plugins.load.paths, [
    operatorPlugin,
    path.join(nativeDir, "plugins", "livex-gcp-readonly"),
    path.join(nativeDir, "plugins", "livex-slack-summary"),
  ]);
  assert.deepEqual(next.agents.entries.oncall, config.agents.entries.oncall);
  assert.deepEqual(next.agents.entries.other, config.agents.entries.other);
  assert.deepEqual(next.bindings, [...operatorBindings, slackRoute("debugger")]);
  assert.deepEqual(next.channels.slack.botToken, botToken);
  assert.deepEqual(next.channels.slack.appToken, appToken);
  assert.deepEqual(next.channels.slack.channels.C0OTHER, { requireMention: false });
  assert.deepEqual(next.channels.slack.allowFrom, ["${SLACK_SENDER_ID}"]);
  assert.deepEqual(next.channels.slack.channels["*"].users, ["${SLACK_SENDER_ID}"]);
  assert.equal(fs.readFileSync(`${configPath}.pre-regression`, "utf8"), before);
  for (const [file, contents] of Object.entries(retainedFiles)) {
    assert.equal(fs.readFileSync(path.join(state, file), "utf8"), contents);
  }
});

test("managed wildcard retirement keeps a customized OnCall entry and exact binding", (t) => {
  const { oncallWorkspace, seed, applyTwice } = fixture(t);
  const exact = slackRoute("oncall", "C0OPS");
  const entry = { ...priorOncall(oncallWorkspace), model: "openai/operator-model" };
  markPriorWorkspace(oncallWorkspace);
  seed(priorConfig(entry, [slackRoute("oncall"), exact]));
  const config = applyTwice();
  assert.deepEqual(config.agents.entries.oncall, entry);
  assert.deepEqual(config.bindings, [exact, slackRoute("debugger")]);
});

test("a normalized OnCall reference and nondefault account routes survive migration", (t) => {
  const { oncallWorkspace, seed, applyTwice } = fixture(t);
  const entry = priorOncall(oncallWorkspace);
  const exact = slackRoute(" OnCall ", "C0OPS");
  const otherAccount = slackRoute("oncall");
  markPriorWorkspace(oncallWorkspace);
  otherAccount.match.accountId = "sandbox";
  seed(priorConfig(entry, [slackRoute("oncall"), exact, otherAccount]));
  const config = applyTwice();
  assert.deepEqual(config.agents.entries.oncall, entry);
  assert.deepEqual(config.bindings, [exact, otherAccount, slackRoute("debugger")]);
});

test("ambiguous Slack wildcards stop apply before writing config", (t) => {
  const cases = [
    { binding: slackRoute("oncall") },
    { binding: slackRoute("oncall"), managedPath: true },
    { binding: { ...slackRoute("oncall"), type: "route" }, managedPath: true, marker: true },
    { binding: slackRoute("other") },
    {
      binding: {
        agentId: "oncall",
        match: { channel: "slack", accountId: "-default-", peer: { kind: "group", id: "*" } },
      },
    },
  ];
  for (const { binding, managedPath, marker } of cases) {
    const { configPath, oncallWorkspace, run, read, seed } = fixture(t);
    const entry = priorOncall(managedPath ? oncallWorkspace : "/operator/oncall");
    if (marker) {
      markPriorWorkspace(oncallWorkspace);
    }
    seed(priorConfig(entry, [binding]));
    const before = read();
    const result = run();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Slack wildcard.+shadow.+Debugger/);
    assert.equal(read(), before);
    assert.equal(fs.existsSync(`${configPath}.pre-regression`), false);
  }
});

test("an opt-in fragment owns OnCall and retains user exact-channel routing", (t) => {
  const { oncallWorkspace, seed, applyTwice } = fixture(t, { includeOncall: true });
  const exact = slackRoute("oncall", "C0OPS");
  const installed = priorConfig(priorOncall(oncallWorkspace), [exact, slackRoute("debugger")]);
  installed.agents.defaults.systemAgent.agentId = "debugger";
  seed(installed);
  const config = applyTwice();
  assert.equal(config.agents.entries.oncall.name, "LiveX OnCall");
  assert.equal(config.agents.entries.oncall.workspace, oncallWorkspace);
  assert.equal(config.agents.defaults.systemAgent.agentId, "debugger");
  assert.deepEqual(config.bindings, [
    exact,
    slackRoute("debugger"),
    slackRoute("oncall", "C0OPTIN"),
  ]);
});

test("the fragment clears every deployed secret from the Codex process environment", () => {
  const fragment = json5.parse(
    fs.readFileSync(path.join(nativeDir, "config", "openclaw.fragment.json5"), "utf8"),
  );
  const cleared = new Set(fragment.plugins.entries.codex.config.appServer.clearEnv);
  // Every secret-bearing variable the deploy hands to the Gateway container.
  const secretName = /\b[A-Z][A-Z0-9_]*_(?:TOKEN|SECRET|PASSWORD|API_KEY)\b/g;
  const named = new Set();
  for (const file of ["README.md", "apply.mjs", "compose.yaml", "remote.sh"]) {
    const text = fs.readFileSync(path.join(nativeDir, "deploy", file), "utf8");
    for (const name of text.match(secretName) ?? []) named.add(name);
  }
  assert.ok(named.has("SLACK_BOT_TOKEN") && named.has("OPENCLAW_GATEWAY_TOKEN"));
  // Slack credentials dev-bootstrap.sh refuses in runtime.env; cleared in case one is added.
  for (const name of ["SLACK_USER_TOKEN", "SLACK_SIGNING_SECRET"]) named.add(name);
  assert.deepEqual(
    [...named].filter((name) => !cleared.has(name)).sort(),
    [],
    "add these to plugins.entries.codex.config.appServer.clearEnv",
  );
});
