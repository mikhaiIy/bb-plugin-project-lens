import type {
  CoverageRecord,
  LensComponent,
  LensConnection,
  LensGraph,
  LensVersion,
  SourceCapture,
} from "./model.js";
import { inventoryDifferences, sourceIdentityDifferences } from "./source-boundary.js";

export type DiagramChange = "added" | "changed" | "removed" | "unchanged" | "uncertain";

export interface DiagramComponentItem {
  id: string;
  current: LensComponent | null;
  baseline: LensComponent | null;
  change: DiagramChange;
  sourceOnly: boolean;
  explanationOnly: boolean;
  architectureChanged: boolean;
}

export interface DiagramConnectionItem {
  id: string;
  current: LensConnection | null;
  baseline: LensConnection | null;
  change: DiagramChange;
  sourceOnly: boolean;
  explanationOnly: boolean;
  architectureChanged: boolean;
}

export interface DiagramComparison {
  currentVersionId: string;
  baselineVersionId: string | null;
  components: DiagramComponentItem[];
  connections: DiagramConnectionItem[];
  canConfirmRemovals: boolean;
  uncertainty: string[];
  sourceOnlyChanges: number;
  explanationOnlyChanges: number;
  architectureChanges: number;
}

export interface DiagramGroup {
  id: string;
  label: string;
  componentIds: string[];
}

export interface DiagramHierarchy {
  roots: LensComponent[];
  childrenByParent: Map<string, LensComponent[]>;
  groups: DiagramGroup[];
  malformed: string[];
}

export interface DiagramPoint {
  x: number;
  y: number;
}

export interface DiagramRect extends DiagramPoint {
  width: number;
  height: number;
}

export interface DiagramLayout {
  width: number;
  height: number;
  contentBounds: DiagramRect;
  groups: Array<DiagramGroup & { rect: DiagramRect }>;
  nodes: Map<string, DiagramRect>;
}

export interface DiagramViewport {
  width: number;
  height: number;
}

export interface DiagramCameraFit {
  zoom: number;
  pan: DiagramPoint;
  screenScale: number;
  letterbox: DiagramPoint;
}

export interface DiagramCameraFitOptions {
  minZoom?: number;
  maxZoom?: number;
  horizontalPadding?: number;
  verticalPadding?: number;
}

export interface DiagramConnectionRoute {
  connectionId: string;
  path: string;
  label: { x: number; y: number; width: number; height: number };
  labelLines: string[];
  laneX: number;
  bounds: DiagramRect;
}

export type SourceFreshnessStatus = "fresh" | "stale" | "unknown";

export interface SourceFreshness {
  status: SourceFreshnessStatus;
  checkedAt: number;
  changedPaths: string[];
  detail: string;
}

/**
 * The browser preserves an SVG viewBox with xMidYMid meet. Keep that base
 * transform in the camera math so fitting content uses the pixels the user
 * actually has, including the letterboxed margins.
 */
export function diagramScreenScale(
  layout: Pick<DiagramLayout, "width" | "height">,
  viewport: DiagramViewport,
): number {
  if (
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    layout.width <= 0 ||
    layout.height <= 0
  ) {
    return 1;
  }
  return Math.max(
    0.001,
    Math.min(viewport.width / layout.width, viewport.height / layout.height),
  );
}

function clampCameraZoom(value: number, minZoom: number, maxZoom: number): number {
  return Math.min(maxZoom, Math.max(minZoom, value));
}

/**
 * Fit a content rectangle to the measured SVG viewport. `pan` is expressed in
 * viewBox units because it is applied inside the SVG's own transform group.
 * The returned camera therefore works for both a content rectangle smaller
 * than the layout (which must be enlarged) and a graph that already fills its
 * layout (which must remain bounded by the viewport padding).
 */
export function fitDiagramCamera(
  layout: Pick<DiagramLayout, "width" | "height">,
  bounds: DiagramRect,
  viewport: DiagramViewport,
  options: DiagramCameraFitOptions = {},
): DiagramCameraFit {
  const minZoom = Math.max(0.001, options.minZoom ?? 0.4);
  const maxZoom = Math.max(minZoom, options.maxZoom ?? 4.5);
  const horizontalPadding = Math.min(1, Math.max(0.01, options.horizontalPadding ?? 0.94));
  const verticalPadding = Math.min(1, Math.max(0.01, options.verticalPadding ?? 0.9));
  const screenScale = diagramScreenScale(layout, viewport);
  const letterbox = {
    x: (Math.max(0, viewport.width) - layout.width * screenScale) / 2,
    y: (Math.max(0, viewport.height) - layout.height * screenScale) / 2,
  };
  const fitZoom = Math.min(
    (Math.max(1, viewport.width) * horizontalPadding) / Math.max(1, bounds.width * screenScale),
    (Math.max(1, viewport.height) * verticalPadding) / Math.max(1, bounds.height * screenScale),
  );
  const zoom = clampCameraZoom(
    Number.isFinite(fitZoom) && fitZoom > 0 ? fitZoom : 1,
    minZoom,
    maxZoom,
  );
  return {
    zoom,
    pan: {
      x: layout.width / 2 - (bounds.x + bounds.width / 2) * zoom,
      y: layout.height / 2 - (bounds.y + bounds.height / 2) * zoom,
    },
    screenScale,
    letterbox,
  };
}

/** Project a viewBox rectangle into the measured SVG viewport for camera tests. */
export function projectDiagramRect(
  rect: DiagramRect,
  camera: DiagramCameraFit,
): DiagramRect {
  return {
    x: camera.letterbox.x + (camera.pan.x + rect.x * camera.zoom) * camera.screenScale,
    y: camera.letterbox.y + (camera.pan.y + rect.y * camera.zoom) * camera.screenScale,
    width: rect.width * camera.zoom * camera.screenScale,
    height: rect.height * camera.zoom * camera.screenScale,
  };
}

