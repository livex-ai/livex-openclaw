import { execFile } from "node:child_process";
import { isIPv4 } from "node:net";
import { promisify } from "node:util";
import { createCloudRunReaders } from "./read-cloud-run-serving-images.mjs";
import registry from "./services.json" with { type: "json" };

const { region, gke } = registry;
const project = registry.environments.prd;
const compute = "https://www.googleapis.com/compute/v1/projects/" + project;
const clusterLink =
  "https://container.googleapis.com/v1/projects/" +
  project +
  "/locations/" +
  region +
  "/clusters/" +
  gke.cluster;
const workloads = Object.values(gke.workloads).flat();
const namespaces = new Set(workloads.map(({ name }) => name));
const backends = new Set(workloads.flatMap(({ route }) => (route ? [route.backend] : [])));
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const commandTimeoutMs = 15_000;
const maxResponseBytes = 1024 * 1024;
const listLimit = 100;
const maxPages = 4;
const execFileAsync = promisify(execFile);
const routeUnverified = "gke-route-unverified";
const workloadUnverified = "gke-workload-unverified";
const mixedImages = "gke-mixed-images";
const validationReasons = new Set([routeUnverified, workloadUnverified, mixedImages]);

function requireEvidence(condition, reason) {
  if (!condition) {
    throw new Error(reason);
  }
}

function backendLink(name) {
  return compute + "/global/backendServices/" + name;
}

function validateRoute(map, route) {
  requireEvidence(
    map?.name === gke.urlMap &&
      map.selfLink === compute + "/global/urlMaps/" + gke.urlMap &&
      Array.isArray(map.hostRules) &&
      Array.isArray(map.pathMatchers),
    routeUnverified,
  );
  const destination = backendLink(route.backend);
  for (const host of route.hosts) {
    const rules = map.hostRules.filter(
      (rule) => Array.isArray(rule?.hosts) && rule.hosts.includes(host),
    );
    requireEvidence(
      rules.length === 1 && typeof rules[0].pathMatcher === "string",
      routeUnverified,
    );
    const candidates = map.pathMatchers.filter((matcher) => matcher?.name === rules[0].pathMatcher);
    requireEvidence(candidates.length === 1, routeUnverified);
    const matcher = candidates[0];
    requireEvidence(!matcher.routeRules?.length, routeUnverified);
    if (!route.path) {
      requireEvidence(
        matcher.defaultService === destination &&
          !matcher.defaultRouteAction &&
          !matcher.defaultUrlRedirect &&
          !matcher.pathRules?.length,
        routeUnverified,
      );
      continue;
    }

    const rulesForPath = matcher.pathRules;
    requireEvidence(Array.isArray(rulesForPath) && rulesForPath.length === 1, routeUnverified);
    const rule = rulesForPath[0];
    requireEvidence(
      rule?.paths?.length === 1 &&
        rule.paths[0] === route.path &&
        !rule.service &&
        !rule.urlRedirect,
      routeUnverified,
    );
    const action = rule.routeAction;
    const targets = action?.weightedBackendServices;
    requireEvidence(Array.isArray(targets) && Object.keys(action).length === 1, routeUnverified);
    const fallback = backendLink(route.inactiveBackend);
    requireEvidence(
      targets.filter((entry) => entry?.backendService === destination && entry.weight === 100)
        .length === 1 &&
        targets.every(
          (entry) =>
            (entry?.backendService === destination && entry.weight === 100) ||
            (entry?.backendService === fallback &&
              (entry.weight === undefined || entry.weight === 0)),
        ),
      routeUnverified,
    );
  }
}

function hasIdentity(object, namespace, name) {
  return (
    typeof name === "string" &&
    /^[a-z0-9][a-z0-9.-]{0,252}$/.test(name) &&
    object?.metadata?.name === name &&
    object.metadata.namespace === namespace &&
    typeof object.metadata.uid === "string" &&
    object.metadata.uid.length > 0
  );
}

function controller(object, apiVersion, kind) {
  const owners = object?.metadata?.ownerReferences;
  if (!Array.isArray(owners)) {
    return null;
  }
  const controllers = owners.filter((ref) => ref?.controller === true);
  const ref = controllers[0];
  return controllers.length === 1 && ref.apiVersion === apiVersion && ref.kind === kind
    ? ref
    : null;
}

