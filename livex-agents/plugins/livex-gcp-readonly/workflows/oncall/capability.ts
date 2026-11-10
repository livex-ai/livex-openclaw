import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { z } from "zod";
import {
  buildLogFilter,
  evidence,
  queryArgs,
  validateConfig,
  withEvidenceLink,
} from "../../core.mjs";
import type { OncallConfig } from "./config.js";
import { SERVICE_TOOLS, type Alert, type Assessment } from "./types.js";

const text = z.string().trim().min(1).max(2_000);
const stableResource = text.refine((value) => !/^(?:unknown|unspecified|n\/a|none)$/i.test(value));
const signature = z.strictObject({
  service: text,
  environment: text,
  operation: text,
  error: text,
  resource: stableResource,
});
const assessmentSchema = z.strictObject({
  findings: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
        signature,
        priority: z.enum(["Unknown", "Low", "Medium", "High", "Critical"]),
        summary: text,
        evidence: z.array(text).min(1).max(10),
        nextAction: text,
      }),
    )
    .min(1)
    .max(20),
});

type Resource = { type: string; labels: Record<string, string> };
const IDENTIFIERS = ["conversationId", "jobId", "roomId", "traceId", "insertId"] as const;
type Query = ReturnType<typeof queryArgs> &
  Partial<Record<(typeof IDENTIFIERS)[number], string>> & {
    resourceType?: string;
    resourceLabels?: Record<string, string>;
    insertIds?: string[];
  };
type Grant = {
  alert: Alert;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  signal: AbortSignal;
  expiresAt: number;
  calls: number;
  reservedBytes: number;
  resources: Resource[];
  identifiers: Map<string, Set<string>>;
  evidenceUrls: Set<string>;
  assessment?: Assessment;
  revoked: boolean;
};

function contextMatches(grant: Grant, context: OpenClawPluginToolContext) {
  return (
    context.agentId === grant.agentId &&
    context.sessionKey === grant.sessionKey &&
    context.sessionId === grant.sessionId
  );
}

function resourceMatches(resource: Resource, query: Query) {
  return (
    query.resourceType === resource.type &&
    Object.entries(resource.labels).every(([key, value]) => query.resourceLabels?.[key] === value)
  );
}

function assertSelectors(grant: Grant, query: Query) {
  if (query.mode === "discover") {
    throw new Error("Oncall discovery cannot bypass the configured resource envelope");
  }
  for (const key of IDENTIFIERS) {
    const identifier = query[key];
    if (identifier !== undefined && !grant.identifiers.get(key)?.has(identifier)) {
      throw new Error("Oncall query identifier was not observed");
    }
  }
  if (query.insertIds?.some((id: string) => !grant.identifiers.get("insertId")?.has(id))) {
    throw new Error("Oncall insert identifier was not observed");
  }
  if (
    query.mode !== "discover" &&
    !grant.resources.some((resource) => resourceMatches(resource, query))
  ) {
    throw new Error("Oncall resource scope was not observed or configured");
  }
}

function rememberEvidence(grant: Grant, details: ReturnType<typeof evidence>) {
  for (const entry of details.entries) {
    rememberIdentifiers(grant, {
      conversationId: entry.jsonPayload?.conversation_id,
      jobId: entry.jsonPayload?.job_id,
      roomId: entry.jsonPayload?.room_id,
      traceId: entry.jsonPayload?.trace_id,
      insertId: entry.insertId,
    });
  }
  if (!details.truncated && details.returnedRows > 0 && details.logsExplorerUrl) {
    grant.evidenceUrls.add(details.logsExplorerUrl);
  }
}

function rememberIdentifiers(grant: Grant, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string") {
      const values = grant.identifiers.get(key) ?? new Set<string>();
      values.add(value);
      grant.identifiers.set(key, values);
    }
  }
}

function commandOptions(config: ReturnType<typeof validateConfig>, signal: AbortSignal) {
  return {
    timeoutMs: 30_000,
    signal,
    killProcessTree: true,
    requireProcessTreeExtinction: true,
    maxOutputBytes: { stdout: 262_144, stderr: 8_192 },
    maxCombinedOutputBytes: 270_336,
    terminateOnOutputError: true,
    terminateOnOutputLimit: true,
    baseEnv: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME ?? "/tmp",
      LANG: "en_US.UTF-8",
      CLOUDSDK_CONFIG: config.cloudSdkConfig,
      CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
      CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "1",
      CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: "1",
      CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: "",
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "",
      CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: "",
      CLOUDSDK_AUTH_ACCESS_TOKEN: "",
      CLOUDSDK_AUTH_DISABLE_CREDENTIALS: "false",
      CLOUDSDK_CORE_LOG_HTTP: "false",
    },
  };
}

function toolParameters(kind: "logs" | "assessment") {
  if (kind === "assessment") {
    return z.toJSONSchema(assessmentSchema);
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["start", "end"],
    properties: {
      start: { type: "string" },
      end: { type: "string" },
      mode: { type: "string", enum: ["discover", "context", "errors"] },
      resourceType: { type: "string" },
      resourceLabels: { type: "object", additionalProperties: { type: "string" } },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      errorProfile: { type: "string", enum: ["tab-delimited"] },
      conversationId: { type: "string" },
      jobId: { type: "string" },
      roomId: { type: "string" },
      traceId: { type: "string" },
      insertId: { type: "string" },
      insertIds: { type: "array", items: { type: "string" }, maxItems: 10 },
    },
  };
}

