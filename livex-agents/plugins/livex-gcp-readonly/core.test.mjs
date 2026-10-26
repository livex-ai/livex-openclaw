import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { createLogsTool } from "./core.mjs";
import * as core from "./core.mjs";

const config = {
  gcloudPath: "/opt/google-cloud-sdk/bin/gcloud",
  cloudSdkConfig: "/home/pilot/.config/gcloud",
  gcloudAccount: "investigator@example.test",
  project: "example-prd",
  allowedChannelId: "C123",
  allowedSenderId: "U123",
};
const args = {
  resourceType: "k8s_container",
  resourceLabels: {
    cluster_name: "prd-cluster",
    location: "us-central1",
    namespace_name: "sample-worker",
    container_name: "sample-worker",
  },
  start: "2026-10-20T18:40:00Z",
  end: "2026-10-20T19:00:00Z",
};
const ctx = (guard = () => {}) => ({
  messageChannel: "slack",
  nativeChannelId: "C123",
  requesterSenderId: "U123",
  assertInvocationCurrent: guard,
});
const success = (entries = []) => ({
  stdout: JSON.stringify(entries),
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
});

const discovery = {
  mode: "discover",
  conversationId: "synthetic-conversation",
  start: args.start,
  end: args.end,
};
const discoveryRows = [
  {
    timestamp: "2026-10-20T18:45:04Z",
    severity: "WARNING",
    insertId: "worker-event",
    resource: {
      type: "k8s_container",
      labels: {
        project_id: "example-prd",
        cluster_name: "cluster-next",
        location: "us-central1",
        namespace_name: "worker-next",
        pod_name: "worker-next-xyz",
        container_name: "worker-next",
      },
    },
    jsonPayload: {
      conversation_id: "synthetic-conversation",
      job_id: "job-synthetic",
      room_id: "room-synthetic",
      room: "room-name-synthetic",
      agent_id: "agent-synthetic",
      message: "signal transport timed out",
    },
  },
  {
    timestamp: "2026-10-20T18:45:00Z",
    severity: "DEBUG",
    insertId: "api-event",
    resource: {
      type: "cloud_run_revision",
      labels: {
        project_id: "example-prd",
        service_name: "api-renamed",
        revision_name: "api-renamed-00007",
        location: "us-central1",
        configuration_name: "api-renamed",
      },
    },
    jsonPayload: {
      conversation_id: "synthetic-conversation",
      trace_id: "trace-synthetic",
      message: "container queues inspected",
    },
  },
];

test("discovers dynamic Cloud Run and GKE resources by conversation without excluding WARNING or DEBUG", async () => {
  const calls = [];
  const tool = createLogsTool(config, ctx(), async (argv, options) => {
    calls.push({ argv, options });
    return success(discoveryRows);
  });
  assert.ok(!tool.parameters.required.includes("resourceType"));
  assert.ok(!tool.parameters.required.includes("resourceLabels"));
  const result = await tool.execute("discover", discovery);
  assert.equal(
    calls[0].argv[3],
    'logName =~ "^projects/example-prd/logs/" AND (resource.type="cloud_run_revision" OR resource.type="k8s_container") AND timestamp>="2026-10-20T18:40:00.000Z" AND timestamp<="2026-10-20T19:00:00.000Z" AND (jsonPayload.conversation_id="synthetic-conversation")',
  );
  assert.ok(calls[0].argv.includes("--account=investigator@example.test"));
  assert.ok(calls[0].argv.includes("--limit=20"));
  assert.equal(calls[0].options.timeoutMs, 30000);
  assert.equal(result.details.resourceLabels, undefined);
  assert.equal(result.details.conversationId, discovery.conversationId);
  assert.deepEqual(
    result.details.entries.map((row) => row.severity),
    ["WARNING", "DEBUG"],
  );
  assert.equal(result.details.entries[0].jsonPayload.job_id, "job-synthetic");
  assert.equal(result.details.entries[0].jsonPayload.room_id, "room-synthetic");
  assert.equal(result.details.entries[0].jsonPayload.room, "room-name-synthetic");
  assert.equal(result.details.entries[0].jsonPayload.agent_id, "agent-synthetic");
  const observed = result.details.entries[1].resource;
  assert.equal(observed.labels.service_name, "api-renamed");
  await tool.execute("follow-up", {
    ...args,
    mode: "context",
    resourceType: observed.type,
    resourceLabels: observed.labels,
    conversationId: discovery.conversationId,
  });
  assert.ok(calls[1].argv[3].includes('resource.labels.revision_name="api-renamed-00007"'));
  assert.ok(calls[1].argv[3].endsWith(' AND jsonPayload.conversation_id="synthetic-conversation"'));
  assert.ok(!calls[1].argv[3].includes("severity"));
});

