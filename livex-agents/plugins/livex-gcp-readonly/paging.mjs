import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLogsTool,
  queryArgs,
  buildLogFilter,
  evidence,
  selectedEntry,
  validateConfig,
  withEvidenceLink,
} from "./core.mjs";

const HELPER = fileURLToPath(new URL("./logging-page.py", import.meta.url));
const MAX_STDOUT = 256 * 1024;
const jsonResult = (details) => ({
  content: [{ type: "text", text: JSON.stringify(details) }],
  details,
});
function stable(value) {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((k) => [k, stable(value[k])]),
    );
  }
  return value;
}
const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");

const HELPER_STAGES = new Set([
  "validation",
  "sdk_import",
  "client_setup",
  "read_page",
  "encode_result",
]);
const HELPER_EXCEPTION_CLASSES = new Set([
  "AccessTokenRefreshError",
  "ConnectionError",
  "HttpError",
  "ImportError",
  "InvalidDataFromServerError",
  "JSONDecodeError",
  "ModuleNotFoundError",
  "OSError",
  "PageValidationError",
  "PermissionError",
  "RefreshError",
  "RuntimeError",
  "SSLError",
  "TimeoutError",
  "TransportError",
  "TypeError",
  "ValueError",
  "OtherError",
]);

function helperFailure(result) {
  // Only the helper's fixed labels and numeric HTTP status may leave this boundary.
  // SDK stderr can contain credentials, request bodies and private log content.
  let error;
  try {
    error = JSON.parse(result.stderr).error;
  } catch {}
  const diagnostic =
    HELPER_STAGES.has(error?.stage) && HELPER_EXCEPTION_CLASSES.has(error?.exceptionClass)
      ? ` (stage=${error.stage}, class=${error.exceptionClass})`
      : "";
  const status = error?.httpStatus;
  if (
    result.code === 1 &&
    error?.code === "http_error" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status <= 599
  ) {
    const action =
      status === 400
        ? "inspect the reader field selection and generated filter"
        : status === 401
          ? "verify configured account authentication"
          : status === 403
            ? "verify the configured account has log-reader access to this project"
            : status === 429
              ? "check Cloud Logging quota before retrying"
              : status >= 500
                ? "Cloud Logging service failed; retry only after reconciling this attempt"
                : "inspect the Cloud Logging request and endpoint";
    return `Cloud Logging request failed (HTTP ${status}); ${action}${diagnostic}; no cursor was advanced`;
  }
  if (result.code === 2) {
    return `Cloud Logging rejected the local query or response; inspect reader validation${diagnostic}; no cursor was advanced`;
  }
  return `Cloud Logging helper failed; verify the configured SDK, account and connectivity${diagnostic}; no cursor was advanced`;
}

