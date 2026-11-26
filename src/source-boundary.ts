import type {
  ProjectInventory,
  ProjectWorkspace,
  SourceCapture,
  SourceIdentity,
  WorkspaceIdentity,
} from "./model.js";

/**
 * The identity read that an analysis or synchronization is allowed to publish.
 * The source bytes and the inventory are intentionally paired with the same
 * workspace/configuration boundary; neither is a free-floating hint.
 */
export interface CapturedSourceBoundary {
  workspace: WorkspaceIdentity;
  configurationRevision: number;
  capture: SourceCapture;
  inventory: ProjectInventory;
}

/** Serializable expectation carried from the document phase into generation. */
export interface SourceBoundaryExpectation {
  workspace: WorkspaceIdentity;
  configurationRevision: number;
  sources: SourceIdentity[];
  inventory: ProjectInventory;
}

export function workspaceIdentity(target: ProjectWorkspace): WorkspaceIdentity {
  return {
    projectId: target.projectId,
    environmentId: target.environmentId,
    hostId: target.hostId,
    rootPath: target.rootPath,
  };
}

export function sourceIdentitiesForBoundary(capture: SourceCapture): SourceIdentity[] {
  return capture.sources.map((source) => ({
    path: source.path,
    kind: source.kind,
    sha256: source.sha256,
    sizeBytes: source.sizeBytes,
  }));
}

function sourceKey(source: Pick<SourceIdentity, "kind" | "path">): string {
  return `${source.kind}:${source.path}`;
}

function inventoryKey(entry: ProjectInventory["entries"][number]): string {
  return `${entry.kind}:${entry.path}`;
}

/**
 * Compare both sides of a source manifest. A loop over only the expected side
 * misses additions, which is unsafe for freshness and retry decisions.
 */
export function sourceIdentityDifferences(
  expected: readonly SourceIdentity[],
  actual: readonly SourceIdentity[],
): string[] {
  const expectedByKey = new Map(expected.map((source) => [sourceKey(source), source]));
  const actualByKey = new Map(actual.map((source) => [sourceKey(source), source]));
  const paths: string[] = [];
  for (const [key, source] of expectedByKey) {
    const current = actualByKey.get(key);
    if (current === undefined || current.sha256 !== source.sha256 || current.sizeBytes !== source.sizeBytes) {
      paths.push(source.path);
    }
  }
  for (const source of actual) {
    if (!expectedByKey.has(sourceKey(source))) paths.push(source.path);
  }
  return [...new Set(paths)].sort();
}

/**
 * Compare the complete bounded inventory, including additions, deletions and
 * changes from candidate to excluded/unresolved. Capture timestamps are not
 * identity: a new timestamp alone is not a conflict.
 */
export function inventoryDifferences(
  expected: ProjectInventory,
  actual: ProjectInventory,
): string[] {
  const expectedByKey = new Map(expected.entries.map((entry) => [inventoryKey(entry), entry]));
  const actualByKey = new Map(actual.entries.map((entry) => [inventoryKey(entry), entry]));
  const paths: string[] = [];
  for (const [key, entry] of expectedByKey) {
    const current = actualByKey.get(key);
    if (current === undefined || current.status !== entry.status) paths.push(entry.path);
  }
  for (const entry of actual.entries) {
    if (!expectedByKey.has(inventoryKey(entry))) paths.push(entry.path);
  }
  if (
    expected.totalDiscovered !== actual.totalDiscovered ||
    expected.truncated !== actual.truncated ||
    expected.omittedCount !== actual.omittedCount
  ) {
    paths.push("Project inventory");
  }
  return [...new Set(paths)].sort();
}

export function boundaryDifferences(
  expected: SourceBoundaryExpectation,
  actual: CapturedSourceBoundary,
): string[] {
  const differences: string[] = [];
  if (
    expected.workspace.projectId !== actual.workspace.projectId ||
    expected.workspace.environmentId !== actual.workspace.environmentId ||
    expected.workspace.hostId !== actual.workspace.hostId ||
    expected.workspace.rootPath !== actual.workspace.rootPath
  ) {
    differences.push("Project Lens workspace identity");
  }
  if (expected.configurationRevision !== actual.configurationRevision) {
    differences.push("Project Lens configuration revision");
  }
  differences.push(
    ...sourceIdentityDifferences(expected.sources, sourceIdentitiesForBoundary(actual.capture)),
    ...inventoryDifferences(expected.inventory, actual.inventory),
  );
  return [...new Set(differences)].sort();
}

export function expectationForBoundary(boundary: CapturedSourceBoundary): SourceBoundaryExpectation {
  return {
    workspace: boundary.workspace,
    configurationRevision: boundary.configurationRevision,
    sources: sourceIdentitiesForBoundary(boundary.capture),
    inventory: boundary.inventory,
  };
}
