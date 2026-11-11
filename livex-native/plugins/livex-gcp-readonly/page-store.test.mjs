import assert from "node:assert/strict";
import { test } from "node:test";
import { transactionMemoryStore } from "./page-lru-test-helpers.mjs";
import * as implementation from "./page-store.mjs";
const config = {
  gcloudAccount: "reader@example.test",
  cloudSdkConfig: "/private/cloud",
  project: "example-prd",
  allowedSenderId: "U123",
  allowedChannelId: "*",
};
const context = (overrides = {}) => ({
  messageChannel: "slack",
  nativeChannelId: "C123",
  requesterSenderId: "U123",
  agentAccountId: "default",
  agentId: "oncall",
  sessionKey: "thread-one",
  sessionId: "session-one",
  assertInvocationCurrent() {},
  ...overrides,
});
const id = "a".repeat(64),
  nextId = "b".repeat(64);
const query = {
  start: "2026-10-20T16:00:46.073712Z",
  end: "2026-10-20T17:00:46.073712Z",
  mode: "discover",
  insertIds: ["seed"],
  limit: 50,
};
const result = {
  entries: [{ insertId: "seed", timestamp: query.start, jsonPayload: { message: "evidence" } }],
  returnedRows: 1,
  fetchedRows: 1,
  processedRows: 1,
  invalidRows: 0,
  truncated: false,
  nextCursor: null,
  windowExhausted: true,
};
const cursor = () => ({
  id,
  queryFingerprint: "c".repeat(64),
  query,
  pendingRows: [{ insertId: "pending-row" }],
  backendToken: "PRIVATE_BACKEND_TOKEN",
  projectionTruncated: false,
});
// Run the real static handler with atomic rollback and authority checks.
function memoryStore(assertCurrent = () => {}, maxEntries = 200) {
  return transactionMemoryStore({ assertCurrent, maxEntries });
}
function ledger(store, ctx = context(), cfg = config) {
  assert.equal(
    typeof implementation.createPageLedger,
    "function",
    "page ledger must be implemented",
  );
  return implementation.createPageLedger(store, ctx, cfg, { now: () => 1000 });
}
const reserve = (l, extra = {}) =>
  l.reserveQuery({ toolCallId: "first", fingerprint: id, query, ...extra });
const finish = (l, extra = {}) =>
  l.finishQuery({ receiptId: id, toolCallId: "first", result, ...extra });

test("reservation survives restart and duplicate or concurrent calls cannot repeat a read", async () => {
  const store = memoryStore();
  const calls = await Promise.all(
    Array.from({ length: 8 }, (_, i) => reserve(ledger(store), { toolCallId: `call-${i}` })),
  );
  assert.equal(calls.filter((c) => c.kind === "reserved").length, 1);
  assert.equal(calls.filter((c) => c.kind === "pending").length, 7);
  assert.equal(calls[0].receipt.id, id);
  assert.equal(store.rows.size, 1);
  assert.equal((await reserve(ledger(store))).kind, "pending");
});

test("finished evidence and private cursor survive restart without token disclosure", async () => {
  const store = memoryStore(),
    first = ledger(store);
  await reserve(first);
  await finish(first, {
    result: { ...result, nextCursor: id, windowExhausted: false },
    cursorState: cursor(),
  });
  const replay = await reserve(ledger(store), { toolCallId: "replay" });
  assert.equal(replay.kind, "cached");
  assert.equal(replay.receipt.result.nextCursor, id);
  assert.equal(replay.receipt.result.reusedEvidence, true);
  assert.equal(replay.receipt.result.retrievedAt, "1970-01-01T00:00:01.000Z");
  assert.equal(replay.receipt.result.entries[0].insertId, "seed");
  assert.equal(replay.receipt.result.entries[0].jsonPayload.message, "evidence");
  assert.ok(!JSON.stringify(replay).includes("PRIVATE_BACKEND_TOKEN"));
  assert.ok(!JSON.stringify(replay).includes("pending-row"));
  assert.equal((await ledger(store).getCursor(id)).backendToken, "PRIVATE_BACKEND_TOKEN");
});

test("immutable previous pages permit duplicate continuation replay", async () => {
  const store = memoryStore(),
    first = ledger(store);
  await reserve(first);
  await finish(first, {
    result: { ...result, nextCursor: id, windowExhausted: false },
    cursorState: cursor(),
  });
  const next = ledger(store);
  await reserve(next, { toolCallId: "next", fingerprint: nextId, inputCursor: id });
  await next.finishQuery({ receiptId: nextId, toolCallId: "next", result });
  assert.equal((await ledger(store).getCursor(id)).backendToken, "PRIVATE_BACKEND_TOKEN");
  const replay = await reserve(ledger(store), {
    toolCallId: "replay-next",
    fingerprint: nextId,
    inputCursor: id,
  });
  assert.equal(replay.kind, "cached");
  assert.equal(replay.receipt.result.nextCursor, null);
  await assert.rejects(
    finish(first, {
      result: { ...result, nextCursor: id, windowExhausted: false },
      cursorState: { ...cursor(), backendToken: "CHANGED" },
    }),
    /immutable|different/i,
  );
});