test("discovery matches any supplied correlation ID without widening the source or time predicates", async () => {
  const calls = [];
  const tool = createLogsTool(config, ctx(), async (argv) => {
    calls.push(argv);
    return success();
  });
  await tool.execute("call", {
    ...discovery,
    jobId: "job-synthetic",
    roomId: "room-synthetic",
    traceId: "0123456789abcdef0123456789abcdef",
    insertId: "seed-synthetic",
  });
  const filter = calls[0][3];
  assert.ok(
    filter.startsWith(
      'logName =~ "^projects/example-prd/logs/" AND (resource.type="cloud_run_revision" OR resource.type="k8s_container") AND timestamp',
    ),
  );
  assert.ok(
    filter.includes(
      'jsonPayload.conversation_id="synthetic-conversation" OR jsonPayload.job_id="job-synthetic" OR jsonPayload.room_id="room-synthetic"',
    ),
  );
  assert.ok(
    filter.includes('trace="projects/example-prd/traces/0123456789abcdef0123456789abcdef"'),
  );
  assert.ok(filter.includes('insertId="seed-synthetic"'));
  assert.ok(!filter.includes("severity"));
  for (const [field, logField] of [
    ["jobId", "jsonPayload.job_id"],
    ["roomId", "jsonPayload.room_id"],
    ["traceId", "jsonPayload.trace_id"],
    ["insertId", "insertId"],
  ]) {
    await tool.execute("call", {
      mode: "discover",
      start: args.start,
      end: args.end,
      [field]: "one-id",
    });
    assert.ok(calls.at(-1)[3].includes(`${logField}="one-id"`));
  }
  const injected = 'id" OR logName:*\\';
  await tool.execute("call", { ...discovery, conversationId: injected });
  assert.ok(
    calls.at(-1)[3].endsWith(` AND (jsonPayload.conversation_id=${JSON.stringify(injected)})`),
  );
});

test("discovery rejects uncorrelated or operator-controlled scans before execution", async () => {
  let calls = 0;
  const tool = createLogsTool(config, ctx(), async () => {
    calls++;
    return success();
  });
  const invalid = [
    { mode: "discover", start: args.start, end: args.end },
    { ...discovery, resourceType: "k8s_container" },
    { ...discovery, resourceLabels: {} },
    { ...discovery, project: "other-project" },
    { ...discovery, account: "other@example.test" },
    { ...discovery, filter: "logName:*" },
    { ...discovery, command: "anything" },
    { ...discovery, start: "2026-10-20T17:00:00Z" },
    { ...discovery, limit: 51 },
  ];
  for (const field of ["conversationId", "jobId", "roomId", "traceId", "insertId"]) {
    for (const value of ["", null, 123, "x\nOR true", "x".repeat(257)])
      invalid.push({ ...discovery, [field]: value });
  }
  for (const input of invalid) await assert.rejects(tool.execute("call", input), /Invalid/);
  assert.equal(calls, 0);
});

test("discovery preserves revocation and cancellation checks around process execution", async () => {
  let calls = 0;
  const denied = createLogsTool(
    config,
    ctx(() => {
      throw Error("expired");
    }),
    async () => {
      calls++;
      return success();
    },
  );
  await assert.rejects(denied.execute("call", discovery), /expired/);
  assert.equal(calls, 0);
  let checks = 0;
  const revoked = createLogsTool(
    config,
    ctx(() => {
      if (++checks === 2) throw Error("revoked");
    }),
    async () => success(discoveryRows),
  );
  await assert.rejects(revoked.execute("call", discovery), /revoked/);
  const controller = new AbortController();
  controller.abort();
  const aborted = createLogsTool(config, ctx(), async () => {
    calls++;
    return success();
  });
  await assert.rejects(aborted.execute("call", discovery, controller.signal), /abort/i);
  assert.equal(calls, 0);
});

test("discovery redacts correlation metadata and returned identifiers", async () => {
  const tool = createLogsTool(config, ctx(), async () =>
    success([
      { jsonPayload: { conversation_id: "person@example.test", job_id: "token=SYNTHETIC_SECRET" } },
    ]),
  );
  const result = await tool.execute("call", {
    ...discovery,
    conversationId: "person@example.test",
    jobId: "token=QUERY_SECRET",
  });
  assert.equal(result.details.conversationId, "[REDACTED]");
  assert.ok(!JSON.stringify(result).includes("QUERY_SECRET"));
  assert.ok(!JSON.stringify(result).includes("SYNTHETIC_SECRET"));
});

test(
  "gcloud projection retains discovery IDs and resource labels",
  { skip: !process.env.GCLOUD_SDK_LIB },
  async () => {
    const tool = createLogsTool(config, ctx(), async (argv) => ({
      ...success(),
      stdout: formatRows(argv, discoveryRows),
    }));
    const result = await tool.execute("call", discovery);
    assert.equal(result.details.entries[0].jsonPayload.conversation_id, discovery.conversationId);
    assert.equal(result.details.entries[0].jsonPayload.job_id, "job-synthetic");
    assert.equal(result.details.entries[0].jsonPayload.room_id, "room-synthetic");
    assert.equal(result.details.entries[1].jsonPayload.trace_id, "trace-synthetic");
    assert.equal(result.details.entries[1].resource.labels.service_name, "api-renamed");
  },
);

test("channel wildcard admits the authorized Slack user in different public and private channels", async () => {
  let calls = 0;
  for (const nativeChannelId of ["C123", "C999", "G456"]) {
    const tool = createLogsTool(
      { ...config, allowedChannelId: "*" },
      { ...ctx(), nativeChannelId },
      async () => {
        calls++;
        return success();
      },
    );
    assert.ok(tool);
    await tool.execute("call", args);
  }
  assert.equal(calls, 3);
});

