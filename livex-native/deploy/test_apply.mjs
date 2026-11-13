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
    // The shipped manifest pins real repositories; keep unrelated tests independent of it.
    LIVEX_REPOS_MANIFEST: path.join(state, "no-repos-manifest.json"),
    LIVEX_OPENCLAW_CMD: "fake-openclaw",
    PATH: [state, path.dirname(process.execPath), process.env.PATH ?? ""].join(path.delimiter),
    SLACK_PLUGIN_SPEC: slackSpec,
    LIVEX_SLACK_TARBALL: tarball,
  };
  const run = (extra = {}) =>
    spawnSync(process.execPath, [applyPath], { env: { ...env, ...extra }, encoding: "utf8" });
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
  assert.ok(config.plugins.allow.includes("livex-investigations-lite"));
  const lite = config.plugins.entries["livex-investigations-lite"];
  assert.equal(lite.enabled, true);
  assert.equal(lite.hooks.allowConversationAccess, true);
  assert.equal(lite.hooks.allowPromptInjection, true);
  assert.deepEqual(config.plugins.load.paths, [
    path.join(nativeDir, "plugins", "livex-gcp-readonly"),
    path.join(nativeDir, "plugins", "livex-slack-summary"),
    path.join(nativeDir, "plugins", "livex-investigations-lite"),
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
    path.join(nativeDir, "plugins", "livex-investigations-lite"),
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

test("live guard refuses to drop a serving LiveX agent the release no longer ships", (t) => {
  const { configPath, oncallWorkspace, run, read, seed } = fixture(t);
  seed(priorConfig(priorOncall(oncallWorkspace), []));
  const before = read();
  const live = { LIVEX_LIVE_GUARD: "1" };
  for (const extra of [live, { ...live, LIVEX_CHECK_AGENTS_ONLY: "1" }]) {
    const result = run(extra);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /oncall.+does not ship/);
    assert.equal(read(), before);
    assert.equal(fs.existsSync(`${configPath}.pre-regression`), false);
  }
  // A custom id is protected when its workspace holds a shipped-skills manifest.
  const custom = fixture(t);
  fs.mkdirSync(path.join(custom.state, "workspace-extra", "skills"), { recursive: true });
  fs.writeFileSync(path.join(custom.state, "workspace-extra", "skills", ".livex-shipped"), "x\n");
  custom.seed({ agents: { entries: { extra: { workspace: path.join(custom.state, "workspace-extra") } } } });
  assert.equal(custom.run(live).status, 1);
  // Without the guard (staging, test VM) the same state is accepted as before.
  assert.equal(custom.run().status, 0);
  // A fresh state has nothing to drop, so the live check passes.
  assert.equal(fixture(t).run(live).status, 0);
  // A release that ships oncall passes the check against a state that serves it.
  const optIn = fixture(t, { includeOncall: true });
  optIn.seed(priorConfig(priorOncall(optIn.oncallWorkspace), []));
  const checked = optIn.run({ ...live, LIVEX_CHECK_AGENTS_ONLY: "1" });
  assert.equal(checked.status, 0, checked.stderr);
});

// Mirrors the live DEV config: oncall (stock entry, installed workspace with a shipped-skills
// manifest) and debugger, whose only binding is the default-account Slack wildcard.
function liveLike(t, oncallBindings = []) {
  const f = fixture(t);
  const oncall = priorOncall(f.oncallWorkspace);
  const skills = path.join(f.oncallWorkspace, "skills");
  fs.mkdirSync(path.join(skills, "debug"), { recursive: true });
  fs.writeFileSync(path.join(skills, "debug", "SKILL.md"), "operator edited\n");
  fs.writeFileSync(path.join(skills, ".livex-shipped"), "debug\ninvestigate-alerts\n");
  fs.writeFileSync(path.join(f.oncallWorkspace, "AGENTS.md"), "oncall agents file\n");
  f.seed({
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "debugger" } },
      entries: { oncall, debugger: { name: "LiveX Debugger" } },
    },
    bindings: [slackRoute("debugger"), ...oncallBindings],
  });
  const workspace = () => {
    const out = {};
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else out[path.relative(f.oncallWorkspace, full)] = fs.readFileSync(full, "utf8");
      }
    };
    walk(f.oncallWorkspace);
    return out;
  };
  return { ...f, workspace };
}

