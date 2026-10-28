import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { queryArgs } from "./core.mjs";
import { transactionMemoryStore } from "./page-lru-test-helpers.mjs";
import { createPageLedger } from "./page-store.mjs";
import { createPagedLogsTool } from "./paging.mjs";
import * as recovery from "./recovery.mjs";
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
  sessionKey: "agent:oncall:slack:channel:c123:thread:1792710014.413639",
  sessionId: "generation-one",
  messageChannel: "slack",
  nativeChannelId: "C123",
  requesterSenderId: "U123",
  assertInvocationCurrent() {},
};
const query = {
  mode: "discover",
  insertIds: ["seed"],
  start: "2026-10-20T16:00:00Z",
  end: "2026-10-20T17:00:00Z",
  limit: 50,
};
const result = { entries: [], nextCursor: null, windowExhausted: true };
const id = (value) => createHash("sha256").update(String(value)).digest("hex");
const commandContext = (extra = {}) => ({
  channel: "slack",
  senderId: "U123",
  isAuthorizedSender: true,
  senderIsOwner: true,
  assertOwnerCurrent() {},
  agentId: "oncall",
  accountId: "default",
  sessionKey: "agent:oncall:slack:channel:c123:thread:1792710014.413639",
  sessionId: "generation-one",
  from: "slack:channel:C123",
  to: "channel:C123",
  messageThreadId: "1792710014.413639",
  ...extra,
});
function fixture(maxEntries = 200) {
  const store = transactionMemoryStore({ maxEntries });
  const ledger = (ctx = context, cfg = config) => createPageLedger(store, ctx, cfg);
  let reads = 0;
  const tool = (l = ledger()) =>
    createPagedLogsTool(
      config,
      context,
      () => {
        throw new Error("no process");
      },
      {
        ledger: l,
        readPage: async () => {
          reads++;
          return { entries: [], nextPageToken: null };
        },
      },
    );
  const command = (args, ctx = {}) => {
    assert.equal(
      typeof recovery.createRecoveryCommand,
      "function",
      "operator recovery command must exist",
    );
    return recovery
      .createRecoveryCommand(config, () => store)
      .handler(commandContext({ args, ...ctx }));
  };
  return { store, ledger, tool, command, reads: () => reads };
}
async function unresolved(f, fingerprint = id("attempt"), params = query) {
  return f
    .ledger()
    .reserveQuery({ toolCallId: "original", fingerprint, query: queryArgs(params, config) });
}
async function inspect(f, selector) {
  const response = await f.command(`inspect ${selector}`);
  return JSON.parse(response.text);
}

test("cloud credential configuration isolates reused evidence and private cursors", async () => {
  const f = fixture();
  const first = await unresolved(f);
  await f.ledger().finishQuery({ toolCallId: "original", receiptId: first.receipt.id, result });
  for (const override of [
    { gcloudAccount: "other@example.test" },
    { cloudSdkConfig: "/different/config" },
  ]) {
    const next = await f
      .ledger(context, { ...config, ...override })
      .reserveQuery({ toolCallId: "new", fingerprint: first.receipt.id, query });
    assert.equal(next.kind, "reserved", "changed cloud identity must not reuse evidence");
  }
});

