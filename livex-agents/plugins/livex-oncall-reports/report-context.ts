import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { z } from "zod";

const factsSchema = z.object({
  finding: z.string(),
  impact: z.string(),
  nextAction: z.string(),
  evidence: z.string().optional(),
  disposition: z.string().optional(),
  recovery: z.string().optional(),
  owner: z.object({ name: z.string(), evidenceUrl: z.string() }).optional(),
});
const updateSchema = z.object({
  task: z.string(),
  facts: factsSchema,
  prs: z.array(z.string()),
  slackThreads: z.array(z.string()),
  jiraTickets: z.array(z.string()),
  evidenceUrls: z.array(z.string()),
});
const findingSchema = z.object({
  kind: z.enum(["new", "known-persistence", "changed", "uncertain"]),
  canonicalThreadUrl: z.string().optional(),
  reason: z.string().optional(),
});
const contextSchema = z.object({
  updates: z.array(updateSchema),
  findings: z.array(findingSchema),
});
export type ReportInvestigation = z.infer<typeof updateSchema>;
export type ReportFinding = z.infer<typeof findingSchema>;
export function readReportContext(value: unknown) {
  const parsed = contextSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Oncall report requires validated investigation facts and comparisons");
  }
  return parsed.data;
}

export function assertNoSensitiveContent(value: unknown): void {
  if (typeof value === "string") {
    if (redactSensitiveText(value, { mode: "tools" }) !== value) {
      throw new Error("Investigation content contains sensitive data");
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      assertNoSensitiveContent(item);
    }
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      assertNoSensitiveContent(item);
    }
  }
}
