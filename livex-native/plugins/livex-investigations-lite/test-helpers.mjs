// Minimal fake of the keyed-store V2 surface this plugin uses, honoring
// maxEntries with evict-oldest. No host, network or production state.
export function memoryStore({ maxEntries = 500, overflowPolicy = "evict-oldest" } = {}) {
  const rows = new Map();
  let clock = 0;
  return {
    rows,
    async lookup(key) {
      const row = rows.get(key);
      return row ? structuredClone(row.value) : undefined;
    },
    async register(key, value) {
      if (!rows.has(key) && rows.size >= maxEntries) {
        if (overflowPolicy !== "evict-oldest") throw new Error("store full");
        const oldest = [...rows].sort((a, b) => a[1].createdAt - b[1].createdAt)[0][0];
        rows.delete(oldest);
      }
      const createdAt = rows.get(key)?.createdAt ?? ++clock;
      rows.set(key, { value: structuredClone(value), createdAt });
    },
    async entries() {
      return [...rows].map(([key, row]) => ({
        key,
        value: structuredClone(row.value),
        createdAt: row.createdAt,
      }));
    },
  };
}

export const CHANNEL = "C0ALERTS1";
export const SENDER = "U0ALLOWED";
export const THREAD = "1768996800.000001";
export const SESSION = `agent:debugger:slack:channel:${CHANNEL.toLowerCase()}:thread:${THREAD}`;

export const baseConfig = {
  allowedChannelId: CHANNEL,
  allowedSenderId: SENDER,
};

export const toolContext = (over = {}) => ({
  agentId: "debugger",
  sessionKey: SESSION,
  messageChannel: "slack",
  nativeChannelId: CHANNEL,
  requesterSenderId: SENDER,
  assertInvocationCurrent() {},
  ...over,
});