test("channel wildcard does not grant cloud access to DMs, other senders, providers or missing context", () => {
  const wildcard = { ...config, allowedChannelId: "*" };
  for (const context of [
    {},
    { ...ctx(), requesterSenderId: "U999" },
    { ...ctx(), messageChannel: "discord" },
    { ...ctx(), messageChannel: undefined },
    { ...ctx(), nativeChannelId: "D123" },
    { ...ctx(), nativeChannelId: undefined },
    { ...ctx(), nativeChannelId: "*" },
    { ...ctx(), nativeChannelId: "C123:thread:456" },
    { ...ctx(), assertInvocationCurrent: undefined },
  ])
    assert.equal(
      createLogsTool(wildcard, context, () => {
        throw Error("must not execute");
      }),
      null,
    );
  assert.equal(
    createLogsTool(config, { ...ctx(), messageChannel: "discord" }, () => {}),
    null,
  );
  assert.throws(
    () => createLogsTool({ ...config, allowedChannelId: "C*" }, ctx(), () => {}),
    /Invalid/,
  );
});

test("reads any service with bounded selectors while pinning source project and account", async () => {
  let observed;
  const tool = createLogsTool(config, ctx(), async (argv, options) => {
    observed = { argv, options };
    return success();
  });
  const result = await tool.execute("call", {
    ...args,
    resourceType: "cloud_run_revision",
    resourceLabels: { service_name: "voice-api", location: "us-central1" },
    mode: "context",
  });
  assert.equal(
    observed.argv[3],
    'logName =~ "^projects/example-prd/logs/" AND resource.type="cloud_run_revision" AND resource.labels.service_name="voice-api" AND resource.labels.location="us-central1" AND timestamp>="2026-10-20T18:40:00.000Z" AND timestamp<="2026-10-20T19:00:00.000Z"',
  );
  assert.ok(observed.argv.includes("--project=example-prd"));
  assert.ok(observed.argv.includes("--account=investigator@example.test"));
  assert.ok(observed.argv.includes("--limit=20"));
  assert.equal(result.details.resourceType, "cloud_run_revision");
  assert.deepEqual(result.details.resourceLabels, {
    service_name: "voice-api",
    location: "us-central1",
  });
});

test("requires an explicit gcloud account and rejects malformed account identities", () => {
  for (const gcloudAccount of [
    undefined,
    "",
    "--impersonate-service-account=x",
    "x@example.test\n",
    "x@example.test y@example.test",
  ]) {
    assert.throws(
      () => createLogsTool({ ...config, gcloudAccount }, ctx(), async () => success()),
      /Invalid/,
    );
  }
});

test("rejects missing, oversized, injected and cross-project resource selectors before executing", async () => {
  let calls = 0;
  const tool = createLogsTool(config, ctx(), async () => {
    calls++;
    return success();
  });
  const valid = {
    ...args,
    resourceType: "cloud_run_revision",
    resourceLabels: { service_name: "voice-api" },
  };
  for (const input of [
    { ...valid, resourceType: undefined },
    { ...valid, resourceType: "" },
    { ...valid, resourceType: 'cloud_run_revision" OR true' },
    { ...valid, resourceType: "x".repeat(129) },
    { ...valid, resourceLabels: undefined },
    { ...valid, resourceLabels: null },
    { ...valid, resourceLabels: [] },
    { ...valid, resourceLabels: {} },
    { ...valid, resourceLabels: { "service_name.foo": "x" } },
    { ...valid, resourceLabels: { 'service_name" OR true': "x" } },
    { ...valid, resourceLabels: { service_name: "" } },
    { ...valid, resourceLabels: { service_name: null } },
    { ...valid, resourceLabels: { service_name: 4 } },
    { ...valid, resourceLabels: { service_name: "x".repeat(257) } },
    { ...valid, resourceLabels: { service_name: "x\nOR true" } },
    { ...valid, resourceLabels: { project_id: "another-project" } },
    {
      ...valid,
      resourceLabels: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`label_${i}`, "x"])),
    },
    { ...valid, filter: "logName:*" },
    { ...valid, project: "another-project" },
  ])
    await assert.rejects(tool.execute("call", input), /Invalid/);
  assert.equal(calls, 0);
  await tool.execute("call", { ...valid, resourceLabels: { project_id: "example-prd" } });
  assert.equal(calls, 1);
});

test("quotes selector and correlation values and keeps correlation OR inside the fixed scope", async () => {
  const calls = [];
  const tool = createLogsTool(config, ctx(), async (argv) => {
    calls.push(argv);
    return success();
  });
  const selection = {
    ...args,
    resourceType: "custom_resource",
    resourceLabels: { service: 'x" OR logName:*\\' },
    mode: "context",
  };
  await tool.execute("call", {
    ...selection,
    insertId: 'entry" OR true\\',
    traceId: "0123456789abcdef0123456789abcdef",
  });
  assert.ok(calls[0][3].includes('resource.labels.service="x\\" OR logName:*\\\\"'));
  assert.ok(calls[0][3].includes(' AND insertId="entry\\" OR true\\\\"'));
  assert.ok(
    calls[0][3].endsWith(
      ' AND (jsonPayload.trace_id="0123456789abcdef0123456789abcdef" OR trace="0123456789abcdef0123456789abcdef" OR trace="projects/example-prd/traces/0123456789abcdef0123456789abcdef")',
    ),
  );
  assert.ok(calls[0][3].startsWith('logName =~ "^projects/example-prd/logs/" AND '));
  await tool.execute("call", { ...selection, traceId: "application-correlation" });
  assert.ok(calls[1][3].endsWith(' AND (jsonPayload.trace_id="application-correlation")'));
  assert.ok(!calls[1][3].includes("projects/example-prd/traces/"));
  for (const field of ["insertId", "traceId"]) {
    for (const value of ["", null, 123, "x\nOR true", "x".repeat(257)]) {
      await assert.rejects(tool.execute("call", { ...selection, [field]: value }), /Invalid/);
    }
  }
  assert.equal(calls.length, 2);
});

