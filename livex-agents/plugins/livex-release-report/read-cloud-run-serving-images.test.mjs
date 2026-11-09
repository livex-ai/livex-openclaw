import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { runCapture } from "./capture.mjs";
import {
  collectCloudRunServingImages,
  createCloudRunReaders,
} from "./read-cloud-run-serving-images.mjs";

const digest = "sha256:" + "a".repeat(64);
const commit = "b".repeat(40);

function routes(...entries) {
  return { status: { traffic: entries } };
}

function traffic(revisionName, percent = 100) {
  return { revisionName, percent };
}

function fixtureReaders(overrides = {}) {
  return {
    async readService(target) {
      const revision = target.cloudRunService + "-00001-xyz";
      return routes(
        { revisionName: target.cloudRunService + "-00000-xyz", tag: "pilot" },
        traffic(revision),
      );
    },
    async readRevision(target, revision) {
      const imageDigest = target.imagePrefix + "@" + digest;
      return { metadata: { name: revision }, status: { imageDigest } };
    },
    async readImageCommit() {
      return commit;
    },
    ...overrides,
  };
}

test("keeps equal Scheduler digests across environments and ignores a leading zero-traffic tag", async () => {
  const result = await collectCloudRunServingImages({ service: "scheduler" }, fixtureReaders());
  assert.deepEqual(
    result.paths.map(({ environment, status, revision, digest: imageDigest, commit: sha }) => [
      environment,
      status,
      revision,
      imageDigest,
      sha,
    ]),
    ["dev", "stg", "prd"].map((environment) => [
      environment,
      "verified",
      "copilot-scheduler-00001-xyz",
      digest,
      commit,
    ]),
  );
  for (const path of result.paths) {
    assert.ok(Date.parse(result.captureStartedAt) <= Date.parse(path.observedAt));
    assert.ok(Date.parse(path.observedAt) <= Date.parse(result.capturedAt));
  }
});

test("enumerates the fleet and reserves the three GKE-backed production paths", async () => {
  const seen = [];
  const readers = fixtureReaders();
  const result = await collectCloudRunServingImages(
    {},
    {
      ...readers,
      async readService(target) {
        seen.push([target.environment, target.cloudRunService]);
        return readers.readService(target);
      },
    },
  );
  assert.equal(result.paths.length, 24);
  assert.equal(seen.length, 42);
  assert.ok(
    seen.some(
      ([environment, service]) =>
        environment === "dev" && service === "copilot-cloudrun-doc-processor-v2",
    ),
  );
  assert.deepEqual(
    result.paths
      .filter((path) => path.status === "gke-pending")
      .map(({ environment, service }) => [environment, service]),
    [
      ["prd", "chat-engine"],
      ["prd", "conversation-agent"],
      ["prd", "conversation-avatar"],
    ],
  );
  assert.equal(
    result.paths.find((path) => path.service === "conversation-avatar").repo,
    "conversation-agent",
  );
});

test("rejects split and changed traffic before emitting exact evidence", async () => {
  const options = { service: "gateway", environment: "stg" };
  const split = await collectCloudRunServingImages(
    options,
    fixtureReaders({
      async readService() {
        return routes(
          traffic("copilot-api-gateway-00001-xyz", 80),
          traffic("copilot-api-gateway-00002-xyz", 20),
        );
      },
      async readRevision() {
        assert.fail("split traffic must not select a revision");
      },
    }),
  );
  assert.deepEqual([split.paths[0].status, split.paths[0].reason], ["unresolved", "split-traffic"]);

  let count = 0;
  const changed = await collectCloudRunServingImages(
    options,
    fixtureReaders({
      async readService() {
        count += 1;
        return routes(traffic("copilot-api-gateway-0000" + count + "-xyz"));
      },
    }),
  );
  assert.deepEqual(
    [changed.paths[0].status, changed.paths[0].reason],
    ["unresolved", "traffic-changed"],
  );
  assert.equal(changed.paths[0].digest, undefined);
  assert.equal(changed.paths[0].commit, undefined);
});

