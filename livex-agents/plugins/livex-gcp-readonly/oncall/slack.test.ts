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
    users: { list: vi.fn() },
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
