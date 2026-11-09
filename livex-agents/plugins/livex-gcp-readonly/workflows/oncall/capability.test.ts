import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it, vi } from "vitest";
import { createServiceCapabilities } from "./capability.js";
import { debuggerIdentity, runDebugger } from "./debugger.js";
import { alert, config, finding, gcpConfig, now } from "./test-support.js";
import { SERVICE_TOOLS } from "./types.js";

const query = {
  start: alert.start,
  end: alert.end,
  resourceType: config.resourceType,
  resourceLabels: config.resourceLabels,
  jobId: "job-1",
  limit: 50,
};
const entry = {
  timestamp: alert.end,
  severity: "ERROR",
  insertId: "row-1",
  resource: { type: config.resourceType, labels: config.resourceLabels },
  jsonPayload: { job_id: "job-1", message: "failed" },
};
const success = (rows = [entry]) => ({
  stdout: JSON.stringify(rows),
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit" as const,
});

function setup(overrides = {}) {
  let clock = now;
  const controller = new AbortController();
  const runCommand = vi.fn(async () => success());
  const caps = createServiceCapabilities({
    config: { ...config, ...overrides },
    gcpConfig,
    now: () => clock,
    signal: controller.signal,
    assertCurrent() {},
    runCommand,
  });
  const identity = debuggerIdentity(alert);
  const token = caps.issue(alert, { ...identity, agentId: "oncall", signal: controller.signal });
  const context: OpenClawPluginToolContext<2> = {
    agentId: "oncall",
    sessionKey: identity.sessionKey,
    sessionId: identity.sessionId,
    toolBindings: { livex_oncall: token },
    assertInvocationCurrent() {},
  };
  const logs = caps.createTool(context, SERVICE_TOOLS[0]!)!;
  const submit = caps.createTool(context, SERVICE_TOOLS[1]!)!;
  return {
    caps,
    token,
    context,
    logs,
    submit,
    identity,
    runCommand,
    controller,
    expire: () => {
      clock += config.maxRunMs;
    },
  };
}

it("private factories reject forged, cloned, wrong-run, wrong-agent and missing capabilities", async () => {
  const app = setup();
  for (const token of [undefined, {}, structuredClone(app.token)]) {
    expect(
      app.caps.createTool(
        { ...app.context, toolBindings: { livex_oncall: token } },
        SERVICE_TOOLS[0]!,
      ),
    ).toBeNull();
  }
  expect(app.caps.createTool({ ...app.context, sessionId: "other" }, SERVICE_TOOLS[0]!)).toBeNull();
  expect(app.caps.createTool({ ...app.context, agentId: "other" }, SERVICE_TOOLS[0]!)).toBeNull();
  app.caps.revoke(app.token);
  expect(app.caps.createTool(app.context, SERVICE_TOOLS[0]!)).toBeNull();
  await expect(app.logs.execute("retained-revoked", query)).rejects.toThrow();
  expect(app.runCommand).not.toHaveBeenCalled();
});

it("reads owner-scoped evidence before accepting a complete attributable assessment", async () => {
  const app = setup();
  await expect(app.submit.execute("fabricated", { findings: [finding] })).rejects.toThrow(
    "complete returned",
  );
  const result = await app.logs.execute("logs", query);
  const details = result.details as { logsExplorerUrl: string };
  await app.submit.execute("assessment", {
    findings: [{ ...finding, evidence: [details.logsExplorerUrl] }],
  });
  expect(app.caps.result(app.token)?.findings[0]?.priority).toBe("Critical");
  await expect(app.logs.execute("settled", query)).rejects.toThrow("settled");
  app.expire();
  expect(() => app.caps.result(app.token)).toThrow("expired");
});

it("rejects discovery, foreign environment/resource, fabricated IDs, oversized time windows and unknown arguments before command effects", async () => {
  const app = setup();
  const invalid = [
    { start: alert.start, end: alert.end, mode: "discover", jobId: "job-1" },
    { ...query, resourceLabels: { namespace_name: "stg-worker" } },
    { ...query, jobId: "foreign-job" },
    { ...query, start: "2026-11-07T09:00:00Z" },
    { ...query, filter: "severity>=INFO" },
    { ...query, limit: 51 },
  ];
  for (const input of invalid) {
    await expect(app.logs.execute("denied", input)).rejects.toThrow();
  }
  expect(app.runCommand).not.toHaveBeenCalled();
});

it("counts failed attempts against bounded calls and reserves aggregate returned bytes", async () => {
  const app = setup({ maxLogCalls: 1 });
  app.runCommand.mockRejectedValueOnce(new Error("failed read"));
  await expect(app.logs.execute("failed", query)).rejects.toThrow();
  await expect(app.logs.execute("budget", query)).rejects.toThrow("budget");
  expect(app.runCommand).toHaveBeenCalledOnce();
  const small = setup({ maxLogBytes: 1 });
  await expect(small.logs.execute("bytes", query)).rejects.toThrow("byte budget");
  await expect(small.logs.execute("bytes-again", query)).rejects.toThrow("budget");
});

it("does not accept empty/truncated log reads or foreign assessment environments as evidence", async () => {
  const app = setup();
  app.runCommand.mockResolvedValueOnce(success([]));
  const result = await app.logs.execute("empty", query);
  const details = result.details as { logsExplorerUrl: string };
  await expect(
    app.submit.execute("empty-evidence", {
      findings: [{ ...finding, evidence: [details.logsExplorerUrl] }],
    }),
  ).rejects.toThrow("complete returned");
  await expect(
    app.submit.execute("foreign-env", {
      findings: [{ ...finding, signature: { ...finding.signature, environment: "stg" } }],
    }),
  ).rejects.toThrow("environment");
});

it("revokes effects across an awaited command and native completion, without trusting late submission", async () => {
  const app = setup();
  app.runCommand.mockImplementationOnce(async () => {
    app.controller.abort();
    return success();
  });
  await expect(app.logs.execute("revoked-after-await", query)).rejects.toThrow();
  expect(() => app.caps.result(app.token)).toThrow();
  const other = setup();
  const run = vi.fn(
    async (
      _params: import("./types.js").RunAgent extends (params: infer P) => unknown ? P : never,
    ) => {
      other.controller.abort();
      return { meta: {} };
    },
  );
  await expect(
    runDebugger({
      alert,
      config,
      sourceConfig: {},
      identity: other.identity,
      token: other.token,
      signal: other.controller.signal,
      capabilities: other.caps,
      run,
      assertCurrent() {},
    }),
  ).rejects.toThrow();
  const params = run.mock.calls[0]?.[0];
  expect(params).toMatchObject({
    agentId: "oncall",
    toolsAllow: SERVICE_TOOLS,
    privateCompletion: true,
    disableMessageTool: true,
  });
});
