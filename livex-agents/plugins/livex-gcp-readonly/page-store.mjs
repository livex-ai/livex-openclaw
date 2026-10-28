import { scopeIdentity, PAGE_CACHE_ERRORS } from "./page-store-operation.mjs";

export { PAGE_CACHE_ENTRIES } from "./page-store-operation.mjs";

function pageId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Invalid page receipt or cursor");
  }
  return value;
}

/** Bounded transport cache; native Codex retains conversation history. */
export function createPageLedger(store, context, config, { now = Date.now } = {}) {
  if (!store || typeof store.createOperation !== "function") {
    throw new Error("Page LRU requires host-owned atomic state operations");
  }
  const scope = scopeIdentity(context, config);
  const legacyScope = scopeIdentity(context, config, { legacy: true });
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
        { type, input: { ...input, scope, legacyScope, now: now() } },
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
        // eslint-disable-next-line preserve-caught-error -- This whitelist is a privacy boundary; never attach private native storage causes.
        throw new Error(error.cause.message);
      }
      throw error;
    }
    assertCurrent();
    return receipt.value;
  };
  const resolve = ({ receiptId, toolCallId, attempt }) => {
    const owned = callIds.get(toolCallId);
    const id = pageId(receiptId ?? owned?.id);
    if (owned && owned.id !== id) {
      throw new Error("Tool call reused for a different page");
    }
    return { id, attempt: attempt ?? owned?.attempt ?? 0 };
  };
  return {
    getCursor: (id) => execute("cursor", { id: pageId(id) }),
    async reserveQuery(input) {
      const id = pageId(input.fingerprint);
      if (callIds.has(input.toolCallId) && callIds.get(input.toolCallId).fingerprint !== id) {
        throw new Error("Tool call reused for a different page");
      }
      const output = await execute("reserve", { ...input, id });
      callIds.set(input.toolCallId, {
        fingerprint: id,
        id: output.receipt.id,
        attempt: output.receipt.attempt,
      });
      return output;
    },
    finishQuery: (input) => execute("finish", { ...input, ...resolve(input) }),
    failQuery: (input) => execute("fail", { ...input, ...resolve(input) }),
  };
}