test("returns the real resource type and service labels with redaction and bounded label evidence", async () => {
  const tool = createLogsTool(config, ctx(), async () =>
    success([
      {
        resource: {
          type: "cloud_run_revision",
          labels: {
            project_id: "example-prd",
            service_name: "voice-api",
            revision_name: "voice-api-0042",
            owner: "person@example.test",
            token: "SHOULD_NOT_APPEAR",
          },
        },
        textPayload: "diagnostic",
      },
    ]),
  );
  const result = await tool.execute("call", {
    ...args,
    resourceType: "cloud_run_revision",
    resourceLabels: { service_name: "voice-api" },
  });
  assert.equal(result.details.entries[0].resource.type, "cloud_run_revision");
  assert.equal(result.details.entries[0].resource.labels.revision_name, "voice-api-0042");
  assert.equal(result.details.entries[0].resource.labels.owner, "[REDACTED]");
  assert.equal(result.details.entries[0].resource.labels.token, "[REDACTED]");
  assert.ok(!JSON.stringify(result).includes("SHOULD_NOT_APPEAR"));
  const metadata = await tool.execute("call", {
    ...args,
    resourceLabels: { token: "QUERY_SECRET" },
  });
  assert.equal(metadata.details.resourceLabels.token, "[REDACTED]");
  assert.ok(!JSON.stringify(metadata).includes("QUERY_SECRET"));
});

