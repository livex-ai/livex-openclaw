import assert from "node:assert/strict";
import { test } from "node:test";
import { collectGkeServingImages, createGkeReaders } from "./read-gke-serving-images.mjs";

const project = "livex-copilot-prd";
const region = "us-central1";
const zone = region + "-a";
const host = "gke-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-123456789012.us-central1.gke.goog";
const compute = "https://www.googleapis.com/compute/v1/projects/" + project;
const clusterLink =
  "https://container.googleapis.com/v1/projects/" +
  project +
  "/locations/" +
  region +
  "/clusters/copilot-prd-cluster";
const digest = "sha256:" + "a".repeat(64);
const otherDigest = "sha256:" + "b".repeat(64);
const commit = "c".repeat(40);
const webBackend = "copilot-chat-backend-gke";
const avatarBackend = "copilot-chat-avatar-backend-gke";

function metadata(name, namespace, ownerReferences = []) {
  return { name, namespace, uid: name + "-uid", ownerReferences };
}

function owner(apiVersion, kind, name) {
  return { apiVersion, kind, name, uid: name + "-uid", controller: true };
}

function backendLink(name) {
  return compute + "/global/backendServices/" + name;
}

function routeMap() {
  return {
    name: "copilot-lb",
    selfLink: compute + "/global/urlMaps/copilot-lb",
    hostRules: [
      { hosts: ["chat.copilot.livex.ai"], pathMatcher: "web" },
      {
        hosts: ["chat-avatar.copilot.livex.ai", "chat-avatar.agent.livex.ai"],
        pathMatcher: "avatar",
      },
    ],
    pathMatchers: [
      {
        name: "web",
        pathRules: [
          {
            paths: ["/api/*"],
            routeAction: {
              weightedBackendServices: [
                { backendService: backendLink(webBackend), weight: 100 },
                { backendService: backendLink("copilot-chat-backend-cloudrun") },
              ],
            },
          },
        ],
      },
      { name: "avatar", defaultService: backendLink(avatarBackend) },
    ],
  };
}

function workload(name) {
  const backend = name === "chat-engine" ? webBackend : avatarBackend;
  const image =
    name === "conversation-avatar"
      ? "copilot-conversation-akool"
      : name === "conversation-agent"
        ? "copilot-conversation-agent"
        : "copilot-chat-engine";
  const container = name.startsWith("chat-engine") ? "chat-engine" : name;
  const pod = name + "-pod";
  const replicaSet = name + "-replica";
  const ip = name === "chat-engine-avatar" ? "10.0.1.2" : "10.0.1.1";
  const serviceMetadata = metadata(name, name);
  serviceMetadata.annotations = {
    "cloud.google.com/neg-status": JSON.stringify({
      network_endpoint_groups: { 80: backend },
      zones: [zone],
    }),
  };
  return {
    deployment: { metadata: metadata(name, name), status: { readyReplicas: 1 } },
    service: {
      metadata: serviceMetadata,
      spec: { ports: [{ name: "http", protocol: "TCP", port: 80, targetPort: 8080 }] },
    },
    replicasets: [{ metadata: metadata(replicaSet, name, [owner("apps/v1", "Deployment", name)]) }],
    pods: [
      {
        metadata: metadata(pod, name, [owner("apps/v1", "ReplicaSet", replicaSet)]),
        spec: { nodeName: "node-1" },
        status: {
          phase: "Running",
          podIP: ip,
          conditions: [{ type: "Ready", status: "True" }],
          containerStatuses: [
            {
              name: container,
              ready: true,
              imageID: region + "-docker.pkg.dev/" + project + "/copilot/" + image + "@" + digest,
            },
          ],
        },
      },
    ],
    endpointslices: [
      {
        metadata: {
          ...metadata(name + "-slice", name, [owner("v1", "Service", name)]),
          labels: { "kubernetes.io/service-name": name },
        },
        addressType: "IPv4",
        ports: [{ name: "http", port: 8080, protocol: "TCP" }],
        endpoints: [
          {
            addresses: [ip],
            conditions: { ready: true, serving: true, terminating: false },
            targetRef: { kind: "Pod", namespace: name, name: pod, uid: pod + "-uid" },
            nodeName: "node-1",
            zone,
          },
        ],
      },
    ],
    health: [
      {
        backend: compute + "/zones/" + zone + "/networkEndpointGroups/" + backend,
        status: {
          healthStatus: [
            {
              healthState: "HEALTHY",
              ipAddress: ip,
              port: 8080,
              instance: compute + "/zones/" + zone + "/instances/node-1",
            },
          ],
        },
      },
    ],
  };
}

