import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackMessageEvent } from "../types.js";

export const SLACK_ROOT_MESSAGE_SIGNAL = "root-message-signal";

export type SlackRootMessageSignal = Readonly<{
  ts: string;
  botId?: string;
  appId?: string;
}>;

export type SlackRootMessageSignalSource = {
  subscribe(params: {
    teamId: string;
    channelId: string;
    onMessage: (message: SlackRootMessageSignal) => void;
  }): () => void;
};

export function createSlackRootMessageSignals() {
  const listeners = new Set<Parameters<SlackRootMessageSignalSource["subscribe"]>[0]>();
  const source: SlackRootMessageSignalSource = {
    subscribe(params) {
      listeners.add(params);
      return () => {
        listeners.delete(params);
      };
    },
  };
  return {
    source,
    publish(teamId: string, message: SlackMessageEvent) {
      if (
        !teamId ||
        !message.ts ||
        (message.subtype && message.subtype !== "bot_message") ||
        (message.thread_ts && message.thread_ts !== message.ts)
      ) {
        return;
      }
      const record = asOptionalRecord(message);
      const signal = Object.freeze({
        ts: message.ts,
        botId: normalizeOptionalString(message.bot_id),
        appId: normalizeOptionalString(record?.app_id),
      });
      for (const listener of listeners) {
        if (listener.teamId === teamId && listener.channelId === message.channel) {
          try {
            listener.onMessage(signal);
          } catch {
            logVerbose("slack: root message signal subscriber failed");
          }
        }
      }
    },
  };
}
