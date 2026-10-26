import assert from "node:assert/strict";

const clone = (value) => (value === undefined ? undefined : structuredClone(value));
const capacityError = () =>
  Object.assign(new Error("store full: reject-new"), { code: "PLUGIN_STATE_LIMIT_EXCEEDED" });

// Isolated adapter for the public keyed-store transaction contract. It executes
// the plugin's real static handler, serializes transactions, and commits only
// after the handler and final authority check succeed. Native host proof remains
// a separate gate; no production state, credentials, or network are used here.
export function transactionMemoryStore({
  maxEntries = 200,
  now = Date.now,
  assertCurrent = () => {},
} = {}) {
  const rows = new Map(),
    created = new Map(),
    versions = new Map();
  let queue = Promise.resolve();
  const controls = { afterMutation: undefined, beforeCommit: undefined, afterCommit: undefined };
  const store = {
    rows,
    controls,
    async lookup(key) {
      assertCurrent();
      return clone(rows.get(key));
    },
    async observe(key) {
      assertCurrent();
      return { value: clone(rows.get(key)), comparison: String(versions.get(key) ?? 0) };
    },
    async compareAndApply(key, comparison, intent) {
      assertCurrent();
      if (comparison !== String(versions.get(key) ?? 0))
        return { status: "conflict", current: await store.observe(key) };
      if (intent.action === "keep") return { status: "unchanged" };
      if (intent.action === "delete") {
        rows.delete(key);
        created.delete(key);
      } else {
        assert.equal(intent.action, "set");
        if (!rows.has(key) && rows.size >= maxEntries) throw capacityError();
        rows.set(key, clone(intent.value));
        created.set(key, now());
      }
      versions.set(key, (versions.get(key) ?? 0) + 1);
      return { status: "applied" };
    },
    async entries() {
      assertCurrent();
      return [...rows].map(([key, value]) => ({
        key,
        value: clone(value),
        createdAt: created.get(key) ?? 0,
      }));
    },
    async count() {
      assertCurrent();
      return rows.size;
    },
    createOperation(stores, descriptor, authority) {
      assert.ok(stores.length > 0);
      assert.ok(
        stores.every((candidate) => candidate === store),
        "fixture supports only this physical namespace",
      );
      const check = () => {
        assertCurrent();
        authority?.assertCurrent();
      };
      check();
      return {
        execute(command, options) {
          const execute = async () => {
            check();
            const module = await import(new URL(descriptor.moduleName, import.meta.url));
            const handler = module[descriptor.exportName];
            assert.equal(typeof handler, "function");
            const next = new Map([...rows].map(([key, value]) => [key, clone(value)]));
            const dates = new Map(created);
            const changed = new Set();
            let active = true,
              mutationCount = 0;
            const access = (index, write = false) => {
              assert.ok(active, "transaction ended");
              assert.ok(Number.isInteger(index) && stores[index] === store);
              if (write) assert.ok(options.writeStores.includes(index), "undeclared write");
            };
            const mutated = () => controls.afterMutation?.(++mutationCount);
            const tx = {
              lookup(index, key) {
                access(index);
                return clone(next.get(key));
              },
              lookupMany(keys) {
                return keys.map(({ store: index, key }) => tx.lookup(index, key));
              },
              entries(index) {
                access(index);
                return [...next].map(([key, value]) => ({
                  key,
                  value: clone(value),
                  createdAt: dates.get(key) ?? 0,
                }));
              },
              set(index, key, value, settings) {
                access(index, true);
                assert.equal(settings?.ttlMs, undefined);
                if (!next.has(key) && next.size >= maxEntries) throw capacityError();
                next.set(key, clone(value));
                dates.set(key, now());
                changed.add(key);
                mutated();
              },
              delete(index, key) {
                access(index, true);
                const removed = next.delete(key);
                dates.delete(key);
                changed.add(key);
                mutated();
                return removed;
              },
            };
            let value;
            try {
              value = handler(clone(command), tx);
              assert.ok(!value || typeof value.then !== "function", "handler must be synchronous");
              controls.beforeCommit?.();
              check();
              rows.clear();
              for (const [key, row] of next) rows.set(key, row);
              created.clear();
              for (const [key, date] of dates) created.set(key, date);
              for (const key of changed) versions.set(key, (versions.get(key) ?? 0) + 1);
            } finally {
              active = false;
            }
            controls.afterCommit?.();
            return { value: clone(value), assertCurrent: check };
          };
          const pending = queue.then(execute);
          queue = pending.catch(() => {});
          return pending;
        },
      };
    },
  };
  return store;
}
