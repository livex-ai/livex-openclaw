import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { transactionMemoryStore } from "./page-lru-test-helpers.mjs";
import { createPageLedger } from "./page-store.mjs";
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
const context = (overrides) => ({
  agentId: "oncall",
  agentAccountId: "default",
  sessionKey: "thread-one",
  sessionId: "generation-one",
  messageChannel: "slack",
  nativeChannelId: "C123",
  requesterSenderId: "U123",
  assertInvocationCurrent() {},
  ...overrides,
});
const query = {
  mode: "discover",
  insertIds: ["seed"],
  start: "2026-10-20T16:00:46.073712345Z",
  end: "2026-10-20T17:00:46.073712345Z",
  limit: 50,
};
const id = (value) => createHash("sha256").update(String(value)).digest("hex");
const result = {
  entries: [{ insertId: "seed", timestamp: query.start }],
  returnedRows: 1,
  fetchedRows: 1,
  processedRows: 1,
  invalidRows: 0,
  truncated: false,
  nextCursor: null,
  windowExhausted: true,
};
const snapshot = (store) => JSON.stringify([...store.rows]);
const ids = (store) => new Set([...store.rows.values()].map((row) => row.id));
function fixture(maxEntries = 200, ctx = context()) {
  let time = 1_000;
  const now = () => ++time;
  const store = transactionMemoryStore({
    maxEntries,
    now,
    assertCurrent: ctx.assertInvocationCurrent,
  });
  const ledger = (scope = ctx) => createPageLedger(store, scope, config, { now, maxEntries });
  return { store, ledger, now, ctx, maxEntries };
}
async function page(f, label, { scope, inputCursor, more = false, finish = true } = {}) {
  const l = f.ledger(scope),
    fingerprint = id(label),
    toolCallId = `call-${label}`;
  const pageQuery = inputCursor
    ? (await l.getCursor(inputCursor)).query
    : { ...query, insertIds: [label] };
  const reserved = await l.reserveQuery({
    toolCallId,
    fingerprint,
    query: pageQuery,
    ...(inputCursor ? { inputCursor } : {}),
  });
  if (finish && reserved.kind === "reserved") {
    await l.finishQuery({
      receiptId: fingerprint,
      toolCallId,
      result: { ...result, nextCursor: more ? fingerprint : null, windowExhausted: !more },
      ...(more
        ? {
            cursorState: {
              id: fingerprint,
              queryFingerprint: id("query"),
              query: pageQuery,
              pendingRows: [],
              backendToken: `PRIVATE:${label}`,
              projectionTruncated: false,
            },
          }
        : {}),
    });
  }
  return { ledger: l, id: fingerprint, toolCallId, reserved };
}

test("more than 200 cloud pages resume through new ledger instances with bounded LRU storage", async () => {
  const f = fixture(),
    seen = [];
  let reads = 0,
    firstCursor,
    args = query,
    last;
  const readPage = async (_query, token) => {
    const index = token === null ? 0 : Number(token.split(":")[1]);
    reads++;
    return {
      entries: [
        {
          timestamp: query.start,
          insertId: `entry-${index}`,
          resource: { type: "k8s_container", labels: { project_id: config.project } },
          jsonPayload: { message: "synthetic evidence" },
        },
      ],
      nextPageToken: index < 244 ? `PRIVATE:${index + 1}` : null,
    };
  };
  const execute = async (call, params) =>
    (
      await createPagedLogsTool(
        config,
        f.ctx,
        () => {
          throw new Error("no shell");
        },
        { ledger: f.ledger(), readPage },
      ).execute(call, params)
    ).details;
  for (let index = 0; index < 245; index++) {
    last = await execute(`page-${index}`, args);
    seen.push(...last.entries.map((row) => row.insertId));
    assert.ok(f.store.rows.size <= 200);
    assert.ok(!JSON.stringify(last).includes("PRIVATE:"));
    firstCursor ??= last.nextCursor;
    if (last.nextCursor) {
      args = { cursor: last.nextCursor };
    }
  }
  assert.equal(reads, 245);
  assert.equal(seen.length, 245);
  assert.equal(new Set(seen).size, 245);
  assert.equal(last.windowExhausted, true);
  assert.equal(last.nextCursor, null);
  await assert.rejects(execute("expired-cursor", { cursor: firstCursor }), /cursor|evict|expire/i);
  assert.equal(reads, 245, "an evicted cursor must not restart a cloud scan");
  const fresh = await execute("old-initial-query", query);
  assert.equal(reads, 246);
  assert.equal(fresh.reusedEvidence, false, "an evicted initial query is a fresh cache miss");
});