test("LIVEX_UNMANAGED_AGENTS=oncall leaves the oncall entry, workspace and routes untouched", (t) => {
  const { run, read, workspace } = liveLike(t, [slackRoute("oncall", "C0OPTIN")]);
  const before = JSON.parse(read());
  const filesBefore = workspace();
  const result = run({ LIVEX_LIVE_GUARD: "1", LIVEX_UNMANAGED_AGENTS: "oncall" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /live guard: leaving unmanaged agent\(s\) untouched: oncall/);
  const after = JSON.parse(read());
  assert.deepEqual(after.agents.entries.oncall, before.agents.entries.oncall);
  assert.deepEqual(workspace(), filesBefore, "no copy, prune or manifest write in the oncall workspace");
  assert.deepEqual(
    after.bindings.filter((b) => b.agentId === "oncall"),
    before.bindings.filter((b) => b.agentId === "oncall"),
  );
  assert.equal(after.agents.defaults.systemAgent.agentId, "debugger");
  assert.equal(after.agents.ownership, "explicit");
  assert.ok(after.bindings.some((b) => b.agentId === "debugger"), "debugger route kept");
});

test("an unmanaged oncall wildcard is not retired; the ambiguity stops apply instead", (t) => {
  const { run, read } = liveLike(t, [slackRoute("oncall")]);
  const before = read();
  const guard = { LIVEX_LIVE_GUARD: "1", LIVEX_UNMANAGED_AGENTS: "oncall" };
  const result = run(guard);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Slack wildcard.+shadow.+Debugger/);
  assert.equal(read(), before);
});

function treeDigest(dir) {
  const hash = createHash("sha256");
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      hash.update(`${path.relative(dir, full)}|${e.isDirectory() ? "d" : "f"}|`);
      if (e.isDirectory()) walk(full);
      else hash.update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest("hex");
}

