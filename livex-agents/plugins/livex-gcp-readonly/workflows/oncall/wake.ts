import {
  SLACK_ROOT_MESSAGE_SIGNAL,
  type SlackRootMessageSignalSource,
} from "@openclaw/slack/integration-api.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContextV2,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OncallConfig } from "./config.js";
import { isRecentAlert } from "./intake.js";

const WAKE_INTERVAL_MS = 5_000;

export function startOncallSlackWake(params: {
  api: OpenClawPluginApi;
  context: OpenClawPluginServiceContextV2;
  config: OncallConfig;
  jobId: string;
  expectedScript: { agentId: string; script: string; toolName: string };
  assertCurrent: () => void;
}) {
  const { api, context, config, jobId, expectedScript, assertCurrent } = params;
  const { scheduler } = context;
  const contexts = api.runtime.channel.runtimeContexts;
  const key = {
    channelId: "slack",
    accountId: config.accountId,
    capability: SLACK_ROOT_MESSAGE_SIGNAL,
  };
  let unsubscribe: (() => void) | undefined;
  let pending: { source: SlackRootMessageSignalSource; ts: string } | undefined;
  let lastWakeAt = -Infinity;
  const subscribe = () => {
    unsubscribe?.();
    const source = contexts.get<SlackRootMessageSignalSource>(key);
    if (!source) {
      return;
    }
    unsubscribe = source.subscribe({
      teamId: config.teamId,
      channelId: config.channelId,
      onMessage(message) {
        if (
          scheduler.signal.aborted ||
          contexts.get(key) !== source ||
          !isRecentAlert(message.ts, scheduler.now()) ||
          message.botId !== config.publisherBotId ||
          (config.publisherAppId && message.appId !== config.publisherAppId)
        ) {
          return;
        }
        if (!pending || pending.source !== source || Number(message.ts) > Number(pending.ts)) {
          pending = { source, ts: message.ts };
        }
        scheduler.schedule({
          id: "slack-alert-wake",
          mode: "earliest",
          delayMs: Math.max(250, lastWakeAt + WAKE_INTERVAL_MS - scheduler.now()),
          async run() {
            const signal = pending;
            pending = undefined;
            const isCurrent = () =>
              signal !== undefined &&
              contexts.get(key) === signal.source &&
              isRecentAlert(signal.ts, scheduler.now());
            if (!isCurrent()) {
              return;
            }
            const assertSignalCurrent = () => {
              assertCurrent();
              if (!isCurrent()) {
                throw new Error("Oncall Slack signal is no longer current");
              }
            };
            lastWakeAt = scheduler.now();
            try {
              assertCurrent();
              const cron = context.getCron?.();
              const job = (await cron?.list({ includeDisabled: true }))?.find(
                (candidate) => candidate.id === jobId,
              );
              assertSignalCurrent();
              if (job?.enabled) {
                await cron?.enqueueRun?.(jobId, "if-enabled", {
                  ...expectedScript,
                  assertCurrent: assertSignalCurrent,
                });
              }
            } catch {
              if (!scheduler.signal.aborted && isCurrent()) {
                api.logger.warn(
                  "Oncall Slack wake was not admitted. Scheduled catch-up remains available.",
                );
              }
            }
          },
        });
      },
    });
  };
  const unwatch = contexts.watch({ ...key, onEvent: subscribe });
  scheduler.signal.addEventListener(
    "abort",
    () => {
      unwatch();
      unsubscribe?.();
    },
    { once: true },
  );
  subscribe();
}