test("recent reuse beats FIFO while another conversation live cursor stays pinned", async () => {
  const f = fixture(4),
    other = context({
      sessionKey: "thread-two",
      sessionId: "generation-two",
      nativeChannelId: "C456",
    });
  const pinned = await page(f, "other-live", { scope: other, more: true });
  const a = await page(f, "old-a"),
    b = await page(f, "old-b");
  await page(f, "old-c");
  assert.equal((await page(f, "old-a")).reserved.kind, "cached");
  await page(f, "new-d");
  assert.ok(ids(f.store).has(a.id), "a cache hit must refresh recency");
  assert.ok(!ids(f.store).has(b.id), "the least recently used eligible result should be evicted");
  assert.equal((await f.ledger(other).getCursor(pinned.id)).backendToken, "PRIVATE:other-live");
  await assert.rejects(f.ledger().getCursor(pinned.id), /cursor/i);
});

test("all pinned capacity preserves pending and failed attempts and stops before any cloud read", async () => {
  const f = fixture(2);
  await page(f, "pending", { finish: false });
  const failed = await page(f, "failed", { finish: false });
  await failed.ledger.failQuery({
    receiptId: failed.id,
    toolCallId: failed.toolCallId,
    reason: "timeout; outcome unknown",
  });
  const before = snapshot(f.store);
  let reads = 0;
  const tool = createPagedLogsTool(config, f.ctx, () => {}, {
    ledger: f.ledger(),
    readPage: async () => {
      reads++;
      return { entries: [], nextPageToken: null };
    },
  });
  await assert.rejects(tool.execute("full", query), /capacity|pinned|full|limit/i);
  assert.equal(reads, 0);
  assert.equal(snapshot(f.store), before);
});

test("a full 200-record legacy chain resumes by proving consumed parents, preserving the live tip", async () => {
  const f = fixture();
  let previous;
  for (let n = 0; n < 200; n++) {
    previous = (await page(f, `legacy-${n}`, { inputCursor: previous, more: true })).id;
  }
  for (const row of f.store.rows.values()) {
    delete row.lastUsedAt;
    delete row.cursorConsumed;
  }
  const tip = previous;
  assert.equal(f.store.rows.size, 200);
  assert.equal((await f.ledger().getCursor(tip)).backendToken, "PRIVATE:legacy-199");
  const next = await page(f, "legacy-next", { inputCursor: tip, more: true });
  assert.equal(f.store.rows.size, 200);
  assert.equal((await f.ledger().getCursor(next.id)).backendToken, "PRIVATE:legacy-next");
  assert.ok(!ids(f.store).has(id("legacy-0")));
});

test("legacy parent stays evictable after its older successor is reclaimed first", async () => {
  const f = fixture(3);
  const parent = await page(f, "legacy-parent", { more: true });
  const child = await page(f, "legacy-child", { inputCursor: parent.id, more: true });
  const tip = await page(f, "legacy-tip", { inputCursor: child.id, more: true });
  for (const row of f.store.rows.values()) {
    delete row.lastUsedAt;
    delete row.cursorConsumed;
  }
  await f.ledger().getCursor(parent.id);
  const next = await page(f, "after-legacy", { inputCursor: tip.id, more: true });
  assert.ok(
    !ids(f.store).has(child.id),
    "the older child must be evicted before its touched parent",
  );
  const persistedParent = [...f.store.rows.values()].find((row) => row.id === parent.id);
  assert.equal(persistedParent.cursorConsumed, true, "consumption proof survives child eviction");
  await f.ledger().getCursor(tip.id);
  await page(f, "after-legacy-again", { inputCursor: next.id, more: true });
  assert.ok(
    !ids(f.store).has(parent.id),
    "the settled parent must remain eligible without its child",
  );
  assert.equal(f.store.rows.size, 3);
});