function fixtures() {
  const state = Object.fromEntries(
    ["chat-engine", "chat-engine-avatar", "conversation-agent", "conversation-avatar"].map(
      (name) => [name, workload(name)],
    ),
  );
  const readers = {
    readRouteMap: async () => routeMap(),
    readBackend: async (name) =>
      state[name === webBackend ? "chat-engine" : "chat-engine-avatar"].health,
    readObject: async (namespace, kind) => state[namespace][kind],
    listObjects: async (namespace, kind) => state[namespace][kind],
    readImageCommit: async () => commit,
  };
  return { state, readers };
}

test("verifies the two agreeing engine routes and both Deployment-owned worker images", async () => {
  const { readers } = fixtures();
  const result = await collectGkeServingImages({}, readers);
  assert.deepEqual(
    result.paths.map(({ service, source, status, digest: image, commit: sha, workloads }) => [
      service,
      source,
      status,
      image,
      sha,
      workloads,
    ]),
    [
      ["chat-engine", "gke", "verified", digest, commit, ["chat-engine", "chat-engine-avatar"]],
      ["conversation-agent", "gke", "verified", digest, commit, ["conversation-agent"]],
      ["conversation-avatar", "gke", "verified", digest, commit, ["conversation-avatar"]],
    ],
  );
  assert.ok(
    result.paths.every(
      (path) =>
        path.environment === "prd" &&
        Date.parse(path.observedAt) >= Date.parse(result.captureStartedAt),
    ),
  );
  assert.equal((await collectGkeServingImages({ environment: "stg" }, readers)).paths.length, 0);
});

test("fails closed on split routing, foreign endpoints, and mixed engine images", async () => {
  for (const issue of ["split", "foreign", "mixed"]) {
    const { state, readers } = fixtures();
    if (issue === "split") {
      readers.readRouteMap = async () => {
        const map = routeMap();
        map.pathMatchers[0].pathRules[0].routeAction.weightedBackendServices[1].weight = 1;
        return map;
      };
    } else if (issue === "foreign") {
      state["chat-engine"].endpointslices[0].endpoints[0].targetRef.uid = "unrelated-pod";
    } else {
      const image = state["chat-engine-avatar"].pods[0].status.containerStatuses[0];
      image.imageID = image.imageID.replace(digest, otherDigest);
    }
    const result = await collectGkeServingImages({ service: "chat-engine" }, readers);
    assert.equal(result.paths[0].status, "unresolved", issue);
    assert.equal(result.paths[0].digest, undefined, issue);
  }
});

test("does not accept unready, foreign-owned, or deleting workers", async () => {
  for (const issue of ["unready", "foreign", "deleting"]) {
    const { state, readers } = fixtures();
    const worker = state["conversation-agent"].pods[0];
    if (issue === "unready") {
      worker.status.containerStatuses[0].ready = false;
    } else if (issue === "foreign") {
      worker.metadata.ownerReferences[0].uid = "unrelated-replica";
    } else {
      worker.metadata.deletionTimestamp = "2026-11-09T00:00:00Z";
    }
    const result = await collectGkeServingImages({ service: "conversation-agent" }, readers);
    assert.equal(result.paths[0].status, "unresolved", issue);
    assert.equal(result.paths[0].digest, undefined, issue);
  }
});

