import { createHash } from "node:crypto";

const MAX_RECORD_BYTES = 256 * 1024;
const MAX_RETENTION_METADATA_BYTES = 128;
const clone = (value) => (value === undefined ? undefined : structuredClone(value));
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}
const hash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
function text(value, name, maximum = 512) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw Error(`Invalid ${name}`);
  return value;
}
function pageId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw Error("Invalid page receipt or cursor");
  return value;
}
function queryValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || bytes(value) > 8192)
    throw Error("Invalid page query metadata");
  return JSON.parse(JSON.stringify(value));
}
export function scopeIdentity(context, config) {
  if (
    context?.messageChannel !== "slack" ||
    context.requesterSenderId !== config.allowedSenderId ||
    !/^[CG][A-Z0-9]+$/.test(context.nativeChannelId ?? "") ||
    (config.allowedChannelId !== "*" && context.nativeChannelId !== config.allowedChannelId) ||
    typeof context.assertInvocationCurrent !== "function"
  )
    throw Error("Unauthorized investigation context");
  const identity = Object.fromEntries(
    [
      "agentId",
      "agentAccountId",
      "sessionKey",
      "sessionId",
      "nativeChannelId",
      "requesterSenderId",
    ].map((name) => [name, text(context[name], `${name} identity`)]),
  );
  identity.project = text(config.project, "project identity", 128);
  return hash(identity);
}

function resultValue(result, retrievedAt) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !Array.isArray(result.entries) ||
    result.entries.length > 50
  )
    throw Error("Invalid page result");
  const nextCursor =
    result.nextCursor === undefined || result.nextCursor === null
      ? null
      : pageId(result.nextCursor);
  const value = {
    // Already redacted and bounded by the evidence projector. Keep actual
    // evidence so a lost response or follow-up can recover without a cloud read.
    entries: clone(result.entries),
    nextCursor,
    retrievedAt,
    reusedEvidence: false,
    truncated: result.truncated === true,
    truncationReasons: Array.isArray(result.truncationReasons)
      ? result.truncationReasons
          .filter((reason) => typeof reason === "string")
          .slice(0, 12)
          .map((reason) => reason.slice(0, 64))
      : [],
    windowExhausted: nextCursor === null && result.windowExhausted === true,
    note:
      typeof result.note === "string"
        ? result.note.slice(0, 4096)
        : "Stored projected evidence. Window exhaustion applies only to the original filter at retrieval time, not investigation completion.",
  };
  for (const name of ["project", "start", "end", "mode"])
    if (typeof result[name] === "string") value[name] = result[name].slice(0, 128);
  for (const name of ["fetchedRows", "returnedRows", "processedRows", "invalidRows"])
    if (Number.isSafeInteger(result[name]) && result[name] >= 0) value[name] = result[name];
  for (const name of [
    "resourceType",
    "resourceLabels",
    "limit",
    "conversationId",
    "jobId",
    "roomId",
    "insertId",
    "insertIds",
    "traceId",
  ])
    if (result[name] !== undefined) value[name] = clone(result[name]);
  if (typeof result.fromBuffer === "boolean") value.fromBuffer = result.fromBuffer;
  if (bytes(value) > 64 * 1024) throw Error("Projected page evidence byte limit exceeded");
  return value;
}

function privateCursor(value, record, result) {
  if (value === undefined || value === null) {
    if (result.nextCursor) throw Error("Page result requires a durable cursor");
    return undefined;
  }
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "id",
          "queryFingerprint",
          "query",
          "pendingRows",
          "backendToken",
          "projectionTruncated",
          "retrievedAt",
        ].includes(key),
    )
  )
    throw Error("Invalid page cursor state");
  if (pageId(value.id) !== record.id || value.id !== result.nextCursor)
    throw Error("Cursor does not match its receipt");
  pageId(value.queryFingerprint);
  const query = queryValue(value.query);
  if (hash(query) !== hash(record.query)) throw Error("Cursor query differs from reserved query");
  if (
    !Array.isArray(value.pendingRows) ||
    value.pendingRows.length > 50 ||
    (value.backendToken !== null &&
      (typeof value.backendToken !== "string" || Buffer.byteLength(value.backendToken) > 16384))
  )
    throw Error("Invalid page cursor buffer");
  if (bytes(value) > MAX_RECORD_BYTES) throw Error("Page cursor byte limit exceeded");
  // The pager supplies redacted projections, never raw cloud log payloads.
  const retrievedAt = text(
    value.retrievedAt ?? result.retrievedAt,
    "cursor retrieval timestamp",
    64,
  );
  if (!Number.isFinite(Date.parse(retrievedAt))) throw Error("Invalid cursor retrieval timestamp");
  return {
    id: value.id,
    queryFingerprint: value.queryFingerprint,
    query,
    pendingRows: clone(value.pendingRows),
    backendToken: value.backendToken,
    projectionTruncated: value.projectionTruncated === true,
    retrievedAt,
  };
}