for (const invalid of [
  { label: "missing owner", field: "toolCallId", value: undefined },
  { label: "negative attempt", field: "attempt", value: -1 },
  { label: "null attempt", field: "attempt", value: null },
  { label: "string attempt", field: "attempt", value: "0" },
  { label: "boolean attempt", field: "attempt", value: false },
  { label: "fractional attempt", field: "attempt", value: 0.5 },
  { label: "unsafe integer attempt", field: "attempt", value: Number.MAX_SAFE_INTEGER + 1 },
]) {
  test(`malformed finished child with ${invalid.label} cannot settle or evict its parent`, async () => {
    const f = fixture(2);
    const parent = await page(f, "protected-parent", { more: true });
    const child = await page(f, "malformed-child", { inputCursor: parent.id });
    await f.ledger().getCursor(parent.id); // Make the child the oldest apparent candidate.
    const parentRow = [...f.store.rows.values()].find((row) => row.id === parent.id);
    const childRow = [...f.store.rows.values()].find((row) => row.id === child.id);
    delete parentRow.cursorConsumed; // Legacy checkpoints rely on valid successor proof.
    childRow[invalid.field] = invalid.value;
    const before = snapshot(f.store);
    await assert.rejects(page(f, "different-query", { finish: false }), /protected checkpoints/);
    assert.equal(
      snapshot(f.store),
      before,
      "malformed child and live parent remain byte-identical",
    );
    assert.equal(parentRow.cursorConsumed, undefined);
    assert.equal((await f.ledger().getCursor(parent.id)).backendToken, "PRIVATE:protected-parent");
  });
}

test("a valid finished child cannot mark a malformed parent consumed", async () => {
  const f = fixture(2);
  const parent = await page(f, "malformed-parent", { more: true });
  const child = await page(f, "valid-child-of-malformed-parent", { inputCursor: parent.id });
  await f.ledger().getCursor(parent.id);
  const parentRow = [...f.store.rows.values()].find((row) => row.id === parent.id);
  delete parentRow.cursorConsumed;
  delete parentRow.toolCallId;
  const before = JSON.stringify(parentRow);
  await page(f, "independent-valid-query", { finish: false });
  assert.equal(f.store.rows.size, 2);
  assert.ok(!ids(f.store).has(child.id), "valid terminal child can still be reclaimed");
  assert.equal(
    JSON.stringify([...f.store.rows.values()].find((row) => row.id === parent.id)),
    before,
  );
});

test("valid finished child still proves legacy consumption and permits bounded admission", async () => {
  const f = fixture(2);
  const parent = await page(f, "valid-parent", { more: true });
  const child = await page(f, "valid-child", { inputCursor: parent.id });
  assert.equal(
    Object.hasOwn(
      [...f.store.rows.values()].find((row) => row.id === child.id),
      "attempt",
    ),
    false,
    "absent legacy attempt remains valid and defaults to zero",
  );
  await f.ledger().getCursor(parent.id);
  const parentRow = [...f.store.rows.values()].find((row) => row.id === parent.id);
  delete parentRow.cursorConsumed;
  await page(f, "different-valid-query", { finish: false });
  assert.equal(f.store.rows.size, 2);
  assert.ok(!ids(f.store).has(child.id), "valid old successor is reclaimed");
  assert.equal([...f.store.rows.values()].find((row) => row.id === parent.id).cursorConsumed, true);
  assert.equal((await f.ledger().getCursor(parent.id)).backendToken, "PRIVATE:valid-parent");
});

test("fixed bookkeeping headroom preserves a near-limit legacy checkpoint through child completion", async () => {
  const f = fixture(),
    parent = await page(f, "large-legacy", { more: true });
  const row = [...f.store.rows.values()][0];
  const stable = (value) =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .toSorted()
              .map((key) => [key, stable(value[key])]),
          )
        : value;
  const completionHash = () =>
    createHash("sha256")
      .update(JSON.stringify(stable({ result: row.result, cursorState: row.cursorState })))
      .digest("hex");
  delete row.lastUsedAt;
  row.cursorState.pendingRows = [{ synthetic: "" }];
  row.completionHash = completionHash();
  row.cursorState.pendingRows[0].synthetic = "x".repeat(
    262140 - Buffer.byteLength(JSON.stringify(row)),
  );
  row.completionHash = completionHash();
  assert.equal(Buffer.byteLength(JSON.stringify(row)), 262140);
  assert.equal((await f.ledger().getCursor(parent.id)).backendToken, "PRIVATE:large-legacy");
  assert.equal((await page(f, "large-legacy")).reserved.kind, "cached");
  await page(f, "large-legacy-child", { inputCursor: parent.id });
  const settledParent = [...f.store.rows.values()].find((value) => value.id === parent.id);
  assert.equal(settledParent.cursorConsumed, true);
  assert.equal((await f.ledger().getCursor(parent.id)).backendToken, "PRIVATE:large-legacy");
  assert.ok(
    Buffer.byteLength(JSON.stringify(settledParent)) > 256 * 1024,
    "legacy content uses only the new bookkeeping allowance",
  );
  for (const value of f.store.rows.values()) {
    const { lastUsedAt: _lastUsedAt, cursorConsumed: _cursorConsumed, ...content } = value;
    assert.ok(Buffer.byteLength(JSON.stringify(content)) <= 256 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024 + 128);
  }
});