test("timestamps unresolved initial and terminal GKE observations", async () => {
  for (const terminal of [false, true]) {
    const { readers } = fixtures();
    const readObject = readers.readObject;
    let unavailable = !terminal;
    readers.readObject = async (...args) => {
      if (unavailable) {
        throw new Error("private read error");
      }
      return readObject(...args);
    };
    readers.readImageCommit = async () => {
      unavailable = true;
      return commit;
    };
    const result = await collectGkeServingImages({ service: "conversation-agent" }, readers);
    const row = result.paths[0];
    assert.equal(row.status, "unresolved");
    assert.equal(row.reason, "gke-read-unavailable");
    assert.ok(Date.parse(result.captureStartedAt) <= Date.parse(row.observedAt));
    assert.ok(Date.parse(row.observedAt) <= Date.parse(result.capturedAt));
    assert.doesNotMatch(JSON.stringify(row), /private read error/);
  }
});

test("keeps empty zones in backend health evidence", async () => {
  const { state, readers } = fixtures();
  const engine = state["chat-engine"];
  const annotation = JSON.parse(engine.service.metadata.annotations["cloud.google.com/neg-status"]);
  const emptyZone = region + "-b";
  annotation.zones.push(emptyZone);
  engine.service.metadata.annotations["cloud.google.com/neg-status"] = JSON.stringify(annotation);
  const emptyGroup = {
    backend: compute + "/zones/" + emptyZone + "/networkEndpointGroups/" + webBackend,
    status: {},
  };
  const cloud = createGkeReaders({
    async runGcloud(args) {
      // Projecting status.healthStatus drops the empty group from gcloud output.
      return JSON.stringify(
        args.includes("--format=json(backend,status.healthStatus)")
          ? engine.health
          : [...engine.health, emptyGroup],
      );
    },
  });
  const readBackend = readers.readBackend;
  readers.readBackend = (backend) =>
    backend === webBackend ? cloud.readBackend(backend) : readBackend(backend);
  const result = await collectGkeServingImages({ service: "chat-engine" }, readers);
  assert.equal(result.paths[0].status, "verified");
});

test("invalidates initial digest evidence when ready worker evidence changes on recheck", async () => {
  const { state, readers } = fixtures();
  readers.readImageCommit = async () => {
    const image = state["conversation-avatar"].pods[0].status.containerStatuses[0];
    image.imageID = image.imageID.replace(digest, otherDigest);
    return commit;
  };
  const result = await collectGkeServingImages({ service: "conversation-avatar" }, readers);
  assert.equal(result.paths[0].reason, "gke-evidence-changed");
  assert.equal(result.paths[0].digest, undefined);
});

function cluster(endpoint = host) {
  return {
    name: "copilot-prd-cluster",
    location: region,
    selfLink: clusterLink,
    controlPlaneEndpointsConfig: { dnsEndpointConfig: { endpoint } },
  };
}

test("refuses credentials and HTTPS reads for an untrusted DNS endpoint", async () => {
  let tokenRequests = 0;
  let requests = 0;
  const readers = createGkeReaders({
    runGcloud: async (args) => {
      if (args[0] === "auth") {
        tokenRequests += 1;
      }
      return JSON.stringify(cluster("another.us-central1.gke.goog"));
    },
    fetchKubernetes: async () => {
      requests += 1;
      throw new Error("unexpected credential use");
    },
  });
  const result = await collectGkeServingImages({ service: "conversation-agent" }, readers);
  assert.equal(result.paths[0].status, "unresolved");
  assert.equal(tokenRequests, 0);
  assert.equal(requests, 0);
});

test("uses fixed authenticated GETs and rejects inconsistent list pagination", async () => {
  const urls = [];
  const readers = createGkeReaders({
    runGcloud: async (args) => (args[0] === "auth" ? "synthetic-token" : JSON.stringify(cluster())),
    fetchKubernetes: async (url, options) => {
      urls.push(url);
      assert.ok(url.startsWith("https://" + host + "/"));
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer synthetic-token");
      const path = new URL(url);
      return Response.json({
        metadata: path.searchParams.has("continue")
          ? { resourceVersion: "2" }
          : { resourceVersion: "1", continue: "../continuation" },
        items: [],
      });
    },
  });
  await assert.rejects(readers.listObjects("conversation-agent", "pods"), /incomplete/);
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[1]).pathname, "/api/v1/namespaces/conversation-agent/pods");
  assert.equal(new URL(urls[1]).searchParams.get("continue"), "../continuation");
});