test("rechecks every serving route after collecting initial fleet evidence", async () => {
  let productionCollected = false;
  const reads = new Map();
  const baseline = fixtureReaders();
  const result = await collectCloudRunServingImages(
    {},
    fixtureReaders({
      async readService(target) {
        const key = target.service + ":" + target.environment;
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        if (key === "chatbox:stg" && count === 2 && productionCollected) {
          return routes(traffic("chatbox-00002-xyz"));
        }
        return baseline.readService(target);
      },
      async readImageCommit(target) {
        if (target.service === "scheduler" && target.environment === "prd") {
          productionCollected = true;
        }
        return commit;
      },
    }),
  );
  const stg = result.paths.find((path) => path.service === "chatbox" && path.environment === "stg");
  assert.equal(stg.reason, "traffic-changed");
  assert.equal(stg.digest, undefined);
});

test("accepts traffic entries sharing one revision when their percentages total 100", async () => {
  const revision = "copilot-api-gateway-00001-xyz";
  const result = await collectCloudRunServingImages(
    { service: "gateway", environment: "stg" },
    fixtureReaders({
      async readService() {
        return routes(traffic(revision, 60), { ...traffic(revision, 40), tag: "candidate" });
      },
    }),
  );
  assert.equal(result.paths[0].status, "verified");
  assert.equal(result.paths[0].revision, revision);
});

test("preserves a stable digest when Git metadata is missing and sanitizes denied reads", async () => {
  const options = { service: "gateway", environment: "stg" };
  const missing = await collectCloudRunServingImages(
    options,
    fixtureReaders({
      async readImageCommit() {
        return null;
      },
    }),
  );
  assert.equal(missing.paths[0].status, "verified");
  assert.equal(missing.paths[0].digest, digest);
  assert.equal(missing.paths[0].commit, null);
  assert.equal(missing.paths[0].commitReason, "image-commit-missing");

  const denied = await collectCloudRunServingImages(
    options,
    fixtureReaders({
      async readService() {
        throw new Error("Permission denied: private identity and credential");
      },
    }),
  );
  assert.equal(denied.paths[0].reason, "service-unavailable");
  assert.doesNotMatch(JSON.stringify(denied), /private identity|credential/);
});

test("rejects unrelated revision names and cross-repository image references", async () => {
  const options = { service: "scheduler", environment: "stg" };
  const unrelated = await collectCloudRunServingImages(
    options,
    fixtureReaders({
      async readService() {
        return routes(traffic("other-service-00001-xyz"));
      },
      async readRevision() {
        assert.fail("unrelated revision must not be queried");
      },
    }),
  );
  assert.equal(unrelated.paths[0].reason, "invalid-traffic");
  const crossRepo = await collectCloudRunServingImages(
    options,
    fixtureReaders({
      async readRevision(_target, revision) {
        return {
          metadata: { name: revision },
          status: { imageDigest: "other.invalid/repo@" + digest },
        };
      },
      async readImageCommit() {
        assert.fail("unapproved registry must not receive a token");
      },
    }),
  );
  assert.equal(crossRepo.paths[0].reason, "unexpected-image");
});

test("CLI selects a canary and rejects arbitrary targets without collecting", async () => {
  const output = [];
  const errors = [];
  const io = { output: (line) => output.push(line), error: (line) => errors.push(line) };
  assert.equal(
    await runCapture(["--service", "scheduler", "--environment", "stg"], io, fixtureReaders()),
    0,
  );
  assert.equal(JSON.parse(output[0]).paths[0].environment, "stg");
  assert.equal(JSON.parse(output[0]).paths.length, 1);
  assert.equal(
    await runCapture(["--service", "https://other.invalid"], io, {
      async readService() {
        assert.fail("invalid options must not call gcloud");
      },
    }),
    2,
  );
  assert.equal(errors.length, 1);
});

function registryDocument(value) {
  const body = JSON.stringify(value);
  return { body, digest: "sha256:" + createHash("sha256").update(body).digest("hex") };
}

