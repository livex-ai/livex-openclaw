import assert from "node:assert/strict";
import { test } from "node:test";
import { createPagedLogsTool } from "./paging.mjs";

const config = {
  gcloudPath: "/sdk/bin/gcloud",
  cloudSdkConfig: "/private/cloud",
  gcloudAccount: "reader@example.test",
  project: "example-prd",
  allowedSenderId: "U123",
  allowedChannelId: "*",
  paging: { enabled: true, pythonPath: "/usr/bin/python3", sdkRoot: "/sdk" },
};
const context = {
  agentId: "oncall",
  agentAccountId: "default",
  sessionKey: "thread-one",
  sessionId: "generation-one",
  messageChannel: "slack",
  nativeChannelId: "C123",
  requesterSenderId: "U123",
  assertInvocationCurrent() {},
};
const query = {
  mode: "discover",
  insertIds: ["early-seed", "webhook-seed"],
  start: "2026-10-20T16:00:46.073712Z",
  end: "2026-10-20T17:00:46.073712Z",
  limit: 50,
};
function ledger() {
  const receipts = new Map(),
    cursors = new Map();
  return {
    async reserveQuery({ toolCallId, fingerprint, inputCursor }) {
      const prior = [...receipts.values()].find((r) => r.fingerprint === fingerprint);
      if (prior) return { kind: prior.result ? "cached" : "pending", receipt: prior };
      receipts.set(toolCallId, { fingerprint, inputCursor });
      return { kind: "reserved" };
    },
    async finishQuery({ toolCallId, result, cursorState }) {
      const r = receipts.get(toolCallId);
      r.result = result;
      if (r.inputCursor) cursors.delete(r.inputCursor);
      if (cursorState) cursors.set(cursorState.id, cursorState);
    },
    async failQuery({ toolCallId, reason }) {
      receipts.get(toolCallId).failure = reason;
    },
    async getCursor(id) {
      const c = cursors.get(id);
      if (!c) throw Error("Unknown or consumed cursor");
      return c;
    },
    receipts,
    cursors,
  };
}
const row = (i, size = 10) => ({
  timestamp: "2026-10-20T16:10:00.123456789Z",
  insertId: `seed-${i}`,
  severity: "ERROR",
  resource: {
    type: "k8s_container",
    labels: { project_id: "example-prd", namespace_name: "service" },
  },
  jsonPayload: { message: "x".repeat(size), stack: "y".repeat(size), level: "DEBUG" },
});

test("empty cloud page with continuation is incomplete and cursor is opaque", async () => {
  const state = ledger();
  let calls = 0;
  const tool = createPagedLogsTool(
    config,
    context,
    () => {
      throw Error("unused");
    },
    {
      ledger: state,
      readPage: async () =>
        ++calls === 1
          ? { entries: [], nextPageToken: "PRIVATE_BACKEND_CURSOR" }
          : { entries: [row(1)], nextPageToken: null },
    },
  );
  const first = (await tool.execute("one", query)).details;
  assert.equal(first.windowExhausted, false);
  assert.ok(first.nextCursor);
  assert.ok(!JSON.stringify(first).includes("PRIVATE_BACKEND_CURSOR"));
  const last = (await tool.execute("two", { cursor: first.nextCursor })).details;
  assert.equal(last.windowExhausted, true);
  assert.equal(last.entries.length, 1);
  assert.equal(calls, 2);
});

test("byte-limited page retains every undelivered row before advancing cloud cursor", async () => {
  const state = ledger();
  let calls = 0;
  const found = [];
  const tool = createPagedLogsTool(
    config,
    context,
    () => {
      throw Error("unused");
    },
    {
      ledger: state,
      readPage: async () => {
        calls++;
        return { entries: Array.from({ length: 50 }, (_, i) => row(i, 1800)), nextPageToken: null };
      },
    },
  );
  let result = (await tool.execute("p0", query)).details;
  let n = 1;
  const firstRetrievedAt = result.retrievedAt;
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 30 * 1024);
  found.push(...result.entries.map((r) => r.insertId));
  while (result.nextCursor) {
    assert.ok(n < 20);
    result = (await tool.execute(`p${n++}`, { cursor: result.nextCursor })).details;
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 30 * 1024);
    assert.equal(result.retrievedAt, firstRetrievedAt);
    found.push(...result.entries.map((r) => r.insertId));
  }
  assert.equal(calls, 1);
  assert.equal(found.length, 50);
  assert.equal(new Set(found).size, 50);
  assert.equal(result.windowExhausted, true);
});

test("duplicate request reuses receipt without another cloud read", async () => {
  const state = ledger();
  let calls = 0;
  const tool = createPagedLogsTool(
    config,
    context,
    () => {
      throw Error("unused");
    },
    {
      ledger: state,
      readPage: async () => {
        calls++;
        return { entries: [row(1)], nextPageToken: null };
      },
    },
  );
  await tool.execute("first", query);
  const replay = (await tool.execute("second", query)).details;
  assert.equal(calls, 1);
  assert.equal(replay.reusedEvidence, true);
});

test("explicit refresh obtains new evidence while ordinary duplicate requests reuse prior evidence", async () => {
  const state = ledger();
  let calls = 0;
  const tool = createPagedLogsTool(config, context, () => {}, {
    ledger: state,
    readPage: async () => ({ entries: [row(++calls)], nextPageToken: null }),
  });
  const first = (await tool.execute("original", query)).details;
  const fresh = (await tool.execute("refresh", { ...query, refresh: true })).details;
  assert.notEqual(first.entries[0].insertId, fresh.entries[0].insertId);
  assert.equal(fresh.reusedEvidence, false);
  assert.equal(calls, 2);
  const retry = (await tool.execute("refresh", { ...query, refresh: true })).details;
  assert.equal(retry.reusedEvidence, true);
  assert.equal(calls, 2);
});

test("caller, cursor substitution and cancellation cannot bypass query admission", async () => {
  const state = ledger();
  let calls = 0;
  const options = {
    ledger: state,
    readPage: async () => {
      calls++;
      return { entries: [], nextPageToken: null };
    },
  };
  assert.equal(
    createPagedLogsTool(config, { ...context, requesterSenderId: "UOTHER" }, () => {}, options),
    null,
  );
  const tool = createPagedLogsTool(config, context, () => {}, options);
  await assert.rejects(tool.execute("bad", { cursor: "unknown", ...query }), /cursor/i);
  await assert.rejects(tool.execute("other", { cursor: "unknown" }), /cursor/i);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(tool.execute("abort", query, aborted.signal), /abort/i);
  assert.equal(calls, 0);
});

test("revocation after response prevents result disclosure and further effects", async () => {
  const state = ledger();
  let live = true;
  const tool = createPagedLogsTool(
    config,
    {
      ...context,
      assertInvocationCurrent() {
        if (!live) throw Error("revoked");
      },
    },
    () => {},
    {
      ledger: state,
      readPage: async () => {
        live = false;
        return { entries: [row(1)], nextPageToken: null };
      },
    },
  );
  await assert.rejects(tool.execute("one", query), /revoked/);
  assert.equal(state.receipts.get("one").result, undefined);
});
