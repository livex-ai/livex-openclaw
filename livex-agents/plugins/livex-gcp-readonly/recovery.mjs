import { validateConfig } from "./core.mjs";
import { scopeIdentity, PAGE_CACHE_ENTRIES, PAGE_CACHE_ERRORS } from "./page-store-operation.mjs";

// This command is intercepted by the host before the LLM. Its owner authority is
// required independently of the evidence tool's ordinary invocation authority.
export function createRecoveryCommand(rawConfig, openStore) {
  return {
    name: "livex-gcp-recover",
    description: "Inspect or explicitly recover one unfinished log read in this thread.",
    channels: ["slack"],
    acceptsArgs: true,
    requireAuth: true,
    requiredScopes: [/** @type {"operator.admin"} */ ("operator.admin")],
    async handler(ctx) {
      const config = validateConfig(rawConfig);
      const from = /^slack:(channel|group):([CG][A-Z0-9]+)$/.exec(ctx.from ?? "");
      const channel = from?.[2];
      const target = /^(?:team:(T[A-Z0-9]+):)?channel:([CG][A-Z0-9]+)$/.exec(ctx.to ?? "");
      if (
        ctx.channel !== "slack" ||
        !ctx.isAuthorizedSender ||
        ctx.senderIsOwner !== true ||
        ctx.senderId !== config.allowedSenderId ||
        typeof ctx.assertOwnerCurrent !== "function"
      ) {
        throw new Error("Recovery requires the authorized Slack owner and current owner authority");
      }
      if (
        !channel ||
        typeof ctx.messageThreadId !== "string" ||
        !/^\d+\.\d+$/.test(ctx.messageThreadId) ||
        target?.[2] !== channel ||
        typeof ctx.agentId !== "string"
      ) {
        throw new Error(
          "Use the recovery text command in the original alert thread; ambiguous or native slash context is not supported",
        );
      }
      const peer = target[1] ? `team:${target[1]}:channel:${channel}` : channel;
      const expectedSession =
        `agent:${ctx.agentId}:slack:${from[1]}:${peer}:thread:${ctx.messageThreadId}`.toLowerCase();
      if (ctx.sessionKey !== expectedSession) {
        throw new Error(
          "Recovery requires the original canonical thread session; shared or custom bindings are not supported",
        );
      }
      const authority = ctx.assertOwnerCurrent;
      authority();
      const scopeContext = {
        agentId: ctx.agentId,
        agentAccountId: ctx.accountId,
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        nativeChannelId: channel,
        requesterSenderId: ctx.senderId,
        messageChannel: "slack",
        assertInvocationCurrent: authority,
      };
      const scope = scopeIdentity(scopeContext, config);
      const legacyScope = scopeIdentity(scopeContext, config, { legacy: true });
      const parts = ctx.args?.trim().split(/\s+/) ?? [];
      const [action, selector, receiptHash] = parts;
      const listing = action === "list";
      const legacyList = listing && selector === "legacy";
      const offsetText = listing ? parts[legacyList ? 2 : 1] : undefined;
      const offset = offsetText === undefined ? 0 : Number(offsetText);
      const selected = /^(legacy:)?([a-f0-9]{64})$/.exec(selector ?? "");
      if (
        listing
          ? parts.length > (legacyList ? 3 : 2) ||
            (offsetText !== undefined && !/^(0|[1-9]\d*)$/.test(offsetText)) ||
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            offset > PAGE_CACHE_ENTRIES
          : !selected ||
            !["inspect", "retry", "restart-legacy", "retire-checkpoint"].includes(action) ||
            parts.length !== (action === "inspect" ? 2 : 3) ||
            (action !== "inspect" && !/^[a-f0-9]{64}$/.test(receiptHash ?? ""))
      ) {
        throw new Error(
          "Usage: /livex-gcp-recover list [legacy] [offset]; inspect <receipt|legacy:receipt>; retry, restart-legacy or retire-checkpoint <receipt> <inspected-hash>",
        );
      }
      if (
        !listing &&
        (action === "restart-legacy") !==
          (Boolean(selected[1]) && action !== "inspect" && action !== "retire-checkpoint")
      ) {
        throw new Error(
          "Use restart-legacy for explicit legacy recovery; retry only accepts current-identity receipts",
        );
      }
      const store = openStore(
        { namespace: "log-pages", maxEntries: PAGE_CACHE_ENTRIES, overflowPolicy: "reject-new" },
        { assertCurrent: authority },
      );
      const operation = store.createOperation(
        [store],
        {
          moduleName: "page-store-operation-api.ts",
          exportName: "runPageOperation",
        },
        { assertCurrent: authority },
      );
      authority();
      let result;
      try {
        result = await operation.execute(
          {
            type: listing
              ? "list"
              : action === "inspect"
                ? "inspect"
                : ["retry", "restart-legacy"].includes(action)
                  ? "approve-retry"
                  : "retire",
            input: {
              scope,
              legacyScope,
              legacy: listing ? legacyList : Boolean(selected[1]),
              id: listing ? "0".repeat(64) : selected[2],
              receiptHash,
              offset,
              operatorId: ctx.senderId,
              restartLegacy: action === "restart-legacy",
              now: Date.now(),
            },
          },
          { writeStores: [0] },
        );
      } catch (error) {
        authority();
        if (
          error?.code === "PLUGIN_STATE_WRITE_FAILED" &&
          Object.values(PAGE_CACHE_ERRORS).includes(error.cause?.message)
        ) {
          // eslint-disable-next-line preserve-caught-error -- This whitelist is a privacy boundary; never attach private native storage causes.
          throw new Error(error.cause.message);
        }
        throw error;
      }
      authority();
      return { text: JSON.stringify(result.value) };
    },
  };
}