test("at capacity an operator-approved exact retry runs once in the same row and rejects the old attempt", async () => {
  const f = fixture(1),
    original = await unresolved(f);
  await assert.rejects(f.tool().execute("unapproved", query), /unresolved/);
  await assert.rejects(
    f.tool().execute("refresh-bypass", { ...query, refresh: true }),
    /unresolved/,
  );
  assert.equal(f.reads(), 0);
  const receipt = await inspect(f, original.receipt.id);
  const before = JSON.stringify([...f.store.rows]);
  await assert.rejects(f.command(`retry ${original.receipt.id} ${id("stale")}`), /changed|stale/);
  assert.equal(JSON.stringify([...f.store.rows]), before);
  await f.command(`retry ${original.receipt.id} ${receipt.receiptHash}`);
  assert.equal(f.reads(), 0, "operator command must never launch a cloud read");
  const outcomes = await Promise.allSettled([
    f.tool().execute("retry-one", query),
    f.tool().execute("retry-two", query),
  ]);
  assert.ok(
    outcomes.some((x) => x.status === "fulfilled"),
    outcomes.map((x) => x.reason?.message).join("; "),
  );
  assert.equal(f.reads(), 1);
  assert.equal(f.store.rows.size, 1);
  await assert.rejects(
    f.ledger().finishQuery({ toolCallId: "original", receiptId: original.receipt.id, result }),
    /owner|attempt/,
  );
  await assert.rejects(
    f
      .ledger()
      .failQuery({ toolCallId: "original", receiptId: original.receipt.id, reason: "late" }),
    /owner|attempt/,
  );
  const saved = [...f.store.rows.values()][0];
  assert.equal(saved.attempt, 1);
  assert.equal(saved.status, "finished");
  assert.equal(saved.recovery.previousStatus, "pending");
  await f.tool().execute("different-query", { ...query, insertIds: ["different"] });
  assert.equal(f.reads(), 2, "completed recovery frees an ordinary LRU slot");
});

test("original refresh fingerprint recovers through normal query without another row", async () => {
  const f = fixture(1),
    first = f.tool();
  // A synthetic failed reader models a refresh attempt with a nonstandard fingerprint.
  const failed = createPagedLogsTool(config, context, () => {}, {
    ledger: f.ledger(),
    readPage: async () => {
      throw new Error("synthetic timeout");
    },
  });
  await assert.rejects(failed.execute("refresh-original", { ...query, refresh: true }), /timeout/);
  const stored = [...f.store.rows.values()][0];
  const receipt = await inspect(f, stored.id);
  await f.command(`retry ${stored.id} ${receipt.receiptHash}`);
  await first.execute("approved-new-owner", query);
  assert.equal(f.reads(), 1);
  assert.equal(f.store.rows.size, 1);
  assert.equal([...f.store.rows.values()][0].id, stored.id);
  await first.execute("reuse-recovered-refresh", query);
  assert.equal(f.reads(), 1, "ordinary query reuses retained recovery evidence");
  await first.execute("explicit-fresh-refresh", { ...query, refresh: true });
  assert.equal(f.reads(), 2, "explicit refresh still permits a new read");
});

test("recovery is scoped, operator-only, current, and metadata-only", async () => {
  const f = fixture(),
    first = await unresolved(f);
  for (const override of [
    { senderId: "UOTHER" },
    { senderIsOwner: false },
    { isAuthorizedSender: false },
    { channel: "discord" },
    { assertOwnerCurrent: undefined },
    { messageThreadId: undefined },
    { to: "slash:U123" },
  ]) {
    await assert.rejects(
      f.command(`inspect ${first.receipt.id}`, override),
      /authorized|owner|thread|context/i,
    );
  }
  await assert.rejects(
    f.command(`inspect ${first.receipt.id}`, { sessionKey: "other" }),
    /receipt|missing|thread/i,
  );
  await assert.rejects(
    f.command(`inspect ${first.receipt.id}`, {
      assertOwnerCurrent() {
        throw new Error("revoked");
      },
    }),
    /revoked/,
  );
  const info = await inspect(f, first.receipt.id);
  assert.equal(info.status, "pending");
  assert.equal(info.receiptHash.length, 64);
  assert.ok(!JSON.stringify(info).includes("/private/cloud"));
  assert.ok(!JSON.stringify(info).includes("reader@example.test"));
  const before = JSON.stringify([...f.store.rows]);
  f.store.controls.beforeCommit = () => {
    throw new Error("revoked before commit");
  };
  await assert.rejects(f.command(`retry ${first.receipt.id} ${info.receiptHash}`), /revoked/);
  assert.equal(JSON.stringify([...f.store.rows]), before);
});

const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .toSorted()
            .map((k) => [k, stable(v[k])]),
        )
      : v;
const hash = (v) =>
  createHash("sha256")
    .update(JSON.stringify(stable(v)))
    .digest("hex");
