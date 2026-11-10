import {
  createSlackWebClient,
  createSlackWriteClient,
  resolveSlackAccount,
} from "@openclaw/slack/api.js";
import { resolveAgentOutboundIdentity } from "openclaw/plugin-sdk/channel-outbound";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "zod";
import type { OncallConfig } from "./config.js";
import { resolveRoster, rotationReferences } from "./roster.js";
import type { Roster, SlackTransport, SourceConfig } from "./types.js";

const channelSchema = z.object({
  properties: z
    .object({
      tabs: z
        .array(
          z.object({
            type: z.string().optional(),
            data: z.object({ file_id: z.string().optional() }).optional(),
          }),
        )
        .optional(),
      canvas: z.object({ file_id: z.string().optional(), id: z.string().optional() }).optional(),
      meeting_notes: z
        .object({ file_id: z.string().optional(), id: z.string().optional() })
        .optional(),
    })
    .optional(),
});

const acknowledgmentNames = new Set(["white_check_mark", "eyes", "+1", "ok_hand"]);
const reactionMessageSchema = z.object({
  reactions: z
    .array(z.object({ name: z.string(), users: z.array(z.string().min(1)).optional() }))
    .optional(),
});
const acknowledgmentUserSchema = z.object({
  id: z.string(),
  is_bot: z.boolean(),
  deleted: z.boolean().optional(),
  is_agentforce_bot: z.boolean().optional(),
  is_workflow_bot: z.boolean().optional(),
  profile: z
    .object({
      bot_id: z.string().nullish(),
      is_agentforce_bot: z.boolean().optional(),
      is_sidekick_bot: z.boolean().optional(),
    })
    .nullish(),
});

function acknowledgmentActors(message: unknown) {
  const { reactions = [] } = reactionMessageSchema.parse(message);
  // Slack can omit reactor IDs, even when it reports a higher count.
  const actors = new Set(
    reactions.flatMap(({ name, users }) => (acknowledgmentNames.has(name) ? (users ?? []) : [])),
  );
  // Slackbot reports is_bot=false.
  actors.delete("USLACKBOT");
  return actors;
}

function isHumanReactor(actor: string, value: unknown) {
  const result = acknowledgmentUserSchema.safeParse(value);
  if (!result.success) {
    return false;
  }
  const { profile, ...user } = result.data;
  const { bot_id, is_agentforce_bot, is_sidekick_bot } = profile ?? {};
  return (
    user.id === actor &&
    !user.is_bot &&
    !user.deleted &&
    !user.is_agentforce_bot &&
    !user.is_workflow_bot &&
    !bot_id &&
    !is_agentforce_bot &&
    !is_sidekick_bot
  );
}

function isSlackUserUnavailable(error: unknown) {
  return z
    .object({
      code: z.literal("slack_webapi_platform_error"),
      data: z.object({ error: z.enum(["user_not_found", "user_not_visible"]) }),
    })
    .safeParse(error).success;
}

function canvasId(value: unknown) {
  const props = channelSchema.parse(value).properties;
  if (!props) {
    return undefined;
  }
  const candidates = [
    props.tabs?.find((tab) => tab.type === "canvas")?.data?.file_id,
    props.canvas?.file_id,
    props.meeting_notes?.file_id,
    props.canvas?.id,
  ];
  return candidates.find((id) => Boolean(id));
}

function slackFileUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !/^(?:[^.]+\.)*(?:slack\.com|slack-edge\.com|slack-files\.com)$/.test(url.hostname)
  ) {
    throw new Error("Canvas download URL is outside approved Slack hosts");
  }
  return url.href;
}

async function downloadCanvas(
  url: string,
  token: string,
  signal: AbortSignal,
  assertCurrent: () => void,
) {
  const fetched = await fetchWithSsrFGuard({
    url: slackFileUrl(url),
    requireHttps: true,
    maxRedirects: 0,
    beforeRequest: assertCurrent,
    signal,
    timeoutMs: 15_000,
    init: { headers: { Authorization: `Bearer ${token}` } },
    capture: false,
  });
  try {
    assertCurrent();
    if (!fetched.response.ok) {
      throw new Error("Canvas download failed");
    }
    const bytes = await readResponseWithLimit(fetched.response, 131_072, {
      signal,
      timeoutMs: 15_000,
    });
    assertCurrent();
    return bytes.toString("utf8");
  } finally {
    await fetched.release();
  }
}

