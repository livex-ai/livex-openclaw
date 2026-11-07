import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginStateKeyedStoreV2ForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { vi } from "vitest";
import { parseOncallConfig } from "./config.js";
import { admitAlert } from "./intake.js";
import { createReceiptStore, type OncallStore } from "./state.js";
import type { Receipt, SlackTransport } from "./types.js";

export const now = Date.parse("2026-11-07T10:00:00Z");
export const config = parseOncallConfig({
  enabled: true,
  accountId: "default",
  teamId: "T123456",
  channelId: "C123456",
  publisherBotId: "B123456",
  historicalSenderId: "U123456",
  environment: "prd",
  resourceType: "k8s_container",
  resourceLabels: { namespace_name: "prd-worker" },
  broadcastChannelId: "C765432",
})!;
export const message = {
  ts: (now / 1000).toFixed(6),
  bot_id: config.publisherBotId,
  team: config.teamId,
  text: "job_id=job-1 failed",
};
export const alert = admitAlert(message, config, now);
export const gcpConfig = {
  gcloudPath: "/opt/google-cloud-sdk/bin/gcloud",
  cloudSdkConfig: "/home/pilot/.config/gcloud",
  gcloudAccount: "investigator@example.test",
  project: "example-prd",
  allowedChannelId: "C123456",
  allowedSenderId: "U123456",
};
export const finding = {
  id: "one",
  signature: {
    service: "worker",
    environment: "prd",
    operation: "process",
    error: "failed",
    resource: "job-1",
  },
  priority: "Critical" as const,
  summary: "Failure <@U666666> @channel",
  nextAction: "Inspect worker",
  evidence: ["https://console.cloud.google.com/logs/query;query=test"],
};
export function slackStub(): SlackTransport {
  return {
    verify: vi.fn(async () => {}),
    history: vi.fn(async () => ({ messages: [] })),
    roster: vi.fn(async () => ({ p1: "U123456", p2: "U765432" })),
    acknowledged: vi.fn(async () => false),
    send: vi.fn(async () => "1794045601.000001"),
  };
}
export function nativeStore(maxEntries = 2001) {
  const root = mkdtempSync(join(tmpdir(), "oncall-state-"));
  const source: OncallStore = createPluginStateKeyedStoreV2ForTests<
    Receipt | { timestamp: string; sourceId: string }
  >(
    "livex-gcp-readonly",
    {
      namespace: `oncall-${randomUUID()}`,
      maxEntries,
      overflowPolicy: "reject-new",
      env: { OPENCLAW_STATE_DIR: root },
    },
    { assertCurrent() {} },
  );
  return { source, store: createReceiptStore(source, "test-source"), root };
}