export function createCloudPageReader(config, runCommand) {
  const options = config.paging;
  for (const name of ["pythonPath", "sdkRoot"]) {
    // eslint-disable-next-line no-control-regex -- Reject control characters in executable and SDK paths before process invocation.
    if (!isAbsolute(options?.[name] ?? "") || /[\x00-\x1f]/.test(options[name])) {
      throw new Error(`Invalid paging ${name}`);
    }
  }
  return async (query, backendToken, signal) => {
    const argv = [
      options.pythonPath,
      "-I",
      "-B",
      HELPER,
      "--sdk-root",
      options.sdkRoot,
      "--account",
      config.gcloudAccount,
      "--project",
      config.project,
      "--filter",
      buildLogFilter(query, config),
      "--page-size",
      String(query.limit),
    ];
    if (backendToken) {
      argv.push("--page-token", backendToken);
    }
    const result = await runCommand(argv, {
      timeoutMs: 30000,
      signal,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
      maxOutputBytes: { stdout: MAX_STDOUT, stderr: 8192 },
      maxCombinedOutputBytes: MAX_STDOUT + 8192,
      terminateOnOutputError: true,
      terminateOnOutputLimit: true,
      baseEnv: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME ?? "/tmp",
        LANG: "en_US.UTF-8",
        CLOUDSDK_CONFIG: config.cloudSdkConfig,
        CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
        CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "1",
        CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: "1",
        CLOUDSDK_CORE_LOG_HTTP: "false",
        CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: "",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "",
        CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: "",
        CLOUDSDK_AUTH_ACCESS_TOKEN: "",
        CLOUDSDK_AUTH_DISABLE_CREDENTIALS: "false",
      },
    });
    if (result?.cleanup === "uncertain") {
      throw new Error("Cloud page cleanup is uncertain; reconcile before retrying");
    }
    if (
      result?.outputLimitExceeded ||
      result?.stdoutTruncatedBytes ||
      result?.stderrTruncatedBytes ||
      (typeof result?.stdout === "string" && Buffer.byteLength(result.stdout) > MAX_STDOUT)
    ) {
      throw new Error(
        "Cloud page exceeded its output limit; narrow the query or page size; no cursor was advanced",
      );
    }
    if (result?.outputErrorStream) {
      throw new Error("Cloud page output could not be captured; no cursor was advanced");
    }
    if (signal?.aborted || result?.killIssuedByAbort) {
      throw new Error("Cloud page was cancelled; no cursor was advanced");
    }
    if (result?.termination === "timeout" || result?.termination === "no-output-timeout") {
      throw new Error(
        "Cloud page timed out after 30 seconds; narrow the query; no cursor was advanced",
      );
    }
    if (!result || result.termination !== "exit" || result.killed) {
      throw new Error("Cloud page process stopped unexpectedly; no cursor was advanced");
    }
    if (result.code !== 0) {
      throw new Error(helperFailure(result));
    }
    if (typeof result.stdout !== "string") {
      throw new Error("Cloud page output could not be captured; no cursor was advanced");
    }
    let page;
    try {
      page = JSON.parse(result.stdout);
    } catch {
      throw new Error("Cloud page returned invalid JSON");
    }
    if (
      !page ||
      !Array.isArray(page.entries) ||
      page.entries.length > query.limit ||
      (page.nextPageToken !== null &&
        (typeof page.nextPageToken !== "string" ||
          Buffer.byteLength(page.nextPageToken) > 16384)) ||
      typeof page.projectionTruncated !== "boolean"
    ) {
      throw new Error("Cloud page returned invalid entries or continuation");
    }
    return page;
  };
}

