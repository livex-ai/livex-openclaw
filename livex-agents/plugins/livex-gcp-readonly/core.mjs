import { isAbsolute } from "node:path";

const MAX_STDOUT = 256 * 1024;
const MAX_RESULT = 30 * 1024;
// Local output budget, not a Google Console URL limit.
const MAX_EVIDENCE_URL = 4096;
const RESOURCE_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const LABEL_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_LABELS = 16;
const MAX_LITERAL = 256;
const MAX_INSERT_IDS = 10;
const TRUNCATION_REASONS = ["field", "row-limit", "result-byte", "invalid-row"];
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
const CORRELATION_FIELDS = {
  conversationId: "jsonPayload.conversation_id",
  jobId: "jsonPayload.job_id",
  roomId: "jsonPayload.room_id",
  insertId: "insertId",
};
const CORRELATION_KEYS = [...Object.keys(CORRELATION_FIELDS), "traceId"];
// Shorten large plain-text errors before stdout capture. One extra character
// lets the existing egress truncation mark the returned evidence as incomplete.
const FORMAT =
  "json(timestamp,severity,insertId,resource.type,resource.labels,textPayload.trailoff(2049),jsonPayload.level,jsonPayload.levelname,jsonPayload.message,jsonPayload.error,jsonPayload.stack,jsonPayload.filename,jsonPayload.lineno,jsonPayload.funcName,jsonPayload.exc_info,jsonPayload.conversation_id,jsonPayload.job_id,jsonPayload.room_id,jsonPayload.room,jsonPayload.agent_id,jsonPayload.trace_id,trace)";
const ERRORS =
  '(severity>=ERROR OR jsonPayload.level="error" OR jsonPayload.level="ERROR" OR jsonPayload.levelname="ERROR")';

export function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid plugin configuration");
  for (const key of ["gcloudPath", "cloudSdkConfig"]) {
    if (typeof value[key] !== "string" || !isAbsolute(value[key]) || /[\x00-\x1f]/.test(value[key]))
      throw new Error(`Invalid plugin ${key}`);
  }
  for (const key of ["project", "allowedSenderId"]) {
    if (typeof value[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value[key]))
      throw new Error(`Invalid plugin ${key}`);
  }
  if (
    typeof value.allowedChannelId !== "string" ||
    !/^(?:\*|[CG][A-Z0-9]+)$/.test(value.allowedChannelId)
  )
    throw new Error("Invalid plugin allowedChannelId");
  if (
    typeof value.gcloudAccount !== "string" ||
    value.gcloudAccount.length > 254 ||
    !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(value.gcloudAccount)
  )
    throw new Error("Invalid plugin gcloudAccount");
  return Object.freeze({ ...value });
}

function utc(value) {
  const match =
    typeof value === "string" &&
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) throw new Error("Invalid UTC timestamp");
  const wholeSecond = `${match[1]}.000Z`;
  const milliseconds = Date.parse(wholeSecond);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== wholeSecond)
    throw new Error("Invalid UTC timestamp");
  // Date validates the calendar; integer nanoseconds retain the original bounds.
  return {
    value: match[2] === undefined ? wholeSecond : value,
    nanoseconds: BigInt(milliseconds) * 1000000n + BigInt((match[2] ?? "").padEnd(9, "0")),
  };
}

function literal(value, field) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_LITERAL ||
    CONTROL_CHARACTERS.test(value)
  )
    throw new Error(
      `Invalid ${field}: use a nonempty literal of at most ${MAX_LITERAL} characters without control characters`,
    );
  return value;
}

