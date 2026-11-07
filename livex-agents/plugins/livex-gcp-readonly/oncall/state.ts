import { createHash } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { OncallConfig } from "./config.js";
import type { Alert, Receipt } from "./types.js";

type Checkpoint = { timestamp: string; sourceId: string; quarantined?: boolean };
export type OncallStore = PluginStateKeyedStore<Receipt | Checkpoint, 2>;

export function createReceiptScope(
  config: OncallConfig,
  gcp: { project: string; gcloudAccount: string },
  catalogSource: string,
) {
  const labels = Object.entries(config.resourceLabels).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  const source = [
    config.accountId,
    config.teamId,
    config.channelId,
    config.publisherBotId,
    config.publisherAppId,
    gcp.project,
    gcp.gcloudAccount,
    config.environment,
    config.resourceType,
    labels,
    config.historicalSenderId,
    catalogSource,
    config.broadcastChannelId,
  ];
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

export function createReceiptStore(
  store: OncallStore,
  sourceId: string,
  reportQuarantine: (count: number) => void = () => {},
) {
  if (!sourceId) {
    throw new Error("Oncall receipt source identity is required");
  }
  let reportedQuarantine = false;
  function executable(value: Receipt | Checkpoint): value is Receipt {
    return "alert" in value && value.sourceId === sourceId && !value.quarantined;
  }

  async function quarantine(key: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const observation = await store.observe(key);
      const value = observation.value;
      if (!value || value.quarantined || executable(value)) {
        return;
      }
      const result = await store.compareAndApply(key, observation.comparison, {
        operation: "update",
        action: "set",
        value: { ...value, quarantined: true },
      });
      if (result.status !== "conflict") {
        return;
      }
    }
    throw new Error("Oncall quarantine changed concurrently");
  }
  async function change(key: string, update: (receipt: Receipt) => Receipt): Promise<Receipt> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const observation = await store.observe(key);
      const current = observation.value;
      if (!current || !executable(current)) {
        throw new Error("Oncall receipt is missing or outside the current source");
      }
      // Optional fields are absent in the durable JSON representation, never undefined.
      // JSON serialization deliberately removes undefined optional fields; structuredClone preserves them.
      // eslint-disable-next-line unicorn/prefer-structured-clone
      const value: Receipt = JSON.parse(JSON.stringify(update(current)));
      if (value.sourceId !== sourceId) {
        throw new Error("Oncall receipt source identity cannot change");
      }
      const result = await store.compareAndApply(key, observation.comparison, {
        operation: "update",
        action: "set",
        value,
      });
      if (result.status !== "conflict") {
        return value;
      }
    }
    throw new Error("Oncall receipt changed concurrently");
  }
  return {
    change,
    async admit(alert: Alert) {
      await store.registerIfAbsent(alert.key, { alert, phase: "queued", sourceId });
    },
    async list() {
      const entries = await store.entriesInKeyRange({
        keyStartInclusive: "alert:",
        keyEndExclusive: "alert;",
        limit: 2_000,
      });
      const matching: Receipt[] = [];
      let quarantined = 0;
      for (const entry of entries) {
        if (executable(entry.value)) {
          matching.push(entry.value);
        } else {
          await quarantine(entry.key);
          quarantined++;
        }
      }
      if (quarantined > 0 && !reportedQuarantine) {
        reportQuarantine(quarantined);
        reportedQuarantine = true;
      }
      return matching;
    },
    async checkpoint() {
      const value = await store.lookup("checkpoint");
      return value && "timestamp" in value && value.sourceId === sourceId
        ? value.timestamp
        : undefined;
    },
    async advance(timestamp: string) {
      await store.register("checkpoint", { timestamp, sourceId });
    },
  };
}

export type ReceiptStore = ReturnType<typeof createReceiptStore>;
