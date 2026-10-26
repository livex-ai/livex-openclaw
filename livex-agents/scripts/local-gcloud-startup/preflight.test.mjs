import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const preflightUrl = pathToFileURL(path.join(directory, "preflight.mjs")).href;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(t, behavior = "ready") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gcloud startup "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const callsPath = path.join(root, "calls.jsonl");
  const marker = path.join(root, "signed-in");
  const gcloud = path.join(root, "gcloud");
  const stub = path.join(root, "gcloud-stub.mjs");
  await fs.writeFile(
    stub,
    `import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({args, config:process.env.CLOUDSDK_CONFIG, impersonation:process.env.CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT, credentialOverride:process.env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE})+'\\n');
const kind=args.slice(0,2).join(' '); const behavior=${JSON.stringify(behavior)};
if(kind==='auth print-access-token') {
  process.stdout.write('SECRET_ACCESS_TOKEN');
  if(behavior==='timeout') { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
  else if(behavior==='network') { process.stderr.write('Connection timeout SECRET_DIAGNOSTIC'); process.exit(1); }
  else if(behavior==='missing' && !fs.existsSync(${JSON.stringify(marker)})) { process.stderr.write('Your current active account [pilot@example.com] does not have any valid credentials'); process.exit(1); }
  else if(behavior==='expired' && !fs.existsSync(${JSON.stringify(marker)})) { process.stderr.write('invalid_grant: Token has been expired or revoked. SECRET_DIAGNOSTIC'); process.exit(1); }
} else if(kind==='auth login') { fs.writeFileSync(${JSON.stringify(marker)},'ready'); }
else if(kind==='logging read') { process.stdout.write('SECRET_LOG'); if(behavior==='denied') { process.stderr.write('Permission denied SECRET_DIAGNOSTIC'); process.exit(1); } }
else { process.exit(99); }
`,
  );
  await fs.writeFile(gcloud, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(stub)} "$@"\n`, {
    mode: 0o700,
  });
  const sdkConfig = path.join(root, "gcloud-config");
  await fs.mkdir(sdkConfig);
  const config = {
    plugins: {
      allow: ["livex-gcp-readonly"],
      entries: {
        "livex-gcp-readonly": {
          enabled: true,
          config: {
            gcloudPath: gcloud,
            cloudSdkConfig: sdkConfig,
            gcloudAccount: "pilot@example.com",
            project: "example-pilot",
          },
        },
      },
    },
  };
  const configPath = path.join(root, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify(config));
  const calls = async () =>
    (await fs.readFile(callsPath, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  const run = (options = {}) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { runPreflight } from ${JSON.stringify(preflightUrl)}; try { await runPreflight(${JSON.stringify({ configPath, ...options })}); } catch (error) { console.error(error.message); process.exitCode=1; }`,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
  return { root, callsPath, calls, config, configPath, sdkConfig, run };
}

test("ready credentials are checked without outputting tokens, then one bounded account-pinned read runs", async (t) => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET_/);
  const calls = await f.calls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 3), ["auth", "print-access-token", "pilot@example.com"]);
  assert.deepEqual(calls[1].args.slice(0, 2), ["logging", "read"]);
  assert.match(calls[1].args[2], /^insertId="openclaw-preflight-[0-9a-f-]+"$/);
  for (const flag of [
    "--account=pilot@example.com",
    "--project=example-pilot",
    "--limit=1",
    "--freshness=1m",
    "--format=value(insertId)",
  ])
    assert.ok(calls[1].args.includes(flag), flag);
  for (const call of calls) {
    assert.equal(call.config, f.sdkConfig);
    assert.equal(call.impersonation, "");
    assert.equal(call.credentialOverride, "");
  }
});

test("expired credentials get one interactive account-specific browser login without changing ADC or active account", async (t) => {
  const f = await fixture(t, "expired");
  const result = f.run({ interactive: true });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET_/);
  const calls = await f.calls();
  assert.deepEqual(
    calls.map((c) => c.args.slice(0, 2).join(" ")),
    ["auth print-access-token", "auth login", "auth print-access-token", "logging read"],
  );
  assert.deepEqual(calls[1].args.slice(0, 3), ["auth", "login", "pilot@example.com"]);
  assert.ok(calls[1].args.includes("--no-activate"));
  assert.ok(calls[1].args.includes("--force"));
  assert.ok(!calls[1].args.some((a) => /update-adc|no-browser|no-launch-browser/.test(a)));
});

test("check-only never logs in even when interactive and credentials expired", async (t) => {
  const f = await fixture(t, "expired");
  const result = f.run({ checkOnly: true, interactive: true });
  assert.equal(result.status, 1);
  assert.equal((await f.calls()).length, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET_/);
});

test("the installed SDK missing-credentials diagnostic triggers account-specific login", async (t) => {
  const f = await fixture(t, "missing");
  assert.equal(f.run({ interactive: true }).status, 0);
  const calls = await f.calls();
  assert.deepEqual(calls[1].args.slice(0, 3), ["auth", "login", "pilot@example.com"]);
});

