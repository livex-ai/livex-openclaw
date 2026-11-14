import { isAbsolute } from "node:path";
import { logNotOffered, toolGateRefusal } from "./tool-gate.mjs";

const MAX_STDOUT = 256 * 1024;
const MAX_RESULT = 30 * 1024;
// Local output budget, not a Google Console URL limit.
const MAX_EVIDENCE_URL = 4096;
// Longest evidence link the Slack summary card accepts, measured after `&` is escaped to `&amp;`.
// Must equal MAX_EVIDENCE_URL in ../livex-slack-summary/core.mjs: a longer link is dropped from
// the card ("No verified evidence link"), so the logs tool does not offer one.
export const MAX_CARD_EVIDENCE_URL = 1600;
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
const KIOSK_SELECTORS = {
  kiosk_renderer: { deviceSerial: "^[a-fA-F0-9]{32}$" },
  mappedin_token_request: {
    agentId: "^pub-[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$",
    mapId: "^[a-fA-F0-9]{24}$",
  },
};
export const KIOSK_MODES = Object.keys(KIOSK_SELECTORS);
export const KIOSK_FIELDS = Object.fromEntries(
  Object.entries({
    ...KIOSK_SELECTORS.kiosk_renderer,
    ...KIOSK_SELECTORS.mappedin_token_request,
  }).map(([key, pattern]) => [key, { type: "string", pattern }]),
);
// Text-bearing fields the entry projection reads; a phrase may match any of them (case-insensitive
// substring, Cloud Logging's has operator).
const TEXT_FIELDS = [
  "textPayload",
  "jsonPayload.message",
  "jsonPayload.error",
  "jsonPayload.error.message",
  "jsonPayload.error.stack",
  "jsonPayload.stack",
  "jsonPayload.exc_info",
  "jsonPayload.exception",
];
const MIN_PHRASE = 3;
const MAX_PHRASE = 200;
const MAX_PHRASES = 5;
const COUNT_MAX_WINDOW_MS = 6 * 60 * 60 * 1000;
const COUNT_MAX_FUTURE_MS = 5 * 60 * 1000;
const COUNT_HOUR_NS = 3600n * 1_000_000_000n;
const COUNT_SCAN_CAP = 5000;
const COUNT_PAGE = 800;
const COUNT_MIN_PAGE = 250;
const COUNT_DEADLINE_MS = 60000;
const COUNT_CALL_TIMEOUT_MS = 30000;
const COUNT_SAMPLES = 3;
// Count key for "every entry of agentId" when no phrases are supplied (shorter than any phrase).
const ALL_ENTRIES = "*";
const COUNT_SAMPLE_TEXT = 300;
// Counting needs only identity; one entry is about 200 bytes, so a page stays far below MAX_STDOUT.
const COUNT_FORMAT = "json(timestamp,insertId)";
const TOOL_IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TOOL_OFFER_BYTES = 1024;
// Shorten large plain-text errors before stdout capture. One extra character
// lets the existing egress truncation mark the returned evidence as incomplete.
const FORMAT =
  "json(timestamp,severity,insertId,resource.type,resource.labels,textPayload.trailoff(2049),jsonPayload.level,jsonPayload.levelname,jsonPayload.message,jsonPayload.error,jsonPayload.stack,jsonPayload.filename,jsonPayload.lineno,jsonPayload.funcName,jsonPayload.exc_info,jsonPayload.exception,jsonPayload.conversation_id,jsonPayload.job_id,jsonPayload.room_id,jsonPayload.room,jsonPayload.agent_id,jsonPayload.trace_id,trace)";
const ERRORS =
  '(severity>=ERROR OR jsonPayload.level="error" OR jsonPayload.level="ERROR" OR jsonPayload.levelname="ERROR")';
// Matches the application-error alert's tab-delimited level, independently of Cloud severity.
const TAB_DELIMITED_ERRORS =
  '((jsonPayload:* AND severity>=ERROR) OR textPayload =~ "^[^\\t]+\\t(ERROR|DPANIC|PANIC|FATAL)\\t")';

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

function phrase(value, field) {
  if (
    typeof value !== "string" ||
    value.length < MIN_PHRASE ||
    value.length > MAX_PHRASE ||
    value.trim().length < MIN_PHRASE ||
    CONTROL_CHARACTERS.test(value) ||
    // A phrase echoed in results and links must be exactly what was searched.
    redact(value, {}) !== value
  )
    throw new Error(
      `Invalid ${field}: use a literal phrase of ${MIN_PHRASE} to ${MAX_PHRASE} characters without control characters, credentials or personal data`,
    );
  return value;
}

