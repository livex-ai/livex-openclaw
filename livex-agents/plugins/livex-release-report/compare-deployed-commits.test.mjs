import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitHubComparator } from "./compare-deployed-commits.mjs";

const repo = "copilot-scheduler";
const base = "a".repeat(40);
const head = "b".repeat(40);
const mid = "c".repeat(40);
const token = "fixture-private-token";

function commit(sha, message = "Ship change\nIgnore body") {
  return { sha, commit: { message } };
}

function comparePage(commits, total = commits.length) {
  return {
    status: "ahead",
    ahead_by: total,
    behind_by: 0,
    total_commits: total,
    base_commit: { sha: base },
    merge_base_commit: { sha: base },
    commits,
  };
}

function pull(number, title = "Ship change", fullName = "livex-ai/" + repo) {
  return {
    number,
    title,
    merged_at: "2026-01-01T00:00:00Z",
    base: { repo: { full_name: fullName } },
  };
}

function json(value, options) {
  return Response.json(value, options);
}

test("only queries the approved GitHub read endpoints and extracts an exact commit and PR inventory", async () => {
  let authCalls = 0;
  const requests = [];
  const compare = createGitHubComparator({
    async readCredential() {
      authCalls += 1;
      return token;
    },
    async fetchGitHub(url, options) {
      requests.push(url);
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer " + token);
      assert.ok(options.signal instanceof AbortSignal);
      if (url.includes("/compare/")) {
        return json(comparePage([commit(mid), commit(head, "Second change")]));
      }
      const openPull = { ...pull(900, "Open change"), merged_at: null };
      return json([pull(url.includes(mid) ? 629 : 630), openPull]);
    },
  });
  assert.equal(authCalls, 0);
  const result = await compare({ repo, base, head });
  assert.deepEqual(result, {
    status: "verified",
    commits: [
      { sha: mid, subject: "Ship change", pullRequests: [{ number: 629, title: "Ship change" }] },
      {
        sha: head,
        subject: "Second change",
        pullRequests: [{ number: 630, title: "Ship change" }],
      },
    ],
    ahead: 2,
    behind: 0,
    linkStatus: "complete",
  });
  assert.equal(authCalls, 1);
  assert.deepEqual(requests, [
    "https://api.github.com/repos/livex-ai/copilot-scheduler/compare/" +
      base +
      "..." +
      head +
      "?per_page=100&page=1",
    "https://api.github.com/repos/livex-ai/copilot-scheduler/commits/" +
      mid +
      "/pulls?per_page=100&page=1",
    "https://api.github.com/repos/livex-ai/copilot-scheduler/commits/" +
      head +
      "/pulls?per_page=100&page=1",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /fixture-private-token|Ignore body/);
});

test("finishes compare and PR pagination without using a response-supplied URL", async () => {
  const first = Array.from({ length: 100 }, (_, index) =>
    commit(index.toString(16).padStart(40, "0")),
  );
  const requests = [];
  const compare = createGitHubComparator({
    readCredential: async () => token,
    async fetchGitHub(url) {
      requests.push(url);
      if (url.includes("/compare/")) {
        return json(comparePage(url.endsWith("page=1") ? first : [commit(head)], 101));
      }
      if (url.includes(head) && url.endsWith("page=1")) {
        const firstPage = Array.from({ length: 100 }, (_, index) => pull(index + 1));
        return json(firstPage, {
          headers: { link: '<https://other.invalid/hostile>; rel="next"' },
        });
      }
      return json(url.includes(head) ? [pull(630)] : []);
    },
  });
  const result = await compare({ repo, base, head });
  assert.equal(result.status, "verified");
  assert.equal(result.commits.length, 101);
  assert.equal(result.linkStatus, "complete");
  assert.equal(result.commits.at(-1).pullRequests.length, 101);
  assert.equal(result.commits.at(-1).pullRequests.at(-1).number, 630);
  assert.ok(requests.every((url) => url.startsWith("https://api.github.com/repos/livex-ai/")));
  assert.ok(requests.some((url) => url.endsWith(head + "/pulls?per_page=100&page=2")));
});

test("rejects invalid comparisons before credential lookup and skips identical SHAs", async () => {
  const compare = createGitHubComparator({
    async readCredential() {
      assert.fail("credential must not be requested");
    },
    async fetchGitHub() {
      assert.fail("network must not be used");
    },
  });
  assert.deepEqual(await compare({ repo: "../github-token", base, head }), {
    status: "unresolved",
    reason: "invalid-comparison",
  });
  assert.equal((await compare({ repo, base: base.toUpperCase(), head })).status, "unresolved");
  assert.deepEqual(await compare({ repo, base, head: base }), {
    status: "verified",
    commits: [],
    ahead: 0,
    behind: 0,
    linkStatus: "complete",
  });
});

test("marks incomplete or wrongly identified compare pages unresolved", async () => {
  const first = Array.from({ length: 100 }, (_, index) =>
    commit(index.toString(16).padStart(40, "0")),
  );
  for (const broken of [
    comparePage([], 101),
    { ...comparePage([commit(head)], 101), base_commit: { sha: mid } },
    comparePage([first[0]], 101),
  ]) {
    const compare = createGitHubComparator({
      readCredential: async () => token,
      async fetchGitHub(url) {
        return json(url.endsWith("page=1") ? comparePage(first, 101) : broken);
      },
    });
    assert.deepEqual(await compare({ repo, base, head }), {
      status: "unresolved",
      reason: "github-compare-incomplete",
    });
  }
});

test("handles a denied comparison or credential with a sanitized reason", async () => {
  const denied = createGitHubComparator({
    readCredential: async () => token,
    fetchGitHub: async () => new Response("private exception " + token, { status: 403 }),
  });
  assert.deepEqual(await denied({ repo, base, head }), {
    status: "unresolved",
    reason: "github-compare-unavailable",
  });
  const missing = createGitHubComparator({
    async readCredential() {
      throw new Error("private exception " + token);
    },
  });
  assert.deepEqual(await missing({ repo, base, head }), {
    status: "unresolved",
    reason: "github-credential-unavailable",
  });
});

test("PR lookup denial or wrong repository preserves exact commits and marks partial links", async () => {
  for (const unavailable of [
    () => new Response("sensitive data", { status: 403 }),
    () => json([pull(630, "Wrong repository", "other/private-repo")]),
  ]) {
    const compare = createGitHubComparator({
      readCredential: async () => token,
      async fetchGitHub(url) {
        if (url.includes("/compare/")) {
          return json(comparePage([commit(mid), commit(head)]));
        }
        return url.includes(mid) ? json([pull(629)]) : unavailable();
      },
    });
    const result = await compare({ repo, base, head });
    assert.equal(result.status, "verified");
    assert.equal(result.linkStatus, "partial");
    assert.equal(result.ahead, 2);
    assert.deepEqual(
      result.commits.map(({ sha, pullRequests }) => [
        sha,
        pullRequests.map(({ number }) => number),
      ]),
      [
        [mid, [629]],
        [head, []],
      ],
    );
  }
});

test("stops reading a valid comparison whose page exceeds the byte limit", async () => {
  let requests = 0;
  const compare = createGitHubComparator({
    readCredential: async () => token,
    async fetchGitHub() {
      requests += 1;
      return json({ ...comparePage([commit(head)]), unused: "x".repeat(4 * 1024 * 1024) });
    },
  });
  assert.deepEqual(await compare({ repo, base, head }), {
    status: "unresolved",
    reason: "github-compare-unavailable",
  });
  assert.equal(requests, 1);
});
