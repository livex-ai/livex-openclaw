import { expect, it } from "vitest";
import { observeLogPage, measuredTrend, type TrendCapture } from "./trend-evidence.js";
function fixture() {
  const c: TrendCapture = {
    issueId: "one",
    signature: {
      service: "svc",
      environment: "prd",
      operation: "submit",
      error: "timeout",
      scope: { agentId: "a", accountId: "a", teamId: "T", channelId: "C", senderId: "U" },
    },
    startCall: "begin",
    pages: new Map(),
  };
  const start = "2026-01-01T00:00:00.000000001Z",
    end = "2026-01-01T00:01:00.000000000Z";
  const make = (start: string, end: string) => ({
    start,
    end,
    project: "prd",
    mode: "errors",
    resourceLabels: { container_name: "svc" },
    retrievedAt: "2026-01-02T00:00:00Z",
    logsExplorerUrl:
      "https://console.cloud.google.com/logs/query?" +
      new URLSearchParams({
        project: "prd",
        query:
          'resource.type="k8s_container" AND timestamp>="' +
          start +
          '" AND timestamp<="' +
          end +
          '"',
      }),
    entries: [{ textPayload: "submit timeout" }],
    returnedRows: 1,
    invalidRows: 0,
    truncationReasons: [] as string[],
    truncated: false,
    nextCursor: null as string | null,
    windowExhausted: true,
  });
  const a = make(start, end),
    b = make("2026-01-01T00:01:00.000000001Z", "2026-01-01T00:02:00.000000000Z");
  return { c, a, b, make };
}
it("counts only matching entries, requires a complete cursor chain and ignores a replayed continuation", () => {
  const { c, a, b } = fixture();
  observeLogPage(
    c,
    {},
    {
      details: {
        ...a,
        nextCursor: "next",
        windowExhausted: false,
        truncated: true,
        truncationReasons: ["more-pages"],
      },
    },
  );
  observeLogPage(c, {}, { details: { ...b, entries: [{ textPayload: "unrelated timeout" }] } });
  const measure = () => measuredTrend(c, a.logsExplorerUrl, b.logsExplorerUrl);
  expect(measure).toThrow();
  for (const cursor of ["bad", "next", "next"]) observeLogPage(c, { cursor }, { details: a });
  expect(measure()).toMatchObject({ earlier: { count: 2 }, later: { count: 0 } });
});
it.each([
  "overlap",
  "shorter",
  "truncated",
  "foreign service",
  "wrong namespace",
  "event selector",
  "future window",
] as const)("refuses %s evidence", (mode) => {
  const { c, a, b, make } = fixture();
  observeLogPage(c, {}, { details: a });
  const changed =
    mode === "overlap"
      ? make(a.end, b.end)
      : mode === "shorter"
        ? make(b.start, "2026-01-01T00:01:05Z")
        : mode === "truncated"
          ? { ...b, truncated: true, truncationReasons: ["field"] }
          : mode === "foreign service"
            ? { ...b, resourceLabels: { container_name: "other" } }
            : mode === "wrong namespace"
              ? { ...b, resourceLabels: { container_name: "svc", namespace_name: "staging" } }
              : mode === "event selector"
                ? { ...b, traceId: "single-trace" }
                : { ...b, retrievedAt: a.start };
  observeLogPage(c, {}, { details: changed });
  expect(() => measuredTrend(c, a.logsExplorerUrl, changed.logsExplorerUrl)).toThrow();
});

it.each(["non-prod", "non-production", "nonprod", "pre_prod"])(
  "refuses prod evidence from %s inside a prod project",
  (namespace_name) => {
    const { c, a, b } = fixture();
    observeLogPage(c, {}, { details: a });
    observeLogPage(
      c,
      {},
      { details: { ...b, resourceLabels: { ...b.resourceLabels, namespace_name } } },
    );
    expect(() => measuredTrend(c, a.logsExplorerUrl, b.logsExplorerUrl)).toThrow();
  },
);