const EMPTY_COVERAGE: CoverageRecord = {
  scope: "whole-project",
  totalRequested: 0,
  analyzed: [],
  excluded: [],
  unsupported: [],
  unresolved: [],
  missing: [],
  escaped: [],
  complete: true,
};

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function sortedObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortedObject(child)]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortedObject(value));
}

function sourceKey(source: { kind: string; path: string }): string {
  return `${source.kind}:${source.path}`;
}

/**
 * Compare retained evidence and, for inventory-bearing Lens versions, the
 * complete bounded project manifest. A matching manifest is the current
 * freshness boundary; a completed historical synchronization is not evidence
 * that the live workspace is still fresh. Legacy versions without an inventory
 * stay unknown even when all retained source paths still match.
 */
export function assessSourceFreshness(
  version: LensVersion,
  capture: Pick<SourceCapture, "capturedAt" | "sources" | "coverage" | "inventory">,
  currentConfigurationRevision?: number,
): SourceFreshness {
  const changedPaths: string[] = [];
  if (
    currentConfigurationRevision !== undefined &&
    currentConfigurationRevision !== version.configurationRevision
  ) {
    changedPaths.push("Project Lens document configuration");
  }

  changedPaths.push(...sourceIdentityDifferences(
    version.sources.map((source) => ({
      path: source.path,
      kind: source.kind,
      sha256: source.sha256,
      sizeBytes: source.sizeBytes,
    })),
    capture.sources.map((source) => ({
      path: source.path,
      kind: source.kind,
      sha256: source.sha256,
      sizeBytes: source.sizeBytes,
    })),
  ));

  let inventoryIncomplete = false;
  const inventoryHasUnresolvedEntries = (inventory: NonNullable<LensVersion["inventory"]>) =>
    inventory.entries.some((entry) => entry.status === "unresolved");
  if (version.inventory !== undefined) {
    if (capture.inventory === undefined) {
      changedPaths.push("Project inventory");
      inventoryIncomplete = true;
    } else {
      changedPaths.push(...inventoryDifferences(version.inventory, capture.inventory));
      inventoryIncomplete =
        version.inventory.truncated ||
        capture.inventory.truncated ||
        inventoryHasUnresolvedEntries(version.inventory) ||
        inventoryHasUnresolvedEntries(capture.inventory);
    }
  }

  const legacyInventory = version.inventory === undefined;

  const incomplete =
    capture.coverage.unresolved.length > 0 ||
    capture.coverage.missing.length > 0 ||
    capture.coverage.unsupported.length > 0 ||
    capture.coverage.escaped.length > 0 ||
    (capture.coverage.unknownAreas?.length ?? 0) > 0;
  if (changedPaths.length > 0) {
    return {
      status: "stale",
      checkedAt: capture.capturedAt,
      changedPaths: unique(changedPaths),
      detail: "Saved evidence differs from the latest read for one or more checked paths.",
    };
  }
  if (legacyInventory || inventoryIncomplete || incomplete || !capture.coverage.complete) {
    return {
      status: "unknown",
      checkedAt: capture.capturedAt,
      changedPaths: [],
      detail: legacyInventory
        ? "This Lens predates project inventory capture. Retained source paths match, but whole-project freshness is unknown; Update Lens can capture an inventory-backed Lens."
        : "The freshness read is bounded or incomplete. No checked source differences were found, but whole-project freshness is unknown; Update Lens can publish another bounded Lens and its coverage may remain incomplete.",
    };
  }
  return {
    status: "fresh",
    checkedAt: capture.capturedAt,
    changedPaths: [],
    detail: version.inventory === undefined
      ? "Saved evidence matches the latest read for every retained path."
      : "Saved evidence and the complete bounded project inventory match the latest read.",
  };
}

function componentSourceFingerprint(component: LensComponent): string {
  return stableJson({
    code: component.codeAnchors.map((anchor) => ({
      path: anchor.path,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      capturedSha256: anchor.capturedSha256,
    })),
    documents: component.documentMappings.map((mapping) => ({
      documentPath: mapping.documentPath,
      sectionAnchor: mapping.sectionAnchor,
      capturedSha256: mapping.capturedSha256,
    })),
    evidence: component.evidence.map((evidence) => ({
      kind: evidence.kind,
      path: evidence.path,
      capturedSha256: evidence.capturedSha256,
      startLine: evidence.startLine,
      endLine: evidence.endLine,
      sectionAnchor: evidence.sectionAnchor,
    })),
  });
}

function componentArchitectureFingerprint(component: LensComponent): string {
  return stableJson({
    name: component.name,
    parentId: component.parentId,
    groupId: component.groupId,
    state: component.state,
  });
}

function componentExplanationFingerprint(component: LensComponent): string {
  return stableJson({
    responsibility: component.responsibility,
    provenance: component.provenance,
  });
}

function connectionSourceFingerprint(connection: LensConnection): string {
  return stableJson(
    connection.evidence.map((evidence) => ({
      kind: evidence.kind,
      path: evidence.path,
      capturedSha256: evidence.capturedSha256,
      startLine: evidence.startLine,
      endLine: evidence.endLine,
      sectionAnchor: evidence.sectionAnchor,
    })),
  );
}

function connectionArchitectureFingerprint(connection: LensConnection): string {
  return stableJson({
    fromComponentId: connection.fromComponentId,
    toComponentId: connection.toComponentId,
    type: connection.type,
    direction: connection.direction,
    state: connection.state,
  });
}

function connectionExplanationFingerprint(connection: LensConnection): string {
  return stableJson({ label: connection.label, provenance: connection.provenance });
}

export function flattenComponents(graph: LensGraph): LensComponent[] {
  return graph.components.flatMap((component) => [
    component,
    ...(component.nestedFlow === undefined ? [] : flattenComponents(component.nestedFlow)),
  ]);
}