export function queryArgs(params, config) {
  if (
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    Object.keys(params).some(
      (k) =>
        ![
          "resourceType",
          "resourceLabels",
          "start",
          "end",
          "limit",
          "mode",
          "insertIds",
          ...CORRELATION_KEYS,
        ].includes(k),
    )
  )
    throw new Error("Invalid query arguments");
  const mode = params.mode === undefined ? "errors" : params.mode;
  if (!["errors", "context", "discover"].includes(mode)) throw new Error("Invalid query mode");
  const correlation = Object.fromEntries(
    CORRELATION_KEYS.flatMap((key) =>
      params[key] === undefined ? [] : [[key, literal(params[key], key)]],
    ),
  );
  if (params.insertIds !== undefined) {
    if (params.insertId !== undefined)
      throw new Error("Invalid insertIds: use either insertId or insertIds");
    if (
      !Array.isArray(params.insertIds) ||
      params.insertIds.length < 1 ||
      params.insertIds.length > MAX_INSERT_IDS
    )
      throw new Error(`Invalid insertIds: use 1 to ${MAX_INSERT_IDS} observed IDs`);
    correlation.insertIds = Array.from(params.insertIds, (value) => literal(value, "insertIds"));
  }
  let selection = {};
  if (mode === "discover") {
    if ("resourceType" in params || "resourceLabels" in params)
      throw new Error(
        "Invalid discovery selectors: omit resourceType and resourceLabels; discover them from results",
      );
    if (Object.keys(correlation).length === 0)
      throw new Error(
        "Invalid discovery query: supply an observed conversationId, jobId, roomId, traceId, insertId or insertIds",
      );
  } else {
    if (typeof params.resourceType !== "string" || !RESOURCE_TYPE.test(params.resourceType))
      throw new Error("Invalid resourceType");
    if (
      !params.resourceLabels ||
      typeof params.resourceLabels !== "object" ||
      Array.isArray(params.resourceLabels)
    )
      throw new Error("Invalid resourceLabels");
    const labels = Object.entries(params.resourceLabels);
    if (labels.length < 1 || labels.length > MAX_LABELS)
      throw new Error(`Invalid resourceLabels: use 1 to ${MAX_LABELS} labels`);
    const resourceLabels = Object.fromEntries(
      labels.map(([key, value]) => {
        if (!LABEL_KEY.test(key)) throw new Error("Invalid resource label name");
        const validated = literal(value, "resource label value");
        if (key === "project_id" && validated !== config.project)
          throw new Error("Invalid resourceLabels.project_id: use the configured project");
        return [key, validated];
      }),
    );
    selection = { resourceType: params.resourceType, resourceLabels };
  }
  const start = utc(params.start);
  const end = utc(params.end);
  if (end.nanoseconds <= start.nanoseconds || end.nanoseconds - start.nanoseconds > 3600000000000n)
    throw new Error("Invalid query window: use at most one hour");
  const limit = params.limit === undefined ? 20 : params.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error("Invalid row limit: use 1 to 50");
  return {
    ...selection,
    ...correlation,
    start: start.value,
    end: end.value,
    limit,
    mode,
  };
}

// Callers pass a query admitted by queryArgs and configuration by validateConfig.
export function buildLogFilter(query, config) {
  const projectPattern = config.project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const traceClauses =
    query.traceId === undefined ? [] : [`jsonPayload.trace_id=${JSON.stringify(query.traceId)}`];
  if (query.traceId && /^[a-fA-F0-9]{32}$/.test(query.traceId) && !/^0{32}$/.test(query.traceId)) {
    traceClauses.push(
      `trace=${JSON.stringify(query.traceId)}`,
      `trace=${JSON.stringify(`projects/${config.project}/traces/${query.traceId}`)}`,
    );
  }
  const correlation = Object.entries(CORRELATION_FIELDS).flatMap(([key, field]) =>
    query[key] === undefined ? [] : [`${field}=${JSON.stringify(query[key])}`],
  );
  if (query.insertIds)
    correlation.push(
      `(${query.insertIds.map((value) => `insertId=${JSON.stringify(value)}`).join(" OR ")})`,
    );
  if (traceClauses.length) correlation.push(`(${traceClauses.join(" OR ")})`);
  const resourceScope =
    query.mode === "discover"
      ? ['(resource.type="cloud_run_revision" OR resource.type="k8s_container")']
      : [
          `resource.type=${JSON.stringify(query.resourceType)}`,
          ...Object.entries(query.resourceLabels).map(
            ([key, value]) => `resource.labels.${key}=${JSON.stringify(value)}`,
          ),
        ];
  return [
    // --project selects the read scope; logName also excludes imported logs from other projects.
    `logName =~ ${JSON.stringify(`^projects/${projectPattern}/logs/`)}`,
    ...resourceScope,
    `timestamp>="${query.start}"`,
    `timestamp<="${query.end}"`,
    ...(query.mode === "errors" ? [ERRORS] : []),
    ...(query.mode === "discover" ? [`(${correlation.join(" OR ")})`] : correlation),
  ].join(" AND ");
}

function markTruncated(state, reason) {
  state.truncated = true;
  state.truncationReasons ??= [];
  if (!state.truncationReasons.includes(reason)) state.truncationReasons.push(reason);
}