async function legacyRow(f, { continuation = false, label = "legacy", more = false } = {}) {
  const { scopeIdentity } = await import("./page-store-operation.mjs");
  const scope = scopeIdentity(context, config, { legacy: true });
  const row = {
    version: 1,
    scope,
    id: id(label),
    toolCallId: "old-attempt",
    query: queryArgs(query, config),
    status: more ? "finished" : "failed",
    reservedAt: "2026-10-20T16:00:00Z",
    ...(continuation ? { inputCursor: id("old-parent") } : { failure: "Original outcome unknown" }),
  };
  if (more) {
    row.result = { ...result, nextCursor: row.id, windowExhausted: false };
    row.cursorState = {
      id: row.id,
      query: row.query,
      queryFingerprint: hash(row.query),
      pendingRows: [{ secret: "PRIVATE_LOG" }],
      backendToken: "PRIVATE_TOKEN",
      retrievedAt: row.reservedAt,
    };
    row.completionHash = hash({ result: row.result, cursorState: row.cursorState });
  }
  f.store.rows.set(`page:${hash({ scope, id: row.id })}`, row);
  return row;
}

test("legacy unknown continuation explicitly restarts only its saved window under current credentials at capacity", async () => {
  const f = fixture(1),
    old = await legacyRow(f, { continuation: true });
  await assert.rejects(f.tool().execute("no-auto-adoption", query), /legacy:/);
  assert.equal(f.reads(), 0);
  const info = await inspect(f, `legacy:${old.id}`);
  await assert.rejects(f.command(`retry legacy:${old.id} ${info.receiptHash}`), /restart-legacy/);
  const approved = JSON.parse(
    (await f.command(`restart-legacy legacy:${old.id} ${info.receiptHash}`)).text,
  );
  assert.equal(approved.restartFromBeginning, true);
  assert.equal(f.store.rows.size, 1);
  await f.tool().execute("explicit-restart", query);
  assert.equal(f.reads(), 1);
  const saved = [...f.store.rows.values()][0];
  assert.equal(saved.recovery.previousInputCursor, old.inputCursor);
  assert.equal(saved.recovery.previousStatus, "failed");
  assert.equal(saved.inputCursor, undefined);
  assert.notEqual(saved.scope, old.scope);
  await f.tool().execute("reuse-legacy-restart", query);
  assert.equal(f.reads(), 1, "ordinary query reuses migrated recovery evidence");
  await f.tool().execute("explicit-refresh-after-restart", { ...query, refresh: true });
  assert.equal(f.reads(), 2);
});

test("checkpoint retirement records abandonment, hides private state, and unblocks only an ordinary new query", async () => {
  const f = fixture(1),
    first = await unresolved(f);
  await f.ledger().finishQuery({
    toolCallId: "original",
    receiptId: first.receipt.id,
    result: { ...result, nextCursor: first.receipt.id, windowExhausted: false },
    cursorState: {
      id: first.receipt.id,
      query: queryArgs(query, config),
      queryFingerprint: hash(queryArgs(query, config)),
      pendingRows: [{ secret: "PRIVATE_LOG" }],
      backendToken: "PRIVATE_TOKEN",
    },
  });
  const info = await inspect(f, first.receipt.id);
  assert.ok(!JSON.stringify(info).includes("PRIVATE_"));
  await f.command(`retire-checkpoint ${first.receipt.id} ${info.receiptHash}`);
  const saved = [...f.store.rows.values()][0];
  assert.equal(saved.status, "retired");
  assert.equal(saved.cursorConsumed, undefined);
  assert.equal(saved.cursorState, undefined);
  assert.equal(f.reads(), 0);
  await assert.rejects(f.tool().execute("retired-cursor", { cursor: first.receipt.id }), /retired/);
  await f.tool().execute("independent-query", { ...query, insertIds: ["other"] });
  assert.equal(f.reads(), 1);
  await assert.rejects(f.tool().execute("evicted-cursor", { cursor: first.receipt.id }), /cursor/);
  assert.equal(f.reads(), 1);
});

