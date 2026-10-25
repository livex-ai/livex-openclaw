import { scopeIdentity, PAGE_CACHE_ERRORS } from "./page-store-operation.mjs";

export { PAGE_CACHE_ENTRIES } from "./page-store-operation.mjs";

function pageId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw Error("Invalid page receipt or cursor");
  return value;
}

/** Bounded transport cache; native Codex retains conversation history. */
export function createPageLedger(store, context, config, { now = Date.now } = {}) {
  if (!store || typeof store.createOperation !== "function")
    throw Error("Page LRU requires host-owned atomic state operations");
  const scope = scopeIdentity(context, config);
  const assertCurrent = () => context.assertInvocationCurrent();
  const operation = store.createOperation(
    [store],
    {
      moduleName: "page-store-operation-api.ts",
      exportName: "runPageOperation",
    },
    { assertCurrent },
  );
  const callIds = new Map();
  const execute = async (type, input) => {
    assertCurrent();
    let receipt;
    try {
      receipt = await operation.execute(
        { type, input: { ...input, scope, now: now() } },
        { writeStores: [0] },
      );
    } catch (error) {
      // Native workers wrap handler failures. Expose only our fixed diagnostic
      // messages, never arbitrary nested storage details or untrusted content.
      assertCurrent();
      if (
        error?.code === "PLUGIN_STATE_WRITE_FAILED" &&
        Object.values(PAGE_CACHE_ERRORS).includes(error.cause?.message)
      ) {
        throw Error(error.cause.message);
      }
      throw error;
    }
    assertCurrent();
    return receipt.value;
  };
  const resolve = ({ receiptId, toolCallId }) => {
    const id = pageId(receiptId ?? callIds.get(toolCallId));
    if (callIds.has(toolCallId) && callIds.get(toolCallId) !== id)
      throw Error("Tool call reused for a different page");
    return id;
  };
  return {
    getCursor: (id) => execute("cursor", { id: pageId(id) }),
    async reserveQuery(input) {
      const id = pageId(input.fingerprint);
      if (callIds.has(input.toolCallId) && callIds.get(input.toolCallId) !== id)
        throw Error("Tool call reused for a different page");
      const output = await execute("reserve", { ...input, id });
      callIds.set(input.toolCallId, id);
      return output;
    },
    finishQuery: (input) => execute("finish", { ...input, id: resolve(input) }),
    failQuery: (input) => execute("fail", { ...input, id: resolve(input) }),
  };
}