test("check-only runs the config preparation and stops on an unmanaged oncall wildcard, writing nothing", (t) => {
  const { state, run } = liveLike(t, [slackRoute("oncall")]);
  const digest = treeDigest(state);
  const result = run({ LIVEX_LIVE_GUARD: "1", LIVEX_CHECK_AGENTS_ONLY: "1", LIVEX_UNMANAGED_AGENTS: "oncall" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Slack wildcard.+shadow.+Debugger/);
  assert.equal(treeDigest(state), digest, "zero writes under the state dir");
});

test("check-only prints a secret-safe preview and writes nothing; a standalone copy of two files works", (t) => {
  const { state, configPath, run, seed, read } = liveLike(t, [slackRoute("oncall", "C0OPTIN")]);
  const config = JSON.parse(read());
  config.channels = { slack: { enabled: true, botToken: "xoxb-LITERALSECRET", appToken: "xapp-LITERALSECRET" } };
  config.gateway = { auth: { mode: "token", token: "LITERALGATEWAYSECRET" } };
  seed(config);
  const digest = treeDigest(state);
  const extra = {
    LIVEX_LIVE_GUARD: "1",
    LIVEX_CHECK_AGENTS_ONLY: "1",
    LIVEX_UNMANAGED_AGENTS: "oncall",
    SLACK_BOT_TOKEN: "xoxb-ENVSECRET",
    SLACK_APP_TOKEN: "xapp-ENVSECRET",
  };
  const result = run(extra);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(treeDigest(state), digest, "zero writes under the state dir");
  const out = result.stdout;
  assert.doesNotMatch(out + result.stderr, /LITERAL|ENVSECRET|xoxb|xapp/);
  assert.match(out, /^preview: apply would change \d+ path\(s\)/m);
  assert.match(out, /^ {2}~ channels\.slack\.botToken: <changed> -> <changed>$/m);
  assert.match(out, /^ {2}~ gateway\.auth\.token: <changed> -> <changed>$/m);
  assert.match(out, /^ {2}\+ agents\.entries\.debugger\.model = "/m);
  assert.match(out, /^ {2}\+ plugins\.entries\.livex-gcp-readonly\./m);
  assert.match(out, /^ {2}~ agents\.entries\.debugger\.workspace|^ {2}\+ agents\.entries\.debugger\.workspace/m);
  assert.match(out, /^preview: shared settings oncall rely on .*: \d+ changed$/m);
  assert.match(out, /^ {2}channels\.slack\.botToken$/m);
  assert.doesNotMatch(out, /agents\.entries\.oncall/, "the unmanaged agent's entry is not in the preview");
  assert.match(out, /^preview: end \(read-only/m);
  // Deterministic.
  assert.equal(run(extra).stdout, out);
  // Standalone: only apply.mjs and the fragment, as the live container check uses them.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "livex-preview-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "deploy"));
  fs.mkdirSync(path.join(dir, "config"));
  fs.copyFileSync(applyPath, path.join(dir, "deploy", "apply.mjs"));
  fs.copyFileSync(
    path.join(nativeDir, "config", "openclaw.fragment.json5"),
    path.join(dir, "config", "openclaw.fragment.json5"),
  );
  const alone = spawnSync(process.execPath, [path.join(dir, "deploy", "apply.mjs")], {
    env: {
      LIVEX_NATIVE_DIR: dir,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      LIVEX_JSON5_FROM: json5From,
      ...extra,
    },
    encoding: "utf8",
  });
  assert.equal(alone.status, 0, alone.stderr);
  assert.match(alone.stdout, /^preview: apply would change/m);
  assert.equal(treeDigest(state), digest);
});

test("LIVEX_UNMANAGED_AGENTS is refused without the live guard", (t) => {
  const { run } = liveLike(t);
  const result = run({ LIVEX_UNMANAGED_AGENTS: "oncall" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only valid with LIVEX_LIVE_GUARD=1/);
});

test("the unmanaged list never excuses another dropped LiveX agent", (t) => {
  const { state, run, read, seed } = liveLike(t);
  const config = JSON.parse(read());
  const workspace = path.join(state, "workspace-extra");
  fs.mkdirSync(path.join(workspace, "skills"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "skills", ".livex-shipped"), "x\n");
  config.agents.entries.extra = { workspace };
  seed(config);
  const before = read();
  const result = run({ LIVEX_LIVE_GUARD: "1", LIVEX_UNMANAGED_AGENTS: "oncall" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /extra.+does not ship/);
  assert.doesNotMatch(result.stderr, /agent\(s\) oncall/);
  assert.equal(read(), before);
});

test("a listed agent that the release ships is a configuration error", (t) => {
  const { run, read } = liveLike(t);
  const before = read();
  const result = run({ LIVEX_LIVE_GUARD: "1", LIVEX_UNMANAGED_AGENTS: "oncall,debugger" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /lists debugger, but this release ships and manages it/);
  assert.equal(read(), before);
});

test("a malformed LIVEX_UNMANAGED_AGENTS is rejected", (t) => {
  const { run, read } = liveLike(t);
  const before = read();
  for (const bad of ["Oncall", "oncall,", ",oncall", "on call", "a,b,c,d,e,f", "1abc", "on_call"]) {
    const result = run({ LIVEX_LIVE_GUARD: "1", LIVEX_UNMANAGED_AGENTS: bad });
    assert.equal(result.status, 1, bad);
    assert.match(result.stderr, /LIVEX_UNMANAGED_AGENTS must be/, bad);
    assert.equal(read(), before);
  }
});

const ORIGINS = (...ports) => ports.flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]);

test("Control UI origins cover the container and host ports and keep operator entries", (t) => {
  // Live-like: both pairs already there, plus an operator origin. Nothing changes.
  const live = liveLike(t);
  const seeded = JSON.parse(live.read());
  const operator = "https://ops.example.test";
  seeded.gateway = { controlUi: { allowedOrigins: [...ORIGINS(18789, 18790), operator] } };
  live.seed(seeded);
  const kept = live.run({ LIVEX_LIVE_GUARD: "1", LIVEX_UNMANAGED_AGENTS: "oncall", LIVEX_HOST_PORT: "18790" });
  assert.equal(kept.status, 0, kept.stderr);
  assert.deepEqual(JSON.parse(live.read()).gateway.controlUi.allowedOrigins, [...ORIGINS(18789, 18790), operator]);
  // The preview shows no change for the origins.
  const preview = live.run({ LIVEX_LIVE_GUARD: "1", LIVEX_CHECK_AGENTS_ONLY: "1", LIVEX_UNMANAGED_AGENTS: "oncall", LIVEX_HOST_PORT: "18790" });
  assert.doesNotMatch(preview.stdout, /allowedOrigins/);
  // Old install (container-port pair only) gains the host-port pair after the existing ones.
  const old = liveLike(t);
  const cfg = JSON.parse(old.read());
  cfg.gateway = { controlUi: { allowedOrigins: [operator, ...ORIGINS(18789)] } };
  old.seed(cfg);
  assert.equal(old.run({ LIVEX_HOST_PORT: "18790" }).status, 0);
  assert.deepEqual(JSON.parse(old.read()).gateway.controlUi.allowedOrigins, [operator, ...ORIGINS(18789, 18790)]);
  // Fresh state: both pairs. Stage/test (host port 18789 or unset): the container pair only.
  const fresh = fixture(t);
  assert.equal(fresh.run({ LIVEX_HOST_PORT: "18790" }).status, 0);
  assert.deepEqual(JSON.parse(fresh.read()).gateway.controlUi.allowedOrigins, ORIGINS(18789, 18790));
  for (const extra of [{ LIVEX_HOST_PORT: "18789" }, {}]) {
    const stage = fixture(t);
    assert.equal(stage.run(extra).status, 0);
    assert.deepEqual(JSON.parse(stage.read()).gateway.controlUi.allowedOrigins, ORIGINS(18789));
  }
});

test("a malformed LIVEX_HOST_PORT is rejected", (t) => {
  const { run, read } = fixture(t);
  for (const bad of ["0", "65536", "abc", "18790x", "-1", "018790"]) {
    const result = run({ LIVEX_HOST_PORT: bad });
    assert.equal(result.status, 1, bad);
    assert.match(result.stderr, /LIVEX_HOST_PORT must be a port number/);
  }
});

test("LIVEX_PLUGIN_ROOT sets the plugin load paths for a standalone preview", (t) => {
  const { run, read, seed } = liveLike(t);
  const config = JSON.parse(read());
  config.plugins = { load: { paths: ["/opt/livex-native/plugins/livex-gcp-readonly", "/opt/livex-native/plugins/livex-slack-summary", "/opt/livex-native/plugins/livex-investigations-lite"] } };
  seed(config);
  const preview = run({
    LIVEX_LIVE_GUARD: "1",
    LIVEX_CHECK_AGENTS_ONLY: "1",
    LIVEX_UNMANAGED_AGENTS: "oncall",
    LIVEX_PLUGIN_ROOT: "/opt/livex-native",
  });
  assert.equal(preview.status, 0, preview.stderr);
  assert.doesNotMatch(preview.stdout, /plugins\.load\.paths/);
});

test("preview masks credentials by value and never prints object contents", (t) => {
  const { seed, run } = fixture(t);
  seed({
    gateway: { port: { hidden: "LEAKME4" }, controlUi: { allowedOrigins: "http://127.0.0.1:18789" } },
    hooks: { notify: "https://hooks.slack.com/services/T0/B0/LEAKME1" },
    upstream: { url: "https://user:LEAKME2@example.test/x" },
    headers: { Authorization: "Bearer LEAKME3" },
    // A type change (object -> number) must not print the object's contents.
  });
  const result = run({ LIVEX_LIVE_GUARD: "1", LIVEX_CHECK_AGENTS_ONLY: "1" });
  assert.equal(result.status, 0, result.stderr);
  for (const leak of ["LEAKME1", "LEAKME2", "LEAKME3", "LEAKME4"]) {
    assert.ok(!result.stdout.includes(leak) && !result.stderr.includes(leak), `preview leaked ${leak}`);
  }
});

const GCP_PLUGIN_ID = "livex-gcp-readonly";
const repositoriesOf = (config) => config.plugins.entries[GCP_PLUGIN_ID].config.repositories;
const pin = (n) => String(n).repeat(40);

function writeManifest(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "manifest.json");
  const body = rows.map(([id, commit]) => `  {"id": "${id}", "branch": "main", "commit": "${commit}"}`).join(",\n");
  fs.writeFileSync(file, `[\n${body}\n]\n`);
  return file;
}

test("pinned manifest entries replace the VM's stale repositories list, unpinned ones are skipped", (t) => {
  const { state, run, read, seed } = fixture(t);
  const manifest = writeManifest(state, [["alpha", pin(1)], ["beta", ""], ["gamma_2", pin(2)]]);
  seed({
    plugins: { entries: { [GCP_PLUGIN_ID]: { config: { repositories: [{ id: "stale", path: "/repos/stale", commit: pin(9) }] } } } },
  });
  const first = run({ LIVEX_REPOS_MANIFEST: manifest });
  assert.equal(first.status, 0, first.stderr);
  const config = JSON.parse(read());
  assert.deepEqual(repositoriesOf(config), [
    { id: "alpha", path: "/repos/alpha", commit: pin(1) },
    { id: "gamma_2", path: "/repos/gamma_2", commit: pin(2) },
  ]);
  const second = run({ LIVEX_REPOS_MANIFEST: manifest });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(repositoriesOf(JSON.parse(read())), repositoriesOf(config));
});

test("a manifest without pins keeps the VM's repositories list", (t) => {
  const { state, run, read, seed } = fixture(t);
  const manifest = writeManifest(state, [["alpha", ""], ["beta", ""]]);
  const mine = [{ id: "hand", path: "/repos/hand", commit: pin(7) }];
  seed({ plugins: { entries: { [GCP_PLUGIN_ID]: { config: { repositories: mine } } } } });
  const result = run({ LIVEX_REPOS_MANIFEST: manifest });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(repositoriesOf(JSON.parse(read())), mine);
  // No manifest at all behaves the same.
  const none = run({ LIVEX_REPOS_MANIFEST: path.join(state, "absent.json") });
  assert.equal(none.status, 0, none.stderr);
  assert.deepEqual(repositoriesOf(JSON.parse(read())), mine);
});

test("the manifest shipped in the release dir is the default source", (t) => {
  const { state, run, read } = fixture(t);
  const release = path.join(state, "release-dir");
  fs.mkdirSync(path.join(release, "config"), { recursive: true });
  fs.symlinkSync(path.join(nativeDir, "agents"), path.join(release, "agents"));
  fs.copyFileSync(
    path.join(nativeDir, "config", "openclaw.fragment.json5"),
    path.join(release, "config", "openclaw.fragment.json5"),
  );
  writeManifest(path.join(release, "repos"), [["alpha", pin(3)]]);
  const result = run({ LIVEX_NATIVE_DIR: release, LIVEX_PLUGIN_ROOT: nativeDir, LIVEX_REPOS_MANIFEST: undefined });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(repositoriesOf(JSON.parse(read())), [{ id: "alpha", path: "/repos/alpha", commit: pin(3) }]);
});

test("the change preview shows the managed repositories list and writes nothing", (t) => {
  const { state, run, read, seed, configPath } = fixture(t);
  const manifest = writeManifest(state, [["alpha", pin(1)], ["beta", pin(2)]]);
  seed({ plugins: { entries: { [GCP_PLUGIN_ID]: { config: { repositories: [{ id: "old", path: "/repos/old", commit: pin(9) }] } } } } });
  const before = read();
  const result = run({ LIVEX_LIVE_GUARD: "1", LIVEX_CHECK_AGENTS_ONLY: "1", LIVEX_REPOS_MANIFEST: manifest });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /preview: repositories: 2 pinned from the manifest \(replaces the 1 the live config lists\)/);
  assert.match(result.stdout, /^  alpha @ 111111111111$/m);
  assert.match(result.stdout, /~ plugins\.entries\.livex-gcp-readonly\.config\.repositories: \[1 items #[0-9a-f]{8}\] -> \[2 items #[0-9a-f]{8}\]/);
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
});

test("a malformed manifest stops apply before anything is written", (t) => {
  const { state, run, read, seed } = fixture(t);
  seed({ agents: {} });
  const before = read();
  for (const rows of [[["alpha", "abc"]], [["alpha", pin(1)], ["alpha", pin(2)]], [["bad id", pin(1)]]]) {
    const manifest = writeManifest(state, rows);
    const check = run({ LIVEX_LIVE_GUARD: "1", LIVEX_CHECK_AGENTS_ONLY: "1", LIVEX_REPOS_MANIFEST: manifest });
    assert.notEqual(check.status, 0, "pre-stop check refuses");
    const apply = run({ LIVEX_REPOS_MANIFEST: manifest });
    assert.notEqual(apply.status, 0);
    assert.match(apply.stderr, /manifest\.json/);
    assert.equal(read(), before);
  }
});