test("unknown refresh attempts remain blocked with spare capacity until exact operator approval", async () => {
  const f = fixture();
  const failed = createPagedLogsTool(config, context, () => {}, {
    ledger: f.ledger(),
    readPage: async () => {
      throw new Error("unknown original outcome");
    },
  });
  await assert.rejects(failed.execute("first", query), /unknown/);
  await assert.rejects(
    f.tool().execute("different-fingerprint", { ...query, refresh: true }),
    /unresolved/,
  );
  assert.equal(f.reads(), 0);
  assert.equal(f.store.rows.size, 1);
});

test("200 protected records can recover one exact read without changing the other 199", async () => {
  const f = fixture();
  for (let n = 0; n < 200; n++) {
    await unresolved(f, id(`pending-${n}`), { ...query, insertIds: [`seed-${n}`] });
  }
  const selected = [...f.store.rows.values()][0],
    preserved = JSON.stringify([...f.store.rows].slice(1));
  const info = await inspect(f, selected.id);
  await f.command(`retry ${selected.id} ${info.receiptHash}`);
  await f.tool().execute("one-recovery", selected.query);
  assert.equal(f.reads(), 1);
  assert.equal(f.store.rows.size, 200);
  assert.equal(JSON.stringify([...f.store.rows].slice(1)), preserved);
  await f.tool().execute("new-query", { ...query, insertIds: ["new"] });
  assert.equal(f.reads(), 2);
  assert.equal(f.store.rows.size, 200);
});

test("bounded owner list discovers current and legacy receipts without logs or cross-thread records", async () => {
  const f = fixture();
  for (let n = 0; n < 25; n++) {
    await unresolved(f, id(n), { ...query, insertIds: [String(n)] });
  }
  const old = await legacyRow(f, { more: true });
  const first = JSON.parse((await f.command("list")).text);
  assert.equal(first.receipts.length, 20);
  assert.equal(first.nextOffset, 20);
  assert.equal(first.total, 25);
  assert.ok(first.receipts.every((x) => !("query" in x) && !("receiptHash" in x)));
  const last = JSON.parse((await f.command("list 20")).text);
  assert.equal(last.receipts.length, 5);
  assert.equal(last.nextOffset, null);
  const legacy = JSON.parse((await f.command("list legacy")).text);
  assert.deepEqual(
    legacy.receipts.map((x) => x.id),
    [old.id],
  );
  assert.ok(!JSON.stringify(legacy).includes("PRIVATE_"));
  await assert.rejects(f.command("list", { messageThreadId: "1792710014.413640" }), /thread/);
  await assert.rejects(f.command("list", { sessionKey: "shared-custom-session" }), /thread/);
  await assert.rejects(f.command("list -1"), /Usage/);
  const scoped = JSON.parse(
    (
      await f.command("list", {
        sessionKey: "agent:oncall:slack:channel:c123:thread:1792710014.413640",
        messageThreadId: "1792710014.413640",
      })
    ).text,
  );
  assert.equal(scoped.total, 0);
});

test("team-qualified text command preserves the exact canonical original-root scope", async () => {
  const f = fixture(),
    sessionKey = "agent:oncall:slack:channel:team:t123:channel:c123:thread:1792710014.413639";
  const l = f.ledger({ ...context, sessionKey });
  const row = await l.reserveQuery({ toolCallId: "team", fingerprint: id("team"), query });
  const output = JSON.parse(
    (await f.command(`inspect ${row.receipt.id}`, { sessionKey, to: "team:T123:channel:C123" }))
      .text,
  );
  assert.equal(output.id, row.receipt.id);
  await assert.rejects(
    f.command(`inspect ${row.receipt.id}`, { sessionKey, to: "team:T999:channel:C123" }),
    /thread/,
  );
});

test("malformed persisted recovery approval never admits or evicts its row", async () => {
  const f = fixture(),
    row = await unresolved(f);
  const record = [...f.store.rows.values()][0];
  record.status = "retry-approved";
  record.recovery = { operatorId: "U123" };
  const before = JSON.stringify([...f.store.rows]);
  await assert.rejects(
    f.tool().execute("bad-approval", { ...query, refresh: true }),
    /full|invalid/,
  );
  assert.equal(f.reads(), 0);
  assert.equal(JSON.stringify([...f.store.rows]), before);
  await assert.rejects(f.command(`inspect ${row.receipt.id}`), /invalid/i);
});

