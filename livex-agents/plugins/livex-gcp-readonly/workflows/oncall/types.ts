import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

export const SERVICE_TOOLS = ["livex_oncall_logs_read", "livex_oncall_assessment_submit"];
export type Priority = "Unknown" | "Low" | "Medium" | "High" | "Critical";
export type Signature = {
  service: string;
  environment: string;
  operation: string;
  error: string;
  resource?: string;
};
export type AssessmentFinding = {
  id: string;
  signature: Signature;
  priority: Priority;
  summary: string;
  evidence: string[];
  nextAction: string;
};
export type Assessment = { findings: AssessmentFinding[] };
export type Classification = "known" | "unknown" | "unclassified";
export type Delivery = {
  status: "reserved" | "rejected" | "confirmed" | "uncertain" | "failed";
  step: number;
  attempts: number;
  tick: number;
  messageTs?: string;
};
export type Finding = Partial<AssessmentFinding> & {
  classification: Classification;
  caseId?: string;
  caseUrl?: string;
  reason?: string;
  acknowledged?: boolean;
  notifiedAt?: number;
  lastNotifiedAt?: number;
  step?: number;
  baseTier?: number;
  delivery?: Delivery;
};
export type Alert = {
  key: string;
  ts: string;
  text: string;
  admittedAt: number;
  start: string;
  end: string;
  identifiers: Record<string, string>;
};
export type Receipt = {
  sourceId: string;
  quarantined?: boolean;
  alert: Alert;
  phase: "queued" | "dispatch_reserved" | "dispatch_uncertain" | "assessed";
  runId?: string;
  findings?: Finding[];
  summary?: Delivery;
};
export type Roster = { p1?: string; p2?: string; error?: string };
export type SlackMessage = {
  ts?: string;
  text?: string;
  bot_id?: string;
  app_id?: string;
  team?: string;
  thread_ts?: string;
  metadata?: { event_type?: string; event_payload?: { incident_id?: unknown } };
};
export type SlackTransport = {
  verify(): Promise<void>;
  history(oldest: string, cursor?: string): Promise<{ messages: SlackMessage[]; cursor?: string }>;
  roster(): Promise<Roster>;
  acknowledged(ts: string): Promise<boolean>;
  send(params: { text: string; threadTs?: string; channel?: string }): Promise<string>;
};
export type RunAgent = (
  params: Parameters<
    import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginApi["runtime"]["agent"]["runEmbeddedAgent"]
  >[0],
) => Promise<unknown>;
export type SourceConfig = OpenClawConfig;