export function flattenConnections(graph: LensGraph): LensConnection[] {
  return [
    ...graph.connections,
    ...graph.components.flatMap((component) =>
      component.nestedFlow === undefined ? [] : flattenConnections(component.nestedFlow),
    ),
  ];
}

export function hierarchyForGraph(graph: LensGraph): DiagramHierarchy {
  const ids = new Set(graph.components.map((component) => component.id));
  const childrenByParent = new Map<string, LensComponent[]>();
  const malformed: string[] = [];

  for (const component of graph.components) {
    if (component.parentId === component.id) {
      malformed.push(`Component ${component.name} points to itself and is shown at the root`);
      continue;
    }
    if (component.parentId !== null && !ids.has(component.parentId)) {
      malformed.push(`Component ${component.name} references missing parent ${component.parentId}`);
      continue;
    }
    if (component.parentId !== null) {
      const siblings = childrenByParent.get(component.parentId) ?? [];
      siblings.push(component);
      childrenByParent.set(component.parentId, siblings);
    }
  }

  const roots = graph.components.filter(
    (component) =>
      component.parentId === null ||
      component.parentId === component.id ||
      !ids.has(component.parentId),
  );

  const reachable = new Set<string>();
  const visit = (component: LensComponent, trail: Set<string>) => {
    if (trail.has(component.id)) {
      malformed.push(`Parent cycle includes ${component.name}; cycle members are shown at the root`);
      return;
    }
    if (reachable.has(component.id)) return;
    reachable.add(component.id);
    const nextTrail = new Set(trail).add(component.id);
    for (const child of childrenByParent.get(component.id) ?? []) visit(child, nextTrail);
  };
  roots.forEach((root) => visit(root, new Set()));
  graph.components
    .filter((component) => !reachable.has(component.id))
    .forEach((component) => {
      malformed.push(`Component ${component.name} is unreachable from the hierarchy root`);
      roots.push(component);
      visit(component, new Set());
    });

  const componentNames = new Map(graph.components.map((component) => [component.id, component.name]));
  const groups = new Map<string, string[]>();
  for (const component of roots) {
    const groupId = component.groupId ?? "project";
    const idsForGroup = groups.get(groupId) ?? [];
    idsForGroup.push(component.id);
    groups.set(groupId, idsForGroup);
  }

  return {
    roots,
    childrenByParent,
    groups: [...groups.entries()].map(([id, componentIds]) => ({
      id,
      label:
        id === "project"
          ? "Project surface"
          : componentNames.get(id) ?? id.replace(/[-_]+/g, " "),
      componentIds,
    })),
    malformed: unique(malformed),
  };
}

export function childrenFor(graph: LensGraph, parentId: string): LensComponent[] {
  return hierarchyForGraph(graph).childrenByParent.get(parentId) ?? [];
}

function graphContainingComponent(graph: LensGraph, componentId: string): LensGraph | null {
  if (graph.components.some((component) => component.id === componentId)) return graph;
  for (const component of graph.components) {
    if (component.nestedFlow === undefined) continue;
    const nested = graphContainingComponent(component.nestedFlow, componentId);
    if (nested !== null) return nested;
  }
  return null;
}

export function visibleLevelForGraph(graph: LensGraph, focusId: string | null): LensGraph {
  if (focusId === null) return graph;
  const focused = flattenComponents(graph).find((component) => component.id === focusId);
  if (focused?.nestedFlow !== undefined) return focused.nestedFlow;
  const containing = graphContainingComponent(graph, focusId);
  if (containing === null) return { components: [], connections: [] };
  const children = childrenFor(containing, focusId);
  const childIds = new Set(children.map((child) => child.id));
  return {
    components: children,
    connections: containing.connections.filter(
      (connection) => childIds.has(connection.fromComponentId) && childIds.has(connection.toComponentId),
    ),
  };
}

export function graphForComponent(graph: LensGraph, componentId: string): LensGraph | null {
  const component = flattenComponents(graph).find((candidate) => candidate.id === componentId);
  if (component?.nestedFlow !== undefined) return component.nestedFlow;
  const level = visibleLevelForGraph(graph, componentId);
  return level.components.length === 0 ? null : level;
}

function sourceAnchorKeys(component: LensComponent): string[] {
  return [
    ...component.codeAnchors.map(
      (anchor) => `code:${anchor.path}:${anchor.startLine ?? "?"}-${anchor.endLine ?? "?"}`,
    ),
    ...component.documentMappings.map(
      (mapping) => `markdown:${mapping.documentPath}#${mapping.sectionAnchor}`,
    ),
    ...component.evidence.map(
      (evidence) => `evidence:${evidence.kind}:${evidence.path}:${evidence.sectionAnchor ?? ""}`,
    ),
  ];
}

function matchComponent(
  current: LensComponent,
  baseline: readonly LensComponent[],
  used: ReadonlySet<string>,
): LensComponent | null {
  const exact = baseline.find((candidate) => candidate.id === current.id && !used.has(candidate.id));
  if (exact !== undefined) return exact;

  if (current.identityKey !== undefined) {
    const identityMatches = baseline.filter(
      (candidate) => candidate.identityKey === current.identityKey && !used.has(candidate.id),
    );
    if (identityMatches.length === 1) return identityMatches[0]!;
  }

  const currentKeys = new Set(sourceAnchorKeys(current));
  const scored = baseline
    .filter((candidate) => !used.has(candidate.id))
    .map((candidate) => ({
      candidate,
      score: sourceAnchorKeys(candidate).filter((key) => currentKeys.has(key)).length,
    }))
    .filter((entry) => entry.score > 0);
  const maxScore = Math.max(0, ...scored.map((entry) => entry.score));
  const matches = scored.filter((entry) => entry.score === maxScore);
  return matches.length === 1 ? matches[0]!.candidate : null;
}

