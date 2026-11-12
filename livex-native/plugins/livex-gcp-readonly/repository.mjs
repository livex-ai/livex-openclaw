import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { redact } from "./core.mjs";

const MAX_FILE = 64 * 1024;
const MAX_OUTPUT = 256 * 1024;
const MAX_RESULT = 30 * 1024;
const GIT = "/usr/bin/git";
const SOURCE =
  /\.(?:py|js|mjs|cjs|ts|tsx|jsx|rs|go|java|scala|kt|c|cpp|h|hpp|cs|rb|php|sql|graphql|proto|md|toml|yaml|yml|json|sh|html|css|scss)$/i;
const PRIVATE_PART =
  /^(?:\.git|\.aws|\.ssh|\.config|\.codex|\.agents|\.venv|venv|node_modules|vendor|dist|build|coverage|logs?|secrets?|credentials?|certs?|certificates?|\.terraform|\.next)$/i;
const PRIVATE_FILE =
  /(?:^\.env(?:\.|$)|^\.(?:npmrc|pypirc|netrc|git-credentials)$|(?:credential|secret|service[-_]?account|private[-_]?key)|\.(?:pem|key|p12|pfx|jks|log|sqlite|sqlite3|db|tfstate)(?:\.|$)|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$))/i;

function validPath(value, allowEmpty = false) {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    /[\x00-\x1f\x7f-\x9f\\:]/.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/")
  )
    return false;
  if (!value) return allowEmpty;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function permittedPath(path, file = false) {
  if (!validPath(path, !file)) return false;
  const parts = path.split("/");
  if (parts.some((part) => PRIVATE_PART.test(part) || PRIVATE_FILE.test(part))) return false;
  // Local runtime configuration is not service source. Source modules such as
  // src/config.py remain available; source snapshots never include untracked files.
  if (
    /(?:^|\/)(?:config|configs|configuration)\/(?:local|production|prod|staging|stg|development|dev)(?:[./]|$)/i.test(
      path,
    )
  )
    return false;
  if (
    /(?:^|\/)(?:config|configs|configuration)\//i.test(path) &&
    /\.(?:json|ya?ml|toml|ini|cfg)$/i.test(path)
  )
    return false;
  if (
    /(?:^|\/)(?:config|settings|application)(?:[._-](?:local|production|prod|staging|stg|development|dev))?\.(?:json|ya?ml|toml|ini|cfg)$/i.test(
      path,
    )
  )
    return false;
  return !file || SOURCE.test(path) || /(?:^|\/)(?:Dockerfile|Makefile|LICENSE|NOTICE)$/.test(path);
}

function repositories(config) {
  if (!Array.isArray(config.repositories) || config.repositories.length > 64)
    throw Error("Invalid repositories configuration");
  const ids = new Set();
  return config.repositories.map((repo) => {
    if (
      !repo ||
      typeof repo !== "object" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(repo.id ?? "") ||
      ids.has(repo.id) ||
      typeof repo.path !== "string" ||
      !isAbsolute(repo.path) ||
      /[\x00-\x1f]/.test(repo.path) ||
      !/^[a-f0-9]{40}$/.test(repo.commit ?? "")
    )
      throw Error(
        "Invalid repository binding: require a unique id, absolute path and pinned 40-hex commit",
      );
    ids.add(repo.id);
    return Object.freeze({ id: repo.id, path: resolve(repo.path), commit: repo.commit });
  });
}

function parseTree(output) {
  if (output && !output.endsWith("\0")) throw Error("Repository read returned an incomplete tree");
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40}) +(-|\d+)\t([\s\S]+)$/.exec(record);
      if (!match) throw Error("Repository read returned an invalid tree");
      return {
        mode: match[1],
        type: match[2],
        object: match[3],
        size: match[4] === "-" ? null : Number(match[4]),
        path: match[5],
      };
    });
}