function ownedBy(object, kind, owner) {
  const ref = controller(object, kind === "Service" ? "v1" : "apps/v1", kind);
  return ref?.name === owner.metadata.name && ref.uid === owner.metadata.uid;
}

function isReady(pod) {
  return (
    !pod?.metadata?.deletionTimestamp &&
    pod?.status?.phase === "Running" &&
    Array.isArray(pod.status.conditions) &&
    pod.status.conditions.some(
      (condition) => condition?.type === "Ready" && condition.status === "True",
    )
  );
}

function readyPods(deployment, replicasets, pods, target, imagePrefix) {
  const name = target.name;
  requireEvidence(
    hasIdentity(deployment, name, name) &&
      !deployment.metadata.deletionTimestamp &&
      Array.isArray(replicasets) &&
      Array.isArray(pods),
    workloadUnverified,
  );
  const replicas = new Map();
  for (const replica of replicasets) {
    if (
      hasIdentity(replica, name, replica?.metadata?.name) &&
      !replica.metadata.deletionTimestamp &&
      ownedBy(replica, "Deployment", deployment)
    ) {
      replicas.set(replica.metadata.uid, replica);
    }
  }
  const ready = new Map();
  for (const pod of pods) {
    const replica = replicas.get(controller(pod, "apps/v1", "ReplicaSet")?.uid);
    if (!replica || !ownedBy(pod, "ReplicaSet", replica) || !isReady(pod)) {
      continue;
    }
    requireEvidence(
      hasIdentity(pod, name, pod?.metadata?.name) && !ready.has(pod.metadata.uid),
      workloadUnverified,
    );
    const containers = pod.status.containerStatuses?.filter(
      (container) => container?.name === target.container,
    );
    const image = containers?.[0]?.imageID;
    const prefix = imagePrefix + "@";
    const digest =
      typeof image === "string" && image.startsWith(prefix) ? image.slice(prefix.length) : null;
    requireEvidence(
      containers?.length === 1 && containers[0].ready === true && digestPattern.test(digest ?? ""),
      workloadUnverified,
    );
    ready.set(pod.metadata.uid, { pod, digest, replica: replica.metadata.uid });
  }
  requireEvidence(
    ready.size > 0 && ready.size === deployment.status?.readyReplicas,
    workloadUnverified,
  );
  return ready;
}

function endpointKey(zone, ip, port, node) {
  requireEvidence(
    typeof zone === "string" &&
      isIPv4(ip) &&
      port === 8080 &&
      typeof node === "string" &&
      /^[a-z0-9-]+$/.test(node),
    routeUnverified,
  );
  return [zone, ip, port, node].join("/");
}

function healthyEndpoints(groups, backend, zones) {
  requireEvidence(Array.isArray(groups) && groups.length === zones.size, routeUnverified);
  const endpoints = new Set();
  const seenZones = new Set();
  for (const group of groups) {
    const zone = [...zones].find(
      (item) => group?.backend === compute + "/zones/" + item + "/networkEndpointGroups/" + backend,
    );
    requireEvidence(zone && !seenZones.has(zone), routeUnverified);
    seenZones.add(zone);
    requireEvidence(
      group.status &&
        (group.status.healthStatus === undefined || Array.isArray(group.status.healthStatus)),
      routeUnverified,
    );
    for (const health of group.status.healthStatus ?? []) {
      if (health?.healthState !== "HEALTHY") {
        continue;
      }
      const prefix = compute + "/zones/" + zone + "/instances/";
      requireEvidence(
        typeof health.instance === "string" && health.instance.startsWith(prefix),
        routeUnverified,
      );
      const key = endpointKey(
        zone,
        health.ipAddress,
        health.port,
        health.instance.slice(prefix.length),
      );
      requireEvidence(!endpoints.has(key), routeUnverified);
      endpoints.add(key);
    }
  }
  return endpoints;
}