export function createServiceCapabilities(params: {
  config: OncallConfig;
  gcpConfig: unknown;
  signal: AbortSignal;
  now(): number;
  assertCurrent(): void;
  runCommand?: typeof runUtf8CommandWithTimeout;
}) {
  const grants = new WeakMap<object, Grant>();
  const gcp = validateConfig(params.gcpConfig);
  const runCommand = params.runCommand ?? runUtf8CommandWithTimeout;

  function current(grant: Grant, allowSettled = false) {
    params.assertCurrent();
    params.signal.throwIfAborted();
    grant.signal.throwIfAborted();
    if (grant.revoked || params.now() >= grant.expiresAt || (!allowSettled && grant.assessment)) {
      throw new Error("Oncall service grant has expired or settled");
    }
  }

  function captured(context: OpenClawPluginToolContext): Grant | undefined {
    const token = context.toolBindings?.livex_oncall;
    if (!token || typeof token !== "object") {
      return undefined;
    }
    const grant = grants.get(token);
    if (!grant || !contextMatches(grant, context)) {
      return undefined;
    }
    current(grant);
    return grant;
  }

  function assertTool(grant: Grant, context: OpenClawPluginToolContext<2>) {
    context.assertInvocationCurrent();
    current(grant);
    if (!contextMatches(grant, context)) {
      throw new Error("Oncall invocation identity changed");
    }
  }

  async function logs(
    grant: Grant,
    context: OpenClawPluginToolContext<2>,
    input: unknown,
    signal?: AbortSignal,
  ) {
    assertTool(grant, context);
    const query: Query = queryArgs(input, gcp);
    assertSelectors(grant, query);
    if (
      Date.parse(query.start) < Date.parse(grant.alert.start) ||
      Date.parse(query.end) > Date.parse(grant.alert.end)
    ) {
      throw new Error("Oncall query exceeds the admitted alert window");
    }
    const remaining = params.config.maxLogBytes - grant.reservedBytes;
    if (grant.calls >= params.config.maxLogCalls || remaining < 1) {
      throw new Error("Oncall log budget exhausted");
    }
    const reserved = Math.min(30_720, remaining);
    grant.calls++;
    grant.reservedBytes += reserved;
    const abort = AbortSignal.any([grant.signal, params.signal, ...(signal ? [signal] : [])]);
    const argv = [
      gcp.gcloudPath,
      "logging",
      "read",
      buildLogFilter(query, gcp),
      `--project=${gcp.project}`,
      `--account=${gcp.gcloudAccount}`,
      `--limit=${query.limit}`,
      "--order=desc",
      "--format=json",
      "--quiet",
    ];
    assertTool(grant, context);
    const result = await runCommand(argv, commandOptions(gcp, abort));
    assertTool(grant, context);
    const details = withEvidenceLink(evidence(result, query, gcp), query, gcp);
    const content = JSON.stringify(details);
    if (Buffer.byteLength(content) > reserved) {
      throw new Error("Oncall evidence exceeds the reserved byte budget");
    }
    rememberEvidence(grant, details);
    return { content: [{ type: "text" as const, text: content }], details };
  }

  function assessment(grant: Grant, context: OpenClawPluginToolContext<2>, input: unknown) {
    assertTool(grant, context);
    const parsed = assessmentSchema.parse(input);
    if (new Set(parsed.findings.map((finding) => finding.id)).size !== parsed.findings.length) {
      throw new Error("Oncall finding IDs must be unique");
    }
    if (
      parsed.findings.some((finding) => finding.signature.environment !== params.config.environment)
    ) {
      throw new Error("Oncall assessment environment differs from the admitted source");
    }
    if (
      parsed.findings.some((finding) =>
        finding.evidence.some((url) => !grant.evidenceUrls.has(url)),
      )
    ) {
      throw new Error("Oncall assessment requires complete returned log evidence");
    }
    grant.assessment = parsed;
    return {
      content: [{ type: "text" as const, text: "Assessment accepted by coordinator" }],
      details: { accepted: true },
    };
  }

  return {
    issue(alert: Alert, identity: Pick<Grant, "sessionKey" | "sessionId" | "agentId" | "signal">) {
      params.assertCurrent();
      const token = Object.freeze({});
      grants.set(token, {
        ...identity,
        alert,
        expiresAt: params.now() + params.config.maxRunMs,
        calls: 0,
        reservedBytes: 0,
        evidenceUrls: new Set(),
        revoked: false,
        resources: [{ type: params.config.resourceType, labels: params.config.resourceLabels }],
        identifiers: new Map(
          Object.entries(alert.identifiers).map(([key, value]) => [key, new Set([value])]),
        ),
      });
      return token;
    },
    result(token: object) {
      const grant = grants.get(token);
      if (!grant) {
        return undefined;
      }
      current(grant, true);
      return grant.assessment;
    },
    revoke(token: object) {
      const grant = grants.get(token);
      if (grant) {
        grant.revoked = true;
      }
      grants.delete(token);
    },
    createTool(context: OpenClawPluginToolContext<2>, name: string): AnyAgentTool | null {
      let grant: Grant | undefined;
      try {
        grant = captured(context);
      } catch {
        return null;
      }
      if (!grant || !SERVICE_TOOLS.includes(name)) {
        return null;
      }
      const admitted = grant;
      const isLogs = name === SERVICE_TOOLS[0];
      return {
        name,
        label: isLogs ? "Read admitted alert logs" : "Submit Oncall assessment",
        description: isLogs
          ? "Read bounded observed alert evidence in the admitted project and UTC window."
          : "Submit supported independent findings to the coordinator. Case matching and paging are coordinator-owned.",
        parameters: toolParameters(isLogs ? "logs" : "assessment"),
        execute: async (_id, input, signal) =>
          isLogs ? logs(admitted, context, input, signal) : assessment(admitted, context, input),
      };
    },
  };
}

export type ServiceCapabilities = ReturnType<typeof createServiceCapabilities>;
