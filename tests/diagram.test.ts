import { describe, expect, it } from "vitest";
import type { LensComponent, LensGraph, LensVersion, ProjectInventory } from "../src/model.js";
import {
  compareLensVersions,
  assessSourceFreshness,
  fitDiagramCamera,
  graphForComponent,
  hierarchyForGraph,
  projectDiagramRect,
  routeConnections,
  stableLayout,
} from "../src/diagram.js";

const hash = "a".repeat(64);

function component(
  id: string,
  overrides: Partial<LensComponent> = {},
): LensComponent {
  return {
    id,
    identityKey: id,
    name: id,
    responsibility: `Owns ${id}`,
    parentId: null,
    groupId: null,
    provenance: "extracted",
    state: "implemented",
    codeAnchors: [
      {
        sourceId: `source:${id}`,
        path: `src/${id}.ts`,
        startLine: 1,
        endLine: 4,
        capturedSha256: hash,
      },
    ],
    documentMappings: [],
    evidence: [
      {
        sourceId: `source:${id}`,
        kind: "code",
        path: `src/${id}.ts`,
        claim: `Evidence for ${id}`,
        capturedSha256: hash,
        startLine: 1,
        endLine: 4,
        provenance: "extracted",
      },
    ],
    ...overrides,
  };
}

function version(
  id: string,
  graph: LensGraph,
  coverage: Partial<LensVersion["coverage"]> = {},
): LensVersion {
  return {
    id,
    versionNumber: id === "v0" ? 0 : 1,
    projectId: "project",
    environmentId: "environment",
    hostId: "host",
    rootPath: "/tmp/project",
    parentVersionId: id === "v0" ? null : "v0",
    createdAt: 1,
    configurationRevision: 1,
    documentSettings: [],
    analyzerRevision: "test",
    sources: [],
    documentSections: [],
    graph,
    coverage: {
      scope: "whole-project",
      totalRequested: 1,
      analyzed: [],
      excluded: [],
      unsupported: [],
      unresolved: [],
      missing: [],
      escaped: [],
      complete: true,
      ...coverage,
    },
  };
}

function sampleCubicPath(path: string): { x: number; y: number }[] {
  const numbers = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (numbers.length < 8) return [];
  const [startX, startY, firstX, firstY, secondX, secondY, endX, endY] = numbers;
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index <= 50; index += 1) {
    const t = index / 50;
    const inverse = 1 - t;
    points.push({
      x: inverse ** 3 * startX! + 3 * inverse ** 2 * t * firstX! + 3 * inverse * t ** 2 * secondX! + t ** 3 * endX!,
      y: inverse ** 3 * startY! + 3 * inverse ** 2 * t * firstY! + 3 * inverse * t ** 2 * secondY! + t ** 3 * endY!,
    });
  }
  return points;
}

function distanceToPath(point: { x: number; y: number }, path: string): number {
  return Math.min(...sampleCubicPath(path).map((sample) => Math.hypot(sample.x - point.x, sample.y - point.y)));
}