test("malicious and cross-session cursors cannot access private continuation state", async () => {
  const store = memoryStore(),
    first = ledger(store);
  await reserve(first);
  await finish(first, {
    result: { ...result, nextCursor: id, windowExhausted: false },
    cursorState: cursor(),
  });
  for (const override of [
    { sessionId: "new" },
    { sessionKey: "other" },
    { agentId: "other" },
    { agentAccountId: "other" },
    { nativeChannelId: "C456" },
  ]) {
    await assert.rejects(ledger(store, context(override)).getCursor(id), /cursor/i);
  }
  for (const bad of ["../cursor", "a".repeat(63), "A".repeat(64), { id }]) {
    await assert.rejects(async () => first.getCursor(bad), /cursor/i);
  }
  await assert.rejects(
    reserve(first, { toolCallId: "bad-cursor", fingerprint: nextId, inputCursor: "d".repeat(64) }),
    /cursor/i,
  );
  for (const override of [
    { requesterSenderId: "UOTHER" },
    { messageChannel: "discord" },
    { sessionId: undefined },
    { agentAccountId: undefined },
  ]) {
    assert.throws(() => ledger(store, context(override)), /authorized|identity|context/i);
  }
});

test("failed and unknown attempts fail closed instead of being silently replayed", async () => {
  const store = memoryStore(),
    first = ledger(store);
  await reserve(first);
  await first.failQuery({ receiptId: id, toolCallId: "first", reason: "timeout; outcome unknown" });
  const replay = await reserve(ledger(store));
  assert.equal(replay.kind, "pending");
  assert.equal(replay.receipt.status, "failed");
  await assert.rejects(finish(first), /failed|pending/i);
  let writes = 0;
  const unknown = memoryStore();
  unknown.controls.beforeCommit = () => {
    writes++;
    throw new Error("unknown write outcome");
  };
  await assert.rejects(reserve(ledger(unknown)), /unknown write/);
  assert.equal(writes, 1);
  assert.equal(unknown.rows.size, 0);
  const lostAcknowledgement = memoryStore();
  let acknowledgements = 0;
  lostAcknowledgement.controls.afterCommit = () => {
    acknowledgements++;
    throw new Error("unknown write outcome");
  };
  await assert.rejects(reserve(ledger(lostAcknowledgement)), /unknown write/);
  assert.equal(acknowledgements, 1);
  assert.equal(lostAcknowledgement.rows.size, 1);
  lostAcknowledgement.controls.afterCommit = undefined;
  assert.equal(
    (await reserve(ledger(lostAcknowledgement))).kind,
    "pending",
    "a committed reservation with lost acknowledgement must not repeat the cloud read",
  );
});

test("revocation before or during asynchronous storage prevents effects and disclosure", async () => {
  let current = true;
  const guard = () => {
    if (!current) {
      throw new Error("revoked");
    }
  };
  const store = memoryStore(guard),
    first = ledger(store, context({ assertInvocationCurrent: guard }));
  store.controls.beforeCommit = () => {
    current = false;
  };
  await assert.rejects(reserve(first), /revoked/);
  assert.equal(store.rows.size, 0);
  current = true;
  store.controls.beforeCommit = undefined;
  await reserve(first);
  await finish(first, {
    result: { ...result, nextCursor: id, windowExhausted: false },
    cursorState: cursor(),
  });
  store.controls.afterCommit = () => {
    current = false;
  };
  await assert.rejects(first.getCursor(id), /revoked/);
  await assert.rejects(reserve(first), /revoked/);
});

test("result and cursor commit together and oversized buffers leave the reservation unresolved", async () => {
  const store = memoryStore(),
    first = ledger(store);
  await reserve(first);
  await assert.rejects(
    finish(first, {
      result: { ...result, nextCursor: id },
      cursorState: { ...cursor(), id: nextId },
    }),
    /cursor/i,
  );
  await assert.rejects(
    finish(first, {
      result: { ...result, nextCursor: id },
      cursorState: { ...cursor(), pendingRows: [{ message: "x".repeat(262144) }] },
    }),
    /byte|size/i,
  );
  await assert.rejects(first.getCursor(id), /cursor/i);
  assert.equal((await reserve(ledger(store))).receipt.status, "pending");
  await finish(first, {
    result: { ...result, nextCursor: id, windowExhausted: false },
    cursorState: cursor(),
  });
  assert.equal((await reserve(ledger(store))).kind, "cached");
});

