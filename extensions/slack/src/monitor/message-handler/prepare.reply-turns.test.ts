import type { App } from "@slack/bolt";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareSlackMessage } from "./prepare.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
  createSlackTestAccount,
} from "./prepare.test-helpers.js";
const { lookup, order } = vi.hoisted(() => ({ lookup: vi.fn(), order: [] as string[] }));
vi.mock("openclaw/plugin-sdk/reply-turns", () => ({ prepareAgentReplyTurn: lookup }));
afterEach(() => {
  vi.clearAllMocks();
  order.length = 0;
});
function turn(context: string) {
  return {
    context: "\n\n" + context,
    toolBindings: { slack_investigation: { turnId: "prepared-turn" } },
    releaseImmediate: vi.fn(),
  };
}
describe("plugin reply-turn preparation", () => {
  const fixture = createSlackSessionStoreFixture("slack-investigation-prepare-");
  it("uses the hydrated alert symptom when the new thread reply only says investigate", async () => {
    const { storePath } = fixture.makeTmpStorePath();
    const cfg: OpenClawConfig = {
      agents: { entries: { oncall: {} } },
      session: { store: storePath },
      plugins: {
        entries: {
          "livex-investigations": {
            config: { investigationCatalog: { enabled: true, agentId: "oncall" } },
          },
        },
      },
      channels: { slack: { enabled: true, groupPolicy: "open" } },
    };
    lookup.mockImplementation(async () => turn("Catalog empty"));
    const replies = vi.fn(async () => ({
      ok: true,
      messages: [
        { ts: "200.000", text: "variant_name is absent in ingestion job", user: "U2" },
        { ts: "201.000", text: "<@B1> investigate", user: "U1" },
      ],
      response_metadata: { next_cursor: "" },
    }));
    const ctx = createInboundSlackTestContext({
      cfg,
      appClient: { conversations: { replies } } as unknown as App["client"],
    });
    const prepared = await prepareSlackMessage({
      ctx,
      account: createSlackTestAccount(),
      message: {
        type: "message",
        channel: "C2",
        channel_type: "channel",
        user: "U1",
        text: "<@B1> investigate",
        ts: "201.000",
        thread_ts: "200.000",
      },
      opts: { source: "app_mention" },
    });
    expect(prepared).not.toBeNull();
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.stringContaining("variant_name is absent") }),
    );
    prepared?.replyTurn?.releaseImmediate();
  });
  it("loads prior investigations before composing the admitted turn and binds the exact request", async () => {
    const { storePath } = fixture.makeTmpStorePath();
    const cfg: OpenClawConfig = {
      agents: { entries: { oncall: {} } },
      session: { store: storePath },
      plugins: {
        entries: {
          "livex-investigations": {
            config: { investigationCatalog: { enabled: true, agentId: "oncall" } },
          },
        },
      },
      channels: { slack: { enabled: true, groupPolicy: "open" } },
    };
    lookup.mockImplementation(async () => {
      order.push("lookup");
      return turn("Prior investigation: canonical variant_name report");
    });
    const base = createInboundSlackTestContext({ cfg });
    const ctx = {
      ...base,
      buildContext: (input: Parameters<typeof buildChannelInboundEventContext>[0]) => {
        order.push("context");
        return buildChannelInboundEventContext(input);
      },
    };
    const prepared = await prepareSlackMessage({
      ctx,
      account: createSlackTestAccount(),
      message: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        text: "<@B1> investigate variant_name",
        ts: "100.001",
      },
      opts: { source: "app_mention" },
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["lookup", "context"]);
    expect(prepared?.ctxPayload.Body).toContain("canonical variant_name report");
    expect(prepared).not.toBeNull();
    const agentContext = finalizeInboundContext(prepared!.ctxPayload);
    expect(agentContext.agentText).toContain("canonical variant_name report");
    expect(agentContext.rawText).not.toContain("canonical variant_name report");
    expect(agentContext.commandText).not.toContain("canonical variant_name report");
    expect(prepared?.ctxPayload.GatewayRunToolBindings).toMatchObject({
      slack_investigation: { turnId: expect.any(String) },
    });
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        agentId: "oncall",
        accountId: "default",
        workspaceId: "T1",
        nativeChannelId: "C1",
        senderId: "U1",
        sessionKey: expect.any(String),
        assertCurrent: expect.any(Function),
      }),
    );
    prepared?.replyTurn?.releaseImmediate();
  });
  it("releases the prepared plugin turn if later ingress composition fails", async () => {
    const { storePath } = fixture.makeTmpStorePath();
    const cfg: OpenClawConfig = {
      agents: { entries: { oncall: {} } },
      session: { store: storePath },
      channels: { slack: { enabled: true, groupPolicy: "open" } },
    };
    const handle = turn("Scoped history");
    lookup.mockResolvedValue(handle);
    const base = createInboundSlackTestContext({ cfg });
    await expect(
      prepareSlackMessage({
        ctx: {
          ...base,
          buildContext() {
            throw new Error("context failed");
          },
        },
        account: createSlackTestAccount(),
        message: {
          type: "message",
          channel: "C1",
          channel_type: "channel",
          user: "U1",
          text: "<@B1> investigate",
          ts: "100.002",
        },
        opts: { source: "app_mention" },
      }),
    ).rejects.toThrow("context failed");
    expect(handle.releaseImmediate).toHaveBeenCalledOnce();
  });
});