function formatRows(argv, rows) {
  const format = argv.find((x) => x.startsWith("--format=")).slice(9);
  return execFileSync(
    "python3",
    [
      "-c",
      `
import sys, json
sdk=sys.argv[1]
sys.path[:0]=[sdk,sdk+'/third_party']
from googlecloudsdk.core.resource import resource_printer
resource_printer.Print(json.load(sys.stdin),sys.argv[2])
`,
      process.env.GCLOUD_SDK_LIB,
      format,
    ],
    { input: JSON.stringify(rows), encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
}

test(
  "CLI-truncated evidence stays marked incomplete after redaction shrinks it",
  { skip: !process.env.GCLOUD_SDK_LIB },
  async () => {
    const tool = createLogsTool(config, ctx(), async (argv) => ({
      ...success(),
      stdout: formatRows(argv, [
        { textPayload: "TimeoutError alice.long.name@example.test " + "x".repeat(12000) },
      ]),
    }));
    const result = await tool.execute("call", args);
    assert.equal(result.details.entries.length, 1);
    assert.ok(result.details.entries[0].textPayload.length < 2048);
    assert.equal(result.details.truncated, true);
  },
);

test(
  "CLI truncation cannot expose the remainder of a quoted secret",
  { skip: !process.env.GCLOUD_SDK_LIB },
  async () => {
    for (const quote of ['"', "'"]) {
      const tool = createLogsTool(config, ctx(), async (argv) => ({
        ...success(),
        stdout: formatRows(argv, [
          {
            textPayload:
              "password: " + quote + "first SENSITIVE_REMAINDER " + "z".repeat(4000) + quote,
          },
        ]),
      }));
      const result = await tool.execute("call", args);
      assert.ok(!JSON.stringify(result).includes("SENSITIVE_REMAINDER"));
      assert.equal(result.details.truncated, true);
    }
  },
);

test(
  "large text error entries fit the process cap using the installed gcloud formatter",
  { skip: !process.env.GCLOUD_SDK_LIB },
  async () => {
    let outputBytes;
    const tool = createLogsTool(config, ctx(), async (argv) => {
      const format = argv.find((x) => x.startsWith("--format=")).slice(9);
      const stdout = execFileSync(
        "python3",
        [
          "-c",
          `
import sys, json, io
sdk=sys.argv[1]
sys.path[:0]=[sdk,sdk+'/third_party']
from googlecloudsdk.core.resource import resource_printer
resource_printer.Print([{'textPayload':'TimeoutError: '+('x'*12000),'severity':'ERROR'} for _ in range(50)],sys.argv[2])
`,
          process.env.GCLOUD_SDK_LIB,
          format,
        ],
        { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
      );
      outputBytes = Buffer.byteLength(stdout);
      return { ...success(), stdout };
    });
    const result = await tool.execute("call", { ...args, limit: 50 });
    assert.ok(
      outputBytes <= 262144,
      "gcloud projection must bound long text before the process output cap",
    );
    assert.ok(result.details.entries.length > 0);
    assert.match(result.details.entries[0].textPayload, /^TimeoutError:/);
    assert.equal(result.details.truncated, true);
  },
);

test("output overflow and timeout give distinct safe next steps", async () => {
  const cases = [
    [{ ...success(), outputLimitExceeded: true }, /output limit.*smaller row limit/i],
    [{ ...success(), termination: "timeout", code: null }, /timed out.*narrower time window/i],
    [{ ...success(), code: 1, stderr: "token=SUPERSECRET" }, /CLI exited with code 1/],
  ];
  for (const [response, expected] of cases) {
    const tool = createLogsTool(config, ctx(), async () => response);
    await assert.rejects(
      tool.execute("call", args),
      (error) => expected.test(error.message) && !error.message.includes("SUPERSECRET"),
    );
  }
});

test("refuses missing or different trusted caller even with operator authority", () => {
  for (const context of [
    {},
    { ...ctx(), requesterSenderId: "U999" },
    { ...ctx(), nativeChannelId: "C999" },
    { ...ctx(), assertInvocationCurrent: undefined },
    { senderIsOwner: true },
  ]) {
    assert.equal(
      createLogsTool(config, context, () => {
        throw Error("must not execute");
      }),
      null,
    );
  }
});

test("fixed argv pins the project and caller-selected resource, bounds output and does not permit a shell", async () => {
  let observed;
  const signal = new AbortController().signal;
  const tool = createLogsTool(config, ctx(), async (argv, options) => {
    observed = { argv, options };
    return success();
  });
  await tool.execute("call", args, signal);
  assert.deepEqual(observed.argv.slice(0, 4), [
    "/opt/google-cloud-sdk/bin/gcloud",
    "logging",
    "read",
    'logName =~ "^projects/example-prd/logs/" AND resource.type="k8s_container" AND resource.labels.cluster_name="prd-cluster" AND resource.labels.location="us-central1" AND resource.labels.namespace_name="sample-worker" AND resource.labels.container_name="sample-worker" AND timestamp>="2026-10-20T18:40:00.000Z" AND timestamp<="2026-10-20T19:00:00.000Z" AND (severity>=ERROR OR jsonPayload.level="error" OR jsonPayload.level="ERROR" OR jsonPayload.levelname="ERROR")',
  ]);
  assert.ok(observed.argv.includes("--project=example-prd"));
  assert.ok(observed.argv.includes("--account=investigator@example.test"));
  assert.ok(observed.argv.includes("--limit=20"));
  assert.ok(observed.argv.includes("--order=desc"));
  assert.equal(observed.options.timeoutMs, 30000);
  assert.deepEqual(observed.options.maxOutputBytes, { stdout: 262144, stderr: 8192 });
  assert.equal(observed.options.terminateOnOutputLimit, true);
  assert.equal(observed.options.killProcessTree, true);
  assert.equal(observed.options.signal, signal);
  assert.equal(observed.options.shell, undefined);
  assert.equal(observed.options.baseEnv.CLOUDSDK_CONFIG, "/home/pilot/.config/gcloud");
  for (const key of [
    "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT",
    "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
    "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE",
    "CLOUDSDK_AUTH_ACCESS_TOKEN",
  ]) {
    assert.equal(
      observed.options.baseEnv[key],
      "",
      `${key} must override persisted alternate credentials`,
    );
  }
  assert.equal(observed.options.baseEnv.CLOUDSDK_AUTH_DISABLE_CREDENTIALS, "false");
  assert.equal(observed.options.baseEnv.CLOUDSDK_CORE_LOG_HTTP, "false");
});

test("context mode broadens levels only and mode cannot inject filters", async () => {
  const calls = [];
  const tool = createLogsTool(config, ctx(), async (argv) => {
    calls.push(argv);
    return success();
  });
  await tool.execute("call", { ...args, mode: "context" });
  assert.ok(!calls[0][3].includes("severity"));
  assert.ok(calls[0][3].includes('resource.labels.container_name="sample-worker"'));
  assert.ok(calls[0][3].includes('timestamp>="2026-10-20T18:40:00.000Z"'));
  await assert.rejects(tool.execute("call", { ...args, mode: 'context" OR true' }), /Invalid/);
  assert.equal(calls.length, 1);
});

test("rejects invalid time, window, limits and injected/unknown fields before any command", async () => {
  let calls = 0;
  const tool = createLogsTool(config, ctx(), async () => {
    calls++;
    return success();
  });
  for (const input of [
    null,
    [],
    {},
    { ...args, start: "2026-02-30T18:40:00Z" },
    { ...args, start: "2026-10-20T18:40:00-07:00" },
    { ...args, start: '2026-10-20T18:40:00Z" OR true' },
    { ...args, start: args.end },
    { ...args, start: "2026-10-20T17:59:59Z" },
    { ...args, limit: 0 },
    { ...args, limit: 51 },
    { ...args, limit: 1.5 },
    { ...args, limit: "5" },
    { ...args, limit: null },
    { ...args, mode: null },
    { ...args, project: "another-project" },
    { ...args, filter: "severity>=INFO" },
    { ...args, command: "rm -rf /" },
  ])
    await assert.rejects(tool.execute("call", input), /Invalid/);
  assert.equal(calls, 0);
  await tool.execute("call", {
    ...args,
    start: "2026-10-20T18:00:00Z",
    end: "2026-10-20T19:00:00Z",
    limit: 50,
  });
  assert.equal(calls, 1);
});

test("rejects malformed operator paths and filter values", () => {
  for (const bad of [
    { gcloudPath: "gcloud" },
    { cloudSdkConfig: "../credentials" },
    { project: 'x" OR true' },
    { project: "" },
  ]) {
    assert.throws(
      () => createLogsTool({ ...config, ...bad }, ctx(), async () => success()),
      /Invalid/,
    );
  }
});

test("checks authority before process admission and again before returning evidence", async () => {
  let checks = 0;
  const tool = createLogsTool(
    config,
    ctx(() => {
      if (++checks === 2) throw Error("revoked");
    }),
    async () => {
      return success([{ textPayload: "private diagnostic" }]);
    },
  );
  await assert.rejects(tool.execute("call", args), /revoked/);
  assert.equal(checks, 2);
  let ran = false;
  const denied = createLogsTool(
    config,
    ctx(() => {
      throw Error("expired");
    }),
    async () => {
      ran = true;
      return success();
    },
  );
  await assert.rejects(denied.execute("call", args), /expired/);
  assert.equal(ran, false);
});

test("aborted invocations cannot start or return evidence", async () => {
  const control = new AbortController();
  control.abort();
  let calls = 0;
  const tool = createLogsTool(config, ctx(), async () => {
    calls++;
    return success();
  });
  await assert.rejects(tool.execute("call", args, control.signal), /abort/i);
  assert.equal(calls, 0);
  const during = new AbortController();
  const delayed = createLogsTool(config, ctx(), async () => {
    during.abort();
    return success([{ textPayload: "not returned" }]);
  });
  await assert.rejects(delayed.execute("call", args, during.signal), /abort/i);
});

test("selects diagnostic fields and redacts common secrets, emails and URL queries", async () => {
  const tool = createLogsTool(config, ctx(), async () =>
    success([
      {
        timestamp: "2026-10-20T18:45:00Z",
        severity: "ERROR",
        insertId: "synthetic-1",
        textPayload:
          "failed user=alice@example.test token=abc123 Bearer secretbearer https://example.test/x?api_key=secret#private",
        jsonPayload: {
          message: "password: secretpass",
          error: { name: "TimeoutError", message: "retry", token: "unselected" },
          customer: "not selected",
          filename: "worker.py",
          lineno: 42,
          funcName: "dispatch",
          exc_info: "TimeoutError: retry",
          trace_id: "synthetic-trace",
        },
        resource: {
          type: "k8s_container",
          labels: {
            pod_name: "sample-worker-abc",
            namespace_name: "sample-worker",
            secret: "not selected",
          },
        },
        labels: { customer: "not selected" },
      },
    ]),
  );
  const result = await tool.execute("call", args);
  const serialized = JSON.stringify(result);
  for (const excluded of [
    "alice@example.test",
    "abc123",
    "secretbearer",
    "api_key=secret",
    "#private",
    "secretpass",
    "unselected",
    "not selected",
  ])
    assert.ok(!serialized.includes(excluded), excluded);
  assert.match(serialized, /TimeoutError/);
  assert.match(serialized, /sample-worker-abc/);
  assert.match(serialized, /worker\.py/);
  assert.equal(result.details.entries[0].jsonPayload.lineno, "42");
  assert.match(serialized, /\[REDACTED\]/);
});

test("caps rows and text while reporting truncation", async () => {
  const rows = Array.from({ length: 50 }, () => ({ textPayload: "a".repeat(3000) }));
  const tool = createLogsTool(config, ctx(), async () => success(rows));
  const result = await tool.execute("call", { ...args, limit: 2 });
  assert.ok(result.details.entries.length <= 2);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 70000);
  assert.equal(result.details.truncated, true);
  assert.ok(result.details.entries[0].textPayload.length <= 2100);
});

test("keeps selectors and evidence together within the result byte budget", async () => {
  const resourceLabels = Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [`label_${i}`, "x".repeat(256)]),
  );
  const rows = Array.from({ length: 50 }, () => ({
    resource: { type: "custom_resource", labels: { service: "any" } },
    textPayload: "a".repeat(2048),
  }));
  const tool = createLogsTool(config, ctx(), async () => success(rows));
  const result = await tool.execute("call", {
    ...args,
    resourceType: "custom_resource",
    resourceLabels,
    limit: 50,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result.details)) <= 30 * 1024);
  assert.equal(result.details.truncated, true);
  assert.ok(result.details.entries.length > 0);
});

