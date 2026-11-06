import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { IssueSignature } from "./schema.js";
import { trendSchema, type Trend } from "./trend.js";

type Window = Trend["earlier"];
type Page = { window: Window; filter: string; selectors: string; cursor: string | null };
export type TrendCapture = {
  issueId: string;
  signature: IssueSignature;
  startCall: string;
  runId?: string;
  pages: Map<string, Page>;
};

const environments: Record<string, string> = {
  production: "prod",
  prd: "prod",
  prod: "prod",
  staging: "stage",
  stage: "stage",
  stg: "stage",
  development: "dev",
  dev: "dev",
  dv: "dev",
  test: "test",
  qa: "qa",
  nonprod: "nonprod",
};
function environmentMatches(expected: string, selectors: unknown[]) {
  const normalize = (name: string) =>
    name.toLowerCase().replace(/(?:non|not|pre)[-_ ]*(?:production|prod|prd)\b/g, "nonprod");
  const target = environments[normalize(expected)] ?? normalize(expected);
  const names = selectors
    .filter((v): v is string => typeof v === "string")
    .flatMap((v) => normalize(v).split(/[^a-z0-9]+/));
  const observed = names
    .map((s) => environments[s] ?? s)
    .filter((s) => s === target || Object.values(environments).includes(s));
  return observed.includes(target) && observed.every((s) => s === target);
}

/** Observe the authorized log tool's actual pages. Retain counts and links only. */
export function observeLogPage(
  capture: TrendCapture,
  input: Record<string, unknown>,
  result: unknown,
) {
  const d = asOptionalRecord(asOptionalRecord(result)?.details);
  if (!d || typeof d.logsExplorerUrl !== "string") return;
  const url = d.logsExplorerUrl;
  const prior = capture.pages.get(url);
  if (input.cursor !== undefined && (!prior || !prior.cursor || prior.cursor !== input.cursor))
    return;
  capture.pages.delete(url);
  const labels = asOptionalRecord(d.resourceLabels);
  if (
    d.mode !== "errors" ||
    !labels ||
    typeof d.project !== "string" ||
    (labels.project_id !== undefined && labels.project_id !== d.project) ||
    !environmentMatches(capture.signature.environment, [
      d.project,
      labels.cluster_name,
      labels.namespace_name,
    ]) ||
    ["insertId", "insertIds", "traceId", "conversationId", "roomId", "jobId"].some(
      (k) => d[k] !== undefined,
    ) ||
    ![labels.service_name, labels.container_name].includes(capture.signature.service) ||
    typeof d.start !== "string" ||
    typeof d.end !== "string" ||
    typeof d.retrievedAt !== "string" ||
    !Array.isArray(d.entries) ||
    d.returnedRows !== d.entries.length ||
    d.invalidRows !== 0 ||
    !Array.isArray(d.truncationReasons) ||
    d.truncationReasons.some((r) => r !== "more-pages") ||
    !(
      (d.windowExhausted === true && d.nextCursor === null && d.truncated === false) ||
      (d.windowExhausted === false && typeof d.nextCursor === "string")
    ) ||
    url.length > 2048 ||
    capture.pages.size >= 16
  )
    return;
  const link = URL.parse(url);
  const query = link?.searchParams.get("query");
  const range = 'timestamp>="' + d.start + '" AND timestamp<="' + d.end + '"';
  if (
    link?.origin !== "https://console.cloud.google.com" ||
    link.pathname !== "/logs/query" ||
    link.searchParams.get("project") !== d.project ||
    !query?.includes(range)
  )
    return;
  const filter = JSON.stringify([
    link.searchParams.get("project"),
    query.replace(range, "<window>"),
  ]);
  let count = input.cursor === undefined ? 0 : prior!.window.count;
  for (const row of d.entries) {
    const log = asOptionalRecord(row);
    if (!log) return;
    const values: string[] = [];
    JSON.stringify([log.textPayload, log.jsonPayload], (_key, v) => {
      if (typeof v === "string") values.push(v.toLowerCase());
      return v;
    });
    const terms = [capture.signature.operation, capture.signature.error];
    if (capture.signature.resource && !Object.values(labels).includes(capture.signature.resource))
      terms.push(capture.signature.resource);

    if (terms.every((s) => s.trim() && values.some((v) => v.includes(s.toLowerCase())))) count++;
  }
  capture.pages.set(url, {
    filter,
    selectors: Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => k + "=" + v)
      .join(", "),
    cursor: d.nextCursor as string | null,
    window: { start: d.start, end: d.end, count, evidenceUrl: url, retrievedAt: d.retrievedAt },
  });
}
export function measuredTrend(
  capture: TrendCapture | undefined,
  earlier: unknown,
  later: unknown,
): Trend {
  const a = typeof earlier === "string" ? capture?.pages.get(earlier) : undefined;
  const b = typeof later === "string" ? capture?.pages.get(later) : undefined;
  if (
    !capture ||
    !a ||
    !b ||
    a.cursor ||
    b.cursor ||
    a.filter !== b.filter ||
    (!a.window.count && !b.window.count)
  )
    throw new Error(
      "Need two completed comparable log reads with an observed matching case signature",
    );
  const { service, operation, error } = capture.signature;
  return trendSchema.parse({
    scope: service + " / " + operation + " — " + error + " (" + a.selectors + ")",
    earlier: a.window,
    later: b.window,
  });
}