function resourceSelection(params, config) {
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
  return { resourceType: params.resourceType, resourceLabels };
}

function countQueryArgs(params, config, now) {
  if (
    Object.keys(params).some(
      (k) => !["mode", "resourceType", "resourceLabels", "phrases", "agentId", "start", "end"].includes(k),
    )
  )
    throw new Error(
      "Invalid count arguments: use only mode, resourceType, resourceLabels, phrases, agentId, start and end",
    );
  const selection = resourceSelection(params, config);
  const agentId = params.agentId === undefined ? undefined : literal(params.agentId, "agentId");
  // Without agentId at least one phrase is required; with it, no phrases counts every entry of that agent.
  let phrases;
  if (params.phrases !== undefined || agentId === undefined) {
    if (
      !Array.isArray(params.phrases) ||
      params.phrases.length < (agentId === undefined ? 1 : 0) ||
      params.phrases.length > MAX_PHRASES
    )
      throw new Error(`Invalid phrases: use 1 to ${MAX_PHRASES} literal phrases`);
    phrases = params.phrases.map((value) => phrase(value, "phrases"));
    if (new Set(phrases).size !== phrases.length) throw new Error("Invalid phrases: remove duplicates");
    if (phrases.length === 0) phrases = undefined;
  }
  const start = utc(params.start);
  const end = utc(params.end);
  if (
    end.nanoseconds <= start.nanoseconds ||
    end.nanoseconds - start.nanoseconds > BigInt(COUNT_MAX_WINDOW_MS) * 1_000_000n
  )
    throw new Error("Invalid query window: use at most 6 hours for count");
  if (end.nanoseconds > BigInt(now() + COUNT_MAX_FUTURE_MS) * 1_000_000n)
    throw new Error("Invalid query window: end must be at most 5 minutes in the future");
  return {
    ...selection,
    ...(phrases ? { phrases } : {}),
    ...(agentId === undefined ? {} : { agentId }),
    start: start.value,
    end: end.value,
    mode: "count",
  };
}

function kioskQueryArgs(params) {
  const selectors = KIOSK_SELECTORS[params.mode];
  const keys = Object.keys(selectors);
  if (
    Object.keys(params).some((key) => !["mode", "start", "end", "limit", ...keys].includes(key))
  ) {
    throw new Error("Invalid kiosk profile selectors");
  }
  const selection = Object.fromEntries(
    keys.map((key) => {
      const value = literal(params[key], key);
      if (!new RegExp(selectors[key]).test(value)) throw new Error(`Invalid ${key}`);
      return [key, value];
    }),
  );
  return { ...selection, ...queryWindow(params, 10), mode: params.mode };
}

function queryWindow(params, minutes) {
  const start = utc(params.start);
  const end = utc(params.end);
  if (
    end.nanoseconds <= start.nanoseconds ||
    end.nanoseconds - start.nanoseconds > BigInt(minutes) * 60_000_000_000n
  ) {
    const maximum = minutes === 60 ? "one hour" : `${minutes} minutes`;
    throw new Error(`Invalid query window: use at most ${maximum}`);
  }
  const limit = params.limit === undefined ? 20 : params.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Invalid row limit: use 1 to 50");
  }
  return { start: start.value, end: end.value, limit };
}

export function queryArgs(params, config, { paged = false, now = Date.now } = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Invalid query arguments");
  }
  if (paged && KIOSK_MODES.includes(params.mode)) return kioskQueryArgs(params);
  if (
    Object.keys(params).some(
      (k) =>
        ![
          "resourceType",
          "resourceLabels",
          "start",
          "end",
          "limit",
          "mode",
          "errorProfile",
          "insertIds",
          "textContains",
          "phrases",
          "agentId",
          ...CORRELATION_KEYS,
        ].includes(k),
    )
  )
    throw new Error("Invalid query arguments");
  const mode = params.mode === undefined ? "errors" : params.mode;
  if (!["errors", "context", "discover", "count"].includes(mode)) throw new Error("Invalid query mode");
  if (mode === "count") return countQueryArgs(params, config, now);
  if ("phrases" in params) throw new Error("Invalid phrases: use only in count mode");
  if ("agentId" in params) throw new Error("Invalid agentId: use only in count mode");
  if ("textContains" in params && mode !== "errors" && mode !== "context")
    throw new Error("Invalid textContains: use only in errors or context mode");
  const textContains =
    params.textContains === undefined ? undefined : phrase(params.textContains, "textContains");
  const errorProfile = params.errorProfile;
  if (errorProfile !== undefined && (mode !== "errors" || errorProfile !== "tab-delimited")) {
    throw new Error("Invalid errorProfile: use tab-delimited only in errors mode");
  }
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
    selection = resourceSelection(params, config);
  }
  return {
    ...selection,
    ...correlation,
    ...queryWindow(params, 60),
    mode,
    ...(errorProfile ? { errorProfile } : {}),
    ...(textContains === undefined ? {} : { textContains }),
  };
}