test("fingerprint reuse with a different query or cursor is rejected", async () => {
  const store = memoryStore(),
    first = ledger(store);
  await reserve(first);
  await assert.rejects(
    reserve(first, { query: { ...query, insertIds: ["different"] } }),
    /fingerprint|different/i,
  );
  await assert.rejects(reserve(first, { inputCursor: nextId }), /cursor|fingerprint/i);
});

test("receipt ownership and final evidence are immutable", async () => {
  const store = memoryStore(),
    first = ledger(store);
  await reserve(first);
  await assert.rejects(finish(ledger(store), { toolCallId: "stranger" }), /owner|call/i);
  await finish(first);
  await finish(first);
  await assert.rejects(
    finish(first, { result: { ...result, entries: [{ insertId: "different" }] } }),
    /immutable|different/i,
  );
  await first.failQuery({ receiptId: id, toolCallId: "first", reason: "late transport failure" });
  assert.equal((await reserve(ledger(store))).kind, "cached");
});

test("protected pending receipts fail closed at capacity without eviction or TTL", async () => {
  const store = memoryStore(() => {}, 1),
    first = ledger(store);
  await reserve(first);
  await assert.rejects(
    reserve(first, {
      toolCallId: "second",
      fingerprint: nextId,
      query: { ...query, insertIds: ["other"] },
    }),
    /full/,
  );
  assert.equal(store.rows.size, 1);
  assert.equal((await reserve(first)).kind, "pending");
});

test("buffer continuations preserve backend retrieval time instead of presenting stale logs as fresh", async () => {
  const store = memoryStore(),
    first = ledger(store);
  await reserve(first);
  const retrievedAt = "2026-10-20T16:35:11.040Z";
  await finish(first, {
    result: { ...result, nextCursor: id, windowExhausted: false, retrievedAt },
    cursorState: { ...cursor(), retrievedAt },
  });
  assert.equal((await ledger(store).getCursor(id)).retrievedAt, retrievedAt);
  assert.equal((await reserve(ledger(store))).receipt.result.retrievedAt, retrievedAt);
});

test("backend token byte bound matches the helper and does not count UTF-16 characters", async () => {
  const store = memoryStore(),
    first = ledger(store);
  await reserve(first);
  const completion = {
    result: { ...result, nextCursor: id, windowExhausted: false },
    cursorState: { ...cursor(), backendToken: "x".repeat(16384) },
  };
  await finish(first, completion);
  assert.equal((await first.getCursor(id)).backendToken.length, 16384);
  const second = ledger(memoryStore());
  await reserve(second);
  await assert.rejects(
    finish(second, { ...completion, cursorState: { ...cursor(), backendToken: "é".repeat(8193) } }),
    /cursor|token|byte/i,
  );
});

test("native worker errors expose only fixed cache diagnostics and preserve authority and nested-error privacy", async () => {
  let current = true,
    lastError;
  const guard = () => {
    if (!current) {
      throw new Error("revoked");
    }
  };
  const store = memoryStore(guard, 1),
    native = store.createOperation.bind(store);
  store.createOperation = (...args) => {
    const operation = native(...args);
    return {
      async execute(...input) {
        try {
          return await operation.execute(...input);
        } catch (cause) {
          lastError = Object.assign(new Error("Plugin state write failed", { cause }), {
            code: "PLUGIN_STATE_WRITE_FAILED",
          });
          throw lastError;
        }
      },
    };
  };
  const first = ledger(store, context({ assertInvocationCurrent: guard }));
  await assert.rejects(first.getCursor(id), /Unknown, evicted, or cross-session cursor/);
  await reserve(first);
  await assert.rejects(
    reserve(first, {
      toolCallId: "full",
      fingerprint: nextId,
      query: { ...query, insertIds: ["other"] },
    }),
    /full of protected checkpoints.*no cloud read was started/,
  );

  // Even a near-match must not promote private or arbitrary nested details.
  const blocked = lastError.cause.message;
  store.controls.beforeCommit = () => {
    throw new Error(`${blocked}; PRIVATE_INTERNAL_DETAIL`);
  };
  await assert.rejects(reserve(first), (error) => {
    assert.equal(error, lastError);
    assert.equal(error.message, "Plugin state write failed");
    assert.ok(!error.message.includes("PRIVATE_INTERNAL_DETAIL"));
    return true;
  });
  store.controls.beforeCommit = () => {
    current = false;
    throw new Error(blocked);
  };
  await assert.rejects(reserve(first), /revoked/);
});