test("redacts Basic authorization and quoted secret values containing spaces", async () => {
  const tool = createLogsTool(config, ctx(), async () =>
    success([
      {
        textPayload:
          "Authorization: Basic YWxwaGE6YnJhdm8= password=\"secret phrase\" token='another secret'",
      },
    ]),
  );
  const result = await tool.execute("call", args);
  const text = JSON.stringify(result);
  for (const value of ["YWxwaGE6YnJhdm8=", "secret phrase", "another secret", "phrase", "another"])
    assert.ok(!text.includes(value), value);
});

test("does not expose stderr or process errors, and rejects oversized/malformed output", async () => {
  const results = [
    { ...success(), code: 1, stderr: "credential=SUPERSECRET" },
    { ...success(), termination: "timeout", code: null },
    { ...success(), outputLimitExceeded: true, stdout: '["partial' },
    { ...success(), stdoutTruncatedBytes: 12 },
    { ...success(), stdout: "x".repeat(262145) },
    { ...success(), stdout: '{"not":"an array"}' },
    { ...success(), stdout: "not json" },
  ];
  for (const result of results) {
    const tool = createLogsTool(config, ctx(), async () => result);
    await assert.rejects(
      tool.execute("call", args),
      (e) => !e.message.includes("SUPERSECRET") && /Cloud log read/.test(e.message),
    );
  }
  const thrown = createLogsTool(config, ctx(), async () => {
    throw Error("SUPERSECRET");
  });
  await assert.rejects(
    thrown.execute("call", args),
    (e) => !e.message.includes("SUPERSECRET") && /Cloud log read/.test(e.message),
  );
});

