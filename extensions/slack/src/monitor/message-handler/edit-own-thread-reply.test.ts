import type { WebClient } from "@slack/web-api";
import { describe, it, expect, vi } from "vitest";
import { editOwnThreadReply } from "./edit-own-thread-reply.js";
import { explicitPriorityEdit } from "./priority-card.js";

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
function fixture() {
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
    priority: "Medium",
    team: "T1",
    botUser: "UBOT",
    assertCurrent: () => {},
  });
  return {
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
    expect(explicitPriorityEdit(inbound, "UBOT", true)?.priority).toBe("Medium");
    for (const change of [
      { thread_ts: undefined },
      { user: undefined },
      { bot_id: "B123" },
      { text: "quoted: " + inbound.text },
      { text: inbound.text + " and remove the evidence" },
      { text: inbound.text.replace("UBOT", "UOTHER") },
    ]) {
      expect(explicitPriorityEdit({ ...inbound, ...change }, "UBOT", true)).toBeUndefined();
    }
    expect(explicitPriorityEdit(inbound, "UBOT", false)).toBeUndefined();
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
    ])
      await expect(f.edit(url)).rejects.toThrow();
    expect(f.write).not.toHaveBeenCalled();
  });
  it("recovers a lost response only from matching readback; never retries a write", async () => {
    const f = fixture();
    const normal = f.write.getMockImplementation()!;
    f.write.mockImplementationOnce(async (a) => {
      await normal(a);
      throw Error("connection lost");
    });
    await f.edit(link);
    expect(f.write).toHaveBeenCalledTimes(1);
    f.write.mockRejectedValueOnce(
      Object.assign(Error("missing_scope"), { code: "slack_webapi_platform_error" }),
    );
    await expect(f.edit(link)).rejects.toThrow("missing_scope");
    expect(f.write).toHaveBeenCalledTimes(2);
    const g = fixture();
    g.write.mockRejectedValueOnce(Error("connection lost"));
    await expect(g.edit(link)).rejects.toThrow("not confirmed");
    expect(g.write).toHaveBeenCalledTimes(1);
  });
});