test("noninteractive authentication failure stops without launching login", async (t) => {
  const f = await fixture(t, "expired");
  assert.equal(f.run({ interactive: false }).status, 1);
  assert.equal((await f.calls()).length, 1);
});

test("network failure stops without mistaking it for missing credentials", async (t) => {
  const f = await fixture(t, "network");
  assert.equal(f.run({ interactive: true }).status, 1);
  assert.equal((await f.calls()).length, 1);
});

test("Logging IAM failure stops after the read without a login loop or raw diagnostics", async (t) => {
  const f = await fixture(t, "denied");
  const result = f.run({ interactive: true });
  assert.equal(result.status, 1);
  assert.equal((await f.calls()).length, 2);
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET_/);
});

test("unresponsive credential checks are killed and do not trigger login", async (t) => {
  const f = await fixture(t, "timeout");
  const started = Date.now();
  assert.equal(f.run({ interactive: true, commandTimeoutMs: 500, killGraceMs: 50 }).status, 1);
  assert.ok(Date.now() - started < 3000);
  assert.equal((await f.calls()).length, 1);
});

test("disabled plugin or missing account fails before any gcloud call", async (t) => {
  const f = await fixture(t);
  f.config.plugins.entries["livex-gcp-readonly"].enabled = false;
  await fs.writeFile(f.configPath, JSON.stringify(f.config));
  assert.equal(f.run().status, 1);
  assert.deepEqual(await f.calls(), []);
  f.config.plugins.entries["livex-gcp-readonly"].enabled = true;
  delete f.config.plugins.entries["livex-gcp-readonly"].config.gcloudAccount;
  await fs.writeFile(f.configPath, JSON.stringify(f.config));
  assert.equal(f.run().status, 1);
  assert.deepEqual(await f.calls(), []);
});

async function shellFixture(t, behavior, listening = false) {
  const f = await fixture(t, behavior);
  await fs.mkdir(path.join(f.root, "state"));
  await fs.copyFile(f.configPath, path.join(f.root, "state/openclaw.json"));
  await fs.copyFile(path.join(directory, "preflight.mjs"), path.join(f.root, "preflight.mjs"));
  const listener = path.join(f.root, "lsof");
  await fs.writeFile(listener, `#!/bin/sh\nexit ${listening ? 0 : 1}\n`, { mode: 0o700 });
  await fs.copyFile(
    path.join(directory, "start-gateway.sh"),
    path.join(f.root, "start-gateway.sh"),
  );
  const launched = path.join(f.root, "gateway-args");
  await fs.writeFile(
    path.join(f.root, "openclaw-local.sh"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${quote(launched)}\n`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    PATH: `${f.root}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LIVEX_NODE: process.execPath,
    OPENCLAW_COMMAND: path.join(f.root, "openclaw-local.sh"),
    OPENCLAW_STATE_DIR: path.join(f.root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(f.root, "state/openclaw.json"),
  };
  return {
    ...f,
    launched,
    start: (args = [], overrides = {}) =>
      spawnSync("/bin/sh", [path.join(f.root, "start-gateway.sh"), ...args], {
        env: { ...env, ...overrides },
        encoding: "utf8",
        timeout: 10000,
      }),
  };
}

test("startup launches only the existing local gateway command after successful preflight", async (t) => {
  const f = await shellFixture(t, "ready");
  assert.equal(f.start().status, 0);
  assert.equal(
    await fs.readFile(f.launched, "utf8"),
    "gateway\nrun\n--bind\nloopback\n--port\n18791\n--auth\ntoken\n--tailscale\noff\n",
  );
});

test("startup --check verifies credentials but never launches the gateway", async (t) => {
  const f = await shellFixture(t, "ready", true);
  assert.equal(f.start(["--check"]).status, 0);
  assert.equal((await f.calls()).length, 2);
  await assert.rejects(fs.access(f.launched));
});

test("startup leaves an existing listener untouched and does not authenticate", async (t) => {
  const f = await shellFixture(t, "ready", true);
  assert.equal(f.start().status, 1);
  assert.deepEqual(await f.calls(), []);
  await assert.rejects(fs.access(f.launched));
});

test("startup does not launch after the Logging probe fails", async (t) => {
  const f = await shellFixture(t, "denied");
  assert.equal(f.start().status, 1);
  await assert.rejects(fs.access(f.launched));
});

test("startup rejects missing or relative local paths before authentication", async (t) => {
  const f = await shellFixture(t, "ready");
  for (const overrides of [
    { OPENCLAW_COMMAND: "" },
    { OPENCLAW_STATE_DIR: "relative" },
    { OPENCLAW_CONFIG_PATH: "relative" },
  ]) {
    assert.equal(f.start([], overrides).status, 1);
    assert.deepEqual(await f.calls(), []);
    await assert.rejects(fs.access(f.launched));
  }
});

test("startup uses the state directory config when no config override is supplied", async (t) => {
  const f = await shellFixture(t, "ready");
  assert.equal(f.start(["--check"], { OPENCLAW_CONFIG_PATH: "" }).status, 0);
  assert.equal((await f.calls()).length, 2);
  await assert.rejects(fs.access(f.launched));
});
