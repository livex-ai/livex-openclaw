import type { WebClient } from "@slack/web-api";
import {
  createReplyTurnDelivery,
  type ReplyTurnDeliveryHost,
  type PreparedReplyTurn,
  type ReportAmendment,
} from "openclaw/plugin-sdk/reply-turns";
import { describe, it, expect, vi } from "vitest";
import { createReportEditor } from "./amend-own-report.js";
import type { SlackDispatchSetup } from "./dispatch-setup.js";
import { editOwnThreadReply } from "./edit-own-thread-reply.js";
import { editRequest } from "./priority-card.js";

const root = "1793000000.000001",
  ts = "1793000001.000002",
  requestId = "1793000002.000003";
const link = "https://example.slack.com/archives/C123/p1793000001000002";
const sections = [
  "*Title:* Kiosk start",
  "*Priority:* Unknown",
  "*Next action:* Check config · Owner: Unassigned",
  "*Summary:* Still unresolved",
  "*Evidence:* Logs\n*Priority:* Unknown",
];
const block = (text: string) => ({
  type: "section",
  text: { type: "mrkdwn", text, verbatim: true },
});
const inbound = {
  type: "message" as const,
  channel: "C123",
  user: "U1",
  thread_ts: root,
  ts: requestId,
  text: "<@UBOT> update the above one to Medium priority",
};
function fixture(changes: ReportAmendment = { priority: "Medium" }) {
  const initial = {
    ts,
    thread_ts: root,
    user: "UBOT",
    bot_id: "B123",
    text: sections.join("  "),
    blocks: [block(sections[0])],
    attachments: [
      { color: "#9CA3AF", blocks: sections.slice(1).map(block), fallback: sections.join("\n\n") },
    ],
  };
  let current = structuredClone(initial);
  const write = vi.fn(async (args: Partial<typeof initial>) => {
    current = {
      ...current,
      text: args.text!,
      blocks: args.blocks!,
      attachments: args.attachments!,
    };
    return { ok: true };
  });
  const replies = vi.fn(async () => ({ ok: true, messages: [current] }));
  const client = {
    auth: { test: async () => ({ ok: true, user_id: "UBOT", team_id: "T1", bot_id: "B123" }) },
    chat: { getPermalink: async () => ({ ok: true, permalink: link }), update: write },
    conversations: { replies },
  };
  const edit = editOwnThreadReply({
    client: client as unknown as WebClient,
    token: "test",
    channel: "C123",
    thread: root,
    requestId,
    changes,
    sender: "U1",
    team: "T1",
    botUser: "UBOT",
    assertCurrent: () => {},
  });
  return {
    client,
    edit,
    write,
    replies,
    initial,
    apply: (v: typeof initial) => {
      current = v;
    },
    current: () => current,
  };
}
describe("explicit report priority edit", () => {
  it("requires a directly addressed current authorized human thread reply", () => {
    expect(editRequest(inbound, "UBOT", true)?.text).toBe(
      "update the above one to Medium priority",
    );
    for (const change of [
      { thread_ts: undefined },
      { user: undefined },
      { bot_id: "B123" },
      { text: "quoted: " + inbound.text },
      { text: "update it" },
      { text: inbound.text.replace("UBOT", "UOTHER") },
    ]) {
      expect(editRequest({ ...inbound, ...change }, "UBOT", true)).toBeUndefined();
    }
    expect(editRequest(inbound, "UBOT", false)).toBeUndefined();
  });
  it("edits the same verified message and leaves quoted priority text in evidence untouched", async () => {
    const f = fixture();
    await f.edit(link);
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.write.mock.calls[0][0]).toMatchObject({ channel: "C123", ts });
    expect(f.current().text).toBe(
      f.initial.text.replace("*Priority:* Unknown", "*Priority:* Medium"),
    );
    const a = f.current().attachments[0];
    expect(a.blocks.slice(1)).toEqual(f.initial.attachments[0].blocks.slice(1));
    expect(a.fallback).toBe(
      f.initial.attachments[0].fallback.replace("*Priority:* Unknown", "*Priority:* Medium"),
    );
    expect(a.color).toBe("#D99A00");
    expect(f.replies).toHaveBeenCalledTimes(2);
  });
  it("snapshots the proven fields before Slack I/O and rejects a different visible queued card", async () => {
    const f = fixture();
    const setup = {
      prepared: {
        ctx: { botUserId: "UBOT", teamId: "T1" },
        message: inbound,
        replyTurn: { assertCurrent() {} },
        ctxPayload: { CommandAuthorized: true },
        eventScope: { teamId: "T1", writeClient: { ...f.client, token: "test" } },
      },
    } as unknown as SlackDispatchSetup;
    const writer = createReportEditor(setup)!;
    const changes: ReportAmendment = { priority: "Medium" };
    const pending = writer(link, changes);
    changes.priority = "Critical";
    await pending;
    expect(f.current().text).toContain("*Priority:* Medium");
    const receipt = {
      messageId: "1793000003.000002",
      text: "Requested report update: priority Medium.",
    };
    f.replies.mockResolvedValueOnce({
      ok: true,
      messages: [{ ...f.initial, ts: receipt.messageId, text: receipt.text, attachments: [] }],
    });
    await expect(writer(link, { priority: "Medium" }, receipt)).rejects.toThrow("acknowledgment");
    expect(f.write).toHaveBeenCalledTimes(1);
    await writer(link, { priority: "Medium" });
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it.each(["complete", "partial", "foreign author", "wrong thread", "wrong text"] as const)(
    "checks a queued final through the SDK and Slack (%s)",
    async (mode) => {
      const f = fixture();
      const setup = {
        prepared: {
          ctx: { botUserId: "UBOT" },
          message: inbound,
          replyTurn: { assertCurrent() {} },
          ctxPayload: { CommandAuthorized: true },
          eventScope: { teamId: "T1", writeClient: { ...f.client, token: "synthetic" } },
        },
      } as unknown as SlackDispatchSetup;
      const text = "Requested report update: priority Medium.",
        id = "1793000003.000002";
      const transport = {
        amendOwnReport: createReportEditor(setup),
        sourceMessageIds: [root, requestId],
        resolvePermalink: vi.fn(),
        annotateAcceptedFinal: vi.fn(),
        reportError: vi.fn(),
        deliver: vi.fn(),
      };
      const provider = {
        assertCurrent() {},
        createDelivery(host: ReplyTurnDeliveryHost) {
          return {
            deliver: host.deliver,
            queuedCorrelation: {
              begin() {},
              onReplyDelivered: async () => {
                await host.amendOwnReport!(link, { priority: "Medium" });
              },
            },
          };
        },
      } as PreparedReplyTurn;
      const owner = createReplyTurnDelivery(provider, transport);
      f.replies.mockResolvedValueOnce({
        ok: true,
        messages: [
          {
            ...f.initial,
            ts: id,
            text: mode === "wrong text" ? "other" : text,
            blocks: [],
            attachments: [],
            thread_ts: mode === "wrong thread" ? "elsewhere" : root,
            user: mode === "foreign author" ? "OTHER" : "UBOT",
          },
        ],
      });
      const received = owner.queuedCorrelation!.onReplyDelivered!(
        { text },
        { complete: mode !== "partial", messageId: id, kind: "final" },
      );
      if (mode === "complete") {
        await received;
      } else {
        await expect(received).rejects.toThrow();
      }
      expect(f.write).toHaveBeenCalledTimes(mode === "complete" ? 1 : 0);
    },
  );
  it("renders an accepted owner and action together and keeps the original evidence", async () => {
    const f = fixture({ nextAction: "Review proxy logs", acceptOwnership: true });
    await f.edit(link);
    expect(f.current().text).toContain("*Next action:* Review proxy logs · Owner: U1");
    expect(f.current().attachments[0].fallback).toContain("Review proxy logs · Owner: U1");
    expect(f.current().attachments[0].blocks[3]).toEqual(f.initial.attachments[0].blocks[3]);
  });
  it.each([{ thread_ts: "another" }, { user: "someone" }, { bot_id: "another" }, { blocks: [] }])(
    "refuses an unverified target",
    async (patch) => {
      const f = fixture();
      f.apply({ ...f.initial, ...patch });
      await expect(f.edit(link)).rejects.toThrow();
      expect(f.write).not.toHaveBeenCalled();
    },
  );
  it("rejects a foreign permalink and a different thread before editing", async () => {
    const f = fixture();
    for (const url of [
      link.replace("example.slack.com", "other.slack.com"),
      link + "?thread_ts=123",
      link.replace("C123", "C456"),
    ]) {
      await expect(f.edit(url)).rejects.toThrow();
    }
    expect(f.write).not.toHaveBeenCalled();
  });
  it("recovers a lost response only from matching readback; never retries a write", async () => {
    const f = fixture();
    const normal = f.write.getMockImplementation()!;
    f.write.mockImplementationOnce(async (a) => {
      await normal(a);
      throw new Error("connection lost");
    });
    await f.edit(link);
    expect(f.write).toHaveBeenCalledTimes(1);
    f.apply(f.initial);
    f.write.mockRejectedValueOnce(
      Object.assign(new Error("missing_scope"), { code: "slack_webapi_platform_error" }),
    );
    await expect(f.edit(link)).rejects.toThrow("missing_scope");
    expect(f.write).toHaveBeenCalledTimes(2);
    const g = fixture();
    g.write.mockRejectedValueOnce(new Error("connection lost"));
    await expect(g.edit(link)).rejects.toThrow("not confirmed");
    expect(g.write).toHaveBeenCalledTimes(1);
  });
});

describe("linked priority delivery", () => {
  function linkedFixture() {
    const f = fixture();
    const peerRoot = "1792999999.000001";
    const peerTs = "1793000001.000003";
    const urls = [
      link + "?thread_ts=" + root,
      "https://example.slack.com/archives/C123/p1793000001000003?thread_ts=" + peerRoot,
    ];
    const cards = new Map([
      [ts, structuredClone(f.initial)],
      [peerTs, { ...structuredClone(f.initial), ts: peerTs, thread_ts: peerRoot }],
    ]);
    const update = vi.fn(
      async (args: {
        ts: string;
        text: string;
        blocks: typeof f.initial.blocks;
        attachments: typeof f.initial.attachments;
      }) => {
        cards.set(args.ts, { ...cards.get(args.ts)!, ...args });
        return { ok: true };
      },
    );
    const replies = vi.fn(async (args: { oldest: string; ts: string }) => ({
      ok: true,
      messages: [...cards.values()].filter((m) => m.ts === args.oldest && m.thread_ts === args.ts),
    }));
    const client = {
      ...f.client,
      conversations: { replies },
      chat: {
        update,
        getPermalink: async (args: { message_ts: string }) => ({
          ok: true,
          permalink: urls.find((url) => url.includes(args.message_ts.replace(".", ""))),
        }),
      },
    };
    const writer = (thread = root, text = inbound.text) =>
      createReportEditor({
        prepared: {
          ctx: { botUserId: "UBOT", teamId: "T1" },
          message: { ...inbound, thread_ts: thread, text },
          replyTurn: { assertCurrent() {} },
          ctxPayload: { CommandAuthorized: true },
          eventScope: { teamId: "T1", writeClient: { ...client, token: "test" } },
        },
      } as unknown as SlackDispatchSetup)!;
    return { ...f, urls, cards, update, replies, writer, peerRoot, peerTs };
  }
  it.each([0, 1])(
    "updates both cards from root %i; reconciles an accepted but lost response",
    async (origin) => {
      const f = linkedFixture();
      const urls = origin ? f.urls.toReversed() : f.urls;
      const normal = f.update.getMockImplementation()!;
      f.update.mockImplementationOnce(async (args) => {
        await normal(args);
        throw new Error("lost response");
      });
      const result = await f.writer(origin ? f.peerRoot : root)(
        urls[0]!,
        { priority: "Medium" },
        undefined,
        undefined,
        urls,
        "livex-investigations",
      );
      expect(result).toBe(origin ? f.peerTs : ts);
      for (const card of f.cards.values()) {
        expect(card.text).toContain("*Priority:* Medium");
        expect(card.attachments[0]!.blocks.slice(1)).toEqual(
          f.initial.attachments[0]!.blocks.slice(1),
        );
      }
      expect(f.update).toHaveBeenCalledTimes(2);
      await f.writer(origin ? f.peerRoot : root)(
        urls[0]!,
        { priority: "Medium" },
        undefined,
        undefined,
        urls,
        "livex-investigations",
      );
      expect(f.update).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    "foreign owner",
    "foreign bot",
    "wrong root",
    "foreign channel",
    "nonpriority",
    "duplicate",
    "bad queued ack",
  ])("rejects %s before any write", async (mode) => {
    const f = linkedFixture();
    const urls = [...f.urls];
    let owner = "livex-investigations";
    let changes: ReportAmendment = { priority: "Medium" };
    let receipt: { messageId: string; text: string } | undefined;
    if (mode === "foreign owner") {
      owner = "foreign";
    }
    if (mode === "foreign bot") {
      f.cards.get(f.peerTs)!.user = "FOREIGN";
    }
    if (mode === "wrong root") {
      urls[1] = urls[1]!.replace(f.peerRoot, "1792999998.000001");
    }
    if (mode === "foreign channel") {
      urls[1] = urls[1]!.replace("C123", "C999");
    }
    if (mode === "nonpriority") {
      changes = { priority: "Medium", acceptOwnership: true };
    }
    if (mode === "duplicate") {
      urls[1] = urls[0]!;
    }
    if (mode === "bad queued ack") {
      receipt = { messageId: "1793000003.000002", text: "ack" };
    }
    await expect(f.writer()(urls[0]!, changes, receipt, undefined, urls, owner)).rejects.toThrow();
    expect(f.update).not.toHaveBeenCalled();
  });
  it("preflights every card and rejects nonpriority drift before overwriting it", async () => {
    const f = linkedFixture();
    const normal = f.update.getMockImplementation()!;
    f.update.mockImplementationOnce(async (args) => {
      await normal(args);
      const peer = f.cards.get(f.peerTs)!;
      peer.text = peer.text.replace("Check config", "New human action");
      return { ok: true };
    });
    await expect(
      f.writer()(
        f.urls[0]!,
        { priority: "Medium" },
        undefined,
        undefined,
        f.urls,
        "livex-investigations",
      ),
    ).rejects.toThrow("changed after preflight");
    expect(f.cards.get(f.peerTs)!.text).toContain("New human action");
    expect(f.update).toHaveBeenCalledTimes(1);
  });
  it("verifies the queued acknowledgment in the requesting root for both cards", async () => {
    const f = linkedFixture();
    const receipt = {
      messageId: "1793000003.000002",
      text: "Requested report update: priority Medium.",
    };
    f.cards.set(receipt.messageId, {
      ...f.initial,
      ts: receipt.messageId,
      text: receipt.text,
      blocks: [],
      attachments: [],
    });
    await f.writer()(
      f.urls[0]!,
      { priority: "Medium" },
      receipt,
      undefined,
      f.urls,
      "livex-investigations",
    );
    const ackReads = f.replies.mock.calls.filter(([args]) => args.oldest === receipt.messageId);
    expect(ackReads.length).toBe(2);
    expect(ackReads.every(([args]) => args.ts === root)).toBe(true);
  });
});
