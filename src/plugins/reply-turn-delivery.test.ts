import { describe, expect, it, vi } from "vitest";
import type { LivePreviewDeliveryResult } from "../channels/message/live.js";
import { createReplyTurnDelivery } from "./reply-turn-delivery.js";
import type { PreparedReplyTurn, ReplyTurnDeliveryHost } from "./reply-turn.types.js";

function fixture(
  result: LivePreviewDeliveryResult = { visibleReplySent: true, messageIds: ["final"] },
) {
  let current = true;
  let capability: ReplyTurnDeliveryHost | undefined;
  const queued = vi.fn();
  const host: ReplyTurnDeliveryHost = {
    sourceMessageIds: ["alert", "root"],
    resolvePermalink: vi.fn(async (id: string) => "https://slack.example/" + id),
    annotateAcceptedFinal: vi.fn(async () => {}),
    reportError: vi.fn(),
    deliver: vi.fn(async () => result),
  };
  const turn: PreparedReplyTurn = {
    context: "",
    toolBindings: {},
    assertCurrent() {
      if (!current) {
        throw new Error("retired turn");
      }
    },
    lifecycle: (upstream) => ({ ...upstream, onAdopted: async () => {} }),
    releaseImmediate() {
      current = false;
    },
    createDelivery(transport) {
      capability = transport;
      return {
        deliver: transport.deliver,
        queuedCorrelation: { begin() {}, onReplyDelivered: queued },
      };
    },
  };
  const delivery = createReplyTurnDelivery(turn, host);
  return { host, turn, delivery, queued, transport: () => capability! };
}

describe("reply turn accepted transport authority", () => {
  it("passes ordinary delivery through unchanged when no provider contributes", async () => {
    const f = fixture();
    const ordinary = createReplyTurnDelivery(undefined, f.host);
    expect(ordinary.deliver).toBe(f.host.deliver);
    expect(ordinary.queuedCorrelation).toBeUndefined();
  });

  it("accepts only this turn's actual final receipt and never source or arbitrary IDs", async () => {
    const f = fixture();
    await expect(f.transport().resolvePermalink("final")).rejects.toThrow(/own accepted final/);
    await f.delivery.deliver({ text: "done" }, { kind: "final" });
    expect(await f.transport().resolvePermalink("final")).toContain("/final");
    await f.transport().annotateAcceptedFinal({ messageId: "final", text: "warning" });
    for (const id of ["alert", "root", "other-turn"]) {
      await expect(
        f.transport().annotateAcceptedFinal({ messageId: id, text: "bad" }),
      ).rejects.toThrow(/own accepted final/);
    }
    expect(f.host.annotateAcceptedFinal).toHaveBeenCalledTimes(1);
    f.turn.releaseImmediate();
    await expect(f.transport().resolvePermalink("final")).rejects.toThrow("retired turn");
    await expect(
      f.transport().annotateAcceptedFinal({ messageId: "final", text: "late" }),
    ).rejects.toThrow("retired turn");
  });

  it("does not grant authority for block output, incomplete, suppressed or source-message receipts", async () => {
    const f = fixture();
    await f.delivery.deliver({ text: "progress" }, { kind: "block" });
    await expect(f.transport().resolvePermalink("final")).rejects.toThrow(/own accepted final/);
    for (const result of [
      { visibleReplySent: false, messageIds: ["final"] },
      { visibleReplySent: true, messageIds: ["alert"] },
      {
        visibleReplySent: true,
        messageIds: ["final"],
        suppression: { reason: "no_visible_result" as const },
      },
      {
        visibleReplySent: true,
        messageIds: ["final"],
        deliveryIntent: {
          id: "pending",
          kind: "outbound_queue" as const,
          queuePolicy: "required" as const,
        },
      },
    ]) {
      const other = fixture(result);
      await other.delivery.deliver({ text: "done" }, { kind: "final" });
      await expect(other.transport().resolvePermalink(result.messageIds[0]!)).rejects.toThrow(
        /own accepted final/,
      );
    }
  });

  it("waits for finalization and rechecks retirement after an awaited permalink read", async () => {
    let settle!: (value: { visibleReplySent: boolean; messageIds: string[] }) => void;
    const finalization = new Promise<{ visibleReplySent: boolean; messageIds: string[] }>(
      (resolve) => {
        settle = resolve;
      },
    );
    const f = fixture({ visibleReplySent: false, finalization });
    const sent = await f.delivery.deliver({ text: "done" }, { kind: "final" });
    await expect(f.transport().resolvePermalink("final")).rejects.toThrow(/own accepted final/);
    settle({ visibleReplySent: true, messageIds: ["final"] });
    await sent.finalization;
    vi.mocked(f.host.resolvePermalink).mockImplementation(async () => {
      f.turn.releaseImmediate();
      return "https://slack.example/final";
    });
    await expect(f.transport().resolvePermalink("final")).rejects.toThrow("retired turn");
    expect(f.host.annotateAcceptedFinal).not.toHaveBeenCalled();
  });

  it("grants queued access only on a complete final receipt before the plugin callback", async () => {
    const f = fixture();
    const receipt = { kind: "final" as const, messageId: "queued", complete: false };
    await f.delivery.queuedCorrelation?.onReplyDelivered?.({ text: "done" }, receipt);
    await expect(f.transport().resolvePermalink("queued")).rejects.toThrow(/own accepted final/);
    f.queued.mockImplementation(async () => {
      expect(await f.transport().resolvePermalink("queued")).toContain("/queued");
    });
    await f.delivery.queuedCorrelation?.onReplyDelivered?.(
      { text: "done" },
      { ...receipt, complete: true },
    );
    expect(f.queued).toHaveBeenCalledTimes(2);
  });

  it("keeps receipts isolated across concurrent turns", async () => {
    const first = fixture();
    const second = fixture({ visibleReplySent: true, messageIds: ["second"] });
    await first.delivery.deliver({ text: "one" }, { kind: "final" });
    await second.delivery.deliver({ text: "two" }, { kind: "final" });
    await expect(first.transport().resolvePermalink("second")).rejects.toThrow(
      /own accepted final/,
    );
    await expect(second.transport().resolvePermalink("final")).rejects.toThrow(
      /own accepted final/,
    );
  });
});
