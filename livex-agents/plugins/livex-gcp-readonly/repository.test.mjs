import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";
import { promisify } from "node:util";
import { createRepositoryTool } from "./repository.mjs";

const exec = promisify(execFile);
let root, repo, commit, config, marker;
const context = (guard = () => {}) => ({
  messageChannel: "slack",
  nativeChannelId: "C123",
  requesterSenderId: "U123",
  assertInvocationCurrent: guard,
});
async function run(argv, options) {
  try {
    const result = await exec(argv[0], argv.slice(1), {
      env: options.baseEnv,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes.stdout,
      signal: options.signal,
    });
    return { ...result, code: 0, termination: "exit", killed: false };
  } catch (error) {
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { outputLimitExceeded: true };
    if (typeof error.code === "number")
      return {
        stdout: error.stdout,
        stderr: error.stderr,
        code: error.code,
        termination: "exit",
        killed: false,
      };
    throw error;
  }
}
const git = (...args) =>
  execFileSync("/usr/bin/git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

before(async () => {
  root = await mkdtemp(join(tmpdir(), "repository-evidence-"));
  repo = join(root, "service");
  marker = join(root, "executed");
  await mkdir(join(repo, "src"), { recursive: true });
  repo = await realpath(repo);
  await mkdir(join(repo, "config"));
  await mkdir(join(repo, "logs"));
  await writeFile(
    join(repo, "src", "worker.py"),
    'def investigate():\n    return "signal timeout"\n# password="SYNTHETIC_SECRET"\n',
  );
  await writeFile(join(repo, "src", "config.py"), "RETRY_COUNT = 3\n");
  await writeFile(
    join(repo, "src", "key_fixture.py"),
    'KEY = """-----BEGIN PRIVATE KEY-----\nSYNTHETIC_KEY_BODY\n-----END PRIVATE KEY-----"""\n',
  );
  await writeFile(join(repo, "src", "binary.py"), Buffer.from([0, 1, 2]));
  await writeFile(join(repo, "src", "large.py"), "x".repeat(70 * 1024));
  await writeFile(join(repo, ".env"), "password=ENV_SECRET\n");
  await writeFile(join(repo, "config", "local.json"), '{"token":"CONFIG_SECRET"}\n');
  await writeFile(join(repo, "logs", "debug.log"), "customer signal timeout\n");
  await symlink("/etc/passwd", join(repo, "src", "escape.py"));
  git("init", "-q");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "fixture",
  );
  commit = git("rev-parse", "HEAD");
  await writeFile(join(repo, "src", "worker.py"), "DIRTY_WORKTREE_ONLY\n");
  await writeFile(join(repo, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, {
    mode: 0o755,
  });
  git("config", "core.fsmonitor", `touch '${marker}'`);
  git("config", "diff.external", `touch '${marker}'`);
  config = {
    allowedChannelId: "*",
    allowedSenderId: "U123",
    repositories: [{ id: "service", path: repo, commit }],
  };
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("lists configured repository identities without disclosing host paths", async () => {
  const tool = createRepositoryTool(config, context(), run);
  const result = await tool.execute("inventory", { action: "list" });
  assert.deepEqual(result.details.repositories, [
    { id: "service", commit, deploymentMatch: "unknown" },
  ]);
  assert.ok(!JSON.stringify(result).includes(repo));
});

test("reads pinned committed source, redacts secrets, and leaves working tree and hooks untouched", async () => {
  const tool = createRepositoryTool(config, context(), run);
  const result = await tool.execute("read", {
    action: "read",
    repoId: "service",
    path: "src/worker.py",
  });
  assert.equal(result.details.commit, commit);
  assert.match(result.details.text, /signal timeout/);
  assert.doesNotMatch(result.details.text, /SYNTHETIC_SECRET|DIRTY_WORKTREE_ONLY/);
  assert.equal(await readFile(join(repo, "src", "worker.py"), "utf8"), "DIRTY_WORKTREE_ONLY\n");
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("lists a pinned subdirectory with explicit stable continuation and without symlinks", async () => {
  const tool = createRepositoryTool(config, context(), run);
  const first = await tool.execute("list", {
    action: "list",
    repoId: "service",
    path: "src",
    limit: 2,
  });
  assert.equal(first.details.entries.length, 2);
  assert.equal(first.details.nextOffset, 2);
  const next = await tool.execute("list-next", {
    action: "list",
    repoId: "service",
    path: "src",
    limit: 2,
    offset: first.details.nextOffset,
  });
  assert.ok(
    next.details.entries.every(
      (entry) => !first.details.entries.some((prior) => prior.path === entry.path),
    ),
  );
  assert.ok(
    ![...first.details.entries, ...next.details.entries].some(
      (entry) => entry.path === "src/escape.py",
    ),
  );
});

test("literal source search is pinned and excludes credentials and raw logs", async () => {
  const result = await createRepositoryTool(config, context(), run).execute("search", {
    action: "search",
    repoId: "service",
    query: "signal timeout",
  });
  assert.deepEqual(
    result.details.matches.map((m) => [m.path, m.line]),
    [["src/worker.py", 2]],
  );
  assert.ok(!JSON.stringify(result).includes("customer"));
  const literal = await createRepositoryTool(config, context(), run).execute("literal", {
    action: "search",
    repoId: "service",
    query: ".*",
  });
  assert.equal(literal.details.matches.length, 0);
});

test("search never discloses the interior of a multi-line credential in source", async () => {
  const result = await createRepositoryTool(config, context(), run).execute("secret-search", {
    action: "search",
    repoId: "service",
    query: "SYNTHETIC_KEY_BODY",
  });
  assert.ok(!JSON.stringify(result).includes("SYNTHETIC_KEY_BODY"));
  assert.equal(result.details.matches.length, 0);
});

test("reads ordinary source configuration modules but denies secret/config/log artifacts", async () => {
  const tool = createRepositoryTool(config, context(), run);
  assert.match(
    (
      await tool.execute("source-config", {
        action: "read",
        repoId: "service",
        path: "src/config.py",
      })
    ).details.text,
    /RETRY_COUNT/,
  );
  for (const path of [
    ".env",
    "config/local.json",
    "logs/debug.log",
    ".git/config",
    "../other/file",
    "src/../../etc/passwd",
    "/etc/passwd",
    "src\\worker.py",
    "src/escape.py",
  ]) {
    await assert.rejects(
      tool.execute("deny", { action: "read", repoId: "service", path }),
      /not permitted|regular source file/,
    );
  }
});

test("binary, oversized and unconfigured source access fails without disclosure", async () => {
  const tool = createRepositoryTool(config, context(), run);
  await assert.rejects(
    tool.execute("binary", { action: "read", repoId: "service", path: "src/binary.py" }),
    /binary/,
  );
  await assert.rejects(
    tool.execute("large", { action: "read", repoId: "service", path: "src/large.py" }),
    /size limit/,
  );
  await assert.rejects(
    tool.execute("other", { action: "read", repoId: "unknown", path: "src/worker.py" }),
    /configured/,
  );
  await assert.rejects(
    tool.execute("override", {
      action: "read",
      repoId: "service",
      path: "src/worker.py",
      commit: "0".repeat(40),
    }),
    /Invalid/,
  );
});

test("missing snapshot errors do not disclose private host paths", async () => {
  const missing = {
    ...config,
    repositories: [{ id: "missing", path: join(repo, "does-not-exist"), commit }],
  };
  await assert.rejects(
    createRepositoryTool(missing, context(), run).execute("missing", {
      action: "list",
      repoId: "missing",
    }),
    (error) => !error.message.includes(repo),
  );
});

test("unauthorized caller has no repository tool", () => {
  for (const ctx of [
    {},
    { ...context(), requesterSenderId: "U999" },
    { ...context(), messageChannel: "discord" },
    { ...context(), nativeChannelId: "D123" },
  ]) {
    assert.equal(createRepositoryTool(config, ctx, run), null);
  }
});

test("revocation after a Git read prevents evidence disclosure and aborted calls never launch", async () => {
  let allowed = true,
    calls = 0;
  const tool = createRepositoryTool(
    config,
    context(() => {
      if (!allowed) throw Error("revoked");
    }),
    async (...args) => {
      calls++;
      const result = await run(...args);
      allowed = false;
      return result;
    },
  );
  await assert.rejects(
    tool.execute("revoked", { action: "read", repoId: "service", path: "src/worker.py" }),
    /revoked/,
  );
  assert.equal(calls, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createRepositoryTool(config, context(), async () => {
      throw Error("must not launch");
    }).execute(
      "abort",
      { action: "read", repoId: "service", path: "src/worker.py" },
      controller.signal,
    ),
    /abort/i,
  );
});

test("process failures and output overflows do not expose diagnostics or pretend to be complete", async () => {
  for (const result of [
    { code: 128, termination: "exit", stderr: "CREDENTIAL_IN_STDERR" },
    { outputLimitExceeded: true },
    { code: 0, termination: "exit", stdout: "broken tree record" },
  ]) {
    await assert.rejects(
      createRepositoryTool(config, context(), async () => result).execute("failed", {
        action: "list",
        repoId: "service",
      }),
      (error) => !error.message.includes("CREDENTIAL_IN_STDERR"),
    );
  }
});
