import type {
  CapturedSource,
  CoverageRecord,
  DocumentSection,
  EvidenceRef,
  LensComponent,
  LensConnection,
  LensGraph,
  LensVersion,
  ProjectEnvironmentOption,
  ProjectSummary,
  ProjectInventory,
  SourceAnchor,
} from "../model.js";

/**
 * A deliberately opt-in fixture for W03 visual verification. It is imported
 * only by the separate development fixture entry; provider output and normal
 * project discovery never use this module.
 */
export const w03FixtureProject: ProjectSummary = {
  id: "fixture-w03-project",
  name: "W03 controlled component flow",
  kind: "standard",
};

export const w03FixtureEnvironment: ProjectEnvironmentOption = {
  id: "fixture-w03-environment",
  projectId: w03FixtureProject.id,
  name: "Controlled diagram fixture",
  branchName: "fixture/w03-rework-01",
  path: "/synthetic/project-lens/w03-rework-01",
  hostId: "fixture-w03-host",
  hostName: "Synthetic fixture host",
  hostStatus: "connected",
  status: "ready",
  workspaceProvisionType: "unmanaged",
  hasSavedLens: true,
};

const createdAt = Date.UTC(2026, 8, 8, 8, 30);
const projectId = w03FixtureProject.id;
const environmentId = w03FixtureEnvironment.id;
const hostId = w03FixtureEnvironment.hostId ?? "fixture-w03-host";

