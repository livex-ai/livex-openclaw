import { createHash } from "node:crypto";

const MAX_RECORD_BYTES = 256 * 1024;
const MAX_RETENTION_METADATA_BYTES = 128;
const clone = (value) => (value === undefined ? undefined : structuredClone(value));
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
function stable(value) {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, stable(value[key])]),
    );
  }
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
    // eslint-disable-next-line no-control-regex -- Reject control characters in persisted identities and metadata.
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}
function pageId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Invalid page receipt or cursor");
  }
  return value;
}
function queryValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || bytes(value) > 8192) {
    throw new Error("Invalid page query metadata");
  }
  // eslint-disable-next-line unicorn/prefer-structured-clone -- Normalize to the persisted JSON wire shape; retaining undefined/non-JSON fields would change legacy query hashes.
  return JSON.parse(JSON.stringify(value));
}
export function scopeIdentity(context, config, { legacy = false } = {}) {
  if (
    context?.messageChannel !== "slack" ||
    context.requesterSenderId !== config.allowedSenderId ||
    !/^[CG][A-Z0-9]+$/.test(context.nativeChannelId ?? "") ||
    (config.allowedChannelId !== "*" && context.nativeChannelId !== config.allowedChannelId) ||
    typeof context.assertInvocationCurrent !== "function"
  ) {
    throw new Error("Unauthorized investigation context");
  }
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
  if (!legacy) {
    identity.gcloudAccount = text(config.gcloudAccount, "Google account identity", 254);
    identity.cloudSdkConfig = text(config.cloudSdkConfig, "Cloud SDK identity", 4096);
  }
  return hash(identity);
}

function resultValue(result, retrievedAt) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !Array.isArray(result.entries) ||
    result.entries.length > 50
  ) {
    throw new Error("Invalid page result");
  }
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
  for (const name of ["project", "start", "end", "mode"]) {
    if (typeof result[name] === "string") {
      value[name] = result[name].slice(0, 128);
    }
  }
  for (const name of ["fetchedRows", "returnedRows", "processedRows", "invalidRows"]) {
    if (Number.isSafeInteger(result[name]) && result[name] >= 0) {
      value[name] = result[name];
    }
  }
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
  ]) {
    if (result[name] !== undefined) {
      value[name] = clone(result[name]);
    }
  }
  if (typeof result.fromBuffer === "boolean") {
    value.fromBuffer = result.fromBuffer;
  }
  if (bytes(value) > 64 * 1024) {
    throw new Error("Projected page evidence byte limit exceeded");
  }
  return value;
}

function privateCursor(value, record, result) {
  if (value === undefined || value === null) {
    if (result.nextCursor) {
      throw new Error("Page result requires a durable cursor");
    }
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
  ) {
    throw new Error("Invalid page cursor state");
  }
  if (pageId(value.id) !== record.id || value.id !== result.nextCursor) {
    throw new Error("Cursor does not match its receipt");
  }
  pageId(value.queryFingerprint);
  const query = queryValue(value.query);
  if (hash(query) !== hash(record.query)) {
    throw new Error("Cursor query differs from reserved query");
  }
  if (
    !Array.isArray(value.pendingRows) ||
    value.pendingRows.length > 50 ||
    (value.backendToken !== null &&
      (typeof value.backendToken !== "string" || Buffer.byteLength(value.backendToken) > 16384))
  ) {
    throw new Error("Invalid page cursor buffer");
  }
  if (bytes(value) > MAX_RECORD_BYTES) {
    throw new Error("Page cursor byte limit exceeded");
  }
  // The pager supplies redacted projections, never raw cloud log payloads.
  const retrievedAt = text(
    value.retrievedAt ?? result.retrievedAt,
    "cursor retrieval timestamp",
    64,
  );
  if (!Number.isFinite(Date.parse(retrievedAt))) {
    throw new Error("Invalid cursor retrieval timestamp");
  }
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
    attempt: record.attempt ?? 0,
    ...(record.result ? { result: { ...clone(record.result), reusedEvidence } } : {}),
    ...(record.failure ? { failure: record.failure } : {}),
  };
}