test("historical same-query unresolved siblings recover one inspected receipt at a time", async () => {
  const f = fixture(2);
  await unresolved(f);
  const first = [...f.store.rows.values()][0];
  const sibling = {
    ...structuredClone(first),
    id: id("historical-refresh"),
    toolCallId: "historical-refresh",
  };
  f.store.rows.set(`page:${hash({ scope: sibling.scope, id: sibling.id })}`, sibling);
  const untouched = JSON.stringify(sibling);
  const firstInfo = await inspect(f, first.id);
  const siblingInfo = await inspect(f, sibling.id);
  await f.command(`retry ${first.id} ${firstInfo.receiptHash}`);
  await assert.rejects(
    f.command(`retry ${sibling.id} ${siblingInfo.receiptHash}`),
    /outstanding|approval|retry/i,
  );
  await Promise.allSettled([
    f.tool().execute("recover-first", query),
    f.tool().execute("concurrent", query),
  ]);
  assert.equal(f.reads(), 1);
  assert.equal(
    JSON.stringify(f.store.rows.get(`page:${hash({ scope: sibling.scope, id: sibling.id })}`)),
    untouched,
  );
  const nextInfo = await inspect(f, sibling.id);
  await f.command(`retry ${sibling.id} ${nextInfo.receiptHash}`);
  await f.tool().execute("recover-second", query);
  assert.equal(f.reads(), 2);
  assert.equal(f.store.rows.size, 2);
  assert.ok([...f.store.rows.values()].every((value) => value.status === "finished"));
});

test("multiple legacy attempts migrate independently without collision or silent cached adoption", async () => {
  const f = fixture(2);
  const first = await legacyRow(f, { label: "legacy-initial" });
  const sibling = await legacyRow(f, { label: "legacy-continuation", continuation: true });
  const a = await inspect(f, `legacy:${first.id}`);
  const b = await inspect(f, `legacy:${sibling.id}`);
  const approvedA = JSON.parse(
    (await f.command(`restart-legacy legacy:${first.id} ${a.receiptHash}`)).text,
  );
  await assert.rejects(
    f.command(`restart-legacy legacy:${sibling.id} ${b.receiptHash}`),
    /outstanding|approval|retry/i,
  );
  await f.tool().execute("restart-first", query);
  assert.equal(f.reads(), 1);
  await assert.rejects(f.tool().execute("unapproved-legacy-sibling", query), /legacy:/);
  assert.equal(f.reads(), 1, "unselected legacy sibling remains protected");
  const approvedB = JSON.parse(
    (await f.command(`restart-legacy legacy:${sibling.id} ${b.receiptHash}`)).text,
  );
  assert.notEqual(approvedA.id, approvedB.id);
  await f.tool().execute("restart-second", query);
  assert.equal(f.reads(), 2);
  await f.tool().execute("reuse-all-legacy-recoveries", query);
  assert.equal(f.reads(), 2);
  assert.equal(f.store.rows.size, 2);
  assert.ok([...f.store.rows.values()].every((value) => value.status === "finished"));
  assert.ok([...f.store.rows.values()].every((value) => value.inputCursor === undefined));
  assert.deepEqual(
    new Set([...f.store.rows.values()].map((value) => value.recovery.previousReceiptId)),
    new Set([first.id, sibling.id]),
  );
});