function checkedArgs(params) {
  if (
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    Object.keys(params).some(
      (key) => !["action", "repoId", "path", "query", "startLine", "limit", "offset"].includes(key),
    )
  )
    throw Error("Invalid repository arguments");
  if (!["list", "read", "search"].includes(params.action)) throw Error("Invalid repository action");
  if (params.repoId !== undefined && (typeof params.repoId !== "string" || !params.repoId))
    throw Error("Invalid repository id");
  if (params.path !== undefined && !permittedPath(params.path, params.action === "read"))
    throw Error("Repository path is not permitted");
  if (params.action === "read" && !params.path) throw Error("Repository path is not permitted");
  if (params.action !== "list" && !params.repoId)
    throw Error("A configured repository id is required");
  if (
    params.action === "search" &&
    (typeof params.query !== "string" ||
      !params.query ||
      params.query.length > 160 ||
      /[\x00-\x1f\x7f]/.test(params.query))
  )
    throw Error("Invalid literal search query");
  if (params.action !== "search" && params.query !== undefined)
    throw Error("Invalid query for repository action");
  if (params.action !== "read" && params.startLine !== undefined)
    throw Error("Invalid startLine for repository action");
  if (params.action !== "list" && params.offset !== undefined)
    throw Error("Invalid offset for repository action");
  const limit = params.limit ?? (params.action === "search" ? 30 : 120);
  if (!Number.isInteger(limit) || limit < 1 || limit > (params.action === "search" ? 50 : 200))
    throw Error("Invalid repository result limit");
  const startLine = params.startLine ?? 1,
    offset = params.offset ?? 0;
  if (
    !Number.isInteger(startLine) ||
    startLine < 1 ||
    startLine > 1000000 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 10000
  )
    throw Error("Invalid repository position");
  return { ...params, path: params.path ?? "", limit, startLine, offset };
}