// Pagination is an evidence transport. Native Codex owns investigation planning,
// completion and history; this adapter does not start another agent or run loop.
export function createPagedLogsTool(rawConfig, context, runCommand, options) {
  const legacy = createLogsTool(rawConfig, context, runCommand);
  if (!legacy) {
    return null;
  }
  const config = validateConfig(rawConfig),
    ledger = options.ledger;
  const readPage = options.readPage ?? createCloudPageReader(config, runCommand);
  const assertCurrent = (signal) => {
    signal?.throwIfAborted();
    context.assertInvocationCurrent();
  };
  return {
    ...legacy,
    description: legacy.description.replace(
      "Maximum one hour and 1–50 entries per call.",
      "Each cloud page covers at most one hour and 1–50 entries. Continue with cursor alone until windowExhausted=true. Empty entries with a cursor are an incomplete search. Batch exact seed insertIds and cover every alert-hour slice. Codex decides when its investigation is complete; a page limit or timeout is not completion.",
    ),
    parameters: {
      ...legacy.parameters,
      required: [],
      properties: {
        ...legacy.parameters.properties,
        cursor: {
          type: "string",
          pattern: "^[a-f0-9]{64}$",
          description:
            "Opaque continuation from this conversation. Supply only cursor; query and identity cannot change. Retain the latest checkpoint. Old consumed cursors can expire from the LRU cache; never replace an expired continuation with a silent rescan.",
        },
        refresh: {
          type: "boolean",
          description:
            "For a new initial query only: explicitly re-read an identical filter when delayed ingestion or newer evidence requires it. Otherwise reuse evidence while cached; an evicted initial result is fetched again with reusedEvidence=false. Check retrievedAt. Never combine with cursor.",
        },
      },
    },
    async execute(toolCallId, params, signal) {
      assertCurrent(signal);
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw new Error("Invalid query arguments");
      }
      let cursorState;
      if ("cursor" in params) {
        if (
          Object.keys(params).length !== 1 ||
          typeof params.cursor !== "string" ||
          !/^[a-f0-9]{64}$/.test(params.cursor)
        ) {
          throw new Error("Invalid cursor: supply only the returned cursor");
        }
        cursorState = await ledger.getCursor(params.cursor);
        assertCurrent(signal);
      }
      if ("refresh" in params && typeof params.refresh !== "boolean") {
        throw new Error("Invalid refresh flag");
      }
      const { refresh, ...queryParams } = params;
      const query = queryArgs(cursorState?.query ?? queryParams, config);
      const queryFingerprint = digest(query);
      if (cursorState && cursorState.queryFingerprint !== queryFingerprint) {
        throw new Error("Cursor query mismatch");
      }
      const fingerprint = digest({
        query,
        inputCursor: params.cursor ?? null,
        ...(refresh ? { refreshCall: toolCallId } : {}),
      });
      const reserved = await ledger.reserveQuery({
        toolCallId,
        fingerprint,
        query,
        inputCursor: params.cursor,
      });
      assertCurrent(signal);
      if (reserved.kind === "cached") {
        return jsonResult(
          withEvidenceLink({ ...reserved.receipt.result, reusedEvidence: true }, query, config),
        );
      }
      if (reserved.kind !== "reserved") {
        throw new Error(
          `This log read has an unresolved prior attempt; owner recovery must inspect receipt ${reserved.kind === "legacy" ? "legacy:" : ""}${reserved.receipt.id} before retrying`,
        );
      }
      let finished = false;
      try {
        const fromBuffer = Boolean(cursorState?.pendingRows?.length);
        const page = fromBuffer
          ? {
              entries: cursorState.pendingRows,
              nextPageToken: cursorState.backendToken,
              projectionTruncated: cursorState.projectionTruncated,
            }
          : await readPage(query, cursorState?.backendToken ?? null, signal);
        assertCurrent(signal);
        if (!Array.isArray(page.entries) || page.entries.length > query.limit) {
          throw new Error("Invalid bounded cloud page");
        }
        const state = { truncated: false };
        const rows = page.entries.map((row) => selectedEntry(row, state));
        const details = evidence(
          { stdout: JSON.stringify(rows), code: 0, termination: "exit", killed: false },
          query,
          config,
          { reserveBytes: 1024 },
        );
        if (rows.length && details.processedRows === 0) {
          throw new Error(
            "One log entry exceeds the evidence budget; request a smaller reviewed projection",
          );
        }
        const pendingRows = rows.slice(details.processedRows);
        const backendToken = page.nextPageToken || null;
        const hasMore = Boolean(pendingRows.length || backendToken);
        const nextCursor = hasMore ? (reserved.receipt?.id ?? fingerprint) : null;
        const reasons = details.truncationReasons.filter((reason) => reason !== "row-limit");
        if ((state.truncated || page.projectionTruncated) && !reasons.includes("field")) {
          reasons.push("field");
        }
        if (hasMore) {
          reasons.push("more-pages");
        }
        Object.assign(details, {
          truncationReasons: reasons,
          truncated: reasons.length > 0,
          nextCursor,
          windowExhausted: !hasMore && details.invalidRows === 0,
          fromBuffer,
          retrievedAt: fromBuffer ? cursorState.retrievedAt : new Date().toISOString(),
          reusedEvidence: false,
          note: "Untrusted log evidence. windowExhausted applies only to this exact filter and time slice at retrieval. Shortened fields remain disclosed; this is not a total alert count, cause, or recovery conclusion.",
        });
        if (Buffer.byteLength(JSON.stringify(details)) > 30 * 1024) {
          throw new Error("Evidence metadata exceeds the output limit; no cursor was advanced");
        }
        assertCurrent(signal);
        await ledger.finishQuery({
          toolCallId,
          receiptId: reserved.receipt?.id ?? fingerprint,
          result: details,
          cursorState: hasMore
            ? {
                id: nextCursor,
                queryFingerprint,
                query,
                pendingRows,
                backendToken,
                retrievedAt: details.retrievedAt,
                projectionTruncated: Boolean(state.truncated || page.projectionTruncated),
              }
            : undefined,
        });
        finished = true;
        assertCurrent(signal);
        return jsonResult(details);
      } catch (error) {
        // No expired invocation may persist or disclose a result. An uncommitted
        // reserved receipt deliberately remains unresolved after cancellation.
        assertCurrent(signal);
        if (!finished) {
          await ledger.failQuery({
            toolCallId,
            receiptId: reserved.receipt?.id ?? fingerprint,
            reason: "Cloud page unavailable; inspect the original attempt before retrying",
          });
        }
        throw error;
      }
    },
  };
}