function matchConnection(
  current: LensConnection,
  baseline: readonly LensConnection[],
  used: ReadonlySet<string>,
): LensConnection | null {
  const exact = baseline.find((candidate) => candidate.id === current.id && !used.has(candidate.id));
  if (exact !== undefined) return exact;
  const candidates = baseline.filter(
    (candidate) =>
      !used.has(candidate.id) &&
      candidate.fromComponentId === current.fromComponentId &&
      candidate.toComponentId === current.toComponentId &&
      candidate.type === current.type,
  );
  return candidates.length === 1 ? candidates[0]! : null;
}

function currentCoverageIsReliable(coverage: CoverageRecord): boolean {
  return (
    coverage.unresolved.length === 0 &&
    coverage.missing.length === 0 &&
    coverage.unsupported.length === 0 &&
    coverage.escaped.length === 0 &&
    (coverage.unknownAreas?.length ?? 0) === 0
  );
}

export function compareLensVersions(
  current: LensVersion,
  baseline: LensVersion | null,
): DiagramComparison {
  if (baseline === null || baseline.id === current.id) {
    return {
      currentVersionId: current.id,
      baselineVersionId: baseline?.id ?? null,
      components: flattenComponents(current.graph).map((component) => ({
        id: component.id,
        current: component,
        baseline: null,
        change: "unchanged",
        sourceOnly: false,
        explanationOnly: false,
        architectureChanged: false,
      })),
      connections: flattenConnections(current.graph).map((connection) => ({
        id: connection.id,
        current: connection,
        baseline: null,
        change: "unchanged",
        sourceOnly: false,
        explanationOnly: false,
        architectureChanged: false,
      })),
      canConfirmRemovals: true,
      uncertainty: [],
      sourceOnlyChanges: 0,
      explanationOnlyChanges: 0,
      architectureChanges: 0,
    };
  }

  const currentComponents = flattenComponents(current.graph);
  const baselineComponents = flattenComponents(baseline.graph);
  const currentConnections = flattenConnections(current.graph);
  const baselineConnections = flattenConnections(baseline.graph);
  const usedComponents = new Set<string>();
  const usedConnections = new Set<string>();
  const items: DiagramComponentItem[] = [];
  const uncertainty: string[] = [];
  let sourceOnlyChanges = 0;
  let explanationOnlyChanges = 0;
  let architectureChanges = 0;
  const canConfirmRemovals = currentCoverageIsReliable(current.coverage);

  if (!canConfirmRemovals) {
    uncertainty.push(
      "Some source areas were not fully established; baseline-only components are shown for review, not confidently removed.",
    );
  }

  for (const component of currentComponents) {
    const prior = matchComponent(component, baselineComponents, usedComponents);
    if (prior === null) {
      architectureChanges += 1;
      items.push({
        id: component.id,
        current: component,
        baseline: null,
        change: "added",
        sourceOnly: false,
        explanationOnly: false,
        architectureChanged: true,
      });
      continue;
    }
    usedComponents.add(prior.id);
    const sourceChanged = componentSourceFingerprint(component) !== componentSourceFingerprint(prior);
    const explanationChanged =
      componentExplanationFingerprint(component) !== componentExplanationFingerprint(prior);
    const architectureChangedForItem =
      componentArchitectureFingerprint(component) !== componentArchitectureFingerprint(prior);
    const changed = sourceChanged || explanationChanged || architectureChangedForItem;
    if (sourceChanged && !explanationChanged && !architectureChangedForItem) sourceOnlyChanges += 1;
    if (explanationChanged && !sourceChanged && !architectureChangedForItem) explanationOnlyChanges += 1;
    if (architectureChangedForItem) architectureChanges += 1;
    items.push({
      id: component.id,
      current: component,
      baseline: prior,
      change: changed ? "changed" : "unchanged",
      sourceOnly: sourceChanged && !explanationChanged && !architectureChangedForItem,
      explanationOnly: explanationChanged && !sourceChanged && !architectureChangedForItem,
      architectureChanged: architectureChangedForItem,
    });
  }

  for (const component of baselineComponents) {
    if (usedComponents.has(component.id)) continue;
    architectureChanges += 1;
    items.push({
      id: component.id,
      current: null,
      baseline: component,
      change: canConfirmRemovals ? "removed" : "uncertain",
      sourceOnly: false,
      explanationOnly: false,
      architectureChanged: true,
    });
  }

  const connectionItems: DiagramConnectionItem[] = [];
  for (const connection of currentConnections) {
    const prior = matchConnection(connection, baselineConnections, usedConnections);
    if (prior === null) {
      connectionItems.push({
        id: connection.id,
        current: connection,
        baseline: null,
        change: "added",
        sourceOnly: false,
        explanationOnly: false,
        architectureChanged: true,
      });
      continue;
    }
    usedConnections.add(prior.id);
    const sourceChanged = connectionSourceFingerprint(connection) !== connectionSourceFingerprint(prior);
    const explanationChanged =
      connectionExplanationFingerprint(connection) !== connectionExplanationFingerprint(prior);
    const architectureChangedForItem =
      connectionArchitectureFingerprint(connection) !== connectionArchitectureFingerprint(prior);
    connectionItems.push({
      id: connection.id,
      current: connection,
      baseline: prior,
      change: sourceChanged || explanationChanged || architectureChangedForItem ? "changed" : "unchanged",
      sourceOnly: sourceChanged && !explanationChanged && !architectureChangedForItem,
      explanationOnly: explanationChanged && !sourceChanged && !architectureChangedForItem,
      architectureChanged: architectureChangedForItem,
    });
  }
  for (const connection of baselineConnections) {
    if (usedConnections.has(connection.id)) continue;
    connectionItems.push({
      id: connection.id,
      current: null,
      baseline: connection,
      change: canConfirmRemovals ? "removed" : "uncertain",
      sourceOnly: false,
      explanationOnly: false,
      architectureChanged: true,
    });
  }

  return {
    currentVersionId: current.id,
    baselineVersionId: baseline.id,
    components: items,
    connections: connectionItems,
    canConfirmRemovals,
    uncertainty: unique(uncertainty),
    sourceOnlyChanges,
    explanationOnlyChanges,
    architectureChanges,
  };
}