function publicReceipt(record, reusedEvidence = false) {
  return {
    id: record.id,
    status: record.status,
    reservedAt: record.reservedAt,
    ...(record.result ? { result: { ...clone(record.result), reusedEvidence } } : {}),
    ...(record.failure ? { failure: record.failure } : {}),
  };
}

export const PAGE_CACHE_ENTRIES = 200;
export const PAGE_CACHE_ERRORS = Object.freeze({
  expired:
    "Unknown, evicted, or cross-session cursor; resume from the latest retained checkpoint, not a new scan",
  consumed:
    "This cursor was already consumed and its cached successor was evicted; resume from the latest retained checkpoint",
  protected:
    "Log page cache is full of protected checkpoints or unresolved reads; no safe LRU eviction is available; no cloud read was started",
});
const recordKey = (scope, id) => `page:${hash({ scope, id })}`;
function recordFits(value) {
  const { lastUsedAt, cursorConsumed, ...content } = value;
  // Old records can already fill the content allowance. Reserve fixed, small
  // headroom for retention metadata so touching or settling one remains safe.
  return (
    bytes(content) <= MAX_RECORD_BYTES &&
    bytes(value) <= MAX_RECORD_BYTES + MAX_RETENTION_METADATA_BYTES
  );
}
function checkRecord(value, scope, id) {
  if (
    !value ||
    value.version !== 1 ||
    value.scope !== scope ||
    value.id !== id ||
    !["pending", "finished", "failed"].includes(value.status)
  )
    throw Error("Missing or invalid page receipt");
  return value;
}

function finishedRecord(entry) {
  const record = entry.value;
  // Unknown or malformed persisted data is never an eviction candidate.
  try {
    pageId(record.scope);
    pageId(record.id);
    if (
      entry.key !== recordKey(record.scope, record.id) ||
      !recordFits(record) ||
      record.version !== 1 ||
      record.status !== "finished" ||
      !Number.isFinite(Date.parse(record.reservedAt)) ||
      !record.result ||
      !Array.isArray(record.result.entries) ||
      record.completionHash !== hash({ result: record.result, cursorState: record.cursorState })
    )
      return false;
    if (record.cursorState) {
      if (
        record.cursorState.id !== record.id ||
        record.result.nextCursor !== record.id ||
        hash(record.cursorState.query) !== hash(record.query)
      )
        return false;
    } else if (record.result.nextCursor !== null) return false;
    return true;
  } catch {
    return false;
  }
}

function leastRecentlyUsed(entries, protectedKeys) {
  const finished = entries.filter(finishedRecord);
  // Old receipts predate cursorConsumed. A committed successor is the only
  // evidence that its parent's continuation has already been settled.
  const consumed = new Set();
  for (const { value: child } of finished) {
    if (!child.inputCursor) continue;
    const parent = finished.find(
      ({ value }) => value.scope === child.scope && value.id === child.inputCursor,
    );
    if (parent?.value.cursorState && hash(parent.value.query) === hash(child.query))
      consumed.add(parent.key);
  }
  const victim = finished
    .filter(
      ({ key, value }) =>
        !protectedKeys.has(key) &&
        (!value.cursorState || value.cursorConsumed === true || consumed.has(key)),
    )
    .sort((a, b) => {
      const accessed = (record) =>
        Number.isFinite(record.lastUsedAt) ? record.lastUsedAt : Date.parse(record.reservedAt);
      return accessed(a.value) - accessed(b.value) || a.key.localeCompare(b.key);
    })[0];
  // Keep legacy consumption evidence even when the successor is evicted first.
  // Do not touch access times merely because retention inspected a record.
  const settledParents = finished.filter(
    ({ key, value }) => consumed.has(key) && key !== victim?.key && value.cursorConsumed !== true,
  );
  return { victim, settledParents };
}

