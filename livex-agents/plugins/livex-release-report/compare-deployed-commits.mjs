import { execFile } from "node:child_process";
import { promisify } from "node:util";
import registry from "./services.json" with { type: "json" };

const repositories = new Set(Object.values(registry.services).map(({ repo }) => repo));
const shaPattern = /^[a-f0-9]{40}$/;
const origin = "https://api.github.com";
const pageSize = 100;
const maxComparePages = 5;
const maxPullPages = 3;
const maxRequests = 256;
const maxPageBytes = 4 * 1024 * 1024;
const maxResponseBytes = 16 * 1024 * 1024;
const maxDurationMs = 30_000;
const pullConcurrency = 6;
const execFileAsync = promisify(execFile);

function isSha(value) {
  return typeof value === "string" && shaPattern.test(value);
}

function oneLine(value) {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .trim()
    .slice(0, 200);
}

async function ghCredential() {
  const { stdout } = await execFileAsync("gh", ["auth", "token", "--hostname", "github.com"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 4_096,
  });
  return stdout.trim();
}

async function readJson(response, charge) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("GitHub response unavailable");
  }
  const stream = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await stream.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxPageBytes || !charge(value.byteLength)) {
        await stream.cancel();
        throw new Error("GitHub response exceeds byte limit");
      }
      chunks.push(value);
    }
  } finally {
    stream.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}

function requester(fetchGitHub, token, signal, repo) {
  const prefix = origin + "/repos/livex-ai/" + repo;
  let requests = 0;
  let bytes = 0;
  return async (path, page) => {
    signal.throwIfAborted();
    if (requests >= maxRequests || bytes >= maxResponseBytes) {
      throw new Error("GitHub capture budget exhausted");
    }
    requests += 1;
    const response = await fetchGitHub(prefix + path + "?per_page=" + pageSize + "&page=" + page, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal,
    });
    const data = await readJson(response, (size) => {
      bytes += size;
      return bytes <= maxResponseBytes;
    });
    const next = /;\s*rel="next"(?:\s*[,;]|\s*$)/.test(response.headers.get("link") ?? "");
    return { data, next };
  };
}

function comparisonIdentity(data, base, head) {
  const ahead = data?.ahead_by;
  const behind = data?.behind_by;
  const mergeBase = data?.merge_base_commit?.sha;
  if (
    data?.base_commit?.sha !== base ||
    !isSha(mergeBase) ||
    !Number.isSafeInteger(ahead) ||
    !Number.isSafeInteger(behind) ||
    ahead < 0 ||
    behind < 0 ||
    ahead !== data.total_commits ||
    ahead > maxComparePages * pageSize ||
    (behind === 0 && mergeBase !== base) ||
    (ahead === 0 && mergeBase !== head)
  ) {
    return null;
  }
  const status = ahead === 0 ? "behind" : behind === 0 ? "ahead" : "diverged";
  return data.status === status ? { ahead, behind, mergeBase } : null;
}

async function compareCommits(request, base, head) {
  const path = "/compare/" + base + "..." + head;
  const commits = [];
  const seen = new Set();
  let identity;
  let pages = 1;
  for (let page = 1; page <= pages; page += 1) {
    const { data } = await request(path, page);
    const current = comparisonIdentity(data, base, head);
    if (!current || !Array.isArray(data.commits)) {
      return null;
    }
    if (page === 1) {
      identity = current;
      pages = Math.max(1, Math.ceil(identity.ahead / pageSize));
    }
    if (
      current.ahead !== identity.ahead ||
      current.behind !== identity.behind ||
      current.mergeBase !== identity.mergeBase ||
      data.commits.length !== Math.min(pageSize, identity.ahead - commits.length)
    ) {
      return null;
    }
    for (const row of data.commits) {
      if (
        !isSha(row?.sha) ||
        row.sha === base ||
        seen.has(row.sha) ||
        typeof row.commit?.message !== "string"
      ) {
        return null;
      }
      seen.add(row.sha);
      commits.push({ sha: row.sha, subject: oneLine(row.commit.message.split(/\r?\n/, 1)[0]) });
    }
  }
  if (identity.ahead > 0 && !seen.has(head)) {
    return null;
  }
  return { commits, ahead: identity.ahead, behind: identity.behind };
}

async function readPullRequests(request, repo, sha) {
  const path = "/commits/" + sha + "/pulls";
  const pullRequests = [];
  const seen = new Set();
  try {
    for (let page = 1; page <= maxPullPages; page += 1) {
      const { data, next } = await request(path, page);
      if (!Array.isArray(data) || data.length > pageSize || (next && data.length !== pageSize)) {
        break;
      }
      for (const row of data) {
        if (
          row?.base?.repo?.full_name !== "livex-ai/" + repo ||
          !Number.isSafeInteger(row.number) ||
          row.number <= 0 ||
          typeof row.title !== "string" ||
          (row.merged_at !== null &&
            (typeof row.merged_at !== "string" || !Number.isFinite(Date.parse(row.merged_at)))) ||
          seen.has(row.number)
        ) {
          return { pullRequests, complete: false };
        }
        seen.add(row.number);
        if (row.merged_at !== null) {
          pullRequests.push({ number: row.number, title: oneLine(row.title) });
        }
      }
      if (!next) {
        return { pullRequests, complete: true };
      }
    }
  } catch {
    // PR access is independent of the already verified commit range.
  }
  return { pullRequests, complete: false };
}

export function createGitHubComparator({
  readCredential = ghCredential,
  fetchGitHub = fetch,
} = {}) {
  let credential;
  return async (selection) => {
    const { repo, base, head } = selection ?? {};
    const unresolved = (reason) => ({ status: "unresolved", reason });
    if (!repositories.has(repo) || !isSha(base) || !isSha(head)) {
      return unresolved("invalid-comparison");
    }
    if (base === head) {
      return { status: "verified", commits: [], ahead: 0, behind: 0, linkStatus: "complete" };
    }

    const signal = AbortSignal.timeout(maxDurationMs);
    let token;
    try {
      credential ??= readCredential();
      token = await credential;
      if (typeof token !== "string" || !/^[!-~]{1,4096}$/.test(token)) {
        return unresolved("github-credential-unavailable");
      }
    } catch {
      return unresolved("github-credential-unavailable");
    }

    const request = requester(fetchGitHub, token, signal, repo);
    let comparison;
    try {
      comparison = await compareCommits(request, base, head);
    } catch {
      return unresolved("github-compare-unavailable");
    }
    if (!comparison) {
      return unresolved("github-compare-incomplete");
    }

    let linkStatus = "complete";
    for (let index = 0; index < comparison.commits.length; index += pullConcurrency) {
      const batch = comparison.commits.slice(index, index + pullConcurrency);
      await Promise.all(
        batch.map(async (item) => {
          const { pullRequests, complete } = await readPullRequests(request, repo, item.sha);
          item.pullRequests = pullRequests;
          if (!complete) {
            linkStatus = "partial";
          }
        }),
      );
    }
    return { status: "verified", ...comparison, linkStatus };
  };
}