test("preserves one through nine fractional timestamp digits in the query and evidence", async () => {
  const calls = [];
  const tool = createLogsTool(config, ctx(), async (argv) => {
    calls.push(argv);
    return success();
  });
  for (const fraction of [
    "1",
    "12",
    "123",
    "0737",
    "07371",
    "073712",
    "0737123",
    "07371234",
    "073712345",
  ]) {
    const start = `2026-10-20T18:00:00.${fraction}Z`;
    const end = `2026-10-20T19:00:00.${fraction}Z`;
    const result = await tool.execute("fraction", { ...args, start, end });
    assert.ok(calls.at(-1)[3].includes(`timestamp>="${start}" AND timestamp<="${end}"`));
    assert.equal(result.details.start, start);
    assert.equal(result.details.end, end);
  }
});

test("compares nanosecond windows without rounding away their boundaries", async () => {
  let calls = 0;
  const tool = createLogsTool(config, ctx(), async () => {
    calls++;
    return success();
  });
  await tool.execute("one-nanosecond", {
    ...args,
    start: "2026-10-20T18:00:00.000000001Z",
    end: "2026-10-20T18:00:00.000000002Z",
  });
  await tool.execute("hour-across-day", {
    ...args,
    start: "2026-10-20T23:30:00.999999999Z",
    end: "2026-10-21T00:30:00.999999999Z",
  });
  for (const [start, end] of [
    ["2026-10-20T18:00:00.000000001Z", "2026-10-20T19:00:00.000000002Z"],
    ["2026-10-20T18:00:00.1Z", "2026-10-20T18:00:00.100000000Z"],
    ["2026-10-20T18:00:00.000000002Z", "2026-10-20T18:00:00.000000001Z"],
  ])
    await assert.rejects(
      tool.execute("invalid-window", { ...args, start, end }),
      /Invalid query window/,
    );
  assert.equal(calls, 2);
});

test("fractional timestamps still reject impossible dates and malformed UTC before execution", async () => {
  let calls = 0;
  const tool = createLogsTool(config, ctx(), async () => {
    calls++;
    return success();
  });
  for (const start of [
    "2026-02-29T18:00:00.073712Z",
    "2026-10-20T24:00:00.073712Z",
    "2026-10-20T18:00:60.073712Z",
    "2026-10-20T18:00:00.1234567890Z",
    "2026-10-20T18:00:00.073712+00:00",
  ]) {
    await assert.rejects(tool.execute("invalid-time", { ...args, start }), /Invalid UTC timestamp/);
  }
  await tool.execute("leap-day", {
    ...args,
    start: "2024-02-29T18:00:00.000000001Z",
    end: "2024-02-29T18:01:00.000000001Z",
  });
  assert.equal(calls, 1);
});

test("batches literal insert IDs inside the fixed discovery and scoped predicates", async () => {
  const calls = [];
  const tool = createLogsTool(config, ctx(), async (argv) => {
    calls.push(argv);
    return success();
  });
  await tool.execute("discover-seeds", { ...discovery, insertIds: ["seed-a", "seed-b"] });
  assert.equal(
    calls[0][3],
    'logName =~ "^projects/example-prd/logs/" AND (resource.type="cloud_run_revision" OR resource.type="k8s_container") AND timestamp>="2026-10-20T18:40:00.000Z" AND timestamp<="2026-10-20T19:00:00.000Z" AND (jsonPayload.conversation_id="synthetic-conversation" OR (insertId="seed-a" OR insertId="seed-b"))',
  );
  await tool.execute("scoped-seeds", {
    ...args,
    mode: "context",
    jobId: "job-a",
    insertIds: ["seed-a", "seed-b"],
  });
  assert.ok(
    calls[1][3].endsWith(
      ' AND jsonPayload.job_id="job-a" AND (insertId="seed-a" OR insertId="seed-b")',
    ),
  );
  assert.ok(calls[1][3].includes('resource.labels.namespace_name="sample-worker"'));
  await tool.execute("literal-seed", {
    mode: "discover",
    start: args.start,
    end: args.end,
    insertIds: ['seed" OR true\\'],
  });
  assert.ok(calls[2][3].endsWith(' AND ((insertId="seed\\" OR true\\\\"))'));
  for (const argv of calls)
    assert.ok(
      argv.includes("--project=example-prd") &&
        argv.includes("--account=investigator@example.test"),
    );
});

