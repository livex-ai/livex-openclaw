import { beforeEach, expect, it, vi } from "vitest";
import { createOncallSlack } from "./slack.js";
import { config } from "./test-support.js";

const boundary = vi.hoisted(() => ({
  file: {} as Record<string, unknown>,
  download: vi.fn(),
  write: vi.fn(),
  read: {
    conversations: { info: vi.fn() },
    files: { info: vi.fn() },
    reactions: { get: vi.fn() },
    users: { info: vi.fn(), list: vi.fn() },
  },
}));
vi.mock("@openclaw/slack/api.js", () => ({
  resolveSlackAccount: () => ({ enabled: true, botToken: "xoxb-synthetic-canvas" }),
  createSlackWebClient: () => boundary.read,
  createSlackWriteClient: boundary.write,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: boundary.download }));

beforeEach(() => {
  vi.clearAllMocks();
  boundary.read.conversations.info.mockResolvedValue({
    channel: { properties: { canvas: { file_id: "F123456" } } },
  });
  boundary.read.files.info.mockImplementation(async () => ({ file: boundary.file }));
  boundary.download.mockImplementation(async (options) => {
    options.beforeRequest();
    return { response: new Response("P1: <@U123456>\nP2: <@U765432>"), release: vi.fn() };
  });
  boundary.write.mockReturnValue({
    chat: { postMessage: vi.fn(async () => ({ ok: true, ts: "1794045601.000001" })) },
  });
});

function transport() {
  return createOncallSlack({
    config,
    sourceConfig: {},
    signal: new AbortController().signal,
    assertCurrent() {},
  });
}

it("does not acknowledge a Debugger reaction or infer a human from the count", async () => {
  boundary.read.reactions.get.mockResolvedValue({
    message: { reactions: [{ name: "eyes", users: ["U111111"], count: 2 }] },
  });
  boundary.read.users.info.mockResolvedValue({ user: { id: "U111111", is_bot: true } });
  await expect(transport().acknowledged("1794045600.000001")).resolves.toBe(false);
});

it("acknowledges a human reactor even when a bot added the same marker", async () => {
  boundary.read.reactions.get.mockResolvedValue({
    message: { reactions: [{ name: "white_check_mark", users: ["U111111", "U222222"] }] },
  });
  boundary.read.users.info.mockImplementation(async ({ user }) => ({
    user: { id: user, is_bot: user === "U111111", is_app_user: true },
  }));
  const ts = "1794045600.000001";
  await expect(transport().acknowledged(ts)).resolves.toBe(true);
  expect(boundary.read.reactions.get).toHaveBeenCalledWith({
    channel: config.channelId,
    timestamp: ts,
    full: true,
  });
  expect(boundary.read.users.info).toHaveBeenCalledWith({ user: "U222222" });
});

it("ignores Slackbot and missing or mismatched actor data", async () => {
  boundary.read.reactions.get.mockResolvedValue({
    message: {
      reactions: [
        { name: "+1", users: ["USLACKBOT", "U111111", "U222222", "U333333"] },
        { name: "ok_hand", count: 1 },
        { name: "warning", users: ["U444444"] },
      ],
    },
  });
  boundary.read.users.info
    .mockResolvedValueOnce({ user: { id: "U111111" } })
    .mockResolvedValueOnce({ user: { id: "U999999", is_bot: false } })
    .mockResolvedValueOnce({ user: { id: "U333333", is_bot: false, deleted: true } });
  await expect(transport().acknowledged("1794045600.000001")).resolves.toBe(false);
  expect(boundary.read.users.info.mock.calls).toEqual([
    [{ user: "U111111" }],
    [{ user: "U222222" }],
    [{ user: "U333333" }],
  ]);
});

it.each(["user_not_found", "user_not_visible"])("checks other reactors after %s", async (error) => {
  boundary.read.reactions.get.mockResolvedValue({
    message: { reactions: [{ name: "eyes", users: ["U111111", "U222222"] }] },
  });
  boundary.read.users.info
    .mockRejectedValueOnce({
      code: "slack_webapi_platform_error",
      data: { error },
    })
    .mockResolvedValueOnce({ user: { id: "U222222", is_bot: false } });
  await expect(transport().acknowledged("1794045600.000001")).resolves.toBe(true);
});

it("ignores Workflow Bot even if Slack reports is_bot=false", async () => {
  boundary.read.reactions.get.mockResolvedValue({
    message: { reactions: [{ name: "+1", users: ["U111111"] }] },
  });
  boundary.read.users.info.mockResolvedValue({
    user: { id: "U111111", is_bot: false, is_workflow_bot: true },
  });
  await expect(transport().acknowledged("1794045600.000001")).resolves.toBe(false);
});

it("surfaces a Slack identity lookup outage", async () => {
  boundary.read.reactions.get.mockResolvedValue({
    message: { reactions: [{ name: "ok_hand", users: ["U111111"] }] },
  });
  boundary.read.users.info.mockRejectedValueOnce(new Error("Slack unavailable"));
  await expect(transport().acknowledged("1794045600.000001")).rejects.toThrow("Slack unavailable");
});

it("downloads full Canvas despite a P1-only preview and preserves P2 for escalation", async () => {
  boundary.file = {
    id: "F123456",
    preview_plain_text: "P1: <@U123456>",
    content: "P1: <@U123456>",
    url_private: "https://files.slack.com/rotation",
  };
  const roster = await transport().roster();
  expect(roster).toEqual({ p1: "U123456", p2: "U765432" });
  expect(boundary.download).toHaveBeenCalledOnce();
  expect(boundary.download.mock.lastCall?.[0]).toMatchObject({
    requireHttps: true,
    maxRedirects: 0,
    timeoutMs: 15_000,
  });
});

it.each(["preview", "oversized", "foreign-host"])(
  "rejects %s source rather than selecting a partial or unsafe roster",
  async (kind) => {
    const cases: Record<string, Record<string, unknown>> = {
      preview: { preview_plain_text: "P1: <@U123456>" },
      oversized: { content: "😀".repeat(40_000), size: 160_000 },
      "foreign-host": { url_private: "https://example.invalid/rotation" },
    };
    boundary.file = { id: "F123456", ...cases[kind] };
    const roster = await transport().roster();
    expect(roster.p1).toBeUndefined();
    expect(roster.error).toContain("unavailable");
    expect(boundary.download).not.toHaveBeenCalled();
  },
);

it("does not reuse yesterday's roster after the current Canvas fails", async () => {
  const slack = transport();
  boundary.file = {
    id: "F123456",
    content: "P1: <@U123456>\nP2: <@U765432>",
    size: Buffer.byteLength("P1: <@U123456>\nP2: <@U765432>"),
  };
  expect((await slack.roster()).p1).toBe("U123456");
  boundary.read.files.info.mockRejectedValueOnce(new Error("current source unavailable"));
  expect((await slack.roster()).p1).toBeUndefined();
});

it("bounds its own one-shot write client while preserving marked non-unfurling delivery", async () => {
  await transport().send({ text: "Synthetic result", threadTs: "1794045600.000001" });
  expect(boundary.write.mock.lastCall?.[1]).toMatchObject({
    timeout: 15_000,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
  });
  const client = boundary.write.mock.results[0]!.value;
  expect(client.chat.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      unfurl_links: false,
      unfurl_media: false,
      parse: "none",
      metadata: { event_type: "livex_oncall", event_payload: {} },
    }),
  );
});