export function redact(value, state, maxLength = 2048) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  // CLI projection may have already shortened this field; redaction can shrink it.
  if (String(value).length > maxLength) markTruncated(state, "field");
  let text = String(value)
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[REDACTED]",
    )
    .replace(/https?:\/\/[^\s<>"']+/gi, (url) => {
      try {
        const parsed = new URL(url);
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      } catch {
        return "[REDACTED URL]";
      }
    })
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]")
    .replace(/\b(Basic|Bearer)\s+[^\s,;"']+/gi, "$1 [REDACTED]")
    .replace(
      /((?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|token)\s*["']?\s*[:=]\s*)(["'])[\s\S]*?(?:\2|$)/gi,
      '$1"[REDACTED]"',
    )
    .replace(
      /((?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|token)\s*["']?\s*[:=]\s*["']?)[^\s,;"']+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:xox[baprs]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+|AIza[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      "[REDACTED]",
    );
  if (text.length > maxLength) {
    markTruncated(state, "field");
    text = text.slice(0, maxLength) + "…";
  }
  return text;
}

function selectedLabels(raw, state) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = Object.entries(raw);
  if (entries.length > MAX_LABELS) markTruncated(state, "field");
  return Object.fromEntries(
    entries.slice(0, MAX_LABELS).flatMap(([key, value]) => {
      if (!LABEL_KEY.test(key)) {
        markTruncated(state, "field");
        return [];
      }
      const text = /password|passwd|secret|token|authorization|api[_-]?key/i.test(key)
        ? "[REDACTED]"
        : redact(value, state, MAX_LITERAL);
      if (text === undefined) {
        markTruncated(state, "field");
        return [];
      }
      return [[key, text]];
    }),
  );
}

export function selectedEntry(raw, state) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    markTruncated(state, "invalid-row");
    return null;
  }
  const entry = {};
  for (const key of ["timestamp", "severity", "insertId", "textPayload", "trace"]) {
    const text = redact(raw[key], state);
    if (text !== undefined) entry[key] = text;
  }
  const type = redact(raw.resource?.type, state, 128);
  entry.resource = {
    ...(type !== undefined ? { type } : {}),
    labels: selectedLabels(raw.resource?.labels, state),
  };
  const payload = {};
  for (const key of [
    "level",
    "levelname",
    "message",
    "stack",
    "filename",
    "lineno",
    "funcName",
    "exc_info",
    "conversation_id",
    "job_id",
    "room_id",
    "room",
    "agent_id",
    "trace_id",
  ]) {
    const text = redact(raw.jsonPayload?.[key], state);
    if (text !== undefined) payload[key] = text;
  }
  const error = raw.jsonPayload?.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    payload.error = {};
    for (const key of ["name", "message", "stack", "code"]) {
      const text = redact(error[key], state);
      if (text !== undefined) payload.error[key] = text;
    }
  } else {
    const text = redact(error, state);
    if (text !== undefined) payload.error = text;
  }
  if (Object.keys(payload).length) entry.jsonPayload = payload;
  return entry;
}

function queryEvidenceMetadata(query, state) {
  return {
    ...query,
    ...(query.resourceLabels
      ? { resourceLabels: selectedLabels(query.resourceLabels, state) }
      : {}),
    ...Object.fromEntries(
      CORRELATION_KEYS.flatMap((key) =>
        query[key] === undefined ? [] : [[key, redact(query[key], state, MAX_LITERAL)]],
      ),
    ),
    ...(query.insertIds
      ? { insertIds: query.insertIds.map((value) => redact(value, state, MAX_LITERAL)) }
      : {}),
  };
}

function logsExplorerLink(query, config, metadata = queryEvidenceMetadata(query, {})) {
  const filter = buildLogFilter(query, config);
  // Encoding must not bypass the same redaction used for returned selectors.
  // A changed filter would also make the link misrepresent the executed read.
  if (buildLogFilter(metadata, config) !== filter)
    return { logsExplorerLinkUnavailableReason: "query-redacted" };
  const url = new URL("https://console.cloud.google.com/logs/query");
  url.searchParams.set("project", config.project);
  url.searchParams.set("query", filter); // Contains the exact inclusive UTC bounds.
  const logsExplorerUrl = url.href;
  return Buffer.byteLength(logsExplorerUrl) <= MAX_EVIDENCE_URL
    ? { logsExplorerUrl }
    : { logsExplorerLinkUnavailableReason: "url-too-long" };
}

export function withEvidenceLink(details, query, config) {
  if (details.logsExplorerUrl || details.logsExplorerLinkUnavailableReason) return details;
  // Older cached receipts need no cloud reread or stored-history rewrite.
  const linked = { ...details, ...logsExplorerLink(query, config) };
  if (Buffer.byteLength(JSON.stringify(linked)) <= MAX_RESULT) return linked;
  const omitted = { ...details, logsExplorerLinkUnavailableReason: "result-byte-limit" };
  return Buffer.byteLength(JSON.stringify(omitted)) <= MAX_RESULT ? omitted : details;
}

export function evidence(result, query, config, { reserveBytes = 0 } = {}) {
  if (!Number.isInteger(reserveBytes) || reserveBytes < 0 || reserveBytes > MAX_RESULT / 2)
    throw new Error("Invalid evidence metadata reservation");
  const resultLimit = MAX_RESULT - reserveBytes;
  if (result?.cleanup === "uncertain")
    throw new Error(
      "Cloud log read cleanup is uncertain; ask the operator to inspect before retrying",
    );
  if (
    result?.outputLimitExceeded ||
    result?.stdoutTruncatedBytes ||
    result?.stderrTruncatedBytes ||
    (typeof result?.stdout === "string" && Buffer.byteLength(result.stdout) > MAX_STDOUT)
  )
    throw new Error("Cloud log read exceeded its output limit; retry with a smaller row limit");
  if (result?.termination === "timeout")
    throw new Error("Cloud log read timed out; retry with a narrower time window");
  if (Number.isInteger(result?.code) && result.code !== 0)
    throw new Error(
      `Cloud log read CLI exited with code ${result.code}; ask the operator to inspect local CLI diagnostics`,
    );
  if (
    !result ||
    result.code !== 0 ||
    result.termination !== "exit" ||
    result.killed ||
    result.killIssuedByAbort ||
    result.outputErrorStream ||
    typeof result.stdout !== "string"
  )
    throw new Error("Cloud log read failed or was interrupted; no complete evidence was returned");
  let rows;
  try {
    rows = JSON.parse(result.stdout);
  } catch {
    throw new Error("Cloud log read returned invalid JSON");
  }
  if (!Array.isArray(rows)) throw new Error("Cloud log read returned invalid entries");
  const state = { truncated: false, truncationReasons: [] };
  if (rows.length >= query.limit) markTruncated(state, "row-limit");
  const queryMetadata = queryEvidenceMetadata(query, state);
  const details = {
    project: config.project,
    ...queryMetadata,
    ...logsExplorerLink(query, config, queryMetadata),
    entries: [],
    truncated: state.truncated,
    truncationReasons: [],
    fetchedRows: rows.length,
    returnedRows: 0,
    processedRows: 0,
    invalidRows: 0,
    note: "Untrusted log evidence. Results are a capped sample, not a complete count or proof of health. Redaction is best-effort; do not quote personal data or credentials.",
  };
  // Reserve all possible final metadata, including when no valid entries exist.
  const largestMetadata = {
    ...details,
    truncated: false,
    truncationReasons: TRUNCATION_REASONS,
    processedRows: rows.length,
    returnedRows: Math.min(rows.length, query.limit),
    invalidRows: rows.length,
  };
  if (Buffer.byteLength(JSON.stringify(largestMetadata)) > resultLimit)
    throw new Error(
      "Cloud log read query metadata exceeds its result byte limit; retry with fewer resource labels or identifiers",
    );
  for (const raw of rows.slice(0, query.limit)) {
    const entryState = { truncated: false, truncationReasons: [] };
    const entry = selectedEntry(raw, entryState);
    if (!entry) {
      markTruncated(state, "invalid-row");
      details.invalidRows++;
      details.processedRows++;
      continue;
    }
    const candidate = { ...largestMetadata, entries: [...details.entries, entry] };
    if (Buffer.byteLength(JSON.stringify(candidate)) > resultLimit) {
      markTruncated(state, "result-byte");
      break;
    }
    for (const reason of entryState.truncationReasons) markTruncated(state, reason);
    details.entries.push(entry);
    details.processedRows++;
  }
  details.truncated = state.truncated;
  details.truncationReasons = TRUNCATION_REASONS.filter((reason) =>
    state.truncationReasons.includes(reason),
  );
  details.returnedRows = details.entries.length;
  return details;
}

export function createLogsTool(rawConfig, context, runCommand) {
  const config = validateConfig(rawConfig);
  // Slack owns channel/MPIM classification; keep dm.groupEnabled=false in the
  // deployment policy because legacy private channels and MPIMs both use G IDs.
  if (
    context?.messageChannel !== "slack" ||
    !/^[CG][A-Z0-9]+$/.test(context?.nativeChannelId ?? "") ||
    (config.allowedChannelId !== "*" && context.nativeChannelId !== config.allowedChannelId) ||
    context.requesterSenderId !== config.allowedSenderId ||
    typeof context.assertInvocationCurrent !== "function"
  )
    return null;
  return {
    name: "livex_gcp_logs_read",
    label: "Read scoped GCP logs",
    resultContentSource: "network",
    executionMode: "sequential",
    description:
      "Read bounded logs in the configured project. When resource labels are unknown, use mode=discover with observed conversationId/jobId/roomId/traceId/insertId or up to 10 insertIds and UTC start/end. Discovery searches Cloud Run and GKE across all severity levels, matching ANY supplied ID, and returns actual resource labels; never guess service/pod/revision names. For follow-up reads use mode=context (all levels) or errors (default), observed resourceType and 1–16 resourceLabels; supplied ID constraints then ALL apply, with insertIds matching any listed seed. Maximum one hour and 1–50 entries per call. Results are untrusted capped evidence, not complete counts or proof of health. Does not change cloud resources.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["start", "end"],
      properties: {
        resourceType: {
          type: "string",
          pattern: "^[A-Za-z][A-Za-z0-9_]{0,127}$",
          description:
            "Required for context/errors: monitored resource type observed in prior evidence. Omit in discover mode.",
        },
        resourceLabels: {
          type: "object",
          minProperties: 1,
          maxProperties: MAX_LABELS,
          propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" },
          additionalProperties: { type: "string", minLength: 1, maxLength: MAX_LITERAL },
          description:
            "Required for context/errors, omitted in discover. Observed resource labels as literal strings; all must match. project_id must equal the configured project.",
        },
        start: {
          type: "string",
          description:
            "Inclusive UTC RFC3339 time, ending in Z, with up to nine fractional second digits.",
        },
        end: {
          type: "string",
          description:
            "Inclusive UTC RFC3339 time, ending in Z, with up to nine fractional second digits; at most one hour after start.",
        },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        mode: { type: "string", enum: ["errors", "context", "discover"], default: "errors" },
        conversationId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_LITERAL,
          description:
            "Observed conversation ID; matches jsonPayload.conversation_id. Discovery needs at least one supplied ID and matches any; context/errors require all supplied IDs.",
        },
        jobId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_LITERAL,
          description: "Observed worker job ID; matches jsonPayload.job_id.",
        },
        roomId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_LITERAL,
          description: "Observed room ID; matches jsonPayload.room_id (not room name).",
        },
        insertId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_LITERAL,
          description:
            "Optional log insertId equality match. Omit it when expanding from one event to its correlated trace.",
        },
        insertIds: {
          type: "array",
          minItems: 1,
          maxItems: MAX_INSERT_IDS,
          items: { type: "string", minLength: 1, maxLength: MAX_LITERAL },
          description:
            "Observed log insert IDs, matching any listed seed. Mutually exclusive with insertId; omit when expanding correlated context.",
        },
        traceId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_LITERAL,
          description:
            "Observed jsonPayload.trace_id equality match; nonzero 32-hex IDs also match bare and configured-project Cloud Trace fields. AND with other IDs in context/errors, OR in discover.",
        },
      },
    },
    async execute(_toolCallId, params, signal) {
      const query = queryArgs(params, config);
      const filter = buildLogFilter(query, config);
      const argv = [
        config.gcloudPath,
        "logging",
        "read",
        filter,
        `--project=${config.project}`,
        `--account=${config.gcloudAccount}`,
        `--limit=${query.limit}`,
        "--order=desc",
        `--format=${FORMAT}`,
        "--quiet",
      ];
      signal?.throwIfAborted();
      context.assertInvocationCurrent();
      let result;
      try {
        result = await runCommand(argv, {
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
            ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
            LANG: "en_US.UTF-8",
            CLOUDSDK_CONFIG: config.cloudSdkConfig,
            CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
            CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "1",
            CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: "1",
            // A persisted alternate credential or impersonation setting must not override --account.
            CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: "",
            CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "",
            CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: "",
            CLOUDSDK_AUTH_ACCESS_TOKEN: "",
            CLOUDSDK_AUTH_DISABLE_CREDENTIALS: "false",
            CLOUDSDK_CORE_LOG_HTTP: "false",
          },
        });
      } catch (error) {
        if (
          error?.code === "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" ||
          error?.cleanup === "uncertain"
        )
          throw new Error(
            "Cloud log read cleanup is uncertain; ask the operator to inspect before retrying",
          );
        throw new Error(
          "Cloud log read could not complete; ask the operator to check local gcloud access",
        );
      }
      signal?.throwIfAborted();
      context.assertInvocationCurrent();
      const details = evidence(result, query, config);
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  };
}
