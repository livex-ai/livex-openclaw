import assert from "node:assert/strict";
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
const labels = { project_id: "example-prd", namespace_name: "test-service" };
const timestamp = (hour) => `2026-10-20T${hour}:00:46.073712345Z`;
const ns = (value) => {
  const [whole, fractional = ""] = value.slice(0, -1).split(".");
  return BigInt(Date.parse(`${whole}Z`)) * 1000000n + BigInt(fractional.padEnd(9, "0"));
};
const entry = (
  insertId,
  time,
  severity = "ERROR",
  message = "LLM upstream unavailable",
  size = 0,
) => ({
  timestamp: time,
  insertId,
  severity,
  resource: { type: "k8s_container", labels },
  jsonPayload: {
    conversation_id: "conversation-a",
    message: message + "x".repeat(size),
    stack: "y".repeat(size),
    level: severity,
  },
});

// Execute the plugin's actual atomic handler without host state or credentials.
function hostStore(maxEntries = 200) {
  return transactionMemoryStore({ maxEntries });
}

test("seven-hour evidence retrieval survives dense pages and restart without claiming an investigation conclusion", async () => {
  const rows = [
    entry("early-llm-seed", timestamp(16)),
    entry("webhook-seed", "2026-10-20T22:57:09.123456789Z", "ERROR", "Malformed webhook JSON"),
    entry("before-window", "2026-10-20T16:00:46.073712344Z"),
    ...Array.from({ length: 60 }, (_, i) =>
      entry(
        `dense-${i}`,
        `2026-10-20T16:10:${String(i).padStart(2, "0")}.123456789Z`,
        "ERROR",
        "LLM request failed",
        1400,
      ),
    ),
    entry(
      "recovery-evidence",
      "2026-10-20T23:00:45.999999999Z",
      "INFO",
      "Request completed for conversation-a",
    ),
    entry(
      "late-debug-noise",
      "2026-10-20T23:50:19.123456789Z",
      "ERROR",
      "[DEBUG] Payload after alert window",
    ),
  ];
  const calls = [],
    store = hostStore();
  const readPage = async (query, token) => {
    calls.push({ query: structuredClone(query), token });
    const matched = rows
      .filter((row) => ns(row.timestamp) >= ns(query.start) && ns(row.timestamp) <= ns(query.end))
      .filter((row) => query.mode !== "discover" || query.insertIds.includes(row.insertId))
      .filter(
        (row) => !query.conversationId || row.jsonPayload.conversation_id === query.conversationId,
      );
    if (query.mode === "context" && query.start === timestamp(16) && token === null)
      return { entries: [], nextPageToken: "PRIVATE:0" };
    const offset = token ? Number(token.split(":")[1]) : 0;
    return {
      entries: matched.slice(offset, offset + query.limit),
      nextPageToken:
        offset + query.limit < matched.length ? `PRIVATE:${offset + query.limit}` : null,
    };
  };
  let callId = 0;
  // New tool + ledger objects every time emulate restart, not process-local maps.
  const execute = async (args) => {
    const tool = createPagedLogsTool(
      config,
      context,
      () => {
        throw Error("unexpected command");
      },
      { ledger: createPageLedger(store, context, config), readPage },
    );
    return (await tool.execute(`call-${callId++}`, args)).details;
  };

  const seedResults = [];
  for (let hour = 16; hour < 23; hour++) {
    const result = await execute({
      mode: "discover",
      insertIds: ["early-llm-seed", "webhook-seed"],
      start: timestamp(hour),
      end: timestamp(hour + 1),
      limit: 50,
    });
    assert.equal(result.windowExhausted, true);
    seedResults.push(...result.entries);
  }
  assert.deepEqual(
    seedResults.map((row) => row.insertId),
    ["early-llm-seed", "webhook-seed"],
  );
  assert.equal(seedResults[0].timestamp, timestamp(16));
  assert.equal(calls.length, 7);
  assert.equal(calls[0].query.start, timestamp(16));
  assert.equal(calls.at(-1).query.end, timestamp(23));

  const contextQuery = {
    mode: "context",
    resourceType: "k8s_container",
    resourceLabels: labels,
    conversationId: "conversation-a",
    start: timestamp(16),
    end: timestamp(17),
    limit: 50,
  };
  let page = await execute(contextQuery);
  assert.deepEqual(page.entries, []);
  assert.equal(page.windowExhausted, false);
  assert.match(page.nextCursor, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(page).includes("PRIVATE:"));
  const resumeCursor = page.nextCursor;
  page = await execute({ cursor: resumeCursor });
  assert.ok(page.entries.length > 0 && page.entries.length < 50);
  assert.equal(page.windowExhausted, false);
  const backendReads = calls.length;
  const replay = await execute({ cursor: resumeCursor });
  assert.equal(replay.reusedEvidence, true);
  assert.deepEqual(replay.entries, page.entries);
  assert.equal(calls.length, backendReads);

  const found = [...page.entries],
    retrievalTimes = new Map();
  let bufferPages = 0;
  while (page.nextCursor) {
    const prior = page;
    page = await execute({ cursor: page.nextCursor });
    assert.ok(callId < 100);
    if (page.fromBuffer) {
      bufferPages++;
      assert.equal(page.retrievedAt, prior.retrievedAt);
    }
    found.push(...page.entries);
    for (const row of page.entries) retrievalTimes.set(row.insertId, page.retrievedAt);
  }
  assert.equal(page.windowExhausted, true);
  assert.ok(bufferPages > 0);
  assert.equal(found.length, 61);
  assert.equal(new Set(found.map((row) => row.insertId)).size, 61);
  assert.ok(found.some((row) => row.insertId === "early-llm-seed"));
  assert.ok(!found.some((row) => row.insertId === "before-window"));
  assert.equal(calls.length, 10, "seven seed reads, one empty page, and two dense cloud pages");

  const recovery = await execute({
    ...contextQuery,
    start: "2026-10-20T22:59:46.073712345Z",
    end: timestamp(23),
  });
  assert.deepEqual(
    recovery.entries.map((row) => row.insertId),
    ["recovery-evidence"],
  );
  assert.equal(recovery.entries[0].severity, "INFO");
  assert.ok(
    ![...seedResults, ...found, ...recovery.entries].some(
      (row) => row.insertId === "late-debug-noise",
    ),
  );
  assert.equal(calls.length, 11);
  assert.ok(
    [...store.rows.values()].every(
      (receipt) => Buffer.byteLength(JSON.stringify(receipt)) <= 256 * 1024,
    ),
  );
});

test("LRU reclaims finished evidence at capacity without presenting investigation completion", async () => {
  const store = hostStore(1);
  let calls = 0;
  const readPage = async () => {
    calls++;
    return { entries: [], nextPageToken: null };
  };
  const tool = createPagedLogsTool(
    config,
    context,
    () => {
      throw Error("unexpected command");
    },
    { ledger: createPageLedger(store, context, config), readPage },
  );
  const args = {
    mode: "discover",
    insertIds: ["seed"],
    start: timestamp(16),
    end: timestamp(17),
    limit: 50,
  };
  const first = (await tool.execute("one", args)).details;
  const second = (await tool.execute("two", { ...args, start: timestamp(17), end: timestamp(18) }))
    .details;
  assert.equal(first.windowExhausted, true);
  assert.equal(second.windowExhausted, true);
  assert.equal(second.reusedEvidence, false);
  assert.equal(second.investigationCompleted, undefined);
  assert.equal(calls, 2);
  assert.equal(store.rows.size, 1);
  assert.equal([...store.rows.values()][0].query.start, timestamp(17));
});
