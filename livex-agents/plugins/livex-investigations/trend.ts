import { z } from "zod";

const evidence = z
  .url({ protocol: /^https$/ })
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !/[<>|]/u.test(value);
  });
const utc = z.iso.datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/);
const window = z
  .object({
    start: utc,
    end: utc,
    retrievedAt: utc,
    count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    evidenceUrl: evidence,
  })
  .strict();
export const trendSchema = z
  .object({
    earlier: window,
    later: window,
    scope: z
      .string()
      .trim()
      .min(1)
      .max(768)
      .regex(/^[^<>|\r\n]+$/u),
  })
  .strict()
  .refine(({ earlier, later }) => {
    if (
      ![earlier.start, earlier.end, later.start, later.end].every((v) => utc.safeParse(v).success)
    )
      return false;
    const [a, b, c, d] = [earlier.start, earlier.end, later.start, later.end].map(nanoseconds) as [
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    return (
      a < b &&
      b < c &&
      b - a === d - c &&
      [earlier, later].every(
        (w) =>
          utc.safeParse(w.retrievedAt).success && nanoseconds(w.retrievedAt) >= nanoseconds(w.end),
      )
    );
  }, "Use complete, equal-duration, non-overlapping UTC windows for the same error and service");
export type Trend = z.infer<typeof trendSchema>;
export function nanoseconds(iso: string) {
  if (!utc.safeParse(iso).success) throw new Error("Invalid UTC comparison bound");
  const second = iso.split(/[.Z]/u)[0]!;
  return (
    BigInt(Date.parse(second + "Z")) * 1000000n +
    BigInt((iso.split(".")[1]?.slice(0, -1) ?? "").padEnd(9, "0"))
  );
}
export function trendSummary({ earlier, later, scope }: Trend) {
  const direction =
    later.count > earlier.count
      ? "increased"
      : later.count < earlier.count
        ? "decreased"
        : "stayed the same";
  return `Matching error counts ${direction} for ${scope}: ${earlier.count} (${earlier.start}–${earlier.end}) versus ${later.count} (${later.start}–${later.end}).`;
}

export type StagedTrend = {
  issueId: string;
  trend: Trend;
  finalText: string;
  requestId: string;
  reportUrls: string[];
};