export function createRepositoryTool(config, context, runCommand) {
  if (
    !config ||
    !/^(?:\*|[CG][A-Z0-9]+)$/.test(config.allowedChannelId ?? "") ||
    !/^[A-Z][A-Z0-9]+$/.test(config.allowedSenderId ?? "")
  )
    throw Error("Invalid repository caller policy");
  if (
    context?.messageChannel !== "slack" ||
    !/^[CG][A-Z0-9]+$/.test(context?.nativeChannelId ?? "") ||
    (config.allowedChannelId !== "*" && context.nativeChannelId !== config.allowedChannelId) ||
    context.requesterSenderId !== config.allowedSenderId ||
    typeof context.assertInvocationCurrent !== "function"
  )
    return null;
  const bindings = repositories(config);
  return {
    name: "livex_repository_read",
    label: "Read approved service source",
    executionMode: "sequential",
    description:
      "Read committed source from operator-approved, pinned repository snapshots. List without repoId discovers available repositories. List a directory with repoId/path; read a file with bounded startLine/limit; search literal text with optional directory/file path. Credentials, local configuration, logs, binary/large files, symlinks and submodules are unavailable. No code, hooks, builds, Git writes or network operations run. A local commit is not proof of the deployed revision.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["list", "read", "search"] },
        repoId: { type: "string" },
        path: {
          type: "string",
          description:
            "Relative source path within the configured immutable commit; no host paths.",
        },
        query: {
          type: "string",
          minLength: 1,
          maxLength: 160,
          description: "Literal text for search; not a regular expression.",
        },
        startLine: { type: "integer", minimum: 1, maximum: 1000000 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0, maximum: 10000 },
      },
    },
    async execute(_toolCallId, params, signal) {
      const args = checkedArgs(params);
      const current = () => {
        signal?.throwIfAborted();
        context.assertInvocationCurrent();
      };
      const finish = (details) => {
        const text = JSON.stringify(details);
        if (Buffer.byteLength(text) > MAX_RESULT)
          throw Error("Repository result size limit exceeded; request fewer results");
        current();
        return { content: [{ type: "text", text }], details };
      };
      current();
      if (!args.repoId) {
        if (args.path || params.offset !== undefined || params.startLine !== undefined)
          throw Error("Invalid repository inventory arguments");
        return finish({
          repositories: bindings.map(({ id, commit }) => ({
            id,
            commit,
            deploymentMatch: "unknown",
          })),
        });
      }
      const repo = bindings.find((item) => item.id === args.repoId);
      if (!repo) throw Error("Repository id is not configured");
      let canonical;
      try {
        canonical = await realpath(repo.path);
      } catch {
        current();
        throw Error("Repository snapshot is unavailable; ask the operator to check its binding");
      }
      current();
      if (canonical !== repo.path)
        throw Error("Repository binding changed; operator review is required");
      const deadline = Date.now() + 20000;
      const run = async (gitArgs, maxBytes = MAX_OUTPUT, acceptedCodes = [0]) => {
        current();
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw Error("Repository read time budget exhausted; narrow the source path");
        let result;
        try {
          result = await runCommand(
            [
              GIT,
              "--no-optional-locks",
              "--no-replace-objects",
              "-c",
              "core.fsmonitor=false",
              "-c",
              "core.hooksPath=/dev/null",
              "-c",
              "core.pager=cat",
              "-c",
              "protocol.allow=never",
              "-C",
              repo.path,
              ...gitArgs,
            ],
            {
              timeoutMs: Math.min(10000, remaining),
              signal,
              killProcessTree: true,
              requireProcessTreeExtinction: true,
              maxOutputBytes: { stdout: maxBytes, stderr: 2048 },
              maxCombinedOutputBytes: maxBytes + 2048,
              terminateOnOutputError: true,
              terminateOnOutputLimit: true,
              baseEnv: {
                PATH: "/usr/bin:/bin",
                LANG: "C.UTF-8",
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_OPTIONAL_LOCKS: "0",
                GIT_NO_REPLACE_OBJECTS: "1",
                GIT_NO_LAZY_FETCH: "1",
                GIT_ALLOW_PROTOCOL: "",
                GIT_ATTR_NOSYSTEM: "1",
                GIT_TERMINAL_PROMPT: "0",
                GIT_PAGER: "cat",
              },
            },
          );
        } catch {
          current();
          throw Error(
            "Repository read could not complete; inspect the local snapshot before retrying",
          );
        }
        current();
        if (
          result?.outputLimitExceeded ||
          result?.stdoutTruncatedBytes ||
          result?.stderrTruncatedBytes ||
          (typeof result?.stdout === "string" && Buffer.byteLength(result.stdout) > maxBytes)
        )
          throw Error("Repository output limit exceeded; narrow the source path or search");
        if (
          !result ||
          !acceptedCodes.includes(result.code) ||
          result.termination !== "exit" ||
          result.killed ||
          result.cleanup === "uncertain" ||
          result.killIssuedByAbort ||
          result.outputErrorStream ||
          typeof result.stdout !== "string"
        )
          throw Error("Repository read failed; no complete source evidence returned");
        return result.stdout;
      };
      const base = {
        repoId: repo.id,
        commit: repo.commit,
        deploymentMatch: "unknown",
        note: "Untrusted committed source. Local HEAD is not proof of the deployed revision. Snapshot excludes uncommitted changes and protected paths.",
      };
      const sourceBlob = async (path) => {
        const rows = parseTree(
          await run(["ls-tree", "-z", "-l", "--full-tree", repo.commit, "--", `:(literal)${path}`]),
        );
        if (rows.length !== 1 || rows[0].path !== path || !/^100(?:644|755)$/.test(rows[0].mode))
          throw Error("Repository path is not a regular source file");
        if (!Number.isSafeInteger(rows[0].size) || rows[0].size > MAX_FILE)
          throw Error("Repository file exceeds the size limit; request a smaller source file");
        const raw = await run(["cat-file", "blob", rows[0].object], MAX_FILE);
        if (raw.includes("\0") || raw.includes("\uFFFD"))
          throw Error("Repository source is binary or unsupported text");
        const state = { truncated: false };
        // Redact the complete blob before selecting lines so a slice cannot expose
        // the interior of a multi-line credential block. Redaction may alter lines.
        return { row: rows[0], state, lines: redact(raw, state, MAX_FILE).split("\n") };
      };
      if (args.action === "list") {
        const tree = args.path ? `${repo.commit}:${args.path}` : repo.commit;
        const rows = parseTree(await run(["ls-tree", "-z", "-l", tree]))
          .flatMap((row) => {
            const path = args.path ? `${args.path}/${row.path}` : row.path;
            if (row.mode === "040000" && permittedPath(path)) return [{ path, type: "directory" }];
            if (/^100(?:644|755)$/.test(row.mode) && permittedPath(path, true))
              return [{ path, type: "file", bytes: row.size }];
            return [];
          })
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const entries = [];
        for (const entry of rows.slice(args.offset, args.offset + args.limit)) {
          if (
            Buffer.byteLength(JSON.stringify(entries)) + Buffer.byteLength(JSON.stringify(entry)) >
            MAX_RESULT - 2048
          )
            break;
          entries.push(entry);
        }
        const nextOffset =
          args.offset + entries.length < rows.length ? args.offset + entries.length : undefined;
        return finish({
          ...base,
          path: args.path,
          entries,
          truncated: nextOffset !== undefined,
          ...(nextOffset !== undefined ? { nextOffset } : {}),
        });
      }
      if (args.action === "read") {
        const { row, state, lines } = await sourceBlob(args.path);
        const text = lines.slice(args.startLine - 1, args.startLine - 1 + args.limit).join("\n");
        if (Buffer.byteLength(text) > MAX_RESULT - 2048)
          throw Error("Repository result size limit exceeded; request fewer lines");
        const hasMore = args.startLine - 1 + args.limit < lines.length;
        return finish({
          ...base,
          path: args.path,
          objectId: row.object,
          startLine: args.startLine,
          text,
          truncated: state.truncated || hasMore,
          lineNumbers: "redacted view",
          ...(hasMore ? { nextStartLine: args.startLine + args.limit } : {}),
        });
      }
      // Get candidate names only: grep snippets can reveal the interior of a
      // multi-line secret without its surrounding redaction marker.
      const output = await run(
        [
          "grep",
          "--no-textconv",
          "-I",
          "-l",
          "-z",
          "-F",
          "-e",
          args.query,
          repo.commit,
          "--",
          ...(args.path ? [`:(literal)${args.path}`] : ["."]),
        ],
        MAX_OUTPUT,
        [0, 1],
      );
      const matches = [];
      const state = { truncated: false };
      let skipped = false;
      if (output && !output.endsWith("\0"))
        throw Error("Repository search returned incomplete evidence");
      let inspected = 0,
        bytes = 0;
      for (const record of output.split("\0").filter(Boolean)) {
        if (!record.startsWith(`${repo.commit}:`))
          throw Error("Repository search returned malformed evidence");
        const path = record.slice(repo.commit.length + 1);
        if (!permittedPath(path, true)) continue;
        if (++inspected > 20 || bytes >= MAX_OUTPUT) {
          skipped = true;
          break;
        }
        let source;
        try {
          source = await sourceBlob(path);
        } catch (error) {
          if (/size limit|binary|regular source file/.test(error.message)) {
            skipped = true;
            continue;
          }
          throw error;
        }
        bytes += source.row.size;
        state.truncated ||= source.state.truncated;
        for (let i = 0; i < source.lines.length; i++) {
          if (!source.lines[i].includes(args.query)) continue;
          const item = { path, line: i + 1, text: redact(source.lines[i], state, 2048) };
          if (
            matches.length >= args.limit ||
            Buffer.byteLength(JSON.stringify(matches)) + Buffer.byteLength(JSON.stringify(item)) >
              MAX_RESULT - 2048
          ) {
            skipped = true;
            break;
          }
          matches.push(item);
        }
        if (matches.length >= args.limit) {
          skipped = true;
          break;
        }
      }
      return finish({
        ...base,
        matches,
        lineNumbers: "redacted view",
        truncated: state.truncated || skipped,
        ...(skipped
          ? { nextAction: "Narrow the path or literal query; this search is incomplete." }
          : {}),
      });
    },
  };
}