function kioskFilter(query) {
  if (query.mode === "kiosk_renderer") {
    return [
      'resource.type="global"',
      'log_id("avatai-electron")',
      `jsonPayload.serialNumber="${query.deviceSerial}"`,
      'jsonPayload.message=~"NetworkMonitor|MappedinView|UiStateReporter|sendDeviceHeartbeat"',
    ];
  }
  return [
    'resource.type="http_load_balancer"',
    'log_id("requests")',
    'httpRequest.requestMethod="GET"',
    `httpRequest.requestUrl=~"^https://api[.]copilot[.]livex[.]ai/api/v1/mappedin/auth-token/agents/${query.agentId}[?]map_id=${query.mapId}$"`,
  ];
}

function textClause(text) {
  // JSON string escaping covers the two characters special inside a quoted value: " and \.
  return `(${TEXT_FIELDS.map((field) => `${field}:${JSON.stringify(text)}`).join(" OR ")})`;
}

// Callers pass a query admitted by queryArgs and configuration by validateConfig.
export function buildLogFilter(query, config) {
  const projectPattern = config.project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const projectScope = `logName =~ ${JSON.stringify(`^projects/${projectPattern}/logs/`)}`;
  const window = [`timestamp>="${query.start}"`, `timestamp<="${query.end}"`];
  if (KIOSK_MODES.includes(query.mode)) {
    return [projectScope, ...kioskFilter(query), ...window].join(" AND ");
  }
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
    projectScope,
    ...resourceScope,
    ...window,
    ...(query.mode === "errors" ? [query.errorProfile ? TAB_DELIMITED_ERRORS : ERRORS] : []),
    ...(query.mode === "discover" ? [`(${correlation.join(" OR ")})`] : correlation),
    // Count only: the agent id lives in the structured payload, not necessarily in the message text.
    ...(query.agentId === undefined ? [] : [`jsonPayload.agent_id=${JSON.stringify(query.agentId)}`]),
    ...(query.mode === "count"
      ? query.phrases === undefined
        ? []
        : [
            query.phrases.length === 1
              ? textClause(query.phrases[0])
              : `(${query.phrases.map(textClause).join(" OR ")})`,
          ]
      : query.textContains === undefined
        ? []
        : [textClause(query.textContains)]),
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
    .replace(/\bya29\.[A-Za-z0-9._-]{20,}/g, "[REDACTED]")
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

function toolIdentifier(value) {
  return (
    typeof value === "string" &&
    TOOL_IDENTIFIER.test(value) &&
    !CONTROL_CHARACTERS.test(value) &&
    redact(value, {}) === value
  );
}

function selectedToolOffer(value) {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const offer = [];
  for (const tool of value) {
    if (
      !tool ||
      !toolIdentifier(tool.name) ||
      Object.keys(tool).some((key) => key !== "name" && key !== "operations")
    ) {
      return undefined;
    }
    if (Object.hasOwn(tool, "operations")) {
      const { operations } = tool;
      if (
        !Array.isArray(operations) ||
        operations.length > 16 ||
        !operations.every(toolIdentifier)
      ) {
        return undefined;
      }
      offer.push({ name: tool.name, operations });
    } else {
      offer.push({ name: tool.name });
    }
  }
  return Buffer.byteLength(JSON.stringify(offer)) <= MAX_TOOL_OFFER_BYTES ? offer : undefined;
}

export function selectedEntry(raw, state, { mode, paged = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    markTruncated(state, "invalid-row");
    return null;
  }
  const entry = {};
  const tokenRequest = paged && mode === "mappedin_token_request";
  const identity = ["timestamp", "severity", "insertId", "trace"];
  for (const key of tokenRequest ? identity : [...identity, "textPayload"]) {
    const text = redact(raw[key], state);
    if (text !== undefined) entry[key] = text;
  }
  const type = redact(raw.resource?.type, state, 128);
  entry.resource = {
    ...(type !== undefined ? { type } : {}),
    labels: selectedLabels(raw.resource?.labels, state),
  };
  if (tokenRequest) {
    const status = raw.httpRequest?.status;
    if (
      type === "http_load_balancer" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
    ) {
      entry.httpRequest = { status };
    }
    return entry;
  }
  if (paged) {
    const offer = selectedToolOffer(raw.toolOffer);
    if (offer !== undefined) entry.toolOffer = offer;
  }
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
    "exception",
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
    ...(query.textContains === undefined
      ? {}
      : { textContains: redact(query.textContains, state, MAX_PHRASE) }),
    ...(query.phrases
      ? { phrases: query.phrases.map((value) => redact(value, state, MAX_PHRASE)) }
      : {}),
    ...(query.agentId === undefined ? {} : { agentId: redact(query.agentId, state, MAX_LITERAL) }),
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
  return Buffer.byteLength(logsExplorerUrl) <= MAX_EVIDENCE_URL &&
    logsExplorerUrl.replaceAll("&", "&amp;").length <= MAX_CARD_EVIDENCE_URL
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


// Exact-entry Logs Explorer link. Same URL building, redaction and size rules as
// logsExplorerLink; any redaction or oversize result omits the link.
function entryLink(raw, entry, config) {
  if (typeof raw?.insertId !== "string" || typeof entry.insertId !== "string") return undefined;
  if (entry.insertId !== raw.insertId || typeof raw.timestamp !== "string") return undefined;
  if (entry.timestamp !== raw.timestamp) return undefined;
  const millis = Date.parse(raw.timestamp);
  if (!Number.isFinite(millis) || raw.insertId.length > MAX_LITERAL) return undefined;
  const from = new Date(millis - 1000);
  const to = new Date(millis + 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return undefined;
  const filter = [
    `insertId=${JSON.stringify(raw.insertId)}`,
    `timestamp>=${JSON.stringify(from.toISOString())}`,
    `timestamp<=${JSON.stringify(to.toISOString())}`,
  ].join(" AND ");
  const url = new URL("https://console.cloud.google.com/logs/query");
  url.searchParams.set("project", config.project);
  url.searchParams.set("query", filter);
  return Buffer.byteLength(url.href) <= MAX_EVIDENCE_URL ? url.href : undefined;
}

function addEntryLinks(details, rawEntries, config, resultLimit) {
  const links = details.entries.map((entry, i) => entryLink(rawEntries[i], entry, config));
  const fits = (d) => Buffer.byteLength(JSON.stringify(d)) <= resultLimit;
  // Drop links from the oldest entries first until the result fits.
  const order = details.entries
    .map((entry, i) => i)
    .filter((i) => links[i])
    .sort((a, b) => Date.parse(details.entries[a].timestamp) - Date.parse(details.entries[b].timestamp));
  let dropped = 0;
  const build = () => {
    const entries = details.entries.map((entry, i) =>
      links[i] ? { ...entry, entryUrl: links[i] } : entry,
    );
    return dropped ? { ...details, entries, entryUrlsOmitted: dropped } : { ...details, entries };
  };
  let out = build();
  while (!fits(out) && dropped < order.length) {
    links[order[dropped]] = undefined;
    dropped++;
    out = build();
  }
  if (fits(out)) return out;
  // Even with every link removed the omission flag does not fit: keep the original.
  return details;
}

// Validates one gcloud read and returns its parsed rows; every failure is a thrown, fixed message.
function readRows(result) {
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
  return rows;
}

export function evidence(result, query, config, { reserveBytes = 0, paged = false } = {}) {
  if (!Number.isInteger(reserveBytes) || reserveBytes < 0 || reserveBytes > MAX_RESULT / 2)
    throw new Error("Invalid evidence metadata reservation");
  const resultLimit = MAX_RESULT - reserveBytes;
  const rows = readRows(result);
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
  const rawEntries = [];
  for (const raw of rows.slice(0, query.limit)) {
    const entryState = { truncated: false, truncationReasons: [] };
    const entry = selectedEntry(raw, entryState, { mode: query.mode, paged });
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
    rawEntries.push(raw);
    details.processedRows++;
  }
  details.truncated = state.truncated;
  details.truncationReasons = TRUNCATION_REASONS.filter((reason) =>
    state.truncationReasons.includes(reason),
  );
  details.returnedRows = details.entries.length;
  return addEntryLinks(details, rawEntries, config, resultLimit);
}

export function createLogsTool(rawConfig, context, runCommand, options = {}) {
  const config = validateConfig(rawConfig);
  // Slack owns channel/MPIM classification; keep dm.groupEnabled=false in the
  // deployment policy because legacy private channels and MPIMs both use G IDs.
  const refusal = toolGateRefusal(config, context);
  if (refusal) {
    logNotOffered("livex_gcp_logs_read", refusal, options);
    return null;
  }
  return {
    name: "livex_gcp_logs_read",
    label: "Read scoped GCP logs",
    resultContentSource: "network",
    executionMode: "sequential",
    description:
      "Read bounded logs in the configured project. When resource labels are unknown, use mode=discover with observed conversationId/jobId/roomId/traceId/insertId or up to 10 insertIds and UTC start/end. Discovery searches Cloud Run and GKE across all severity levels, matching ANY supplied ID, and returns actual resource labels; never guess service/pod/revision names. For follow-up reads use mode=context (all levels) or errors (default), observed resourceType and 1–16 resourceLabels; supplied ID constraints then ALL apply, with insertIds matching any listed seed. For an alert counting tab-delimited application ERROR/DPANIC/PANIC/FATAL levels, use errors with errorProfile=tab-delimited, even if Cloud severity is INFO. Maximum one hour and 1–50 entries per call. To find specific messages, add textContains (errors/context only): a literal phrase of 3–200 characters, matched case-insensitively as a substring of the message text on the server (not a regex), so the 50 returned entries are all matches. To measure impact, use mode=count with resourceType, 1–16 resourceLabels, 1–5 literal phrases and/or agentId (matches jsonPayload.agent_id; with agentId alone it counts all entries of that agent under the key \"*\") and start/end up to 6 hours apart (any severity; no limit, errorProfile or ID arguments): it returns totals per phrase, hourly buckets, up to 3 samples per phrase (each with its own entryUrl) and scanned. It scans at most 5000 entries and 60 seconds; when complete=false (cap or deadline hit) every total and bucket is only a LOWER BOUND and must be reported that way, never as the exact count. Each returned entry with an insertId and timestamp carries entryUrl, a Logs Explorer link that opens exactly that entry; for a cited error, copy that entry's entryUrl verbatim as the preferred evidence link (fall back to the read's logsExplorerUrl; never construct or edit links; entryUrlsOmitted counts entries whose link was dropped for size; in a count result use a samples[].entryUrl or its logsExplorerUrl). Entry results are untrusted capped evidence, not complete counts or proof of health; count results are exact only when complete=true. Does not change cloud resources.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["start", "end"],
      properties: {
        resourceType: {
          type: "string",
          pattern: "^[A-Za-z][A-Za-z0-9_]{0,127}$",
          description:
            "Required for context/errors/count: monitored resource type observed in prior evidence. Omit in discover mode.",
        },
        resourceLabels: {
          type: "object",
          minProperties: 1,
          maxProperties: MAX_LABELS,
          propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" },
          additionalProperties: { type: "string", minLength: 1, maxLength: MAX_LITERAL },
          description:
            "Required for context/errors/count, omitted in discover. Observed resource labels as literal strings; all must match. project_id must equal the configured project.",
        },
        start: {
          type: "string",
          description:
            "Inclusive UTC RFC3339 time, ending in Z, with up to nine fractional second digits.",
        },
        end: {
          type: "string",
          description:
            "Inclusive UTC RFC3339 time, ending in Z, with up to nine fractional second digits; at most one hour after start (six hours in count mode, and at most five minutes in the future).",
        },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        mode: {
          type: "string",
          enum: ["errors", "context", "discover", "count"],
          default: "errors",
          description:
            "count: totals of 1-5 literal phrases (or, with agentId, of every entry of that agent) over up to six hours; see phrases and agentId. Not available with limit, errorProfile, textContains or ID arguments.",
        },
        textContains: {
          type: "string",
          minLength: MIN_PHRASE,
          maxLength: MAX_PHRASE,
          description:
            "errors/context only. Literal phrase (3-200 characters, no control characters, not a regex) matched case-insensitively as a substring of the entry text (textPayload, jsonPayload.message, error and stack fields) by Cloud Logging itself, so every returned entry matches. Phrases containing credentials or personal data patterns are rejected.",
        },
        phrases: {
          type: "array",
          minItems: 1,
          maxItems: MAX_PHRASES,
          items: { type: "string", minLength: MIN_PHRASE, maxLength: MAX_PHRASE },
          description:
            "count mode only. 1-5 distinct literal phrases, same rules as textContains. Each is counted separately; an entry matching two phrases counts for both. Required unless agentId is given.",
        },
        agentId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_LITERAL,
          description:
            "count mode only. Observed agent ID; every counted entry must have jsonPayload.agent_id equal to it (the structured field, so it finds entries whose message text never mentions the ID). With phrases, each phrase is counted within that agent. Without phrases the result is one total and hourly buckets under the key \"*\" for all entries of that agent.",
        },
        errorProfile: {
          type: "string",
          enum: ["tab-delimited"],
          description:
            "Errors mode only. Matches (jsonPayload present AND severity>=ERROR) OR a textPayload starting with a nonempty timestamp/prefix, tab, ERROR/DPANIC/PANIC/FATAL, tab. Omit for the existing severity/structured-level filter. No custom filter or regex is accepted.",
        },
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
      const query = queryArgs(params, config, { now: options.now });
      if (query.mode === "count") return executeCount(query, signal);
      const filter = buildLogFilter(query, config);
      signal?.throwIfAborted();
      context.assertInvocationCurrent();
      const result = await runGcloudRead(
        gcloudArgv(config, filter, { limit: query.limit, format: FORMAT }),
        signal,
      );
      signal?.throwIfAborted();
      context.assertInvocationCurrent();
      const details = evidence(result, query, config);
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  };

  // One bounded gcloud read. Cleanup uncertainty and other failures keep their fixed messages.
  async function runGcloudRead(argv, signal, timeoutMs = 30000) {
    try {
      return await runCommand(argv, {
        timeoutMs,
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
        throw new CleanupUncertain();
      throw new Error(
        "Cloud log read could not complete; ask the operator to check local gcloud access",
      );
    }
  }

  // mode=count: exact per-phrase totals by scanning one server-filtered stream per phrase.
  async function executeCount(query, callerSignal) {
    const now = options.now ?? Date.now;
    const startedAt = now();
    const deadlineMs = options.deadlineMs ?? COUNT_DEADLINE_MS;
    const startNs = utc(query.start).nanoseconds;
    const endNs = utc(query.end).nanoseconds;
    const bucketCount = Number((endNs - startNs + COUNT_HOUR_NS - 1n) / COUNT_HOUR_NS);
    const reasons = new Set();
    const current = () => {
      callerSignal?.throwIfAborted();
      context.assertInvocationCurrent();
    };
    current();

    // One deadline for the whole call; it also kills a read still in flight.
    const controller = new AbortController();
    const relay = () => controller.abort(callerSignal.reason);
    callerSignal?.addEventListener("abort", relay, { once: true });
    let deadlineHit = false;
    const timer = setTimeout(() => {
      deadlineHit = true;
      controller.abort(new Error("deadline"));
    }, deadlineMs);
    const remainingMs = () => deadlineMs - (now() - startedAt);

    // No phrases: one stream of every entry of the agent, reported under the key "*".
    const phrases = (query.phrases ?? [ALL_ENTRIES]).map((text) => ({
      text,
      total: 0,
      buckets: new Array(bucketCount).fill(0),
      samples: [],
      done: false,
      from: query.start,
      boundaryNs: -1n,
      boundaryIds: new Set(),
    }));
    let scanned = 0;
    let invalidRows = 0;

    // Reads one page. Returns rows, or undefined once the call must stop with partial totals.
    const read = async (state, { limit, order, format }) => {
      current();
      if (deadlineHit || remainingMs() <= 0) {
        reasons.add("deadline");
        return undefined;
      }
      const filter = buildLogFilter(
        {
          ...query,
          start: state.from,
          ...(state.text === ALL_ENTRIES ? { phrases: undefined } : { phrases: [state.text] }),
        },
        config,
      );
      let result;
      try {
        result = await runGcloudRead(
          gcloudArgv(config, filter, { limit, order, format }),
          controller.signal,
          Math.max(1, Math.min(COUNT_CALL_TIMEOUT_MS, remainingMs())),
        );
      } catch (error) {
        if (error instanceof CleanupUncertain) throw error;
        // A stale or cancelled invocation must reach the host unchanged.
        current();
        if (deadlineHit) {
          reasons.add("deadline");
          return undefined;
        }
        throw error;
      }
      current();
      if (result?.cleanup === "uncertain") throw new CleanupUncertain();
      if (deadlineHit) {
        reasons.add("deadline");
        return undefined;
      }
      if (result?.termination === "timeout" && result?.cleanup !== "uncertain") {
        reasons.add("read-timeout");
        return undefined;
      }
      return readRows(result);
    };

    // Places one row in its hour bucket; false for a row that cannot be counted.
    const place = (raw) => {
      let stamp;
      try {
        stamp = utc(raw?.timestamp);
      } catch {
        return undefined;
      }
      const ns = stamp.nanoseconds;
      if (typeof raw.insertId !== "string" || ns < startNs || ns > endNs) return undefined;
      const index = Math.min(Number((ns - startNs) / COUNT_HOUR_NS), bucketCount - 1);
      return { ns, index, value: stamp.value };
    };

    try {
      // Pass 1: up to three newest matches per phrase, with text. Fewer than three means the
      // phrase has exactly that many matches and needs no scan.
      for (const state of phrases) {
        const rows = await read(state, { limit: COUNT_SAMPLES, order: "desc", format: FORMAT });
        if (!rows) break;
        const sampleState = { truncated: false, truncationReasons: [] };
        for (const raw of rows.slice(0, COUNT_SAMPLES)) {
          const placed = place(raw);
          const entry = selectedEntry(raw, sampleState);
          if (!placed || !entry) {
            invalidRows++;
            continue;
          }
          state.samples.push(sampleFor(state.text, raw, entry, config));
          if (rows.length < COUNT_SAMPLES) {
            state.total++;
            state.buckets[placed.index]++;
            scanned++;
          }
        }
        if (rows.length < COUNT_SAMPLES) state.done = true;
      }
      // Pass 2: round-robin pages in ascending time so a cap leaves every phrase scanned alike.
      while (!reasons.has("deadline") && !reasons.has("read-timeout")) {
        const active = phrases.filter((state) => !state.done);
        if (active.length === 0) break;
        let progressed = false;
        for (const state of active) {
          const open = phrases.filter((other) => !other.done).length;
          if (scanned >= COUNT_SCAN_CAP) {
            reasons.add("scan-cap");
            break;
          }
          // Rows already counted at the continuation timestamp come back first, so a read must
          // be longer than that overlap; it never asks for more new rows than the cap leaves.
          const overlap = state.boundaryIds.size;
          const left = COUNT_SCAN_CAP - scanned;
          const share = Math.max(COUNT_MIN_PAGE, Math.ceil(left / open));
          const limit = Math.min(COUNT_PAGE, left + overlap, Math.max(overlap + 1, share));
          const rows = await read(state, { limit, order: "asc", format: COUNT_FORMAT });
          if (!rows) break;
          let added = 0;
          let last;
          for (const raw of rows) {
            const placed = place(raw);
            if (!placed) {
              invalidRows++;
              continue;
            }
            if (placed.ns === state.boundaryNs && state.boundaryIds.has(raw.insertId)) continue;
            if (placed.ns !== state.boundaryNs) {
              state.boundaryNs = placed.ns;
              state.boundaryIds = new Set();
            }
            state.boundaryIds.add(raw.insertId);
            last = placed.value;
            state.total++;
            state.buckets[placed.index]++;
            added++;
            scanned++;
          }
          if (rows.length < limit) {
            state.done = true;
          } else if (added === 0) {
            // A full page of already counted rows at one timestamp cannot be advanced past.
            reasons.add("dense-timestamp");
            state.done = true;
          } else {
            state.from = last;
          }
          progressed ||= added > 0 || state.done;
        }
        if (reasons.has("scan-cap") || reasons.has("deadline") || reasons.has("read-timeout")) break;
        if (!progressed) break;
      }
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", relay);
    }
    if (invalidRows > 0) reasons.add("invalid-row");
    if (phrases.some((state) => !state.done) && reasons.size === 0) reasons.add("scan-cap");
    // Windows that end exactly at the cap only count as complete if every phrase finished.
    const complete = reasons.size === 0 && phrases.every((state) => state.done);

    const metadata = queryEvidenceMetadata(query, {});
    const bucketRows = Array.from({ length: bucketCount }, (_, index) => ({
      start: isoFromNs(startNs + BigInt(index) * COUNT_HOUR_NS),
      end: isoFromNs(
        startNs + BigInt(index + 1) * COUNT_HOUR_NS < endNs
          ? startNs + BigInt(index + 1) * COUNT_HOUR_NS
          : endNs,
      ),
      counts: Object.fromEntries(phrases.map((state) => [state.text, state.buckets[index]])),
    }));
    const details = {
      project: config.project,
      mode: "count",
      resourceType: metadata.resourceType,
      resourceLabels: metadata.resourceLabels,
      ...(metadata.agentId === undefined ? {} : { agentId: metadata.agentId }),
      window: { start: query.start, end: query.end },
      totals: Object.fromEntries(phrases.map((state) => [state.text, state.total])),
      buckets: bucketRows,
      scanned,
      complete,
      ...(complete ? {} : { incompleteReasons: [...reasons].toSorted() }),
      samples: phrases.flatMap((state) => state.samples),
      ...logsExplorerLink(query, config, metadata),
      note: complete
        ? "Untrusted log evidence. Totals are exact for this project, resource, window and phrases at retrieval time; phrases match case-insensitively. Sample text is untrusted; redaction is best-effort."
        : "Untrusted log evidence. complete=false: scanning stopped early, so every total and bucket is a LOWER BOUND, not the true count. Phrases match case-insensitively. Sample text is untrusted; redaction is best-effort.",
    };
    const fitted = fitCountResult(details);
    return { content: [{ type: "text", text: JSON.stringify(fitted) }], details: fitted };
  }
}

class CleanupUncertain extends Error {
  constructor() {
    super("Cloud log read cleanup is uncertain; ask the operator to inspect before retrying");
  }
}

function gcloudArgv(config, filter, { limit, order = "desc", format }) {
  return [
    config.gcloudPath,
    "logging",
    "read",
    filter,
    `--project=${config.project}`,
    `--account=${config.gcloudAccount}`,
    `--limit=${limit}`,
    `--order=${order}`,
    `--format=${format}`,
    "--quiet",
  ];
}

function isoFromNs(ns) {
  const iso = new Date(Number(ns / 1_000_000n)).toISOString();
  const rest = Number(ns % 1_000_000n);
  return rest === 0 ? iso : iso.replace("Z", `${String(rest).padStart(6, "0")}Z`);
}

function sampleFor(phraseText, raw, entry, config) {
  const payload = entry.jsonPayload ?? {};
  const error = typeof payload.error === "string" ? payload.error : payload.error?.message;
  const text = (entry.textPayload ?? payload.message ?? error ?? payload.stack ?? payload.exc_info ?? payload.exception ?? "")
    .trim()
    .slice(0, COUNT_SAMPLE_TEXT);
  const entryUrl = entryLink(raw, entry, config);
  return {
    phrase: phraseText,
    timestamp: entry.timestamp,
    insertId: entry.insertId,
    ...(entryUrl ? { entryUrl } : {}),
    text,
  };
}

// Keeps a count result within MAX_RESULT: samples shrink first, then links, never the counts.
function fitCountResult(details) {
  const fits = (value) => Buffer.byteLength(JSON.stringify(value)) <= MAX_RESULT;
  if (fits(details)) return details;
  for (const textLength of [150, 60, 0]) {
    const samples = details.samples.map((sample) => ({
      ...sample,
      text: sample.text.slice(0, textLength),
    }));
    const candidate = { ...details, samples, samplesTrimmed: true };
    if (fits(candidate)) return candidate;
  }
  for (const candidate of [
    {
      ...details,
      samples: details.samples.map(({ entryUrl: _entryUrl, ...sample }) => ({ ...sample, text: "" })),
      samplesTrimmed: true,
    },
    { ...details, samples: [], samplesOmitted: true },
  ]) {
    if (fits(candidate)) return candidate;
  }
  const { logsExplorerUrl: _url, ...rest } = details;
  const candidate = {
    ...rest,
    samples: [],
    samplesOmitted: true,
    logsExplorerLinkUnavailableReason: "result-byte-limit",
  };
  if (fits(candidate)) return candidate;
  throw new Error("Cloud log count result exceeds its result byte limit; use shorter phrases");
}
