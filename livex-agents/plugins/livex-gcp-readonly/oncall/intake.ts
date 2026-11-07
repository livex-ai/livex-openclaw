import { createHash } from "node:crypto";
import type { OncallConfig } from "./config.js";
import type { ReceiptStore } from "./state.js";
import type { Alert, SlackMessage, SlackTransport } from "./types.js";

const TIMESTAMP = /^\d{10,}\.\d{6}$/;
const ID_FIELDS = ["conversationId", "jobId", "roomId", "traceId", "insertId"];
const ID_PATTERNS = ID_FIELDS.map(
  (field) =>
    [
      field,
      new RegExp(
        `${field.replace("Id", "(?:[_ -]?id)")}\\s*[=:]\\s*["']?([A-Za-z0-9_.:-]{1,256})`,
        "i",
      ),
    ] as const,
);

export function isEligibleMessage(message: SlackMessage, config: OncallConfig) {
  return trustedPublisher(message, config) && validAlertRoot(message);
}

function trustedPublisher(message: SlackMessage, config: OncallConfig) {
  return (
    message.bot_id === config.publisherBotId &&
    (!config.publisherAppId || message.app_id === config.publisherAppId) &&
    (!message.team || message.team === config.teamId)
  );
}

function validAlertRoot(message: SlackMessage) {
  return (
    TIMESTAMP.test(message.ts ?? "") &&
    (!message.thread_ts || message.thread_ts === message.ts) &&
    message.metadata?.event_type !== "livex_oncall" &&
    !message.text?.includes("\u2063")
  );
}

export function admitAlert(message: SlackMessage, config: OncallConfig, now: number): Alert {
  const ts = message.ts!;
  const text = (message.text ?? "").slice(0, 20_000);
  const identifiers = Object.fromEntries(
    ID_PATTERNS.flatMap(([key, pattern]) => {
      const match = pattern.exec(text);
      return match ? [[key, match[1]!]] : [];
    }),
  );
  const identity = JSON.stringify([config.accountId, config.teamId, config.channelId, ts]);
  const timestamp = Number(ts) * 1_000;
  return {
    key: `alert:${createHash("sha256").update(identity).digest("hex")}`,
    ts,
    text,
    identifiers,
    admittedAt: now,
    start: new Date(timestamp - 900_000).toISOString(),
    end: new Date(Math.min(timestamp + 300_000, now)).toISOString(),
  };
}

export async function scanAlerts(params: {
  config: OncallConfig;
  store: ReceiptStore;
  slack: SlackTransport;
  now: number;
  clock?(): number;
  assertCurrent(): void;
}) {
  const { config, store, slack, now } = params;
  const checkpoint = await store.checkpoint();
  const cutoff = ((now - 900_000) / 1_000).toFixed(6);
  const oldest = checkpoint && checkpoint > cutoff ? checkpoint : cutoff;
  let cursor: string | undefined;
  let newest = oldest;
  for (let page = 0; page < config.maxScanPages; page++) {
    const result = await slack.history(oldest, cursor);
    params.assertCurrent();
    for (const message of result.messages) {
      const observedAt = params.clock?.() ?? now;
      newest = nextCheckpoint(newest, message, observedAt);
      await admitMessage(message, { ...params, now: observedAt });
    }
    cursor = result.cursor;
    if (!cursor) {
      await store.advance(newest);
      return;
    }
  }
  throw new Error("Oncall scan is incomplete; checkpoint retained");
}

function nextCheckpoint(current: string, message: SlackMessage, observedAt: number) {
  if (!TIMESTAMP.test(message.ts ?? "") || Number(message.ts) * 1_000 > observedAt) {
    return current;
  }
  return message.ts! > current ? message.ts! : current;
}

async function admitMessage(message: SlackMessage, params: Parameters<typeof scanAlerts>[0]) {
  if (!isEligibleMessage(message, params.config)) {
    return;
  }
  const age = params.now - Number(message.ts) * 1_000;
  if (age < 0 || age > 900_000) {
    return;
  }
  params.assertCurrent();
  await params.store.admit(admitAlert(message, params.config, params.now));
}