/** Static, synchronous handler executed by OpenClaw's state owner. */
export function runPageOperation(command, transaction) {
  const input = command.input;
  const scope = pageId(input.scope),
    id = pageId(input.id);
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw Error("Invalid page access time");
  const key = recordKey(scope, id);
  const read = (targetId) => {
    const value = transaction.lookup(0, recordKey(scope, targetId));
    return value === undefined ? undefined : checkRecord(value, scope, targetId);
  };
  const save = (record) => {
    const updated = { ...record, lastUsedAt: Math.max(input.now, record.lastUsedAt ?? 0) };
    if (!recordFits(updated))
      throw Error("Page receipt byte limit exceeded; no continuation was committed");
    transaction.set(0, recordKey(scope, record.id), updated);
    return updated;
  };
  const cursor = (targetId) => {
    pageId(targetId);
    const record = read(targetId);
    if (
      record?.status !== "finished" ||
      !record.cursorState ||
      record.cursorState.id !== targetId
    ) {
      throw Error(PAGE_CACHE_ERRORS.expired);
    }
    return record;
  };
  const own = (record) => {
    if (record.toolCallId !== input.toolCallId)
      throw Error("Page receipt belongs to a different tool call owner");
  };

  if (command.type === "cursor") {
    const record = save(cursor(id));
    return clone(record.cursorState);
  }
  text(input.toolCallId, "tool call id");
  if (command.type === "reserve") {
    const query = queryValue(input.query);
    const current = read(id);
    if (current) {
      if (hash(current.query) !== hash(query) || current.inputCursor !== input.inputCursor)
        throw Error("Fingerprint reused for a different page query");
      const touched = save(current);
      return {
        kind: touched.status === "finished" ? "cached" : "pending",
        receipt: publicReceipt(touched, touched.status === "finished"),
      };
    }
    const protectedKeys = new Set([key]);
    if (input.inputCursor !== undefined) {
      const parent = cursor(input.inputCursor);
      if (hash(parent.query) !== hash(query))
        throw Error("Cursor query differs from requested page");
      if (parent.cursorConsumed === true) throw Error(PAGE_CACHE_ERRORS.consumed);
      protectedKeys.add(recordKey(scope, parent.id));
      save(parent);
    }
    const value = {
      version: 1,
      scope,
      id,
      toolCallId: input.toolCallId,
      query,
      ...(input.inputCursor ? { inputCursor: input.inputCursor } : {}),
      status: "pending",
      reservedAt: new Date(input.now).toISOString(),
      lastUsedAt: input.now,
    };
    try {
      save(value);
    } catch (error) {
      // The native host checks capacity before inserting. Only this known
      // refusal is recoverable; unknown storage outcomes must not be replayed.
      if (error?.code !== "PLUGIN_STATE_LIMIT_EXCEEDED") throw error;
      const { victim, settledParents } = leastRecentlyUsed(transaction.entries(0), protectedKeys);
      if (!victim) throw Error(PAGE_CACHE_ERRORS.protected);
      for (const parent of settledParents) {
        const settled = { ...parent.value, cursorConsumed: true };
        if (!recordFits(settled)) throw Error("Page retention metadata exceeds its byte bound");
        transaction.set(0, parent.key, settled);
      }
      transaction.delete(0, victim.key);
      save(value); // Eviction and reservation commit or roll back together.
    }
    return { kind: "reserved", receipt: publicReceipt(value) };
  }

  const record = checkRecord(read(id), scope, id);
  own(record);
  if (command.type === "finish") {
    if (record.status === "failed")
      throw Error("Failed page receipt cannot be replayed or completed without reconciliation");
    const retrievedAt =
      record.result?.retrievedAt ??
      (typeof input.result?.retrievedAt === "string"
        ? text(input.result.retrievedAt, "retrieval timestamp", 64)
        : new Date(input.now).toISOString());
    if (!Number.isFinite(Date.parse(retrievedAt))) throw Error("Invalid page retrieval timestamp");
    const result = resultValue(input.result, retrievedAt);
    const cursorState = privateCursor(input.cursorState, record, result);
    const completionHash = hash({ result, cursorState });
    if (record.status === "finished") {
      if (record.completionHash !== completionHash)
        throw Error("Finished page receipts are immutable");
      return publicReceipt(save(record));
    }
    const finished = save({
      ...record,
      status: "finished",
      result,
      ...(cursorState ? { cursorState } : {}),
      completionHash,
    });
    if (record.inputCursor) {
      const parent = cursor(record.inputCursor);
      if (hash(parent.query) !== hash(record.query))
        throw Error("Cursor query differs from completed page");
      save({ ...parent, cursorConsumed: true });
    }
    return publicReceipt(finished);
  }
  if (command.type === "fail") {
    const reason = text(input.reason, "page failure reason", 512);
    return publicReceipt(
      record.status === "pending" ? save({ ...record, status: "failed", failure: reason }) : record,
    );
  }
  throw Error("Unknown page storage operation");
}