function digest(seed: string): string {
  return seed.replace(/[^a-f0-9]/gi, "a").toLowerCase().padEnd(64, "0").slice(0, 64);
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const codeText = {
  gateway: `export function route(request) {\n  return authenticate(request);\n}\n`,
  gatewayChanged: `export function route(request) {\n  return authenticate(request);\n  // source-only refresh for W03\n}\n`,
  orchestrator: `export function dispatch(job) {\n  return scheduler.enqueue(job);\n}\n`,
  scheduler: `export function enqueue(job) {\n  return queue.push(job);\n}\n`,
  policy: `export function authorize(job) {\n  return policy.check(job);\n}\n`,
  cache: `export function read(key) {\n  return cache.get(key);\n}\n`,
  queue: `export function publish(job) {\n  return broker.publish(job);\n}\n`,
  store: `export function write(record) {\n  return database.save(record);\n}\n`,
  telemetry: `export function record(event) {\n  return metrics.write(event);\n}\n`,
  telemetryChanged: `export function record(event) {\n  return metrics.write(event);\n  // source and explanation both changed\n}\n`,
  legacy: `export function legacyAdapter(value) {\n  return translate(value);\n}\n`,
  audit: `export function audit(event) {\n  return auditLog.append(event);\n}\n`,
  nestedIngress: `export function receive(message) {\n  return validate(message);\n}\n`,
  nestedFanout: `export function fanout(message) {\n  return workers.dispatch(message);\n}\n`,
  nestedPersist: `export function persist(message) {\n  return store.write(message);\n}\n`,
  nestedRetry: `export function retry(message) {\n  return queue.requeue(message);\n}\n`,
};

const hashes = {
  gateway: digest("a1"),
  gatewayChanged: digest("a2"),
  orchestrator: digest("b1"),
  scheduler: digest("b2"),
  policy: digest("b3"),
  cache: digest("b4"),
  queue: digest("b5"),
  store: digest("c1"),
  telemetry: digest("d1"),
  telemetryChanged: digest("d2"),
  legacy: digest("e1"),
  audit: digest("e2"),
  nestedIngress: digest("f1"),
  nestedFanout: digest("f2"),
  nestedPersist: digest("f3"),
  nestedRetry: digest("f4"),
  architecture: digest("aa"),
};

function captured(
  id: string,
  path: string,
  kind: "code" | "markdown",
  text: string,
  sha256: string,
): CapturedSource {
  return {
    id,
    path,
    kind,
    wireEncoding: "base64",
    sha256,
    sizeBytes: new TextEncoder().encode(text).byteLength,
    bytesBase64: base64(text),
    mimeType: kind === "markdown" ? "text/markdown" : "text/plain",
    modifiedAtMs: createdAt,
  };
}

const architectureText = `# Controlled component flow\n\n## Runtime boundary\nThe gateway authenticates requests before dispatch.\n\n## Internal flow\nThe orchestrator fans work out to policy, queue, and persistence.\n`;

const sourceTable = {
  gateway: captured("src-gateway", "src/gateway.ts", "code", codeText.gateway, hashes.gateway),
  gatewayChanged: captured("src-gateway", "src/gateway.ts", "code", codeText.gatewayChanged, hashes.gatewayChanged),
  orchestrator: captured("src-orchestrator", "src/orchestrator.ts", "code", codeText.orchestrator, hashes.orchestrator),
  scheduler: captured("src-scheduler", "src/scheduler.ts", "code", codeText.scheduler, hashes.scheduler),
  policy: captured("src-policy", "src/policy.ts", "code", codeText.policy, hashes.policy),
  cache: captured("src-cache", "src/cache.ts", "code", codeText.cache, hashes.cache),
  queue: captured("src-queue", "src/queue.ts", "code", codeText.queue, hashes.queue),
  store: captured("src-store", "src/store.ts", "code", codeText.store, hashes.store),
  telemetry: captured("src-telemetry", "src/telemetry.ts", "code", codeText.telemetry, hashes.telemetry),
  telemetryChanged: captured("src-telemetry", "src/telemetry.ts", "code", codeText.telemetryChanged, hashes.telemetryChanged),
  legacy: captured("src-legacy", "src/legacy.ts", "code", codeText.legacy, hashes.legacy),
  audit: captured("src-audit", "src/audit.ts", "code", codeText.audit, hashes.audit),
  nestedIngress: captured("src-ingress", "src/ingress.ts", "code", codeText.nestedIngress, hashes.nestedIngress),
  nestedFanout: captured("src-fanout", "src/fanout.ts", "code", codeText.nestedFanout, hashes.nestedFanout),
  nestedPersist: captured("src-persist", "src/persist.ts", "code", codeText.nestedPersist, hashes.nestedPersist),
  nestedRetry: captured("src-retry", "src/retry.ts", "code", codeText.nestedRetry, hashes.nestedRetry),
  architecture: captured("doc-architecture", "docs/architecture.md", "markdown", architectureText, hashes.architecture),
};

function evidence(
  source: CapturedSource,
  claim: string,
  startLine = 1,
  endLine = 2,
  sectionAnchor?: string,
): EvidenceRef {
  return {
    sourceId: source.id,
    kind: source.kind,
    path: source.path,
    claim,
    capturedSha256: source.sha256,
    startLine: source.kind === "markdown" ? null : startLine,
    endLine: source.kind === "markdown" ? null : endLine,
    ...(sectionAnchor === undefined ? {} : { sectionAnchor }),
    provenance: source.kind === "markdown" ? "declared" : "observed",
  };
}

function anchor(source: CapturedSource, startLine = 1, endLine = 2): SourceAnchor {
  return {
    sourceId: source.id,
    path: source.path,
    startLine,
    endLine,
    capturedSha256: source.sha256,
  };
}

function mapping(source: CapturedSource, componentId: string, claim: string, sectionAnchor: string): LensComponent["documentMappings"][number] {
  return {
    componentId,
    documentPath: source.path,
    sectionAnchor,
    sectionHeading: sectionAnchor === "runtime-boundary" ? "Runtime boundary" : "Internal flow",
    sourceId: source.id,
    capturedSha256: source.sha256,
    claim,
    relation: "supports",
    provenance: "declared",
  };
}

function component(input: {
  id: string;
  name: string;
  responsibility: string;
  parentId?: string | null;
  groupId: string;
  source: CapturedSource;
  architectureClaim: string;
  state?: LensComponent["state"];
  nestedFlow?: LensGraph;
  documentAnchor?: string;
}): LensComponent {
  const parentId = input.parentId ?? null;
  const sectionAnchor = input.documentAnchor ?? (parentId === null ? "runtime-boundary" : "internal-flow");
  return {
    id: input.id,
    identityKey: `w03:${input.id}`,
    name: input.name,
    responsibility: input.responsibility,
    parentId,
    groupId: input.groupId,
    provenance: "observed",
    state: input.state ?? "implemented",
    codeAnchors: [anchor(input.source)],
    documentMappings: [mapping(sourceTable.architecture, input.id, input.architectureClaim, sectionAnchor)],
    evidence: [
      evidence(input.source, input.architectureClaim),
      evidence(sourceTable.architecture, input.architectureClaim, 1, 1, sectionAnchor),
    ],
    ...(input.nestedFlow === undefined ? {} : { nestedFlow: input.nestedFlow }),
  };
}

function connection(input: {
  id: string;
  from: string;
  to: string;
  label: string;
  type?: LensConnection["type"];
  source?: CapturedSource;
}): LensConnection {
  const source = input.source ?? sourceTable.orchestrator;
  return {
    id: input.id,
    fromComponentId: input.from,
    toComponentId: input.to,
    type: input.type ?? "depends-on",
    direction: "forward",
    label: input.label,
    provenance: "inferred",
    state: "implemented",
    evidence: [evidence(source, input.label)],
  };
}

function nestedFlow(): LensGraph {
  const ingress = component({
    id: "nested-ingress",
    name: "Ingress",
    responsibility: "Validates the hand-off from the gateway",
    groupId: "edge",
    source: sourceTable.nestedIngress,
    architectureClaim: "Internal ingress validates the hand-off.",
  });
  const fanout = component({
    id: "nested-fanout",
    name: "Fanout",
    responsibility: "Dispatches work to the async lane",
    groupId: "async",
    source: sourceTable.nestedFanout,
    architectureClaim: "Internal fanout dispatches work.",
  });
  const persist = component({
    id: "nested-persist",
    name: "Persist",
    responsibility: "Writes the accepted result",
    groupId: "data",
    source: sourceTable.nestedPersist,
    architectureClaim: "Internal persistence stores the result.",
  });
  const retry = component({
    id: "nested-retry",
    name: "Retry lane",
    responsibility: "Requeues recoverable failures",
    groupId: "async",
    source: sourceTable.nestedRetry,
    architectureClaim: "Retry keeps recoverable work moving.",
  });
  return {
    components: [ingress, fanout, persist, retry],
    connections: [
      connection({ id: "nested-ingress-fanout", from: ingress.id, to: fanout.id, label: "validated message enters async lane", type: "publishes" }),
      connection({ id: "nested-fanout-persist", from: fanout.id, to: persist.id, label: "dispatches accepted result to persistence", type: "writes" }),
      connection({ id: "nested-fanout-retry", from: fanout.id, to: retry.id, label: "requeues a recoverable failure", type: "publishes" }),
      connection({ id: "nested-retry-fanout", from: retry.id, to: fanout.id, label: "retries the async dispatch", type: "depends-on" }),
    ],
  };
}

function baselineGraph(): LensGraph {
  const orchestrator = component({
    id: "orchestrator",
    name: "Orchestrator",
    responsibility: "Coordinates the request lifecycle",
    groupId: "runtime",
    source: sourceTable.orchestrator,
    architectureClaim: "The orchestrator coordinates the request lifecycle.",
    nestedFlow: nestedFlow(),
  });
  return {
    components: [
      component({ id: "gateway", name: "Edge gateway", responsibility: "Authenticates and routes requests", groupId: "boundary", source: sourceTable.gateway, architectureClaim: "The gateway authenticates requests." }),
      orchestrator,
      component({ id: "scheduler", name: "Scheduler", responsibility: "Queues work for execution", groupId: "runtime", source: sourceTable.scheduler, architectureClaim: "The scheduler queues work." }),
      component({ id: "policy", name: "Policy check", responsibility: "Applies authorization rules", groupId: "runtime", source: sourceTable.policy, architectureClaim: "Policy gates execution." }),
      component({ id: "cache", name: "Future cache", responsibility: "Holds a planned read-through cache", groupId: "runtime", source: sourceTable.cache, architectureClaim: "The planned cache holds hot reads.", state: "planned" }),
      component({ id: "store", name: "Record store", responsibility: "Persists accepted records", groupId: "data", source: sourceTable.store, architectureClaim: "The store persists accepted records." }),
      component({ id: "telemetry", name: "Telemetry", responsibility: "Records operational signals", groupId: "observability", source: sourceTable.telemetry, architectureClaim: "Telemetry records operational signals." }),
      component({ id: "legacy-adapter", name: "Legacy adapter", responsibility: "Translates the old payload shape", groupId: "data", source: sourceTable.legacy, architectureClaim: "The legacy adapter translates old payloads." }),
    ],
    connections: [
      connection({ id: "gateway-orchestrator", from: "gateway", to: "orchestrator", label: "routes authenticated requests into runtime", type: "calls", source: sourceTable.gateway }),
      connection({ id: "runtime-scheduler", from: "orchestrator", to: "scheduler", label: "dispatches scheduled work to the runtime queue", type: "publishes" }),
      connection({ id: "runtime-policy", from: "orchestrator", to: "policy", label: "checks authorization before dispatch", type: "calls" }),
      connection({ id: "runtime-cache", from: "orchestrator", to: "cache", label: "reads a warm value before the store", type: "reads" }),
      connection({ id: "runtime-store", from: "orchestrator", to: "store", label: "writes accepted records to durable storage", type: "writes" }),
      connection({ id: "runtime-telemetry", from: "orchestrator", to: "telemetry", label: "publishes lifecycle signals for operators", type: "publishes" }),
      connection({ id: "runtime-legacy", from: "orchestrator", to: "legacy-adapter", label: "translates the legacy payload before persistence", type: "depends-on" }),
    ],
  };
}

function changedGraph(): LensGraph {
  const orchestrator = component({
    id: "orchestrator",
    name: "Orchestrator",
    responsibility: "Coordinates the request lifecycle and retry policy",
    groupId: "runtime",
    source: sourceTable.orchestrator,
    architectureClaim: "The orchestrator coordinates the request lifecycle.",
    nestedFlow: nestedFlow(),
  });
  return {
    // Deliberately reordered. The viewer's scoped previous layout keeps
    // unchanged identities in their existing slots when this is selected.
    components: [
      component({ id: "store", name: "Record store", responsibility: "Persists accepted records", groupId: "storage", source: sourceTable.store, architectureClaim: "The store persists accepted records." }),
      component({ id: "result-encoder", name: "Result encoder", responsibility: "Shapes the durable result", groupId: "data", source: sourceTable.store, architectureClaim: "The encoder shapes the durable result." }),
      component({ id: "cache", name: "Future cache", responsibility: "Holds a planned cache for warmer reads", groupId: "runtime", source: sourceTable.cache, architectureClaim: "The planned cache holds hot reads.", state: "planned" }),
      component({ id: "queue-worker", name: "Queue worker", responsibility: "Consumes durable work from the broker", groupId: "runtime", source: sourceTable.queue, architectureClaim: "The worker consumes durable work." }),
      component({ id: "policy", name: "Policy check", responsibility: "Applies authorization rules", groupId: "runtime", source: sourceTable.policy, architectureClaim: "Policy gates execution." }),
      component({ id: "gateway", name: "Edge gateway", responsibility: "Authenticates and routes requests", groupId: "boundary", source: sourceTable.gatewayChanged, architectureClaim: "The gateway authenticates requests." }),
      orchestrator,
      component({ id: "scheduler", name: "Scheduler", responsibility: "Queues work for execution", groupId: "runtime", source: sourceTable.scheduler, architectureClaim: "The scheduler queues work." }),
      component({ id: "telemetry", name: "Telemetry", responsibility: "Records operational signals and correlates traces", groupId: "observability", source: sourceTable.telemetryChanged, architectureClaim: "Telemetry records operational signals." }),
      component({ id: "audit", name: "Audit trail", responsibility: "Keeps an append-only audit record", groupId: "observability", source: sourceTable.audit, architectureClaim: "Audit preserves operational history.", documentAnchor: "internal-flow" }),
    ],
    connections: [
      connection({ id: "gateway-orchestrator", from: "gateway", to: "orchestrator", label: "routes authenticated requests into runtime", type: "calls", source: sourceTable.gatewayChanged }),
      connection({ id: "runtime-scheduler", from: "orchestrator", to: "scheduler", label: "dispatches scheduled work to the runtime queue", type: "publishes" }),
      connection({ id: "runtime-policy", from: "orchestrator", to: "policy", label: "checks authorization before dispatch", type: "calls" }),
      connection({ id: "runtime-cache", from: "orchestrator", to: "cache", label: "reads a warm value before the store", type: "reads" }),
      connection({ id: "runtime-store", from: "orchestrator", to: "store", label: "writes accepted records to durable storage", type: "writes" }),
      connection({ id: "runtime-telemetry", from: "orchestrator", to: "telemetry", label: "publishes lifecycle signals for operators", type: "publishes" }),
      connection({ id: "runtime-worker", from: "orchestrator", to: "queue-worker", label: "hands durable work to the new worker", type: "publishes" }),
      connection({ id: "runtime-audit", from: "orchestrator", to: "audit", label: "records a lifecycle audit event", type: "writes" }),
    ],
  };
}

function incompleteGraph(): LensGraph {
  const graph = changedGraph();
  return {
    // Same identities and groups as Lens 1, but deliberately returned in a
    // different provider order to exercise the scoped previous-layout cache.
    components: ["telemetry", "store", "result-encoder", "scheduler", "gateway", "queue-worker", "policy", "cache", "orchestrator"]
      .map((id) => graph.components.find((component) => component.id === id)!)
      .filter((component): component is LensComponent => component !== undefined),
    connections: graph.connections.filter((connection) => connection.id !== "runtime-audit"),
  };
}

const coverage = (complete: boolean, unknownAreas?: string[]): CoverageRecord => ({
  scope: "whole-project",
  totalRequested: complete ? 14 : 16,
  analyzed: Object.values(sourceTable).filter((source) => source.kind === "code").map((source) => ({ path: source.path, kind: source.kind, status: "analyzed" as const, sourceId: source.id })),
  excluded: [],
  unsupported: [],
  unresolved: [],
  missing: [],
  escaped: [],
  ...(unknownAreas === undefined ? {} : { unknownAreas }),
  complete,
});

const inventory: ProjectInventory = {
  capturedAt: createdAt,
  entries: Object.values(sourceTable).map((source) => ({ path: source.path, kind: source.kind, status: "candidate" as const })),
  totalDiscovered: Object.values(sourceTable).length,
  truncated: false,
  omittedCount: 0,
};

const documentSections: DocumentSection[] = [
  {
    sourceId: sourceTable.architecture.id,
    path: sourceTable.architecture.path,
    anchor: "runtime-boundary",
    heading: "Runtime boundary",
    level: 2,
    startLine: 3,
    endLine: 4,
    capturedSha256: sourceTable.architecture.sha256,
  },
  {
    sourceId: sourceTable.architecture.id,
    path: sourceTable.architecture.path,
    anchor: "internal-flow",
    heading: "Internal flow",
    level: 2,
    startLine: 6,
    endLine: 7,
    capturedSha256: sourceTable.architecture.sha256,
  },
];

function version(
  id: string,
  versionNumber: number,
  graph: LensGraph,
  sourceSet: CapturedSource[],
  complete: boolean,
  parentVersionId: string | null,
  unknownAreas?: string[],
): LensVersion {
  return {
    id,
    versionNumber,
    projectId,
    environmentId,
    hostId,
    rootPath: "/synthetic/project-lens/w03-rework-01",
    parentVersionId,
    createdAt: createdAt + versionNumber * 60_000,
    configurationRevision: 1,
    documentSettings: [{ path: "docs/architecture.md", purpose: "Controlled architecture evidence", maintenance: "reference-only" }],
    analyzerRevision: "w03-fixture-analyzer-1",
    sources: sourceSet,
    documentSections,
    graph,
    coverage: coverage(complete, unknownAreas),
    inventory,
    identityWarnings: [],
    analysisProviderId: "fixture-provider",
  };
}

const baselineSources = [
  sourceTable.gateway,
  sourceTable.orchestrator,
  sourceTable.scheduler,
  sourceTable.policy,
  sourceTable.cache,
  sourceTable.store,
  sourceTable.telemetry,
  sourceTable.legacy,
  sourceTable.nestedIngress,
  sourceTable.nestedFanout,
  sourceTable.nestedPersist,
  sourceTable.nestedRetry,
  sourceTable.architecture,
];
const changedSources = [
  sourceTable.gatewayChanged,
  sourceTable.orchestrator,
  sourceTable.scheduler,
  sourceTable.policy,
  sourceTable.cache,
  sourceTable.queue,
  sourceTable.store,
  sourceTable.telemetryChanged,
  sourceTable.audit,
  sourceTable.nestedIngress,
  sourceTable.nestedFanout,
  sourceTable.nestedPersist,
  sourceTable.nestedRetry,
  sourceTable.architecture,
];

export const w03FixtureVersions: LensVersion[] = [
  version("fixture-w03-lens-0", 0, baselineGraph(), baselineSources, true, null),
  version("fixture-w03-lens-1", 1, changedGraph(), changedSources, true, "fixture-w03-lens-0"),
  version("fixture-w03-lens-2", 2, incompleteGraph(), changedSources, false, "fixture-w03-lens-1", [
    "a provider scan did not establish the audit source area",
    "the synthetic fixture intentionally omits one bounded area",
  ]),
];