test("rejects invalid or ambiguous seed batches before execution and redacts batch metadata", async () => {
  let calls = 0;
  const tool = createLogsTool(config, ctx(), async () => {
    calls++;
    return success();
  });
  const batch = { mode: "discover", start: args.start, end: args.end, insertIds: ["seed-a"] };
  for (const insertIds of [
    [],
    null,
    "seed-a",
    Array(11).fill("seed-a"),
    [""],
    ["a\nOR true"],
    [123],
    ["x".repeat(257)],
    new Array(1),
  ]) {
    await assert.rejects(tool.execute("invalid-batch", { ...batch, insertIds }), /Invalid/);
  }
  await assert.rejects(
    tool.execute("ambiguous-batch", { ...batch, insertId: "seed-b" }),
    /Invalid/,
  );
  assert.equal(calls, 0);
  const result = await tool.execute("valid-batch", {
    ...batch,
    insertIds: ["token=SYNTHETIC_SECRET", ...Array(9).fill("seed-a")],
  });
  assert.equal(calls, 1);
  assert.equal(result.details.insertIds.length, 10);
  assert.ok(!JSON.stringify(result).includes("SYNTHETIC_SECRET"));
});

test("returns embedded log levels so outer ERROR is distinguishable from embedded DEBUG", async () => {
  let format;
  const tool = createLogsTool(config, ctx(), async (argv) => {
    format = argv.find((value) => value.startsWith("--format="));
    return success([
      {
        severity: "ERROR",
        jsonPayload: { level: "debug", levelname: "DEBUG", message: "synthetic diagnostic" },
      },
    ]);
  });
  const result = await tool.execute("levels", args);
  assert.deepEqual(result.details.entries[0].jsonPayload, {
    level: "debug",
    levelname: "DEBUG",
    message: "synthetic diagnostic",
  });
  assert.ok(format.includes("jsonPayload.level,") && format.includes("jsonPayload.levelname,"));
});

test("reports distinct field, row-limit and invalid-row truncation with consumed-row counts", async () => {
  const rows = [null, { textPayload: "a".repeat(3000) }, { textPayload: "undisplayed third row" }];
  const tool = createLogsTool(config, ctx(), async () => success(rows));
  const { details } = await tool.execute("truncation", { ...args, limit: 2 });
  assert.deepEqual(
    new Set(details.truncationReasons),
    new Set(["field", "row-limit", "invalid-row"]),
  );
  assert.equal(details.fetchedRows, 3);
  assert.equal(details.processedRows, 2);
  assert.equal(details.returnedRows, 1);
  assert.equal(details.invalidRows, 1);
  assert.equal(details.truncated, true);
  assert.ok(!JSON.stringify(details).includes("undisplayed third row"));
});

test("a byte-budget break retains the first undisplayed raw row for continuation", async () => {
  const rows = [
    null,
    ...Array.from({ length: 30 }, (_, i) => ({
      insertId: `row-${i}`,
      textPayload: "a".repeat(2048),
    })),
  ];
  const tool = createLogsTool(config, ctx(), async () => success(rows));
  const { details } = await tool.execute("byte-budget", { ...args, limit: 50 });
  assert.deepEqual(new Set(details.truncationReasons), new Set(["invalid-row", "result-byte"]));
  assert.equal(details.fetchedRows, 31);
  assert.equal(details.processedRows, details.entries.length + 1);
  assert.equal(details.returnedRows, details.entries.length);
  assert.equal(details.invalidRows, 1);
  assert.ok(details.processedRows < rows.length);
  assert.equal(rows[details.processedRows].insertId, `row-${details.entries.length}`);
  assert.ok(Buffer.byteLength(JSON.stringify(details)) <= 30 * 1024);
});

test("rejects query metadata that alone exceeds the result byte budget even for empty results", async () => {
  const wide = "\ud800".repeat(256);
  const resourceLabels = Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [`label_${i}`, wide]),
  );
  const tool = createLogsTool(config, ctx(), async () => success());
  await assert.rejects(
    tool.execute("wide-query", {
      ...args,
      mode: "context",
      resourceLabels,
      conversationId: wide,
      jobId: wide,
      roomId: wide,
      traceId: wide,
      insertIds: Array(10).fill(wide),
    }),
    (error) =>
      /query metadata exceeds its result byte limit/.test(error.message) &&
      !error.message.includes(wide),
  );
});

test("exports shared validation, filter and evidence contracts for the paged backend", () => {
  for (const name of [
    "validateConfig",
    "queryArgs",
    "buildLogFilter",
    "evidence",
    "selectedEntry",
    "redact",
  ])
    assert.equal(typeof core[name], "function", name);
  const validated = core.validateConfig(config);
  const query = core.queryArgs(
    {
      mode: "discover",
      start: "2026-10-20T18:00:00.073712Z",
      end: "2026-10-20T18:01:00.073712Z",
      insertIds: ["seed-a"],
    },
    validated,
  );
  assert.equal(
    core.buildLogFilter(query, validated),
    'logName =~ "^projects/example-prd/logs/" AND (resource.type="cloud_run_revision" OR resource.type="k8s_container") AND timestamp>="2026-10-20T18:00:00.073712Z" AND timestamp<="2026-10-20T18:01:00.073712Z" AND ((insertId="seed-a"))',
  );
  const details = core.evidence(
    success([{ insertId: "seed-a", textPayload: "token=SYNTHETIC_SECRET" }]),
    query,
    validated,
  );
  assert.deepEqual(details.truncationReasons, []);
  assert.equal(details.truncated, false);
  assert.equal(details.processedRows, 1);
  assert.equal(details.returnedRows, 1);
  assert.equal(details.invalidRows, 0);
  assert.ok(!JSON.stringify(details).includes("SYNTHETIC_SECRET"));
});