export const PAGE_CACHE_ENTRIES = 200;
export const PAGE_CACHE_ERRORS = Object.freeze({
  receiptInvalid: "Missing or invalid page receipt",
  recoveryInvalid: "Invalid recovery receipt",
  recoveryStale: "Page receipt changed; inspect it again before recovery",
  recoveryRetire: "Only a finished unconsumed checkpoint can be retired",
  recoveryRetry: "Only an unresolved receipt can receive retry approval",
  recoveryLegacy:
    "Legacy recovery requires explicit restart-legacy approval; old evidence and cursor cannot be reused",
  recoveryExists: "Current identity already has this recovery receipt; inspect it instead",
  recoveryOutstanding:
    "Another approved or active retry is outstanding for this query; settle its receipt before approving another",
  recoveryDependent:
    "Checkpoint has unresolved or unverifiable dependent reads; reconcile their receipts before retirement",

  expired:
    "Unknown, evicted, or cross-session cursor; resume from the latest retained checkpoint, not a new scan",
  consumed:
    "This cursor was already consumed and its cached successor was evicted; resume from the latest retained checkpoint",
  protected:
    "Log page cache is full of protected checkpoints or unresolved reads; no safe LRU eviction is available; no cloud read was started",
  retired:
    "This checkpoint was explicitly retired by its operator; it cannot resume or silently restart a scan",
});
const recordKey = (scope, id) => `page:${hash({ scope, id })}`;
function recordFits(value) {
  const { lastUsedAt: _lastUsedAt, cursorConsumed: _cursorConsumed, ...content } = value;
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
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1 ||
    value.scope !== scope ||
    value.id !== id ||
    !["pending", "finished", "failed", "retry-approved", "retired"].includes(value.status) ||
    (value.attempt !== undefined && (!Number.isSafeInteger(value.attempt) || value.attempt < 0)) ||
    !Number.isFinite(Date.parse(value.reservedAt)) ||
    !recordFits(value)
  ) {
    throw new Error(PAGE_CACHE_ERRORS.receiptInvalid);
  }
  pageId(scope);
  pageId(id);
  text(value.toolCallId, "stored tool call id");
  queryValue(value.query);
  if (["retry-approved", "retired"].includes(value.status)) {
    const recovery = value.recovery;
    if (
      !recovery ||
      !["pending", "failed", "finished"].includes(recovery.previousStatus) ||
      !Number.isSafeInteger(recovery.previousAttempt) ||
      recovery.previousAttempt < 0 ||
      recovery.previousAttempt !== (value.attempt ?? 0) ||
      !Number.isFinite(Date.parse(recovery.approvedAt))
    ) {
      throw new Error(PAGE_CACHE_ERRORS.recoveryInvalid);
    }
    pageId(recovery.previousReceiptHash);
    text(recovery.operatorId, "recovery operator", 128);
    if (value.status === "retired" && recovery.previousStatus !== "finished") {
      throw new Error("Invalid retired checkpoint");
    }
    if (value.status === "retry-approved" && recovery.previousStatus === "finished") {
      throw new Error("Invalid retry approval");
    }
  }
  return value;
}
function validEntry({ key, value }) {
  try {
    checkRecord(value, value?.scope, value?.id);
    return key === recordKey(value.scope, value.id);
  } catch {
    return false;
  }
}

function sameQueryOrUnknown(value, query) {
  try {
    return hash(queryValue(value?.query)) === hash(query);
  } catch {
    // Missing or corrupt query metadata cannot prove this is a different read.
    return true;
  }
}
function scopedQueryEntries(transaction, scopes, query) {
  return transaction.entries(0).filter((entry) => {
    if (!scopes.includes(entry.value?.scope) || !sameQueryOrUnknown(entry.value, query)) {
      return false;
    }
    if (!validEntry(entry)) {
      throw new Error(PAGE_CACHE_ERRORS.receiptInvalid);
    }
    return true;
  });
}