describe("Project Lens diagram model", () => {
  it("fits small content through SVG letterboxing and enlarges it into the real viewport", () => {
    const layout = { width: 1200, height: 360 };
    const content = { x: 420, y: 90, width: 260, height: 150 };
    const viewports = [
      { width: 420, height: 760 },
      { width: 960, height: 360 },
    ];

    for (const viewport of viewports) {
      const camera = fitDiagramCamera(layout, content, viewport, {
        minZoom: 0.4,
        maxZoom: 4.5,
        horizontalPadding: 0.94,
        verticalPadding: 0.9,
      });
      const projected = projectDiagramRect(content, camera);
      const horizontalMargin = (viewport.width - viewport.width * 0.94) / 2;
      const verticalMargin = (viewport.height - viewport.height * 0.9) / 2;

      expect(camera.zoom).toBeGreaterThan(1);
      expect(projected.x).toBeGreaterThanOrEqual(horizontalMargin - 0.001);
      expect(projected.x + projected.width).toBeLessThanOrEqual(viewport.width - horizontalMargin + 0.001);
      expect(projected.y).toBeGreaterThanOrEqual(verticalMargin - 0.001);
      expect(projected.y + projected.height).toBeLessThanOrEqual(viewport.height - verticalMargin + 0.001);
      expect(projected.x + projected.width / 2).toBeCloseTo(viewport.width / 2, 6);
      expect(projected.y + projected.height / 2).toBeCloseTo(viewport.height / 2, 6);
    }
  });

  it("keeps an already-large graph inside padding instead of assuming a square viewport", () => {
    const layout = { width: 1000, height: 700 };
    const content = { x: 20, y: 20, width: 960, height: 660 };
    const viewport = { width: 500, height: 400 };
    const camera = fitDiagramCamera(layout, content, viewport);
    const projected = projectDiagramRect(content, camera);

    expect(camera.zoom).toBeLessThan(1);
    expect(projected.width).toBeLessThanOrEqual(viewport.width * 0.94 + 0.001);
    expect(projected.height).toBeLessThanOrEqual(viewport.height * 0.9 + 0.001);
    expect(projected.x + projected.width / 2).toBeCloseTo(viewport.width / 2, 6);
    expect(projected.y + projected.height / 2).toBeCloseTo(viewport.height / 2, 6);
    expect(camera.letterbox.y).toBeGreaterThan(0);
  });

  it("derives groups and safely surfaces malformed parent references", () => {
    const graph: LensGraph = {
      components: [
        component("root", { groupId: "services" }),
        component("child", { parentId: "root", groupId: "services" }),
        component("orphan", { parentId: "missing", groupId: "edge" }),
      ],
      connections: [],
    };

    const hierarchy = hierarchyForGraph(graph);

    expect(hierarchy.roots.map((item) => item.id)).toEqual(["root", "orphan"]);
    expect(hierarchy.childrenByParent.get("root")?.map((item) => item.id)).toEqual(["child"]);
    expect(hierarchy.groups.map((group) => group.id)).toEqual(["services", "edge"]);
    expect(hierarchy.malformed).toEqual(["Component orphan references missing parent missing"]);
    expect(graphForComponent(graph, "root")?.components.map((item) => item.id)).toEqual(["child"]);
  });

  it("distinguishes source-only changes from explanation changes", () => {
    const baseline = version("v0", {
      components: [component("api"), component("removed")],
      connections: [],
    });
    const changedSource = component("api", {
      codeAnchors: [
        {
          sourceId: "source:api",
          path: "src/api.ts",
          startLine: 1,
          endLine: 6,
          capturedSha256: "b".repeat(64),
        },
      ],
    });
    const changedExplanation = component("removed", {
      responsibility: "The responsibility has been clarified.",
    });
    const current = version("v1", {
      components: [changedSource, changedExplanation, component("added")],
      connections: [],
    });

    const comparison = compareLensVersions(current, baseline);

    expect(comparison.components.find((item) => item.id === "api")).toMatchObject({
      change: "changed",
      sourceOnly: true,
    });
    expect(comparison.components.find((item) => item.id === "removed")).toMatchObject({
      change: "changed",
      explanationOnly: true,
    });
    expect(comparison.components.find((item) => item.id === "added")?.change).toBe("added");
    expect(comparison.components.some((item) => item.id === "removed" && item.current === null)).toBe(false);
    expect(comparison.sourceOnlyChanges).toBe(1);
    expect(comparison.explanationOnlyChanges).toBe(1);
  });

  it("does not call an incompletely analyzed absence a removal", () => {
    const baseline = version("v0", {
      components: [component("api"), component("possibly-missing")],
      connections: [],
    });
    const current = version(
      "v1",
      { components: [component("api")], connections: [] },
      { unresolved: [{ path: "src/unknown.ts", kind: "code", status: "unresolved" }] },
    );

    const comparison = compareLensVersions(current, baseline);

    expect(comparison.canConfirmRemovals).toBe(false);
    expect(comparison.components.find((item) => item.id === "possibly-missing")?.change).toBe("uncertain");
    expect(comparison.uncertainty).toHaveLength(1);
  });

  it("keeps layout deterministic and reserves space for removed baseline nodes", () => {
    const baseline = version("v0", {
      components: [component("api"), component("old")],
      connections: [],
    });
    const current = version("v1", { components: [component("api")], connections: [] });
    const comparison = compareLensVersions(current, baseline);

    const first = stableLayout(current.graph, comparison);
    const second = stableLayout(current.graph, comparison);

    expect([...first.nodes.entries()]).toEqual([...second.nodes.entries()]);
    expect(first.nodes.has("old")).toBe(true);
    expect(first.groups[0]?.componentIds).toContain("old");
  });

  it("fits every focused child group inside the declared content bounds", () => {
    const graph: LensGraph = {
      components: [
        component("root", { groupId: "surface" }),
        component("edge-child", { parentId: "root", groupId: "edge" }),
        component("async-child", { parentId: "root", groupId: "async" }),
        component("data-child", { parentId: "root", groupId: "data" }),
      ],
      connections: [],
    };
    const comparison = compareLensVersions(version("v1", graph), null);
    const layout = stableLayout(graph, comparison, "root");

    expect(layout.groups.map((group) => group.id)).toEqual(["async", "data", "edge"]);
    for (const group of layout.groups) {
      expect(group.rect.x).toBeGreaterThanOrEqual(0);
      expect(group.rect.x + group.rect.width).toBeLessThanOrEqual(
        layout.contentBounds.x + layout.contentBounds.width,
      );
      for (const id of group.componentIds) {
        const node = layout.nodes.get(id)!;
        expect(node.x).toBeGreaterThan(group.rect.x);
        expect(node.x + node.width).toBeLessThan(group.rect.x + group.rect.width);
        expect(node.y + node.height).toBeLessThan(group.rect.y + group.rect.height);
      }
    }
    expect(Math.max(...layout.groups.map((group) => group.rect.x + group.rect.width))).toBeLessThanOrEqual(layout.width);
  });

  it("keeps parallel same-group edge labels in bounds without overlap", () => {
    const nodes = ["api", "store", "cache", "queue"].map((id) => component(id, { groupId: "runtime" }));
    const graph: LensGraph = {
      components: nodes,
      connections: [
        ["a", "api", "store", "calls", "read api"],
        ["b", "api", "store", "writes", "writes the current value back under the same key"],
        ["c", "store", "api", "publishes", "publishes invalidation"],
        ["d", "cache", "queue", "depends-on", "queues a retry"],
      ].map(([id, fromComponentId, toComponentId, type, label]) => ({
        id,
        fromComponentId,
        toComponentId,
        type: type as LensGraph["connections"][number]["type"],
        direction: "forward" as const,
        label,
        provenance: "extracted" as const,
        state: "implemented" as const,
        evidence: [],
      })),
    };
    const comparison = compareLensVersions(version("v1", graph), null);
    const layout = stableLayout(graph, comparison);
    const routes = routeConnections(graph.connections, layout);
    const boxes = [...routes.values()].map((route) => ({
      left: route.label.x - route.label.width / 2,
      right: route.label.x + route.label.width / 2,
      top: route.label.y - route.label.height / 2,
      bottom: route.label.y + route.label.height / 2,
    }));

    expect(routes.size).toBe(4);
    expect(boxes.every((box) => box.left >= 0 && box.right <= layout.width && box.top >= 0 && box.bottom <= layout.height)).toBe(true);
    const nodeBoxes = [...layout.nodes.values()];
    expect(boxes.every((box) => nodeBoxes.every((node) =>
      box.right <= node.x || node.x + node.width <= box.left ||
      box.bottom <= node.y || node.y + node.height <= box.top,
    ))).toBe(true);
    for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
        const left = boxes[leftIndex]!;
        const right = boxes[rightIndex]!;
        const overlaps = left.left < right.right && right.left < left.right && left.top < right.bottom && right.top < left.bottom;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("keeps each dense reverse-pair label nearest to its own cubic route", () => {
    const ids = ["api", "store", "cache", "queue", "audit"];
    const nodes = ids.map((id) => component(id, { groupId: "runtime" }));
    const pairs: [string, string, string, string][] = [
      ["a", "api", "store", "writes the current value back under the same key"],
      ["b", "store", "api", "publishes an invalidation for the same record"],
      ["c", "api", "cache", "reads a warm value before the store"],
      ["d", "cache", "api", "returns the cached record to the caller"],
      ["e", "queue", "store", "hands durable work to the record store"],
      ["f", "store", "queue", "requeues a recoverable failure for retry"],
      ["g", "audit", "store", "records a lifecycle audit event"],
      ["h", "api", "queue", "dispatches scheduled work to the runtime queue"],
    ];
    const graph: LensGraph = {
      components: nodes,
      connections: pairs.map(([id, fromComponentId, toComponentId, label]) => ({
        id,
        fromComponentId,
        toComponentId,
        type: "calls",
        direction: "forward",
        label,
        provenance: "extracted",
        state: "implemented",
        evidence: [],
      })),
    };
    const comparison = compareLensVersions(version("v1", graph), null);
    const layout = stableLayout(graph, comparison);
    const routes = routeConnections(graph.connections, layout);

    for (const route of routes.values()) {
      const ownDistance = distanceToPath(route.label, route.path);
      const nearestOther = Math.min(
        ...[...routes.values()]
          .filter((candidate) => candidate.connectionId !== route.connectionId)
          .map((candidate) => distanceToPath(route.label, candidate.path)),
      );
      expect(ownDistance).toBeLessThan(6);
      expect(ownDistance).toBeLessThan(nearestOther);
    }
  });

  it("keeps unchanged node positions when provider order changes", () => {
    const original: LensGraph = {
      components: [component("api", { groupId: "runtime" }), component("store", { groupId: "runtime" }), component("cache", { groupId: "runtime" })],
      connections: [],
    };
    const reordered: LensGraph = {
      components: [component("cache", { groupId: "runtime" }), component("api", { groupId: "runtime" }), component("store", { groupId: "runtime" })],
      connections: [],
    };
    const first = stableLayout(original, compareLensVersions(version("v1", original), null));
    const second = stableLayout(reordered, compareLensVersions(version("v1", reordered), null), null, first);
    for (const id of ["api", "store", "cache"]) {
      expect(second.nodes.get(id)?.y).toBe(first.nodes.get(id)?.y);
    }
  });

  it("reports retained source freshness without claiming an unseen whole-project scan", () => {
    const saved = version("v0", { components: [component("api")], connections: [] });
    saved.sources = [
      {
        id: "source:code:src/api.ts",
        path: "src/api.ts",
        kind: "code",
        wireEncoding: "utf8",
        sha256: hash,
        sizeBytes: 10,
        bytesBase64: "",
        mimeType: "text/typescript",
        modifiedAtMs: 1,
      },
    ];
    const capture = {
      capturedAt: 2,
      sources: saved.sources,
      documentSections: [],
      coverage: saved.coverage,
    };

    expect(assessSourceFreshness(saved, capture, 1)).toMatchObject({
      status: "unknown",
      detail: expect.stringContaining("predates project inventory capture"),
    });
    expect(assessSourceFreshness(saved, {
      ...capture,
      sources: [{ ...saved.sources[0]!, sha256: "b".repeat(64) }],
    }, 1)).toMatchObject({ status: "stale", changedPaths: ["src/api.ts"] });
    expect(assessSourceFreshness(saved, {
      ...capture,
      coverage: { ...capture.coverage, complete: false },
    }, 1)).toMatchObject({ status: "unknown" });
    expect(assessSourceFreshness(saved, capture, 2)).toMatchObject({
      status: "stale",
      changedPaths: ["Project Lens document configuration"],
    });
  });

  it("keeps bounded and unresolved inventory reads unknown while surfacing known differences", () => {
    const saved = version("v0", { components: [component("api")], connections: [] });
    const savedInventory = {
      capturedAt: 1,
      entries: [{ path: "src/api.ts", kind: "code" as const, status: "candidate" as const }],
      totalDiscovered: 2502,
      truncated: true,
      omittedCount: 2501,
    };
    saved.inventory = savedInventory;
    const sameSources = saved.sources;
    const bounded = {
      capturedAt: 2,
      sources: sameSources,
      documentSections: [],
      coverage: saved.coverage,
      inventory: savedInventory,
    };
    expect(assessSourceFreshness(saved, bounded, 1)).toMatchObject({
      status: "unknown",
      changedPaths: [],
    });

    const unresolvedInventory = {
      ...savedInventory,
      entries: [{ path: "src/api.ts", kind: "code" as const, status: "unresolved" as const, reason: "case collision" }],
    };
    const unresolvedVersion = { ...saved, inventory: unresolvedInventory };
    expect(assessSourceFreshness(unresolvedVersion, {
      ...bounded,
      inventory: unresolvedInventory,
    }, 1)).toMatchObject({ status: "unknown" });

    expect(assessSourceFreshness(saved, {
      ...bounded,
      sources: [{ ...sameSources[0]!, sha256: "b".repeat(64) }],
    }, 1)).toMatchObject({ status: "stale" });
  });

  it("keeps additions, deletions, and status changes stale even inside incomplete coverage", () => {
    const saved = version("v0", { components: [component("api")], connections: [] });
    const entries: ProjectInventory["entries"] = [
      { path: "docs/architecture.md", kind: "markdown", status: "candidate" },
      { path: "src/api.ts", kind: "code", status: "candidate" },
      { path: "src/retained.ts", kind: "code", status: "candidate" },
    ];
    const savedInventory: ProjectInventory = {
      capturedAt: 1,
      entries,
      totalDiscovered: 2502,
      truncated: true,
      omittedCount: 2499,
    };
    saved.inventory = savedInventory;
    const capture = (currentEntries: ProjectInventory["entries"], totalDiscovered: number) => ({
      capturedAt: 2,
      sources: saved.sources,
      documentSections: [],
      coverage: saved.coverage,
      inventory: {
        ...savedInventory,
        capturedAt: 2,
        entries: currentEntries,
        totalDiscovered,
        omittedCount: totalDiscovered - currentEntries.length,
      },
    });

    expect(assessSourceFreshness(saved, capture([
      ...entries,
      { path: "src/added.ts", kind: "code", status: "candidate" },
    ], 2503), 1)).toMatchObject({
      status: "stale",
      changedPaths: expect.arrayContaining(["src/added.ts"]),
    });
    expect(assessSourceFreshness(saved, capture(entries.slice(0, 2), 2501), 1)).toMatchObject({
      status: "stale",
      changedPaths: expect.arrayContaining(["src/retained.ts"]),
    });
    expect(assessSourceFreshness(saved, capture([
      entries[0]!,
      entries[1]!,
      { path: "src/retained.ts", kind: "code", status: "unresolved", reason: "collision" },
    ], 2502), 1)).toMatchObject({
      status: "stale",
      changedPaths: expect.arrayContaining(["src/retained.ts"]),
    });
  });
});