test("eviction and reservation roll back together on failure or final authority revocation", async () => {
  let live = true;
  const guard = () => {
    if (!live) {
      throw new Error("revoked");
    }
  };
  const f = fixture(2, context({ assertInvocationCurrent: guard }));
  await page(f, "victim");
  await page(f, "live", { more: true });
  const before = snapshot(f.store);
  f.store.controls.afterMutation = (count) => {
    if (count === 2) {
      throw new Error("injected transaction failure");
    }
  };
  await assert.rejects(page(f, "after-failure"), /injected/);
  assert.equal(snapshot(f.store), before, "no victim is lost on failed admission");
  f.store.controls.afterMutation = undefined;
  f.store.controls.beforeCommit = () => {
    live = false;
  };
  await assert.rejects(page(f, "after-revocation"), /revoked/);
  assert.equal(snapshot(f.store), before, "revocation prevents both eviction and reservation");
  f.store.controls.beforeCommit = undefined;
  live = true;
  await page(f, "admitted");
  assert.equal(f.store.rows.size, 2);
});

test("concurrent reservations share one admission and cannot evict live cursors to exceed capacity", async () => {
  const f = fixture(3);
  await page(f, "victim");
  const tip = await page(f, "live", { more: true });
  await page(f, "uncertain", { finish: false });
  const admissions = await Promise.all(
    Array.from({ length: 8 }, (_, n) =>
      f.ledger().reserveQuery({ toolCallId: `concurrent-${n}`, fingerprint: id("same"), query }),
    ),
  );
  assert.equal(admissions.filter((row) => row.kind === "reserved").length, 1);
  assert.equal(admissions.filter((row) => row.kind === "pending").length, 7);
  assert.equal(f.store.rows.size, 3);
  assert.equal((await f.ledger().getCursor(tip.id)).backendToken, "PRIVATE:live");
  const rejected = await Promise.allSettled(
    Array.from({ length: 6 }, (_, n) => page(f, `different-${n}`, { finish: false })),
  );
  assert.ok(rejected.every((row) => row.status === "rejected"));
  assert.equal(f.store.rows.size, 3);
});

test("child completion settles its parent cursor atomically and cached continuation remains replayable", async () => {
  const f = fixture(3),
    parent = await page(f, "parent", { more: true });
  const child = await page(f, "child", { inputCursor: parent.id, more: true, finish: false });
  const completion = {
    receiptId: child.id,
    toolCallId: child.toolCallId,
    result: { ...result, nextCursor: child.id, windowExhausted: false },
    cursorState: {
      id: child.id,
      queryFingerprint: id("query"),
      pendingRows: [],
      backendToken: "PRIVATE:child",
      query: (await f.ledger().getCursor(parent.id)).query,
      projectionTruncated: false,
    },
  };
  const before = snapshot(f.store);
  f.store.controls.afterMutation = (count) => {
    if (count === 2) {
      throw new Error("injected completion failure");
    }
  };
  await assert.rejects(child.ledger.finishQuery(completion), /injected/);
  assert.equal(snapshot(f.store), before);
  f.store.controls.afterMutation = undefined;
  assert.equal((await f.ledger().getCursor(parent.id)).backendToken, "PRIVATE:parent");
  await child.ledger.finishQuery(completion);
  assert.equal((await page(f, "child", { inputCursor: parent.id })).reserved.kind, "cached");
  assert.equal((await f.ledger().getCursor(child.id)).backendToken, "PRIVATE:child");
});