function routedPods(target, service, slices, groups, ready) {
  const name = target.name;
  const backend = target.route.backend;
  requireEvidence(
    hasIdentity(service, name, name) &&
      !service.metadata.deletionTimestamp &&
      service.spec?.publishNotReadyAddresses !== true &&
      service.spec?.ports?.some(
        (port) =>
          port?.name === "http" &&
          port.protocol === "TCP" &&
          port.port === 80 &&
          port.targetPort === 8080,
      ) &&
      Array.isArray(slices),
    routeUnverified,
  );
  let neg;
  try {
    neg = JSON.parse(service.metadata.annotations?.["cloud.google.com/neg-status"]);
  } catch {
    throw new Error(routeUnverified);
  }
  requireEvidence(
    neg?.network_endpoint_groups?.["80"] === backend &&
      Array.isArray(neg.zones) &&
      neg.zones.length > 0 &&
      neg.zones.every(
        (zone) =>
          typeof zone === "string" &&
          zone.startsWith(region + "-") &&
          /^[a-z]$/.test(zone.slice(region.length + 1)),
      ),
    routeUnverified,
  );
  const zones = new Set(neg.zones);
  requireEvidence(zones.size === neg.zones.length, routeUnverified);
  const healthy = healthyEndpoints(groups, backend, zones);
  const selected = new Map();
  for (const slice of slices) {
    requireEvidence(
      hasIdentity(slice, name, slice?.metadata?.name) &&
        !slice.metadata.deletionTimestamp &&
        slice.metadata.labels?.["kubernetes.io/service-name"] === name &&
        ownedBy(slice, "Service", service) &&
        slice.addressType === "IPv4" &&
        slice.ports?.some(
          (port) => port?.name === "http" && port.protocol === "TCP" && port.port === 8080,
        ) &&
        Array.isArray(slice.endpoints),
      routeUnverified,
    );
    for (const endpoint of slice.endpoints) {
      const conditions = endpoint?.conditions;
      if (
        conditions?.ready !== true ||
        conditions.serving !== true ||
        conditions.terminating !== false
      ) {
        continue;
      }
      const ref = endpoint.targetRef;
      const member = ready.get(ref?.uid);
      requireEvidence(
        ref?.kind === "Pod" &&
          ref.namespace === name &&
          member &&
          ref.name === member.pod.metadata.name &&
          endpoint.addresses?.length === 1 &&
          endpoint.addresses[0] === member.pod.status.podIP &&
          endpoint.nodeName === member.pod.spec?.nodeName &&
          zones.has(endpoint.zone),
        routeUnverified,
      );
      const key = endpointKey(endpoint.zone, endpoint.addresses[0], 8080, endpoint.nodeName);
      requireEvidence(healthy.has(key) && !selected.has(key), routeUnverified);
      selected.set(key, member);
    }
  }
  requireEvidence(selected.size > 0 && selected.size === healthy.size, routeUnverified);
  return selected;
}

async function readWorkload(target, imagePrefix, routeMap, readers) {
  const name = target.name;
  if (target.route) {
    validateRoute(routeMap, target.route);
  }
  const [deployment, replicasets, pods, service, slices, groups] = await Promise.all([
    readers.readObject(name, "deployment"),
    readers.listObjects(name, "replicasets"),
    readers.listObjects(name, "pods"),
    target.route ? readers.readObject(name, "service") : null,
    target.route ? readers.listObjects(name, "endpointslices") : null,
    target.route ? readers.readBackend(target.route.backend) : null,
  ]);
  const ready = readyPods(deployment, replicasets, pods, target, imagePrefix);
  const selected = target.route ? routedPods(target, service, slices, groups, ready) : ready;
  const members = [];
  const digests = new Set();
  for (const [key, { pod, digest, replica }] of selected) {
    digests.add(digest);
    members.push([key, pod.metadata.uid, replica, digest].join("/"));
  }
  requireEvidence(digests.size === 1, mixedImages);
  return {
    digest: [...digests][0],
    identity: [deployment.metadata.uid, service?.metadata.uid, ...members.toSorted()],
  };
}