test("production readers resolve only digest-verified OCI metadata", async () => {
  const config = registryDocument({
    config: { Env: ["UNRELATED=private-data", "COMMIT_ID=" + commit] },
  });
  const manifest = registryDocument({ config: { digest: config.digest } });
  const amd64Index = registryDocument({
    manifests: [{ digest: manifest.digest, platform: { os: "linux", architecture: "amd64" } }],
  });
  const documents = new Map([amd64Index, manifest, config].map((doc) => [doc.digest, doc.body]));
  const urls = [];
  const commands = [];
  const registry = "us-central1-docker.pkg.dev/livex-copilot-stg/copilot/copilot-scheduler";
  const revision = "copilot-scheduler-00001-xyz";
  const readers = createCloudRunReaders({
    async runGcloud(args) {
      commands.push(args);
      if (args[0] === "auth") {
        return "credential";
      }
      if (args[1] === "services") {
        return JSON.stringify(routes(traffic(revision)));
      }
      return JSON.stringify({
        metadata: { name: revision },
        status: { imageDigest: registry + "@" + amd64Index.digest },
      });
    },
    async fetchRegistry(url, options) {
      urls.push(url);
      assert.match(
        url,
        /^https:\/\/us-central1-docker\.pkg\.dev\/v2\/livex-copilot-stg\/copilot\/copilot-scheduler\//,
      );
      assert.equal(options.redirect, url.includes("/blobs/") ? "manual" : "error");
      assert.equal(options.headers.Authorization, "Bearer credential");
      return new Response(documents.get(url.split("/").at(-1)));
    },
  });
  const result = await collectCloudRunServingImages(
    { service: "scheduler", environment: "stg" },
    readers,
  );
  assert.equal(result.paths[0].commit, commit);
  assert.equal(result.paths[0].commitSource, "artifact-registry-config");
  assert.equal(urls.length, 3);
  assert.equal(commands.filter((args) => args[1] === "services").length, 2);
  assert.doesNotMatch(JSON.stringify(result), /private-data|credential/);
  documents.set(
    config.digest,
    JSON.stringify({ config: { Env: ["COMMIT_ID=" + "c".repeat(40)] } }),
  );
  const mismatched = await collectCloudRunServingImages(
    { service: "scheduler", environment: "stg" },
    readers,
  );
  assert.equal(mismatched.paths[0].digest, amd64Index.digest);
  assert.equal(mismatched.paths[0].commit, null);
  assert.equal(mismatched.paths[0].commitReason, "artifact-unavailable");
});

test("follows only a same-project Artifact Registry blob download without forwarding credentials", async () => {
  const config = registryDocument({ config: { Env: ["COMMIT_ID=" + commit] } });
  const manifest = registryDocument({ config: { digest: config.digest } });
  const registry = "us-central1-docker.pkg.dev/livex-copilot-stg/copilot/copilot-scheduler";
  const revision = "copilot-scheduler-00001-xyz";
  const path =
    "/artifacts-downloads/namespaces/livex-copilot-stg/repositories/copilot/downloads/opaque_id";
  const attempts = [];
  let location = path;
  const readers = createCloudRunReaders({
    async runGcloud(args) {
      if (args[0] === "auth") {
        return "credential";
      }
      if (args[1] === "services") {
        return JSON.stringify(routes(traffic(revision)));
      }
      return JSON.stringify({
        metadata: { name: revision },
        status: { imageDigest: registry + "@" + manifest.digest },
      });
    },
    async fetchRegistry(url, options) {
      if (url.includes("/manifests/")) {
        return new Response(manifest.body);
      }
      attempts.push({ url, options });
      if (url.includes("/blobs/")) {
        return new Response(null, { status: 302, headers: { Location: location } });
      }
      return new Response(config.body);
    },
  });
  const selection = { service: "scheduler", environment: "stg" };
  const result = await collectCloudRunServingImages(selection, readers);
  assert.equal(result.paths[0].commit, commit);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].options.redirect, "manual");
  assert.equal(attempts[0].options.headers.Authorization, "Bearer credential");
  assert.equal(attempts[1].url, "https://us-central1-docker.pkg.dev" + path);
  assert.equal(attempts[1].options.redirect, "error");
  assert.equal(attempts[1].options.headers?.Authorization, undefined);
  assert.equal(attempts[1].options.signal, attempts[0].options.signal);

  for (const invalid of [
    "https://other.invalid" + path,
    path.replace("-stg", "-prd"),
    path + "?unexpected=1",
  ]) {
    location = invalid;
    attempts.length = 0;
    const rejected = await collectCloudRunServingImages(selection, readers);
    assert.equal(attempts.length, 1);
    assert.equal(rejected.paths[0].commit, null);
    assert.equal(rejected.paths[0].commitReason, "artifact-unavailable");
  }
});