export function createOncallSlack(params: {
  config: OncallConfig;
  sourceConfig: SourceConfig;
  signal: AbortSignal;
  assertCurrent(): void;
}): SlackTransport {
  const { config, assertCurrent, signal } = params;
  const account = resolveSlackAccount({ cfg: params.sourceConfig, accountId: config.accountId });
  if (!account.enabled || !account.botToken) {
    throw new Error("Configured Slack bot account is unavailable");
  }
  const token = account.botToken;
  const senderName =
    resolveAgentOutboundIdentity(params.sourceConfig, "oncall-coordinator")?.name ??
    "LiveX Reporting · Oncall";
  const read = createSlackWebClient(
    token,
    { timeout: 15_000, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true },
    assertCurrent,
  );
  let cachedRoster: Roster = {};

  async function checked<T>(operation: () => Promise<T>) {
    assertCurrent();
    signal.throwIfAborted();
    const result = await operation();
    assertCurrent();
    signal.throwIfAborted();
    return result;
  }

  async function body() {
    const channel = await checked(() => read.conversations.info({ channel: config.channelId }));
    const id = canvasId(channel.channel);
    if (!id) {
      throw new Error("The channel has no rotation canvas");
    }
    const info = await checked(() => read.files.info({ file: id }));
    const file = info.file;
    if (!file || file.id !== id) {
      throw new Error("Rotation canvas identity changed");
    }
    if (file.url_private) {
      return downloadCanvas(file.url_private, token, signal, assertCurrent);
    }
    const inline = z.object({ content: z.string().min(1).optional() }).parse(file);
    if (!inline.content) {
      throw new Error("Complete Canvas body unavailable");
    }
    const bytes = Buffer.byteLength(inline.content);
    if (bytes > 131_072) {
      throw new Error("Complete Canvas body exceeds the byte limit");
    }
    if (file.size !== bytes) {
      throw new Error("Inline Canvas body completeness is unverified");
    }
    return inline.content;
  }

  async function users() {
    const members = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await checked(() => read.users.list({ limit: 200, cursor }));
      members.push(...(result.members ?? []));
      cursor = result.response_metadata?.next_cursor?.trim();
      if (!cursor) {
        return members;
      }
    }
    throw new Error("Slack member listing is incomplete");
  }

  return {
    async verify() {
      const result = await checked(() => read.auth.test());
      if (result.team_id !== config.teamId) {
        throw new Error("Slack account belongs to a different workspace");
      }
    },
    async history(oldest, cursor) {
      const result = await checked(() =>
        read.conversations.history({
          channel: config.channelId,
          oldest,
          cursor,
          limit: 100,
          include_all_metadata: true,
        }),
      );
      return {
        messages: result.messages ?? [],
        cursor: result.response_metadata?.next_cursor?.trim() || undefined,
      };
    },
    async roster() {
      try {
        const text = await body();
        const references = Object.values(rotationReferences(text));
        const needsUsers = references.some(
          (reference) => !/^<?@?[UW][A-Z0-9]{6,}>?$/.test(reference),
        );
        cachedRoster = resolveRoster(text, needsUsers ? await users() : []);
        return cachedRoster;
      } catch {
        assertCurrent();
        return { error: "Current rotation Canvas unavailable; no engineer can be selected" };
      }
    },
    async acknowledged(ts) {
      const result = await checked(() =>
        read.reactions.get({ channel: config.channelId, timestamp: ts, full: true }),
      );
      for (const actor of acknowledgmentActors(result.message)) {
        try {
          const profile = await checked(() => read.users.info({ user: actor }));
          if (isHumanReactor(actor, profile.user)) {
            return true;
          }
        } catch (error) {
          if (!isSlackUserUnavailable(error)) {
            throw error;
          }
        }
      }
      return false;
    },
    async send({ text, threadTs, channel = config.channelId }) {
      if (![config.channelId, config.broadcastChannelId].includes(channel)) {
        throw new Error("Oncall delivery target is outside configured channels");
      }
      const write = createSlackWriteClient(
        token,
        { timeout: 15_000, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true },
        assertCurrent,
      );
      const postSlack = write.chat.postMessage;
      assertCurrent();
      signal.throwIfAborted();
      // The client fences the request. Keep a confirmed response available for
      // the service to settle even if the tick is cancelled while it is in flight.
      const result = await postSlack({
        channel,
        thread_ts: threadTs,
        text: `\u2063${text}`,
        username: senderName,
        parse: "none",
        link_names: false,
        unfurl_links: false,
        unfurl_media: false,
        metadata: { event_type: "livex_oncall", event_payload: {} },
      });
      if (!result.ok || !result.ts) {
        throw new Error("Oncall delivery has no confirmed message receipt");
      }
      return result.ts;
    },
  };
}

export function isDefiniteSlackRejection(error: unknown) {
  const result = z
    .object({ code: z.string(), data: z.object({ error: z.string() }).optional() })
    .safeParse(error);
  if (!result.success) {
    return false;
  }
  if (result.data.code === "slack_webapi_rate_limited_error") {
    return true;
  }
  const rejected = [
    "missing_scope",
    "not_authed",
    "invalid_auth",
    "account_inactive",
    "channel_not_found",
    "not_in_channel",
    "is_archived",
    "restricted_action",
    "msg_too_long",
    "no_text",
    "invalid_arguments",
    "ratelimited",
  ];
  return (
    result.data.code === "slack_webapi_platform_error" &&
    rejected.includes(result.data.data?.error ?? "")
  );
}