async function readSnapshot(services, readers) {
  let routeMap;
  if (services.includes("chat-engine")) {
    try {
      routeMap = await readers.readRouteMap();
    } catch {
      // A URL-map read failure leaves worker evidence independent.
    }
  }
  return Promise.all(
    services.map(async (service) => {
      const entry = registry.services[service];
      const targets = gke.workloads[service];
      const imagePrefix =
        region + "-docker.pkg.dev/" + project + "/copilot/" + (entry.artifact ?? entry.cloudRun);
      try {
        const evidence = await Promise.all(
          targets.map((target) => readWorkload(target, imagePrefix, routeMap, readers)),
        );
        const digest = evidence[0].digest;
        requireEvidence(
          evidence.every((row) => row.digest === digest),
          mixedImages,
        );
        return {
          digest,
          imagePrefix,
          identity: JSON.stringify(evidence),
          observedAt: new Date().toISOString(),
        };
      } catch (error) {
        return {
          reason: validationReasons.has(error?.message) ? error.message : "gke-read-unavailable",
          observedAt: new Date().toISOString(),
        };
      }
    }),
  );
}

async function commitEvidence(candidate, readers) {
  try {
    const commit = await readers.readImageCommit(
      { project, imagePrefix: candidate.imagePrefix },
      candidate.digest,
    );
    if (typeof commit === "string" && shaPattern.test(commit)) {
      return { commit, commitSource: "artifact-registry-config" };
    }
    return { commit: null, commitReason: "image-commit-missing" };
  } catch {
    return { commit: null, commitReason: "artifact-unavailable" };
  }
}

export async function collectGkeServingImages(
  { service, environment } = {},
  readers = createGkeReaders(),
) {
  const captureStartedAt = new Date().toISOString();
  const selected =
    environment === undefined || environment === "prd"
      ? Object.keys(gke.workloads).filter((id) => service === undefined || service === id)
      : [];
  const initial = await readSnapshot(selected, readers);
  const commits = await Promise.all(
    initial.map((candidate) => (candidate.digest ? commitEvidence(candidate, readers) : null)),
  );
  const recheckServices = selected.filter((_, index) => initial[index].digest);
  const rechecked = await readSnapshot(recheckServices, readers);
  const final = new Map(recheckServices.map((id, index) => [id, rechecked[index]]));
  const capturedAt = new Date().toISOString();
  const paths = selected.map((id, index) => {
    const candidate = initial[index];
    const latest = final.get(id);
    const path = {
      service: id,
      repo: registry.services[id].repo,
      environment: "prd",
      project,
      region,
      cloudRunService: registry.services[id].cloudRun,
      source: "gke",
      workloads: gke.workloads[id].map(({ name }) => name),
      observedAt: latest?.observedAt ?? candidate.observedAt,
    };
    if (candidate.digest && latest?.identity === candidate.identity) {
      return Object.assign(path, { status: "verified", digest: candidate.digest }, commits[index]);
    }
    return Object.assign(path, {
      status: "unresolved",
      reason: candidate.reason ?? latest?.reason ?? "gke-evidence-changed",
    });
  });
  return { captureStartedAt, capturedAt, paths };
}

async function gcloud(args) {
  const { stdout } = await execFileAsync("gcloud", [...args, "--quiet"], {
    encoding: "utf8",
    maxBuffer: maxResponseBytes,
    timeout: commandTimeoutMs,
  });
  return stdout;
}

async function readJson(response) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Kubernetes response unavailable");
  }
  const stream = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await stream.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) {
        await stream.cancel();
        throw new Error("Kubernetes response too large");
      }
      chunks.push(value);
    }
  } finally {
    stream.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}

const api = {
  deployment: ["/apis/apps/v1", "deployments"],
  replicasets: ["/apis/apps/v1", "replicasets"],
  pods: ["/api/v1", "pods"],
  service: ["/api/v1", "services"],
  endpointslices: ["/apis/discovery.k8s.io/v1", "endpointslices"],
};

function resourcePath(namespace, kind) {
  requireEvidence(
    namespaces.has(namespace) && Object.hasOwn(api, kind),
    "Kubernetes resource outside registry",
  );
  const [prefix, resource] = api[kind];
  return prefix + "/namespaces/" + namespace + "/" + resource;
}