export function itemForComponent(
  comparison: DiagramComparison,
  componentId: string,
): DiagramComponentItem | null {
  return comparison.components.find((item) => item.id === componentId) ?? null;
}

export function itemForConnection(
  comparison: DiagramComparison,
  connectionId: string,
): DiagramConnectionItem | null {
  return comparison.connections.find((item) => item.id === connectionId) ?? null;
}

function stableComponentKey(component: LensComponent): string {
  return `${component.identityKey ?? component.id}\u0000${component.id}`;
}

function componentAtLevel(graph: LensGraph, focusId: string | null): LensComponent[] {
  if (focusId === null) return hierarchyForGraph(graph).roots;
  return visibleLevelForGraph(graph, focusId).components;
}

function connectionItemsAtLevel(
  comparison: DiagramComparison,
  visibleIds: ReadonlySet<string>,
): DiagramConnectionItem[] {
  return comparison.connections.filter((item) => {
    const connection = itemConnection(item);
    return connection !== null &&
      visibleIds.has(connection.fromComponentId) &&
      visibleIds.has(connection.toComponentId);
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function wrapConnectionLabel(label: string, maxCharacters = 26): string[] {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return ["Connection"];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current === "" ? word : `${current} ${word}`;
    if (current !== "" && next.length > maxCharacters) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current !== "") lines.push(current);
  if (lines.length <= 2) return lines;
  const second = lines.slice(1).join(" ");
  const suffix = second.length > maxCharacters - 1 ? `${second.slice(0, maxCharacters - 2).trimEnd()}…` : second;
  return [lines[0]!, suffix];
}

function groupForNode(layout: DiagramLayout, componentId: string): DiagramLayout["groups"][number] | null {
  return layout.groups.find((group) => group.componentIds.includes(componentId)) ?? null;
}

function groupColumn(layout: DiagramLayout, groupId: string): number {
  const columns = [...new Set(layout.groups.map((group) => group.rect.x))].sort((left, right) => left - right);
  const group = layout.groups.find((candidate) => candidate.id === groupId);
  return group === undefined ? 0 : Math.max(0, columns.indexOf(group.rect.x));
}

function routeBounds(
  points: readonly DiagramPoint[],
  label: { x: number; y: number; width: number; height: number },
): DiagramRect {
  const minX = Math.min(...points.map((point) => point.x), label.x - label.width / 2);
  const minY = Math.min(...points.map((point) => point.y), label.y - label.height / 2);
  const maxX = Math.max(...points.map((point) => point.x), label.x + label.width / 2);
  const maxY = Math.max(...points.map((point) => point.y), label.y + label.height / 2);
  const padding = 6;
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

function cubicPoint(
  start: DiagramPoint,
  firstControl: DiagramPoint,
  secondControl: DiagramPoint,
  end: DiagramPoint,
  t: number,
): DiagramPoint {
  const inverse = 1 - t;
  return {
    x:
      inverse * inverse * inverse * start.x +
      3 * inverse * inverse * t * firstControl.x +
      3 * inverse * t * t * secondControl.x +
      t * t * t * end.x,
    y:
      inverse * inverse * inverse * start.y +
      3 * inverse * inverse * t * firstControl.y +
      3 * inverse * t * t * secondControl.y +
      t * t * t * end.y,
  };
}

function cubicSamples(
  start: DiagramPoint,
  firstControl: DiagramPoint,
  secondControl: DiagramPoint,
  end: DiagramPoint,
): DiagramPoint[] {
  const samples: DiagramPoint[] = [];
  for (let index = 0; index <= 40; index += 1) {
    samples.push(cubicPoint(start, firstControl, secondControl, end, index / 40));
  }
  return samples;
}

function distanceToSamples(point: DiagramPoint, samples: readonly DiagramPoint[]): number {
  return Math.min(...samples.map((sample) => Math.hypot(sample.x - point.x, sample.y - point.y)));
}

function boxesOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y;
}

function labelBoxOverlaps(
  point: DiagramPoint,
  width: number,
  height: number,
  existing: readonly DiagramConnectionRoute[],
): boolean {
  const labelBox = { x: point.x - width / 2, y: point.y - height / 2, width, height };
  return existing.some((route) => boxesOverlap(labelBox, {
    x: route.label.x - route.label.width / 2,
    y: route.label.y - route.label.height / 2,
    width: route.label.width,
    height: route.label.height,
  }));
}

function labelBoxOverlapsNode(
  point: DiagramPoint,
  width: number,
  height: number,
  layout: DiagramLayout,
): boolean {
  const labelBox = { x: point.x - width / 2, y: point.y - height / 2, width, height };
  return [...layout.nodes.values()].some((node) => boxesOverlap(labelBox, node));
}

/**
 * Route each edge through a local lane beside its endpoint groups. Labels sit
 * on a segment of the route they describe; the canvas no longer relies on a
 * global top rail whose curves can cross unrelated groups.
 */
export function routeConnections(
  connections: readonly LensConnection[],
  layout: DiagramLayout,
): Map<string, DiagramConnectionRoute> {
  const routes = new Map<string, DiagramConnectionRoute>();
  const routeSamples = new Map<string, DiagramPoint[]>();
  const ordered = [...connections].sort((left, right) => left.id.localeCompare(right.id));
  const channelUse = new Map<string, number>();

  ordered.forEach((connection) => {
    const from = layout.nodes.get(connection.fromComponentId);
    const to = layout.nodes.get(connection.toComponentId);
    const fromGroup = groupForNode(layout, connection.fromComponentId);
    const toGroup = groupForNode(layout, connection.toComponentId);
    if (from === undefined || to === undefined || fromGroup === null || toGroup === null) return;

    const labelLines = wrapConnectionLabel(connection.label);
    const labelWidth = clamp(
      Math.max(...labelLines.map((line) => line.length * 7 + 30)),
      112,
      244,
    );
    const labelHeight = labelLines.length * 16 + 28;
    const sameGroup = fromGroup.id === toGroup.id;
    const fromColumn = groupColumn(layout, fromGroup.id);
    const toColumn = groupColumn(layout, toGroup.id);
    const groupPair = [fromGroup.id, toGroup.id].sort().join(":");
    const nodePair = [connection.fromComponentId, connection.toComponentId].sort().join(":");
    const channelKey = sameGroup
      ? "group:" + fromGroup.id + ":" + nodePair
      : fromColumn !== toColumn
        ? "columns:" + groupPair
        : "rows:" + groupPair;
    const channelIndex = channelUse.get(channelKey) ?? 0;
    channelUse.set(channelKey, channelIndex + 1);
    const laneStep = Math.max(92, Math.min(168, labelWidth * 0.55));
    const laneNumber = Math.floor(channelIndex / 2);
    const alternateLane = channelIndex % 2 === 1;
    let path = "";
    let labelX = 0;
    let labelY = 0;
    let laneX = 0;
    let laneY = 0;
    let pathMode: "horizontal" | "vertical" = "horizontal";
    let startX = 0;
    let startY = 0;
    let endX = 0;
    let endY = 0;
    let laneDirection = 1;

    if (sameGroup) {
      const column = fromColumn;
      const columnCount = new Set(layout.groups.map((group) => group.rect.x)).size;
      const preferredSide = column === columnCount - 1 && columnCount > 1 ? "left" : "right";
      const side = alternateLane
        ? preferredSide === "right" ? "left" : "right"
        : preferredSide;
      const sameGroupLaneNumber = laneNumber;
      startX = side === "right" ? from.x + from.width : from.x;
      endX = side === "right" ? to.x + to.width : to.x;
      const nodeClearance = labelWidth / 2 + 24;
      laneX = side === "right"
        ? fromGroup.rect.x + fromGroup.rect.width + nodeClearance + sameGroupLaneNumber * laneStep
        : fromGroup.rect.x - nodeClearance - sameGroupLaneNumber * laneStep;
      startY = from.y + from.height / 2;
      endY = to.y + to.height / 2;
      laneDirection = side === "right" ? 1 : -1;
    } else {
      if (fromColumn !== toColumn) {
        const sourceOnLeft = fromGroup.rect.x < toGroup.rect.x;
        const leftGroup = sourceOnLeft ? fromGroup : toGroup;
        const rightGroup = sourceOnLeft ? toGroup : fromGroup;
        const gapCenter = (leftGroup.rect.x + leftGroup.rect.width + rightGroup.rect.x) / 2;
        const offset = channelIndex === 0 ? 0 : Math.ceil(channelIndex / 2) * laneStep;
        laneDirection = alternateLane ? -1 : 1;
        laneX = gapCenter + laneDirection * offset;
        startX = sourceOnLeft ? from.x + from.width : from.x;
        endX = sourceOnLeft ? to.x : to.x + to.width;
        startY = from.y + from.height / 2;
        endY = to.y + to.height / 2;
      } else {
        const downward = to.y >= from.y;
        pathMode = "vertical";
        startX = from.x + from.width / 2;
        endX = to.x + to.width / 2;
        startY = downward ? from.y + from.height : from.y;
        endY = downward ? to.y : to.y + to.height;
        const gapCenter = downward
          ? (fromGroup.rect.y + fromGroup.rect.height + toGroup.rect.y) / 2
          : (toGroup.rect.y + toGroup.rect.height + fromGroup.rect.y) / 2;
        const offset = channelIndex === 0 ? 0 : Math.ceil(channelIndex / 2) * laneStep;
        laneDirection = alternateLane ? -1 : 1;
        laneY = gapCenter + laneDirection * offset;
        laneX = (startX + endX) / 2;
        laneDirection *= downward ? 1 : -1;
      }
    }

    const existingRoutes = [...routes.values()];
    const labelTimes = [0.18, 0.34, 0.5, 0.66, 0.82];
    let geometry = {
      start: { x: startX, y: startY },
      firstControl: pathMode === "vertical" ? { x: startX, y: laneY } : { x: laneX, y: startY },
      secondControl: pathMode === "vertical" ? { x: endX, y: laneY } : { x: laneX, y: endY },
      end: { x: endX, y: endY },
    };
    let chosenPoint = cubicPoint(geometry.start, geometry.firstControl, geometry.secondControl, geometry.end, 0.5);
    let chosenSamples = cubicSamples(geometry.start, geometry.firstControl, geometry.secondControl, geometry.end);
    let collisionOffset = 0;
    const baseLaneX = laneX;
    const baseLaneY = laneY;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidates = labelTimes.map((time) => ({
        point: cubicPoint(geometry.start, geometry.firstControl, geometry.secondControl, geometry.end, time),
        time,
      }));
      const safeCandidates = candidates.filter(({ point }) =>
        !labelBoxOverlaps(point, labelWidth, labelHeight, existingRoutes) &&
        !labelBoxOverlapsNode(point, labelWidth, labelHeight, layout),
      );
      const ranked = (safeCandidates.length > 0 ? safeCandidates : candidates).sort((left, right) => {
        const leftDistance = Math.min(
          ...[...routeSamples.values()].map((samples) => distanceToSamples(left.point, samples)),
        );
        const rightDistance = Math.min(
          ...[...routeSamples.values()].map((samples) => distanceToSamples(right.point, samples)),
        );
        return rightDistance - leftDistance;
      });
      if (ranked[0] !== undefined && (safeCandidates.length > 0 || attempt === 9)) {
        chosenPoint = ranked[0].point;
        chosenSamples = cubicSamples(geometry.start, geometry.firstControl, geometry.secondControl, geometry.end);
        break;
      }
      collisionOffset += Math.max(labelWidth + 24, laneStep);
      if (pathMode === "vertical") {
        laneY = baseLaneY + laneDirection * collisionOffset;
        geometry = {
          ...geometry,
          firstControl: { x: startX, y: laneY },
          secondControl: { x: endX, y: laneY },
        };
      } else {
        laneX = baseLaneX + laneDirection * collisionOffset;
        geometry = {
          ...geometry,
          firstControl: { x: laneX, y: startY },
          secondControl: { x: laneX, y: endY },
        };
      }
    }

    labelX = chosenPoint.x;
    labelY = chosenPoint.y;
    path = [
      "M", geometry.start.x, geometry.start.y,
      "C", geometry.firstControl.x, geometry.firstControl.y,
      geometry.secondControl.x, geometry.secondControl.y,
      geometry.end.x, geometry.end.y,
    ].join(" ");

    const label = { x: labelX, y: labelY, width: labelWidth, height: labelHeight };
    const route = {
      connectionId: connection.id,
      path,
      label,
      labelLines,
      laneX,
      // Control points can sit far outside the visible cubic curve. Use the
      // sampled curve for the camera's visual content bounds so a small graph
      // is not kept at layout scale just because a routing handle is distant.
      bounds: routeBounds(chosenSamples, label),
    } satisfies DiagramConnectionRoute;
    routes.set(connection.id, route);
    routeSamples.set(connection.id, chosenSamples);
  });
  return routes;
}

function measuredContentBounds(
  layout: Pick<DiagramLayout, "width" | "height" | "groups" | "nodes">,
  routes: ReadonlyMap<string, DiagramConnectionRoute>,
): DiagramRect {
  const rectangles = [
    ...layout.groups.map((group) => group.rect),
    ...layout.nodes.values(),
    ...[...routes.values()].map((route) => route.bounds),
  ];
  if (rectangles.length === 0) return { x: 0, y: 0, width: layout.width, height: layout.height };
  // Keep a visual breathing room around drawn groups and labels, but do not
  // count a large invisible moat as graph content. The camera adds its own
  // viewport padding after this measurement.
  const padding = 14;
  const minX = Math.min(...rectangles.map((rect) => rect.x));
  const minY = Math.min(...rectangles.map((rect) => rect.y));
  const maxX = Math.max(...rectangles.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rectangles.map((rect) => rect.y + rect.height));
  const x = Math.max(0, minX - padding);
  const y = Math.max(0, minY - padding);
  return {
    x,
    y,
    width: Math.max(1, maxX + padding - x),
    height: Math.max(1, maxY + padding - y),
  };
}

export function stableLayout(
  graph: LensGraph,
  comparison: DiagramComparison,
  focusId: string | null = null,
  previous: DiagramLayout | null = null,
  viewport: DiagramViewport | null = null,
): DiagramLayout {
  const visible = componentAtLevel(graph, focusId);
  const removed = comparison.components
    .filter((item) => {
      const component = item.current === null ? item.baseline : null;
      if (component === null || item.change === "unchanged") return false;
      return focusId === null ? component.parentId === null : component.parentId === focusId;
    })
    .map((item) => item.baseline!);
  const allLevelComponents = [...visible, ...removed];
  const levelComponents = unique(allLevelComponents.map((component) => component.id))
    .map((id) => allLevelComponents.find((component) => component.id === id)!)
    .filter((component): component is LensComponent => component !== undefined);
  const groupIds = unique(levelComponents.map((component) => component.groupId ?? "project"))
    .sort((left, right) => left.localeCompare(right));
  const groups: DiagramGroup[] = (groupIds.length === 0 ? ["project"] : groupIds).map((id) => ({
    id,
    label: id === "project" ? "Project surface" : flattenComponents(graph).find(component => component.id === id)?.name ?? id.replace(/[-_]+/g, " "),
    componentIds: [],
  }));
  const levelConnections = connectionItemsAtLevel(
    comparison,
    new Set(levelComponents.map((component) => component.id)),
  );
  const availableWidth = viewport !== null && viewport.width > 0 ? viewport.width : 0;
  const availableHeight = viewport !== null && viewport.height > 0 ? viewport.height : 0;
  const columnCount = groups.length <= 1 ? 1 : Math.min(3, Math.ceil(Math.sqrt(groups.length)));
  const margin = availableWidth > 0
    ? clamp(Math.round(availableWidth * 0.04), 20, 40)
    : 30;
  const groupGapX = groups.length <= 1
    ? 0
    : availableWidth > 0
      ? clamp(Math.round(availableWidth * 0.055), 42, 90)
      : 72;
  const groupGapY = availableHeight > 0
    ? clamp(Math.round(availableHeight * 0.08), 32, 54)
    : 42;
  const widthBudget = availableWidth > 0
    ? Math.max(1, availableWidth - margin * 2 - Math.max(0, columnCount - 1) * groupGapX)
    : 0;
  const groupWidth = groups.length === 1
    ? availableWidth > 0
      ? clamp(Math.min(widthBudget, Math.round(availableWidth * 0.68)), 320, 760)
      : 680
    : availableWidth > 0
      ? clamp(widthBudget / columnCount, 236, 352)
      : 320;
  const rowCount = Math.max(1, Math.ceil(groups.length / columnCount));
  const nodeHeight = 78;
  const nodeGap = 10;
  const groupTop = 24;
  const groupHeader = 38;
  const nodeTopOffset = groupHeader + 14;
  const nodes = new Map<string, DiagramRect>();
  const previousY = new Map(previous === null ? [] : [...previous.nodes.entries()].map(([id, rect]) => [id, rect.y]));
  const groupLayoutsWithoutRows = groups.map((group, groupIndex) => {
    const groupComponents = levelComponents
      .filter((component) => (component.groupId ?? "project") === group.id)
      .sort((left, right) => {
        const leftPrevious = previousY.get(left.id);
        const rightPrevious = previousY.get(right.id);
        if (leftPrevious !== undefined && rightPrevious !== undefined && leftPrevious !== rightPrevious) {
          return leftPrevious - rightPrevious;
        }
        if (leftPrevious !== undefined) return -1;
        if (rightPrevious !== undefined) return 1;
        return stableComponentKey(left).localeCompare(stableComponentKey(right));
      });
    const x = margin + (groupIndex % columnCount) * (groupWidth + groupGapX);
    const nodeWidth = Math.max(180, groupWidth - 36);
    const previousGroup = previous?.groups.find((candidate) => candidate.id === group.id);
    const previousNodeTop = previousGroup === undefined
      ? groupTop + nodeTopOffset
      : previousGroup.rect.y + nodeTopOffset;
    const occupiedSlots = new Set<number>();
    const slots = new Map<string, number>();
    groupComponents.forEach((component) => {
      const priorY = previousY.get(component.id);
      let slot = priorY === undefined
        ? 0
        : Math.max(0, Math.round((priorY - previousNodeTop) / (nodeHeight + nodeGap)));
      while (occupiedSlots.has(slot)) slot += 1;
      occupiedSlots.add(slot);
      slots.set(component.id, slot);
    });
    const highestSlot = Math.max(-1, ...slots.values());
    const groupHeight = Math.max(
      176,
      nodeTopOffset + Math.max(0, (highestSlot + 1) * (nodeHeight + nodeGap) - nodeGap) + 30,
    );
    return {
      ...group,
      componentIds: groupComponents.map((component) => component.id),
      rect: { x, y: 0, width: groupWidth, height: groupHeight },
      slots,
      nodeWidth,
    };
  });
  const rowHeights = Array.from({ length: rowCount }, (_, row) =>
    Math.max(
      176,
      ...groupLayoutsWithoutRows
        .filter((_, index) => Math.floor(index / columnCount) === row)
        .map((group) => group.rect.height),
    ),
  );
  const groupLayouts = groupLayoutsWithoutRows.map((group, groupIndex) => {
    const row = Math.floor(groupIndex / columnCount);
    const y = groupTop + rowHeights
      .slice(0, row)
      .reduce((sum, height) => sum + height + groupGapY, 0);
    const laidOut = { ...group, rect: { ...group.rect, y } };
    group.componentIds.forEach((componentId) => {
      const slot = group.slots.get(componentId) ?? 0;
      nodes.set(componentId, {
        x: laidOut.rect.x + 24,
        y: laidOut.rect.y + nodeTopOffset + slot * (nodeHeight + nodeGap),
        width: laidOut.nodeWidth,
        height: nodeHeight,
      });
    });
    return laidOut;
  });
  const baseWidth = Math.max(
    760,
    margin * 2 + columnCount * groupWidth + Math.max(0, columnCount - 1) * groupGapX,
  );
  const baseHeight = Math.max(
    420,
    groupTop + rowHeights.reduce((sum, height) => sum + height, 0) +
      Math.max(0, rowCount - 1) * groupGapY + margin,
  );
  const groupsForLayout = groupLayouts.map(({ slots: _slots, nodeWidth: _nodeWidth, ...group }) => group);
  const seedLayout: DiagramLayout = {
    width: baseWidth,
    height: baseHeight,
    contentBounds: { x: 0, y: 0, width: baseWidth, height: baseHeight },
    groups: groupsForLayout,
    nodes,
  };
  const routeInputs = levelConnections
    .map(itemConnection)
    .filter((connection): connection is LensConnection => connection !== null);
  const firstRoutes = routeConnections(routeInputs, seedLayout);
  const minimumRouteX = Math.min(
    seedLayout.groups[0]?.rect.x ?? 0,
    ...[...firstRoutes.values()].map((route) => route.bounds.x),
  );
  const shiftX = Math.max(0, 18 - minimumRouteX);
  const routedLayout = shiftX === 0
    ? seedLayout
    : {
      ...seedLayout,
      width: seedLayout.width + shiftX,
      groups: seedLayout.groups.map((group) => ({
        ...group,
        rect: { ...group.rect, x: group.rect.x + shiftX },
      })),
      nodes: new Map([...seedLayout.nodes.entries()].map(([id, rect]) => [id, { ...rect, x: rect.x + shiftX }])),
    };
  const measuredRoutes = shiftX === 0 ? firstRoutes : routeConnections(routeInputs, routedLayout);
  const contentBounds = measuredContentBounds(routedLayout, measuredRoutes);
  return {
    ...routedLayout,
    width: Math.max(routedLayout.width, contentBounds.x + contentBounds.width),
    height: Math.max(routedLayout.height, contentBounds.y + contentBounds.height),
    contentBounds,
  };
}

export function itemComponent(item: DiagramComponentItem): LensComponent | null {
  return item.current ?? item.baseline;
}

export function itemConnection(item: DiagramConnectionItem): LensConnection | null {
  return item.current ?? item.baseline;
}

export function sourceIdsForComponent(component: LensComponent): string[] {
  return unique([
    ...component.codeAnchors.map((anchor) => anchor.sourceId),
    ...component.documentMappings.map((mapping) => mapping.sourceId),
    ...component.evidence.map((evidence) => evidence.sourceId),
  ]);
}

export { EMPTY_COVERAGE };