function finishedRecord(entry) {
  // Completion hashes cannot substitute for valid receipt ownership and attempt metadata.
  if (!validEntry(entry)) {
    return false;
  }
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
    ) {
      return false;
    }
    if (record.cursorState) {
      if (
        record.cursorState.id !== record.id ||
        record.result.nextCursor !== record.id ||
        hash(record.cursorState.query) !== hash(record.query)
      ) {
        return false;
      }
    } else if (record.result.nextCursor !== null) {
      return false;
    }
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
    if (!child.inputCursor) {
      continue;
    }
    const parent = finished.find(
      ({ value }) => value.scope === child.scope && value.id === child.inputCursor,
    );
    if (parent?.value.cursorState && hash(parent.value.query) === hash(child.query)) {
      consumed.add(parent.key);
    }
  }
  const retired = entries.filter((entry) => validEntry(entry) && entry.value.status === "retired");
  const victim = [...finished, ...retired]
    .filter(
      ({ key, value }) =>
        !protectedKeys.has(key) &&
        (!value.cursorState || value.cursorConsumed === true || consumed.has(key)),
    )
    .toSorted((a, b) => {
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
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new Error("Invalid page access time");
  }
  const key = recordKey(scope, id);
  const read = (targetId) => {
    const value = transaction.lookup(0, recordKey(scope, targetId));
    return value === undefined ? undefined : checkRecord(value, scope, targetId);
  };
  const save = (record) => {
    const updated = { ...record, lastUsedAt: Math.max(input.now, record.lastUsedAt ?? 0) };
    if (!recordFits(updated)) {
      throw new Error("Page receipt byte limit exceeded; no continuation was committed");
    }
    transaction.set(0, recordKey(scope, record.id), updated);
    return updated;
  };
  const cursor = (targetId) => {
    pageId(targetId);
    const record = read(targetId);
    if (record?.status === "retired") {
      throw new Error(PAGE_CACHE_ERRORS.retired);
    }
    if (
      record?.status !== "finished" ||
      !record.cursorState ||
      record.cursorState.id !== targetId
    ) {
      throw new Error(PAGE_CACHE_ERRORS.expired);
    }
    return record;
  };
  const own = (record) => {
    if (record.toolCallId !== input.toolCallId || (record.attempt ?? 0) !== (input.attempt ?? 0)) {
      throw new Error("Page receipt belongs to a different tool call owner or attempt");
    }
  };

  if (command.type === "list") {
    const selectedScope = input.legacy ? pageId(input.legacyScope) : scope;
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      input.offset > PAGE_CACHE_ENTRIES
    ) {
      throw new Error("Invalid recovery list offset");
    }
    const records = transaction
      .entries(0)
      .filter(validEntry)
      .map((entry) => entry.value)
      .filter((value) => value.scope === selectedScope)
      .toSorted((a, b) => a.reservedAt.localeCompare(b.reservedAt) || a.id.localeCompare(b.id));
    return {
      legacy: input.legacy === true,
      total: records.length,
      receipts: records.slice(input.offset, input.offset + 20).map((value) => ({
        id: value.id,
        status: value.status,
        reservedAt: value.reservedAt,
        attempt: value.attempt ?? 0,
      })),
      nextOffset: records.length > input.offset + 20 ? input.offset + 20 : null,
    };
  }
  if (command.type === "inspect" || command.type === "approve-retry" || command.type === "retire") {
    const selectedScope = input.legacy ? pageId(input.legacyScope) : scope;
    const selectedKey = recordKey(selectedScope, id);
    const selected = checkRecord(transaction.lookup(0, selectedKey), selectedScope, id);
    const receiptHash = hash(selected);
    if (command.type === "inspect") {
      return {
        id,
        legacy: input.legacy === true,
        status: selected.status,
        query: clone(selected.query),
        reservedAt: selected.reservedAt,
        attempt: selected.attempt ?? 0,
        ...(selected.failure ? { failure: selected.failure } : {}),
        receiptHash,
        notice: input.legacy
          ? "Legacy receipt has no cloud identity binding. Approval restarts its bounded query under current configured credentials; no old evidence or cursor is reused."
          : "Retry approval acknowledges the prior outcome may be unknown and authorizes one new read of this exact query. No read runs in this command.",
      };
    }
    if (input.receiptHash !== receiptHash) {
      throw new Error(PAGE_CACHE_ERRORS.recoveryStale);
    }
    const operatorId = text(input.operatorId, "recovery operator", 128);
    const recovery = {
      approvedAt: new Date(input.now).toISOString(),
      operatorId,
      previousReceiptHash: receiptHash,
      previousReceiptId: id,
      previousStatus: selected.status,
      previousAttempt: selected.attempt ?? 0,
      previousReservedAt: selected.reservedAt,
      previousToolCallId: selected.toolCallId,
      ...(typeof selected.failure === "string"
        ? { previousFailure: selected.failure.slice(0, 512) }
        : {}),
      ...(input.legacy
        ? {
            legacyScope: selectedScope,
            restartedFromBeginning: true,
            previousInputCursor: selected.inputCursor ?? null,
          }
        : {}),
    };
    if (command.type === "retire") {
      if (
        selected.status !== "finished" ||
        !selected.cursorState ||
        selected.cursorConsumed ||
        !finishedRecord({ key: selectedKey, value: selected })
      ) {
        throw new Error(PAGE_CACHE_ERRORS.recoveryRetire);
      }
      const dependent = transaction
        .entries(0)
        .some(
          (entry) =>
            entry.value?.scope === selectedScope &&
            entry.value.inputCursor === id &&
            (!validEntry(entry) || !finishedRecord(entry)),
        );
      if (dependent) {
        throw new Error(PAGE_CACHE_ERRORS.recoveryDependent);
      }
      // Operator abandonment is not evidence of consumption or query completion.
      transaction.set(0, selectedKey, {
        version: 1,
        scope: selectedScope,
        id,
        toolCallId: selected.toolCallId,
        query: selected.query,
        status: "retired",
        reservedAt: selected.reservedAt,
        lastUsedAt: input.now,
        attempt: selected.attempt ?? 0,
        recovery,
      });
      return { id, status: "retired", cloudReadStarted: false };
    }
    if (!["pending", "failed"].includes(selected.status)) {
      throw new Error(PAGE_CACHE_ERRORS.recoveryRetry);
    }
    if (input.legacy && input.restartLegacy !== true) {
      throw new Error(PAGE_CACHE_ERRORS.recoveryLegacy);
    }
    const inputCursor = input.legacy ? undefined : selected.inputCursor;
    const outstanding = scopedQueryEntries(transaction, [scope], selected.query).some(
      ({ key: candidateKey, value }) =>
        candidateKey !== selectedKey &&
        value.inputCursor === inputCursor &&
        (value.status === "retry-approved" || (value.status === "pending" && value.recovery)),
    );
    if (outstanding) {
      throw new Error(PAGE_CACHE_ERRORS.recoveryOutstanding);
    }
    // Distinct historical attempts need distinct recovery receipts, even when old
    // refresh calls shared a query. Never overwrite an existing current result.
    const targetId = input.legacy
      ? hash({ query: selected.query, inputCursor: null, legacyReceipt: id })
      : id;
    const targetKey = recordKey(scope, targetId);
    if (selectedKey !== targetKey && transaction.lookup(0, targetKey) !== undefined) {
      throw new Error(PAGE_CACHE_ERRORS.recoveryExists);
    }
    const next = {
      version: 1,
      scope,
      id: targetId,
      toolCallId: selected.toolCallId,
      query: selected.query,
      ...(!input.legacy && selected.inputCursor ? { inputCursor: selected.inputCursor } : {}),
      status: "retry-approved",
      reservedAt: selected.reservedAt,
      attempt: selected.attempt ?? 0,
      recovery,
    };
    // Identity migration is an explicit operator decision and one atomic replacement,
    // even at capacity. Legacy evidence and private cursor state are never copied.
    if (selectedKey !== targetKey) {
      transaction.delete(0, selectedKey);
    }
    save(next);
    return {
      id: targetId,
      status: "retry-approved",
      cloudReadStarted: false,
      query: clone(selected.query),
      ...(next.inputCursor ? { cursor: next.inputCursor } : {}),
      ...(input.legacy
        ? {
            restartFromBeginning: true,
            notice:
              "The next matching query restarts this exact saved window under current credentials. Prior outcome remains unknown; deduplicate repeated evidence.",
          }
        : {}),
    };
  }

  if (command.type === "cursor") {
    const record = save(cursor(id));
    return clone(record.cursorState);
  }
  text(input.toolCallId, "tool call id");
  if (command.type === "reserve") {
    const query = queryValue(input.query);
    const current = read(id);
    if (
      current &&
      (hash(current.query) !== hash(query) || current.inputCursor !== input.inputCursor)
    ) {
      throw new Error("Fingerprint reused for a different page query");
    }
    // Refresh changes a fingerprint, not the underlying operation. Never let a
    // fresh tool-call ID bypass an unresolved attempt or an approved retry.
    const entries = scopedQueryEntries(transaction, [scope, input.legacyScope], query);
    const matching = entries.filter(
      ({ value }) =>
        value?.scope === scope &&
        hash(value.query) === hash(query) &&
        value.inputCursor === input.inputCursor &&
        ["pending", "failed", "retry-approved"].includes(value.status),
    );
    const approved = matching.filter(({ value }) => value.status === "retry-approved");
    if (
      approved.length > 1 ||
      (approved.length &&
        matching.some(({ value }) => value.status === "pending" && value.recovery))
    ) {
      throw new Error(PAGE_CACHE_ERRORS.recoveryOutstanding);
    }
    if (approved.length === 1) {
      const record = checkRecord(approved[0].value, scope, approved[0].value.id);
      if (
        !Number.isSafeInteger(record.attempt ?? 0) ||
        (record.attempt ?? 0) >= Number.MAX_SAFE_INTEGER
      ) {
        throw new Error("Page attempt counter exhausted");
      }
      const retried = save({
        ...record,
        status: "pending",
        toolCallId: input.toolCallId,
        attempt: (record.attempt ?? 0) + 1,
        reservedAt: new Date(input.now).toISOString(),
      });
      return { kind: "reserved", receipt: publicReceipt(retried) };
    }
    if (matching.length) {
      const record = matching[0].value;
      return { kind: "pending", receipt: publicReceipt(record) };
    }
    const legacy =
      input.legacyScope &&
      entries.find(
        ({ value }) =>
          value.scope === input.legacyScope &&
          ["pending", "failed", "retry-approved"].includes(value.status) &&
          hash(value.query) === hash(query),
      );
    if (legacy) {
      return { kind: "legacy", receipt: publicReceipt(legacy.value) };
    }
    // Explicit retries may retain an original refresh ID or migrate to a unique
    // legacy ID. Ordinary queries must reuse that completed evidence; a refresh
    // fingerprint is deliberately different and still requests a new read.
    if (id === hash({ query, inputCursor: input.inputCursor ?? null })) {
      const recovered = entries
        .filter(
          (entry) =>
            entry.value.scope === scope &&
            entry.value.inputCursor === input.inputCursor &&
            entry.value.recovery &&
            finishedRecord(entry),
        )
        .toSorted(
          (a, b) =>
            Date.parse(b.value.reservedAt) - Date.parse(a.value.reservedAt) ||
            a.value.id.localeCompare(b.value.id),
        )[0];
      if (recovered) {
        return { kind: "cached", receipt: publicReceipt(save(recovered.value), true) };
      }
    }
    if (current) {
      const touched = save(current);
      return {
        kind: touched.status === "finished" ? "cached" : "pending",
        receipt: publicReceipt(touched, touched.status === "finished"),
      };
    }
    const protectedKeys = new Set([key]);
    if (input.inputCursor !== undefined) {
      const parent = cursor(input.inputCursor);
      if (hash(parent.query) !== hash(query)) {
        throw new Error("Cursor query differs from requested page");
      }
      if (parent.cursorConsumed === true) {
        throw new Error(PAGE_CACHE_ERRORS.consumed);
      }
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
      if (error?.code !== "PLUGIN_STATE_LIMIT_EXCEEDED") {
        throw error;
      }
      const { victim, settledParents } = leastRecentlyUsed(transaction.entries(0), protectedKeys);
      if (!victim) {
        // eslint-disable-next-line preserve-caught-error -- Expose only the fixed capacity diagnostic; native storage causes may contain private keys or paths.
        throw new Error(PAGE_CACHE_ERRORS.protected);
      }
      for (const parent of settledParents) {
        const settled = { ...parent.value, cursorConsumed: true };
        if (!recordFits(settled)) {
          // eslint-disable-next-line preserve-caught-error -- Keep the fixed validation diagnostic free of unrelated private native storage details.
          throw new Error("Page retention metadata exceeds its byte bound");
        }
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
    if (!["pending", "finished"].includes(record.status)) {
      throw new Error("Failed page receipt cannot be replayed or completed without reconciliation");
    }
    const retrievedAt =
      record.result?.retrievedAt ??
      (typeof input.result?.retrievedAt === "string"
        ? text(input.result.retrievedAt, "retrieval timestamp", 64)
        : new Date(input.now).toISOString());
    if (!Number.isFinite(Date.parse(retrievedAt))) {
      throw new Error("Invalid page retrieval timestamp");
    }
    const result = resultValue(input.result, retrievedAt);
    const cursorState = privateCursor(input.cursorState, record, result);
    const completionHash = hash({ result, cursorState });
    if (record.status === "finished") {
      if (record.completionHash !== completionHash) {
        throw new Error("Finished page receipts are immutable");
      }
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
      if (hash(parent.query) !== hash(record.query)) {
        throw new Error("Cursor query differs from completed page");
      }
      save({ ...parent, cursorConsumed: true });
    }
    return publicReceipt(finished);
  }
  if (command.type === "fail") {
    if (!["pending", "failed", "finished"].includes(record.status)) {
      throw new Error("Page attempt no longer owns this receipt");
    }
    const reason = text(input.reason, "page failure reason", 512);
    return publicReceipt(
      record.status === "pending" ? save({ ...record, status: "failed", failure: reason }) : record,
    );
  }
  throw new Error("Unknown page storage operation");
}