export function createGkeReaders({
  runGcloud = gcloud,
  fetchKubernetes = fetch,
  readImageCommit = createCloudRunReaders({ runGcloud }).readImageCommit,
} = {}) {
  let authority;
  async function authorize() {
    const cluster = JSON.parse(
      await runGcloud([
        "container",
        "clusters",
        "describe",
        gke.cluster,
        "--project",
        project,
        "--region",
        region,
        "--format=json(name,selfLink,location,controlPlaneEndpointsConfig.dnsEndpointConfig.endpoint)",
      ]),
    );
    const endpoint = cluster?.controlPlaneEndpointsConfig?.dnsEndpointConfig?.endpoint;
    const suffix = "." + region + ".gke.goog";
    requireEvidence(
      cluster?.name === gke.cluster &&
        cluster.selfLink === clusterLink &&
        cluster.location === region &&
        typeof endpoint === "string" &&
        endpoint.endsWith(suffix) &&
        /^gke-[a-f0-9]{32,64}-[0-9]{1,15}$/.test(endpoint.slice(0, -suffix.length)),
      "Kubernetes cluster authority mismatch",
    );
    const token = (await runGcloud(["auth", "print-access-token"])).trim();
    requireEvidence(/^[!-~]{1,4096}$/.test(token), "Kubernetes credential unavailable");
    return { origin: "https://" + endpoint, token };
  }
  async function get(path, signal) {
    authority ??= authorize();
    const { origin, token } = await authority;
    signal.throwIfAborted();
    return readJson(
      await fetchKubernetes(origin + path, {
        method: "GET",
        redirect: "error",
        headers: { Authorization: "Bearer " + token, Accept: "application/json" },
        signal,
      }),
    );
  }

  return {
    async readRouteMap() {
      return JSON.parse(
        await runGcloud([
          "compute",
          "url-maps",
          "describe",
          gke.urlMap,
          "--project",
          project,
          "--global",
          "--format=json(name,selfLink,hostRules,pathMatchers)",
        ]),
      );
    },
    async readBackend(backend) {
      requireEvidence(backends.has(backend), "GKE backend outside registry");
      return JSON.parse(
        await runGcloud([
          "compute",
          "backend-services",
          "get-health",
          backend,
          "--project",
          project,
          "--global",
          // Keep the whole status object so gcloud preserves zones with no endpoints.
          "--format=json(backend,status)",
        ]),
      );
    },
    async readObject(namespace, kind) {
      requireEvidence(kind === "deployment" || kind === "service", "Unknown Kubernetes object");
      return get(
        resourcePath(namespace, kind) + "/" + namespace,
        AbortSignal.timeout(commandTimeoutMs),
      );
    },
    async listObjects(namespace, kind) {
      requireEvidence(
        kind === "pods" || kind === "replicasets" || kind === "endpointslices",
        "Unknown Kubernetes list",
      );
      const resource = resourcePath(namespace, kind);
      const signal = AbortSignal.timeout(commandTimeoutMs);
      const params = new URLSearchParams({ limit: String(listLimit) });
      if (kind === "endpointslices") {
        params.set("labelSelector", "kubernetes.io/service-name=" + namespace);
      }
      const items = [];
      const seen = new Set();
      let resourceVersion;
      for (let page = 0; page < maxPages; page += 1) {
        const data = await get(resource + "?" + params, signal);
        const version = data?.metadata?.resourceVersion;
        const next = data?.metadata?.continue ?? "";
        resourceVersion ??= version;
        requireEvidence(
          typeof version === "string" &&
            version.length > 0 &&
            version === resourceVersion &&
            typeof next === "string" &&
            next.length <= 4096 &&
            Array.isArray(data.items) &&
            data.items.length <= listLimit,
          "Kubernetes list pagination incomplete",
        );
        items.push(...data.items);
        if (!next) {
          return items;
        }
        requireEvidence(!seen.has(next), "Kubernetes list pagination incomplete");
        seen.add(next);
        params.set("continue", next);
      }
      throw new Error("Kubernetes list pagination incomplete");
    },
    readImageCommit,
  };
}