test("checkpoint retirement refuses outstanding or malformed dependent reads", async () => {
  const f = fixture();
  const parent = await unresolved(f);
  const ledger = f.ledger();
  await ledger.finishQuery({
    toolCallId: "original",
    receiptId: parent.receipt.id,
    result: { ...result, nextCursor: parent.receipt.id, windowExhausted: false },
    cursorState: {
      id: parent.receipt.id,
      query: queryArgs(query, config),
      queryFingerprint: hash(queryArgs(query, config)),
      pendingRows: [],
      backendToken: "PRIVATE_TOKEN",
    },
  });
  const child = await ledger.reserveQuery({
    toolCallId: "child",
    fingerprint: id("dependent"),
    query: queryArgs(query, config),
    inputCursor: parent.receipt.id,
  });
  const info = await inspect(f, parent.receipt.id);
  const before = JSON.stringify([...f.store.rows]);
  await assert.rejects(
    f.command(`retire-checkpoint ${parent.receipt.id} ${info.receiptHash}`),
    /dependent|continuation/i,
  );
  assert.equal(JSON.stringify([...f.store.rows]), before);
  const childRow = [...f.store.rows.values()].find((value) => value.id === child.receipt.id);
  childRow.status = "unrecognized";
  await assert.rejects(
    f.command(`retire-checkpoint ${parent.receipt.id} ${info.receiptHash}`),
    /dependent|continuation/i,
  );
  childRow.status = "pending";
  await ledger.finishQuery({ toolCallId: "child", receiptId: child.receipt.id, result });
  assert.equal(
    [...f.store.rows.values()].find((value) => value.id === parent.receipt.id).cursorConsumed,
    true,
  );
});

test("malformed completed checkpoints cannot be retired", async () => {
  const f = fixture();
  const parent = await unresolved(f);
  await f.ledger().finishQuery({
    toolCallId: "original",
    receiptId: parent.receipt.id,
    result: { ...result, nextCursor: parent.receipt.id, windowExhausted: false },
    cursorState: {
      id: parent.receipt.id,
      query: queryArgs(query, config),
      queryFingerprint: hash(queryArgs(query, config)),
      pendingRows: [],
      backendToken: "PRIVATE_TOKEN",
    },
  });
  const stored = [...f.store.rows.values()][0];
  stored.completionHash = id("corrupt-completion");
  const info = await inspect(f, parent.receipt.id);
  const before = JSON.stringify([...f.store.rows]);
  await assert.rejects(
    f.command(`retire-checkpoint ${parent.receipt.id} ${info.receiptHash}`),
    /invalid|checkpoint/i,
  );
  assert.equal(JSON.stringify([...f.store.rows]), before);
});

test("inconsistent retry audit attempt cannot authorize a read", async () => {
  const other = fixture();
  const first = await unresolved(other);
  const approval = await inspect(other, first.receipt.id);
  await other.command(`retry ${first.receipt.id} ${approval.receiptHash}`);
  const inconsistent = [...other.store.rows.values()][0];
  inconsistent.recovery.previousAttempt = 20;
  const original = JSON.stringify([...other.store.rows]);
  await assert.rejects(
    other.tool().execute("bad-counter", { ...query, refresh: true }),
    /invalid/i,
  );
  assert.equal(other.reads(), 0);
  assert.equal(JSON.stringify([...other.store.rows]), original);
});

test("active retries serialize operator approval without changing sibling receipts", async () => {
  const f = fixture(2);
  const owner = f.ledger();
  await unresolved(f);
  const first = [...f.store.rows.values()][0];
  const sibling = {
    ...structuredClone(first),
    id: id("active-sibling"),
    toolCallId: "active-sibling",
  };
  f.store.rows.set(`page:${hash({ scope: sibling.scope, id: sibling.id })}`, sibling);
  const a = await inspect(f, first.id);
  const b = await inspect(f, sibling.id);
  await f.command(`retry ${first.id} ${a.receiptHash}`);
  const active = await owner.reserveQuery({
    toolCallId: "active-retry",
    fingerprint: id("new-call"),
    query: first.query,
  });
  assert.equal(active.kind, "reserved");
  const before = JSON.stringify([...f.store.rows]);
  await assert.rejects(f.command(`retry ${sibling.id} ${b.receiptHash}`), /outstanding/);
  assert.equal(JSON.stringify([...f.store.rows]), before);
  await assert.rejects(
    f.ledger().finishQuery({ toolCallId: "original", receiptId: first.id, result }),
    /owner|attempt/,
  );
  await owner.finishQuery({ toolCallId: "active-retry", receiptId: first.id, result });
  await f.command(`retry ${sibling.id} ${b.receiptHash}`);
  assert.equal(f.reads(), 0, "synthetic ledger and operator commands never invoke cloud reads");
});
