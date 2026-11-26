import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useBbContext, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { projectLensScopeFor, projectLensUnsupportedScopeMessage } from "../src/model.js";
import type { rpcContract } from "../server.js";
import type {
  CapturedSource,
  DocumentDiff,
  EvidenceRef,
  LensComponent,
  LensConnection,
  LensGraph,
  LensVersion,
  ProjectLensScope,
  ProjectEnvironmentOption,
  ProjectSummary,
  SynchronizationResult,
} from "../src/model.js";
import type { GenerationJobView } from "../src/generation-jobs.js";
import {
  assessSourceFreshness,
  compareLensVersions,
  diagramScreenScale,
  flattenComponents,
  flattenConnections,
  fitDiagramCamera,
  graphForComponent,
  hierarchyForGraph,
  itemComponent,
  itemConnection,
  itemForComponent,
  itemForConnection,
  routeConnections,
  stableLayout,
  visibleLevelForGraph,
  type DiagramChange,
  type DiagramComparison,
  type DiagramComponentItem,
  type DiagramConnectionItem,
  type DiagramLayout,
  type DiagramRect,
  type DiagramViewport,
  type SourceFreshness,
} from "../src/diagram.js";
import { explicitUpdateLensPolicy } from "../src/refresh-policy.js";
import { synchronizationNoticeStatus } from "../src/synchronization-notice.js";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Icon } from "./ui/icon";

type Selection =
  | { kind: "component"; id: string }
  | { kind: "connection"; id: string }
  | null;

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  panX: number;
  panY: number;
  active: boolean;
}

interface CameraSnapshot {
  layout: DiagramLayout;
  viewport: DiagramViewport;
  zoom: number;
  pan: { x: number; y: number };
}

export interface LensPanelFixture {
  project: ProjectSummary;
  environment: ProjectEnvironmentOption;
  versions: LensVersion[];
  copy: {
    historyNotice: string;
    freshnessDetail: string;
    readOnlyError: string;
    title: string;
    detail: string;
  };
}

interface DiagramCanvasProps {
  graph: LensGraph;
  comparison: DiagramComparison;
  selection: Selection;
  focusId: string | null;
  layoutScopeKey: string;
  query: string;
  onSelect: (selection: Selection) => void;
  onOpenFlow: (componentId: string) => void;
}

interface EvidenceSelection {
  sourceId: string;
  kind: "code" | "markdown";
  startLine: number | null;
  endLine: number | null;
  sectionAnchor?: string;
}

const statusLabel: Record<DiagramChange, string> = {
  added: "Added",
  changed: "Changed",
  removed: "Removed",
  uncertain: "Review",
  unchanged: "",
};

function statusClass(change: DiagramChange): string {
  switch (change) {
    case "added":
      return "text-emerald-600";
    case "changed":
      return "text-amber-600";
    case "removed":
      return "text-destructive";
    case "uncertain":
      return "text-muted-foreground";
    case "unchanged":
      return "text-muted-foreground";
  }
}

function statusMarker(change: DiagramChange): string {
  return statusLabel[change];
}

function changeCopy(change: DiagramChange): string {
  return change === "uncertain"
    ? "Baseline item needs review because the latest analysis is incomplete."
    : statusLabel[change] || "No structural change";
}

function changeCue(item: DiagramComponentItem | DiagramConnectionItem): string {
  if (item.change !== "changed") return "";
  const cues = [
    ...(item.sourceOnly ? ["Source change"] : []),
    ...(item.explanationOnly ? ["Explanation change"] : []),
    ...(item.architectureChanged ? ["Architecture change"] : []),
  ];
  return cues.length === 0 ? "Multiple changes" : cues.join(" · ");
}

function visibleStatusDetail(item: DiagramComponentItem | DiagramConnectionItem): string {
  const status = statusLabel[item.change] || "Unchanged";
  const cue = changeCue(item);
  return cue === "" ? status : `${status} · ${cue}`;
}

function shortHash(value: string | undefined): string {
  return value === undefined ? "unknown" : value.slice(0, 12);
}

function formatTimestamp(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function environmentOptionLabel(environment: ProjectEnvironmentOption): string {
  if (environment.status === "unavailable") return `History only · ${environment.id}`;
  const name = environment.name ?? "Unnamed workspace";
  const branch = environment.branchName === null ? "detached" : environment.branchName;
  const host = environment.hostName === null ? "host unavailable" : environment.hostName;
  const status = environment.status === "ready" ? "Ready" : environment.status;
  return `${status} · ${name} · ${branch} · ${host}`;
}

function sourceText(source: CapturedSource): string {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(source.bytesBase64), (character) => character.charCodeAt(0)));
  } catch {
    return "This captured source is not valid UTF-8 text.";
  }
}

function sourceLanguage(path: string, kind: "code" | "markdown"): string {
  if (kind === "markdown") return "markdown";
  const extension = path.split(".").pop()?.toLowerCase();
  return extension === "tsx" || extension === "jsx" ? "tsx" : extension ?? "text";
}

function sourceLineRange(source: string, startLine: number | null, endLine: number | null): { from: number; to: number } {
  const lines = source.split(/\r?\n/);
  const from = Math.max(1, startLine ?? 1);
  const to = Math.min(lines.length, endLine ?? lines.length);
  return { from, to };
}

function evidenceSelectionFromRef(evidence: EvidenceRef): EvidenceSelection {
  return {
    sourceId: evidence.sourceId,
    kind: evidence.kind,
    startLine: evidence.startLine,
    endLine: evidence.endLine,
    ...(evidence.sectionAnchor === undefined ? {} : { sectionAnchor: evidence.sectionAnchor }),
  };
}

function componentEvidence(component: LensComponent): EvidenceRef[] {
  const mappingEvidence: EvidenceRef[] = component.documentMappings.map((mapping) => ({
    sourceId: mapping.sourceId,
    kind: "markdown",
    path: mapping.documentPath,
    claim: mapping.claim,
    capturedSha256: mapping.capturedSha256,
    startLine: null,
    endLine: null,
    sectionAnchor: mapping.sectionAnchor,
    provenance: mapping.provenance,
  }));
  return [...component.evidence, ...mappingEvidence];
}

function componentNames(graph: LensGraph): Map<string, string> {
  return new Map(flattenComponents(graph).map((component) => [component.id, component.name]));
}

function canvasComponents(
  graph: LensGraph,
  comparison: DiagramComparison,
  focusId: string | null,
  query: string,
): DiagramComponentItem[] {
  const visible = focusId === null ? hierarchyForGraph(graph).roots : visibleLevelForGraph(graph, focusId).components;
  const visibleIds = new Set(visible.map((component) => component.id));
  const normalizedQuery = query.trim().toLowerCase();
  return comparison.components.filter((item) => {
    const component = itemComponent(item);
    if (component === null) return false;
    const atLevel = focusId === null ? component.parentId === null : component.parentId === focusId;
    const isVisibleCurrent = item.current !== null && visibleIds.has(item.current.id);
    const isVisibleRemoved = item.current === null && atLevel;
    if (!isVisibleCurrent && !isVisibleRemoved) return false;
    if (normalizedQuery === "") return true;
    return `${component.name} ${component.responsibility}`.toLowerCase().includes(normalizedQuery);
  });
}

function canvasConnections(
  graph: LensGraph,
  comparison: DiagramComparison,
  visibleItems: readonly DiagramComponentItem[],
): DiagramConnectionItem[] {
  const ids = new Set(visibleItems.map((item) => itemComponent(item)?.id).filter((id): id is string => id !== undefined));
  return comparison.connections.filter((item) => {
    const connection = itemConnection(item);
    return connection !== null && ids.has(connection.fromComponentId) && ids.has(connection.toComponentId);
  });
}


function SvgBadge({ change, x, y }: { change: DiagramChange; x: number; y: number }) {
  const label = statusMarker(change);
  if (label === "") return null;
  const width = Math.max(34, label.length * 7 + 16);
  return (
    <g className={`diagram-badge ${statusClass(change)}`} transform={`translate(${x - width} ${y})`}>
      <rect width={width} height={20} rx={10} />
      <text x={width / 2} y={14} textAnchor="middle">{label}</text>
    </g>
  );
}

function DiagramCanvas({
  graph,
  comparison,
  selection,
  focusId,
  layoutScopeKey,
  query,
  onSelect,
  onOpenFlow,
}: DiagramCanvasProps) {
  const markerId = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const layoutMemory = useRef(new Map<string, DiagramLayout>());
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [cameraScope, setCameraScope] = useState("Overview");
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const cameraRef = useRef<CameraSnapshot | null>(null);
  const items = useMemo(() => canvasComponents(graph, comparison, focusId, query), [comparison, focusId, graph, query]);
  const connections = useMemo(() => canvasConnections(graph, comparison, items), [comparison, graph, items]);
  const layout = useMemo(() => stableLayout(
    graph,
    comparison,
    focusId,
    layoutMemory.current.get(layoutScopeKey) ?? null,
    viewportSize,
  ), [comparison, focusId, graph, layoutScopeKey, viewportSize]);
  useEffect(() => {
    layoutMemory.current.set(layoutScopeKey, layout);
    if (layoutMemory.current.size > 12) {
      const firstKey = layoutMemory.current.keys().next().value;
      if (typeof firstKey === "string" && firstKey !== layoutScopeKey) layoutMemory.current.delete(firstKey);
    }
  }, [layout, layoutScopeKey]);
  const routes = useMemo(
    () => routeConnections(
      connections
        .map(itemConnection)
        .filter((connection): connection is LensConnection => connection !== null),
      layout,
    ),
    [connections, layout],
  );
  const nodeIds = new Set(items.map((item) => itemComponent(item)?.id).filter((id): id is string => id !== undefined));
  cameraRef.current = { layout, viewport: viewportSize, zoom, pan };

  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const updateViewport = () => {
      const box = svg.getBoundingClientRect();
      setViewportSize({ width: box.width, height: box.height });
    };
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const zoomMinimum = 0.4;
  const zoomMaximum = 4.5;
  const centerOnBounds = useCallback((bounds: { x: number; y: number; width: number; height: number }, nextZoom: number) => {
    setZoom(nextZoom);
    setPan({
      x: layout.width / 2 - (bounds.x + bounds.width / 2) * nextZoom,
      y: layout.height / 2 - (bounds.y + bounds.height / 2) * nextZoom,
    });
  }, [layout.height, layout.width]);
  const applyZoomAroundPoint = useCallback((localX: number, localY: number, nextZoom: number, nextScope = "Custom camera") => {
    const camera = cameraRef.current;
    if (camera === null) return;
    const currentPoint = {
      x: (localX - camera.pan.x) / camera.zoom,
      y: (localY - camera.pan.y) / camera.zoom,
    };
    setZoom(nextZoom);
    setPan({
      x: localX - currentPoint.x * nextZoom,
      y: localY - currentPoint.y * nextZoom,
    });
    setCameraScope(nextScope);
  }, []);
  const zoomAtViewportCenter = useCallback((nextZoom: number) => {
    const camera = cameraRef.current;
    if (camera === null || camera.viewport.width <= 0 || camera.viewport.height <= 0) {
      applyZoomAroundPoint(layout.width / 2, layout.height / 2, nextZoom);
      return;
    }
    const scale = diagramScreenScale(camera.layout, camera.viewport);
    const letterboxX = (camera.viewport.width - camera.layout.width * scale) / 2;
    const letterboxY = (camera.viewport.height - camera.layout.height * scale) / 2;
    applyZoomAroundPoint(
      (camera.viewport.width / 2 - letterboxX) / scale,
      (camera.viewport.height / 2 - letterboxY) / scale,
      nextZoom,
    );
  }, [applyZoomAroundPoint, layout.height, layout.width]);
  const focusNode = useCallback((componentId: string) => {
    const node = layout.nodes.get(componentId);
    if (node === undefined || viewportSize.width <= 0 || viewportSize.height <= 0) return;
    const scale = diagramScreenScale(layout, viewportSize);
    const readableZoom = Math.min(
      zoomMaximum,
      Math.max(
        0.8,
        14 / Math.max(1, 16 * scale),
        12 / Math.max(1, 13 * scale),
      ),
    );
    setCameraScope("Focused component");
    centerOnBounds(node, readableZoom);
  }, [centerOnBounds, layout, viewportSize]);
  const fitView = useCallback(() => {
    if (viewportSize.width <= 0 || viewportSize.height <= 0) return;
    const camera = fitDiagramCamera(layout, layout.contentBounds, viewportSize, {
      minZoom: zoomMinimum,
      maxZoom: zoomMaximum,
      horizontalPadding: 1,
      verticalPadding: 0.96,
    });
    setCameraScope("Overview");
    setZoom(camera.zoom);
    setPan(camera.pan);
  }, [layout, viewportSize]);

  useEffect(() => {
    fitView();
  }, [
    focusId,
    layout.contentBounds.height,
    layout.contentBounds.width,
    layout.contentBounds.x,
    layout.contentBounds.y,
    layout.height,
    layoutScopeKey,
    layout.width,
    fitView,
    viewportSize.height,
    viewportSize.width,
  ]);

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
      active: false,
    };
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      const camera = cameraRef.current;
      if (camera === null) return;
      event.preventDefault();
      const box = svg.getBoundingClientRect();
      const scale = diagramScreenScale(camera.layout, camera.viewport);
      const letterboxX = (box.width - camera.layout.width * scale) / 2;
      const letterboxY = (box.height - camera.layout.height * scale) / 2;
      const localX = (event.clientX - box.left - letterboxX) / scale;
      const localY = (event.clientY - box.top - letterboxY) / scale;
      const nextZoom = Math.min(
        zoomMaximum,
        Math.max(zoomMinimum, camera.zoom + (event.deltaY < 0 ? 0.12 : -0.12)),
      );
      applyZoomAroundPoint(localX, localY, nextZoom);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [applyZoomAroundPoint]);

  useEffect(() => {
    const onPointerMove = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      const camera = cameraRef.current;
      if (drag === null || camera === null || drag.pointerId !== event.pointerId) return;
      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;
      if (!drag.active && Math.hypot(deltaX, deltaY) < 6) return;
      if (!drag.active) {
        drag.active = true;
        suppressClickRef.current = true;
      }
      const scale = diagramScreenScale(camera.layout, camera.viewport);
      setPan({
        x: drag.panX + deltaX / scale,
        y: drag.panY + deltaY / scale,
      });
      setCameraScope("Custom camera");
    };
    const onPointerUp = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      if (drag.active) suppressClickRef.current = true;
      dragRef.current = null;
    };
    const onPointerCancel = (event: globalThis.PointerEvent) => {
      if (dragRef.current?.pointerId === event.pointerId) {
        dragRef.current = null;
        suppressClickRef.current = false;
      }
    };
    const onClickCapture = (event: globalThis.MouseEvent) => {
      if (!suppressClickRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClickRef.current = false;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("click", onClickCapture, true);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("click", onClickCapture, true);
    };
  }, []);

  const activate = (next: Selection) => (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(next);
    }
  };

  return (
    <div className="diagram-stage" data-testid="diagram-stage">
      <div className="diagram-stage-tools" aria-label="Diagram controls">
        <Button type="button" variant="ghost" size="sm" onClick={() => zoomAtViewportCenter(Math.min(zoomMaximum, zoom + 0.12))} aria-label="Zoom in">
          <Icon name="ZoomIn" aria-hidden="true" />
        </Button>
        <span className="diagram-zoom-label" aria-live="polite">{Math.round(zoom * 100)}%</span>
        <span className="diagram-camera-scope" aria-live="polite">{cameraScope}</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => zoomAtViewportCenter(Math.max(zoomMinimum, zoom - 0.12))} aria-label="Zoom out">
          <Icon name="ZoomOut" aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={fitView} aria-label="Fit view">
          Fit overview
        </Button>
      </div>
      <div className="diagram-change-summary" role="status" aria-label="Diagram change summary">
        {comparison.baselineVersionId === null ? <span className="diagram-summary-neutral">Live graph · no comparison</span> : null}
        {comparison.baselineVersionId !== null && comparison.components.filter((item) => item.sourceOnly).length > 0 ? (
          <span className="diagram-summary-chip is-source">{comparison.components.filter((item) => item.sourceOnly).length} Source change{comparison.components.filter((item) => item.sourceOnly).length === 1 ? "" : "s"}</span>
        ) : null}
        {comparison.baselineVersionId !== null && comparison.components.filter((item) => item.explanationOnly).length > 0 ? (
          <span className="diagram-summary-chip is-explanation">{comparison.components.filter((item) => item.explanationOnly).length} Explanation change{comparison.components.filter((item) => item.explanationOnly).length === 1 ? "" : "s"}</span>
        ) : null}
        {comparison.baselineVersionId !== null && comparison.components.filter((item) => item.architectureChanged).length > 0 ? (
          <span className="diagram-summary-chip is-architecture">{comparison.components.filter((item) => item.architectureChanged).length} Architecture change{comparison.components.filter((item) => item.architectureChanged).length === 1 ? "" : "s"}</span>
        ) : null}
        {comparison.uncertainty.length > 0 ? <span className="diagram-summary-chip is-review">Review · incomplete analysis</span> : null}
      </div>
      <svg
        ref={svgRef}
        className="diagram-svg"
        role="application"
        aria-label={`Project Lens component diagram. ${cameraScope}. Use Tab to move through components and connections.`}
        data-camera-scope={cameraScope}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        onPointerDown={onPointerDown}
      >
        <defs>
          <pattern id={`${markerId}-grid`} width="22" height="22" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1" className="diagram-dot" />
          </pattern>
          {(["added", "changed", "removed", "uncertain", "unchanged"] as const).map((change) => (
            <marker key={change} id={`${markerId}-${change}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className={`diagram-arrow ${statusClass(change)}`} />
            </marker>
          ))}
        </defs>
        <rect width={layout.width} height={layout.height} className="diagram-background" fill={`url(#${markerId}-grid)`} />
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          {layout.groups.map((group) => (
            <g key={group.id}>
              <rect {...group.rect} rx="16" className="diagram-group-surface" />
              <text x={group.rect.x + 22} y={group.rect.y + 28} className="diagram-group-label">{group.label.toUpperCase()}</text>
              <text x={group.rect.x + group.rect.width - 22} y={group.rect.y + 28} textAnchor="end" className="diagram-group-count">{group.componentIds.length} nodes</text>
            </g>
          ))}
          {connections.map((item) => {
            const connection = itemConnection(item);
            if (connection === null) return null;
            const route = routes.get(connection.id);
            if (route === undefined) return null;
            const selected = selection?.kind === "connection" && selection.id === item.id;
            return (
              <g key={item.id} className={`diagram-connection-group ${selected ? "is-selected" : ""}`} data-change={item.change}>
                <path
                  d={route.path}
                  className={`diagram-edge ${statusClass(item.change)} ${item.change === "removed" ? "is-dashed" : item.change === "uncertain" ? "is-dotted" : item.change === "added" ? "is-added" : ""}`}
                  markerEnd={`url(#${markerId}-${item.change})`}
                />
                <path
                  d={route.path}
                  className="diagram-edge-hit"
                  role="button"
                  tabIndex={0}
                  aria-label={`${connection.label}, ${changeCopy(item.change)}`}
                  onClick={(event) => { event.stopPropagation(); onSelect({ kind: "connection", id: item.id }); }}
                  onKeyDown={activate({ kind: "connection", id: item.id })}
                />
                <g className={`diagram-edge-label ${statusClass(item.change)}`} transform={`translate(${route.label.x} ${route.label.y})`}>
                  <rect x={-route.label.width / 2} y={-route.label.height / 2} width={route.label.width} height={route.label.height} rx={8} />
                  <text className="diagram-edge-status" x={-route.label.width / 2 + 10} y={-route.label.height / 2 + 14}>{visibleStatusDetail(item)}</text>
                  {route.labelLines.map((line, lineIndex) => (
                    <text
                      key={`${line}-${lineIndex}`}
                      className="diagram-edge-copy"
                      y={-route.label.height / 2 + 29 + lineIndex * 16}
                      textAnchor="middle"
                      textLength={line.length > 20 ? Math.max(1, route.label.width - 24) : undefined}
                      lengthAdjust="spacingAndGlyphs"
                    >
                      {line}
                    </text>
                  ))}
                  <title>{`${connection.label} · ${visibleStatusDetail(item)}`}</title>
                </g>
              </g>
            );
          })}
          {items.map((item) => {
            const component = itemComponent(item);
            if (component === null) return null;
            const rect = layout.nodes.get(component.id);
            if (rect === undefined || !nodeIds.has(component.id)) return null;
            const selected = selection?.kind === "component" && selection.id === item.id;
            const childCount = graphForComponent(graph, component.id)?.components.length ?? 0;
            return (
              <g
                key={item.id}
                className={`diagram-node ${selected ? "is-selected" : ""} ${item.change === "removed" || item.change === "uncertain" ? "is-ghost" : ""}`}
                data-change={item.change}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`${component.name}. ${component.responsibility}. ${changeCopy(item.change)}`}
                onClick={(event) => { event.stopPropagation(); onSelect({ kind: "component", id: item.id }); }}
                onDoubleClick={(event) => { event.stopPropagation(); if (childCount > 0 || component.nestedFlow !== undefined) onOpenFlow(component.id); }}
                onKeyDown={activate({ kind: "component", id: item.id })}
              >
                <rect {...rect} rx="12" className={`diagram-node-surface ${statusClass(item.change)}`} />
                <rect x={rect.x + 16} y={rect.y + 14} width="30" height="30" rx="9" className="diagram-node-glyph" />
                <text x={rect.x + 58} y={rect.y + 31} className="diagram-node-name">{component.name}</text>
                <text x={rect.x + 58} y={rect.y + 49} className="diagram-node-responsibility">{component.state} · {component.provenance}</text>
                {changeCue(item) !== "" ? <text x={rect.x + 58} y={rect.y + 67} className="diagram-node-change-cue">{changeCue(item)}</text> : null}
                <text x={rect.x + 31} y={rect.y + 35} textAnchor="middle" className="diagram-node-glyph-text">{component.name.slice(0, 1).toUpperCase()}</text>
                <SvgBadge change={item.change} x={rect.x + rect.width - 16} y={rect.y - 10} />
                {childCount > 0 || component.nestedFlow !== undefined ? (
                  <g
                    className="diagram-node-open"
                    role="button"
                    tabIndex={0}
                    aria-label={"Open internal flow for " + component.name}
                    onClick={(event) => { event.stopPropagation(); onOpenFlow(component.id); }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        onOpenFlow(component.id);
                      }
                    }}
                  >
                    <rect x={rect.x + rect.width - 82} y={rect.y + rect.height - 25} width="68" height="19" rx="6" />
                    <text x={rect.x + rect.width - 48} y={rect.y + rect.height - 12} textAnchor="middle">Open flow</text>
                  </g>
                ) : null}
                <title>{component.name}: {component.responsibility}</title>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="diagram-text-nav" aria-label="Text navigation">
        <div className="diagram-text-nav-heading">
          <span>Text navigation</span>
          <span className="text-muted-foreground">{items.length} visible</span>
        </div>
        <div className="diagram-text-nav-list">
          {items.map((item) => {
            const component = itemComponent(item);
            if (component === null) return null;
            return (
              <button
                key={item.id}
                type="button"
                className={`diagram-text-nav-item ${selection?.kind === "component" && selection.id === item.id ? "is-selected" : ""}`}
                onClick={() => {
                  onSelect({ kind: "component", id: item.id });
                  focusNode(component.id);
                }}
              >
                <span>{component.name}</span>
                {statusLabel[item.change] ? <span className={statusClass(item.change)}> · {statusLabel[item.change]}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function EvidenceButton({
  evidence,
  selected,
  onSelect,
}: {
  evidence: EvidenceRef;
  selected: boolean;
  onSelect: (selection: EvidenceSelection) => void;
}) {
  return (
    <button
      type="button"
      className={`evidence-item ${selected ? "is-selected" : ""}`}
      onClick={() => onSelect(evidenceSelectionFromRef(evidence))}
    >
      <span className="evidence-item-kind">{evidence.kind === "code" ? "CODE" : "MD"}</span>
      <span className="evidence-item-main">
        <span className="evidence-item-path">{evidence.path}{evidence.sectionAnchor ? `#${evidence.sectionAnchor}` : ""}</span>
        <span className="evidence-item-claim">{evidence.claim}</span>
      </span>
      <span className="evidence-item-range">{evidence.startLine === null ? "section" : `L${evidence.startLine}${evidence.endLine === null ? "" : `–${evidence.endLine}`}`}</span>
    </button>
  );
}

function SnapshotViewer({
  version,
  selection,
}: {
  version: LensVersion;
  selection: EvidenceSelection | null;
}) {
  const source = selection === null ? null : version.sources.find((candidate) => candidate.id === selection.sourceId) ?? null;
  if (source === null || selection === null) {
    return (
      <div className="evidence-empty">
        <Icon name="Code" aria-hidden="true" />
        <p>Select a code or Markdown reference to open its saved bytes.</p>
        <span>Historical Lens versions never read through the current workspace.</span>
      </div>
    );
  }
  const text = sourceText(source);
  const lines = text.split(/\r?\n/);
  const range = sourceLineRange(text, selection.startLine, selection.endLine);
  const language = sourceLanguage(source.path, selection.kind);
  return (
    <div className="snapshot-viewer">
      <div className="snapshot-meta">
        <span className="snapshot-kind">{language}</span>
        <span>{source.path}</span>
        <span className="snapshot-hash" title={source.sha256}>sha {shortHash(source.sha256)}</span>
      </div>
      {selection.sectionAnchor ? <div className="snapshot-anchor">Section #{selection.sectionAnchor}</div> : null}
      <pre className="snapshot-code" aria-label={`Captured ${selection.kind} source ${source.path}`}>
        {lines.map((line, index) => {
          const lineNumber = index + 1;
          const active = lineNumber >= range.from && lineNumber <= range.to;
          return (
            <span key={`${lineNumber}-${line}`} className={`snapshot-line ${active ? "is-active" : ""}`}>
              <span className="snapshot-line-number">{String(lineNumber).padStart(3, " ")}</span>
              <span className="snapshot-line-content">{line || " "}</span>
            </span>
          );
        })}
      </pre>
      <div className="snapshot-footer">Captured bytes · {source.sizeBytes.toLocaleString()} bytes · {formatTimestamp(version.createdAt)}</div>
    </div>
  );
}

function EvidenceInspector({
  version,
  baseline,
  comparison,
  selection,
  onSelectEvidence,
  onOpenFlow,
  graph,
}: {
  version: LensVersion;
  baseline: LensVersion | null;
  comparison: DiagramComparison;
  selection: Selection;
  onSelectEvidence: (selection: EvidenceSelection) => void;
  onOpenFlow: (componentId: string) => void;
  graph: LensGraph;
}) {
  const [evidenceSelection, setEvidenceSelection] = useState<EvidenceSelection | null>(null);
  const selectedItem = selection?.kind === "component"
    ? itemForComponent(comparison, selection.id)
    : selection?.kind === "connection"
      ? itemForConnection(comparison, selection.id)
      : null;
  const selectedComponent = selection?.kind === "component" && selectedItem !== null
    ? itemComponent(selectedItem as DiagramComponentItem)
    : null;
  const selectedConnection = selection?.kind === "connection" && selectedItem !== null
    ? itemConnection(selectedItem as DiagramConnectionItem)
    : null;
  const names = componentNames(graph);
  const effectiveEvidence = useMemo(
    () => selectedComponent === null ? selectedConnection?.evidence ?? [] : componentEvidence(selectedComponent),
    [selectedComponent, selectedConnection],
  );
  const firstEvidence = effectiveEvidence[0];

  useEffect(() => {
    if (firstEvidence === undefined) {
      setEvidenceSelection(null);
      return;
    }
    setEvidenceSelection(evidenceSelectionFromRef(firstEvidence));
  }, [firstEvidence?.endLine, firstEvidence?.sectionAnchor, firstEvidence?.sourceId, firstEvidence?.startLine, selection?.id, selection?.kind]);

  useEffect(() => {
    if (evidenceSelection !== null) onSelectEvidence(evidenceSelection);
  }, [evidenceSelection, onSelectEvidence]);

  return (
    <aside className="lens-inspector" aria-label="Lens evidence">
      <div className="inspector-header">
        <div>
          <p className="eyebrow">Evidence panel</p>
          <h2>{selectedComponent?.name ?? selectedConnection?.label ?? "Select an item"}</h2>
        </div>
        {selectedItem !== null ? <span className={`status-pill ${statusClass(selectedItem.change)}`}>{statusLabel[selectedItem.change] || "Unchanged"}</span> : null}
      </div>
      {selectedItem === null ? (
        <div className="inspector-empty">
          <Icon name="Target" aria-hidden="true" />
          <p>Choose a component or connection to inspect its responsibility, source proof, and documented claims.</p>
        </div>
      ) : (
        <div className="inspector-content">
          <div className="inspector-summary">
            <p>{selectedComponent?.responsibility ?? selectedConnection?.label}</p>
            {selectedConnection ? (
              <div className="inspector-relationship">
                <span>{names.get(selectedConnection.fromComponentId) ?? selectedConnection.fromComponentId}</span>
                <span aria-hidden="true">→</span>
                <span>{names.get(selectedConnection.toComponentId) ?? selectedConnection.toComponentId}</span>
                <span className="inspector-relationship-type">{selectedConnection.type}</span>
              </div>
            ) : null}
            <div className="inspector-facts">
              <span>{selectedComponent?.state ?? selectedConnection?.state}</span>
              <span>{selectedComponent?.provenance ?? selectedConnection?.provenance}</span>
              {selectedItem.sourceOnly ? <span className="text-amber-600">Source only</span> : null}
              {selectedItem.explanationOnly ? <span className="text-amber-600">Explanation only</span> : null}
              {selectedItem.architectureChanged ? <span>Architecture</span> : null}
            </div>
            {selectedComponent !== null && graphForComponent(graph, selectedComponent.id) !== null ? (
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenFlow(selectedComponent.id)}>
                <Icon name="ArrowRight" aria-hidden="true" />
                Open internal flow
              </Button>
            ) : null}
          </div>
          <section className="inspector-section">
            <div className="inspector-section-heading">
              <h3>Source references</h3>
              <span>{effectiveEvidence.length}</span>
            </div>
            {effectiveEvidence.length === 0 ? <p className="muted-copy">No captured evidence was attached to this item.</p> : null}
            <div className="evidence-list">
              {effectiveEvidence.map((evidence, index) => (
                <EvidenceButton
                  key={`${evidence.sourceId}-${evidence.path}-${evidence.sectionAnchor ?? index}`}
                  evidence={evidence}
                  selected={evidenceSelection?.sourceId === evidence.sourceId && evidenceSelection?.sectionAnchor === evidence.sectionAnchor}
                  onSelect={(next) => setEvidenceSelection(next)}
                />
              ))}
            </div>
          </section>
          <section className="inspector-section snapshot-section">
            <div className="inspector-section-heading">
              <h3>Captured snapshot</h3>
              <span className="snapshot-badge">immutable</span>
            </div>
            <SnapshotViewer version={version} selection={evidenceSelection} />
            {baseline !== null && selectedItem.baseline !== null ? (
              <p className="comparison-note">Comparison baseline: Lens {baseline.versionNumber}. Select another reference above to inspect the current bytes.</p>
            ) : null}
          </section>
        </div>
      )}
    </aside>
  );
}

function CoverageNotice({ version, comparison }: { version: LensVersion; comparison: DiagramComparison }) {
  const unresolved = version.coverage.unresolved.length + version.coverage.missing.length + version.coverage.unsupported.length + version.coverage.escaped.length;
  const unknown = version.coverage.unknownAreas?.length ?? 0;
  if (unresolved === 0 && unknown === 0 && comparison.uncertainty.length === 0) return null;
  return (
    <div className="coverage-notice" role="status">
      <Icon name="AlertCircle" aria-hidden="true" />
      <div>
        <strong>Analysis needs context</strong>
        {version.analysisCoverage ? <span>{version.analysisCoverage.suppliedSourceIds.length}/{version.sources.length} captured sources supplied across {version.analysisCoverage.evidencePasses} evidence batches. {version.analysisCoverage.unrepresentedSourceIds.length > 0 ? `${version.analysisCoverage.unrepresentedSourceIds.length} supplied sources have no component or connection reference.` : ""}</span> : null}
        <span>{unresolved > 0 ? `${unresolved} source area${unresolved === 1 ? "" : "s"} unresolved. ` : ""}{unknown > 0 ? `${unknown} unknown area${unknown === 1 ? "" : "s"} retained. ` : ""}Baseline-only items stay marked for review, not Removed.</span>
      </div>
    </div>
  );
}

function GenerationNotice({
  job,
  onCancel,
}: {
  job: GenerationJobView | null;
  onCancel: () => void;
}) {
  if (job === null) return null;
  const active = job.status === "queued" || job.status === "running" || job.status === "cancelling";
  return (
    <div className={`generation-notice ${job.status === "failed" ? "is-error" : ""}`} role="status">
      <span className={`generation-dot ${active ? "is-running" : ""}`} aria-hidden="true" />
      <div>
        <strong>{job.status === "completed" ? "Lens updated" : job.status === "failed" ? "Lens update failed" : job.status === "cancelled" ? "Lens update cancelled" : "Updating Lens"}</strong>
        <span>{job.status === "failed" ? job.error ?? "The provider did not return a valid Lens." : active ? job.progress ? job.progress.phase === "architecture" ? `Organizing subsystems and connecting flows · ${job.progress.analyzedSources}/${job.progress.totalSources} sources supplied.` : `Analyzing evidence batch ${job.progress.pass} of ${job.progress.totalPasses} · ${job.progress.analyzedSources}/${job.progress.totalSources} sources in completed batches.` : "Capturing the selected project workspace." : job.result ? `Published Lens ${job.result.versionNumber}.` : "The operation has ended."}</span>
      </div>
      {active ? <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button> : null}
    </div>
  );
}

type FreshnessView =
  | { status: "checking" | "unavailable"; detail: string; checkedAt: number | null; changedPaths: string[] }
  | SourceFreshness;

function SourceFreshnessBadge({ freshness }: { freshness: FreshnessView }) {
  const label =
    freshness.status === "checking"
        ? "Checking source freshness…"
        : freshness.status === "fresh"
        ? "Current source snapshot matches"
        : freshness.status === "stale"
          ? "Update needed"
          : freshness.status === "unavailable"
            ? "Freshness unavailable"
            : "Freshness needs context";
  return (
    <span
      className={`freshness-indicator is-${freshness.status}`}
      title={freshness.detail}
      aria-live="polite"
    >
      <span className="freshness-indicator-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function SynchronizationNotice({
  synchronization,
  documentChanges,
  freshness,
  projectScopeSupported,
  hasSelectedEnvironment,
  hasLoadedLens,
}: {
  synchronization: SynchronizationResult | null;
  documentChanges: DocumentDiff[];
  freshness: FreshnessView;
  projectScopeSupported: boolean;
  hasSelectedEnvironment: boolean;
  hasLoadedLens: boolean;
}) {
  const status = synchronizationNoticeStatus({
    projectScopeSupported,
    hasSelectedEnvironment,
    hasLoadedLens,
    synchronization,
    freshnessStatus: freshness.status,
  });
  if (status === null) return null;
  const statusCopy: Record<string, { title: string; detail: string; className: string }> = {
    completed: {
      title: "Builder synchronization recorded",
      detail: "The current source snapshot matches the final code, maintained Markdown and Lens boundary recorded by this operation.",
      className: "is-complete",
    },
    "completed-stale": {
      title: "Update needed after completed synchronization",
      detail: "The last operation completed, but the current source differs from that historical boundary. Reassess the change before claiming this Lens is current.",
      className: "is-pending",
    },
    "completed-unknown": {
      title: "Freshness needs context",
      detail: "The last operation completed, but the current bounded or incomplete read cannot prove whole-project freshness. Update Lens can publish another bounded Lens; do not claim this Lens is fully current.",
      className: "is-pending",
    },
    "completed-unavailable": {
      title: "Freshness unavailable",
      detail: "The last operation completed historically, but the current workspace could not be read. Refresh the workspace before claiming this Lens is current.",
      className: "is-error",
    },
    "completed-checking": {
      title: "Checking current freshness",
      detail: "The last operation completed historically; the current source boundary is still being checked.",
      className: "is-pending",
    },
    "completed-unloaded": {
      title: "Builder synchronization recorded",
      detail: "A completed operation recorded its final code, maintained Markdown and Lens boundary. Load the saved Lens to check current source freshness.",
      className: "is-complete",
    },
    "generation-failed": {
      title: "Markdown updated; Lens generation failed",
      detail: "The document write is retained. Retry the recorded operation after the provider is ready.",
      className: "is-error",
    },
    "documents-written": {
      title: "Markdown updated; Lens publication pending",
      detail: "The builder's document decisions are recorded, but the final Lens is not published yet.",
      className: "is-pending",
    },
    conflict: {
      title: "Synchronization conflict",
      detail: "The parent Lens, configuration, or a document changed. Re-read the current context before starting a fresh synchronization.",
      className: "is-error",
    },
    failed: {
      title: "Synchronization failed",
      detail: "The operation did not establish a final code-to-documents-to-Lens boundary.",
      className: "is-error",
    },
    pending: {
      title: "Synchronization pending",
      detail: "A builder synchronization has started but has not reached final publication.",
      className: "is-pending",
    },
    stale: {
      title: "Update needed",
      detail: "The current source differs from the saved Lens and no builder synchronization result is recorded for it.",
      className: "is-pending",
    },
    unknown: {
      title: "Freshness needs context",
      detail: "The current bounded or incomplete read does not establish whether the saved Lens matches its source paths. Update Lens can publish another bounded Lens; coverage may remain incomplete.",
      className: "is-pending",
    },
    unavailable: {
      title: "Freshness unavailable",
      detail: "The current workspace could not be read for freshness. Refresh the workspace before Update Lens.",
      className: "is-error",
    },
  };
  const copy = statusCopy[status] ?? statusCopy.failed!;
  const documentSummary = synchronization === null
    ? ""
    : synchronization.documents.length === 0
      ? "No configured Markdown decisions were recorded."
      : synchronization.documents.map((document) => `${document.path}: ${document.action}`).join(" · ");
  const changedDocuments = documentChanges.filter((document) => document.status !== "unchanged");
  return (
    <div className={`synchronization-notice ${copy.className}`} role="status" data-testid="synchronization-notice">
      <Icon name={status === "completed" || status === "completed-unloaded" ? "CircleCheck" : status === "conflict" || status === "generation-failed" || status === "failed" || status === "unavailable" || status === "completed-unavailable" ? "AlertCircle" : "Info"} aria-hidden="true" />
      <div>
        <strong>{copy.title}</strong>
        <span>{copy.detail}</span>
        {documentSummary !== "" ? <span className="synchronization-documents">{documentSummary}</span> : null}
        {changedDocuments.length > 0 ? <span className="synchronization-documents">Captured Markdown comparison below: {changedDocuments.map((document) => `${document.path} (${document.status})`).join(" · ")}</span> : null}
      </div>
    </div>
  );
}

function MarkdownComparisonPanel({
  baseline,
  current,
  documentChanges,
}: {
  baseline: LensVersion | null;
  current: LensVersion;
  documentChanges: DocumentDiff[];
}) {
  const changedDocuments = documentChanges.filter((document) => document.status !== "unchanged");
  if (changedDocuments.length === 0) return null;
  return (
    <section className="markdown-comparison" aria-label="Captured Markdown comparison" data-testid="markdown-comparison">
      <div className="markdown-comparison-heading">
        <div>
          <p className="eyebrow">Immutable source evidence</p>
          <h2>Captured Markdown changes</h2>
        </div>
        <span>
          {baseline === null ? "No baseline" : `Lens ${baseline.versionNumber}`} → Lens {current.versionNumber}
        </span>
      </div>
      <p className="comparison-note">
        Before and after sides below are decoded from the selected Lens captures. Live workspace files are not read by this view.
      </p>
      <div className="markdown-comparison-list">
        {changedDocuments.map((document) => (
          <details key={document.path} className="markdown-diff" open>
            <summary>
              <span className="markdown-diff-path">{document.path}</span>
              <span className={`markdown-diff-status is-${document.status}`}>{document.status}</span>
              <span className="markdown-diff-sections">
                {document.changedSections.length === 0 ? "document" : document.changedSections.map((anchor) => `#${anchor}`).join(" · ")}
              </span>
            </summary>
            <div className="markdown-diff-body">
              {document.sections.length === 0 ? (
                <p className="muted-copy">No captured section payload is available for this historical record.</p>
              ) : document.sections.map((section) => (
                <div key={section.anchor} className="markdown-diff-section">
                  <h3>#{section.anchor}</h3>
                  <div className="markdown-diff-sides">
                    <div>
                      <h4>Before · {baseline === null ? "not present" : `Lens ${baseline.versionNumber}`}</h4>
                      {section.beforeText === null ? (
                        <p className="markdown-diff-empty">Not present in the baseline capture.</p>
                      ) : (
                        <pre aria-label={`${document.path} before ${section.anchor}`}>{section.beforeText}</pre>
                      )}
                      {section.beforeTruncated ? <small>Before side is bounded; retrieve the captured source for the full bytes.</small> : null}
                    </div>
                    <div>
                      <h4>After · Lens {current.versionNumber}</h4>
                      {section.afterText === null ? (
                        <p className="markdown-diff-empty">Not present in the current capture.</p>
                      ) : (
                        <pre aria-label={`${document.path} after ${section.anchor}`}>{section.afterText}</pre>
                      )}
                      {section.afterTruncated ? <small>After side is bounded; retrieve the captured source for the full bytes.</small> : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

type LensPanelProps = Partial<PluginNavPanelProps> & { fixture?: LensPanelFixture };

export function LensPanel({ fixture }: LensPanelProps = {}) {
  const rpc = useRpc<typeof rpcContract>();
  const context = useBbContext();
  const controlledFixture = fixture !== undefined;
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [environments, setEnvironments] = useState<ProjectEnvironmentOption[]>([]);
  const [projectId, setProjectId] = useState(context.projectId ?? "");
  const [environmentId, setEnvironmentId] = useState("");
  const [advancedEnvironmentId, setAdvancedEnvironmentId] = useState("");
  const [versions, setVersions] = useState<LensVersion[]>([]);
  const [publishedVersionId, setPublishedVersionId] = useState<string | null>(null);
  const [viewingVersionId, setViewingVersionId] = useState<string | null>(null);
  const [baselineVersionId, setBaselineVersionId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [evidenceSelection, setEvidenceSelection] = useState<EvidenceSelection | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingEnvironments, setLoadingEnvironments] = useState(false);
  const [loadingLens, setLoadingLens] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [job, setJob] = useState<GenerationJobView | null>(null);
  const [synchronization, setSynchronization] = useState<SynchronizationResult | null>(null);
  const [documentChanges, setDocumentChanges] = useState<DocumentDiff[]>([]);
  const [unsupportedScope, setUnsupportedScope] = useState<ProjectLensScope | null>(null);
  const environmentRequestRef = useRef(0);
  const historyRequestRef = useRef(0);
  const [freshness, setFreshness] = useState<FreshnessView>({
    status: "checking",
    checkedAt: null,
    changedPaths: [],
    detail: "Load a Lens to check its retained source paths.",
  });

  const currentProject = projects.find((project) => project.id === projectId);
  const selectedProjectScope = currentProject === undefined
    ? unsupportedScope
    : projectLensScopeFor(currentProject);
  const projectScopeSupported = selectedProjectScope?.status === "supported";

  const publishedVersion = versions.find((version) => version.id === publishedVersionId) ?? null;
  const viewingVersion = versions.find((version) => version.id === viewingVersionId) ?? null;
  const baselineVersion = versions.find((version) => version.id === baselineVersionId) ?? null;
  const comparison = useMemo(
    () => viewingVersion === null ? null : compareLensVersions(viewingVersion, baselineVersion),
    [baselineVersion, viewingVersion],
  );

  const loadControlledFixture = useCallback(() => {
    const published = fixture?.versions.at(-1) ?? null;
    const baseline = fixture?.versions.find((version) => version.versionNumber === 0) ?? fixture?.versions.at(-2) ?? null;
    if (fixture === undefined) return;
    setProjects([fixture.project]);
    setProjectId(fixture.project.id);
    setLoadingProjects(false);
    setEnvironments([fixture.environment]);
    setEnvironmentId(fixture.environment.id);
    setLoadingEnvironments(false);
    setVersions(fixture.versions);
    setPublishedVersionId(published?.id ?? null);
    setViewingVersionId(published?.id ?? null);
    setBaselineVersionId(baseline?.id ?? null);
    setSelection(null);
    setEvidenceSelection(null);
    setFocusId(null);
    setHistoryNotice(fixture.copy.historyNotice);
    setSynchronization(null);
    setDocumentChanges([]);
    setFreshness({
      status: "unknown",
      checkedAt: Date.now(),
      changedPaths: [],
      detail: fixture.copy.freshnessDetail,
    });
  }, [fixture]);

  const loadProjects = useCallback(() => {
    if (controlledFixture) {
      loadControlledFixture();
      return;
    }
    setLoadingProjects(true);
    rpc.call("projects_list", null).then(
      (result) => {
        setProjects(result.projects);
        setProjectId((current) => current || context.projectId || result.projects[0]?.id || "");
        setError(null);
      },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    ).finally(() => setLoadingProjects(false));
  }, [context.projectId, controlledFixture, loadControlledFixture, rpc]);

  const loadEnvironments = useCallback((requestedEnvironmentId?: string) => {
    const requestId = ++environmentRequestRef.current;
    if (controlledFixture) {
      loadControlledFixture();
      return;
    }
    if (currentProject === undefined || currentProject.kind !== "standard") {
      setEnvironments([]);
      setEnvironmentId("");
      setVersions([]);
      setPublishedVersionId(null);
      setViewingVersionId(null);
      setBaselineVersionId(null);
      setSynchronization(null);
      setDocumentChanges([]);
      setJob(null);
      setHistoryNotice(null);
      setError(null);
      setUnsupportedScope(currentProject === undefined ? null : projectLensScopeFor(currentProject));
      setFreshness({
        status: "unknown",
        checkedAt: Date.now(),
        changedPaths: [],
        detail: "Select a standard BB project to use Project Lens. Personal is not an analysis scope.",
      });
      setLoadingEnvironments(false);
      return;
    }
    setUnsupportedScope(null);
    if (projectId === "") {
      setEnvironments([]);
      setEnvironmentId("");
      setLoadingEnvironments(false);
      return;
    }
    setLoadingEnvironments(true);
    rpc.call("environments_list", {
      projectId,
      contextThreadId: context.threadId,
      ...(requestedEnvironmentId === undefined || requestedEnvironmentId.trim() === ""
        ? {}
        : { requestedEnvironmentId: requestedEnvironmentId.trim() }),
    }).then(
      (result) => {
        if (requestId !== environmentRequestRef.current) return;
        if (result.scope.status === "unsupported") {
          setEnvironments([]);
          setEnvironmentId("");
          setVersions([]);
          setPublishedVersionId(null);
          setViewingVersionId(null);
          setBaselineVersionId(null);
          setSynchronization(null);
          setDocumentChanges([]);
          setJob(null);
          setHistoryNotice(null);
          setError(null);
          setUnsupportedScope(result.scope);
          setFreshness({
            status: "unknown",
            checkedAt: Date.now(),
            changedPaths: [],
            detail: "Select a standard BB project to use Project Lens. Personal is not an analysis scope.",
          });
          return;
        }
        setUnsupportedScope(null);
        const requested = requestedEnvironmentId?.trim() ?? "";
        const selectedStillExists =
          requested !== "" ||
          environmentId.trim() === "" ||
          result.environments.some((environment) => environment.id === environmentId.trim());
        setEnvironments(result.environments);
        if (!selectedStillExists) {
          setEnvironmentId("");
          setVersions([]);
          setPublishedVersionId(null);
          setViewingVersionId(null);
          setBaselineVersionId(null);
          setSynchronization(null);
          setDocumentChanges([]);
          setHistoryNotice("The previously selected workspace is no longer available. Choose another workspace, or refresh when its saved history returns.");
        } else {
          setEnvironmentId((current) => {
            if (requested !== "" && result.environments.some((environment) => environment.id === requested)) {
              return requested;
            }
            if (result.environments.some((environment) => environment.id === current)) return current;
            return result.environments.find((environment) => environment.status === "ready")?.id
              ?? result.environments[0]?.id
              ?? "";
          });
          if (requested !== "") {
            setHistoryNotice(
              result.environments.some((environment) => environment.id === requested)
                ? "Workspace resolved from the advanced selector. Its BB path and host are now shown above."
                : null,
            );
          }
        }
        setError(null);
      },
      (cause) => {
        if (requestId !== environmentRequestRef.current) return;
        setEnvironments([]);
        setEnvironmentId("");
        setHistoryNotice("Workspace discovery failed. Saved Lens history is kept locally; refresh workspaces to try again.");
        setError(`Unable to list workspaces for this project. ${cause instanceof Error ? cause.message : String(cause)}`);
      },
    ).finally(() => {
      if (requestId === environmentRequestRef.current) setLoadingEnvironments(false);
    });
  }, [context.threadId, controlledFixture, currentProject, environmentId, loadControlledFixture, projectId, rpc]);

  const loadHistory = useCallback(async () => {
    const requestId = ++historyRequestRef.current;
    if (controlledFixture) {
      loadControlledFixture();
      return;
    }
    if (currentProject === undefined || currentProject.kind !== "standard") {
      setVersions([]);
      setPublishedVersionId(null);
      setViewingVersionId(null);
      setBaselineVersionId(null);
      setSynchronization(null);
      setDocumentChanges([]);
      setJob(null);
      setHistoryNotice(null);
      setError(null);
      setUnsupportedScope(currentProject === undefined ? null : projectLensScopeFor(currentProject));
      setFreshness({
        status: "unknown",
        checkedAt: Date.now(),
        changedPaths: [],
        detail: "Select a standard BB project to load Lens history. Personal has no Project Lens history.",
      });
      setLoadingLens(false);
      return;
    }
    setUnsupportedScope(null);
    if (projectId === "" || environmentId.trim() === "") {
      setVersions([]);
      setPublishedVersionId(null);
      setViewingVersionId(null);
      setBaselineVersionId(null);
      setSynchronization(null);
      setDocumentChanges([]);
      setHistoryNotice(null);
      setFreshness({
        status: "checking",
        checkedAt: null,
        changedPaths: [],
        detail: "Load a Lens to check its retained source paths.",
      });
      return;
    }
    const selectedEnvironment = environments.find((environment) => environment.id === environmentId.trim());
    if (selectedEnvironment === undefined) {
      setHistoryNotice("This workspace selection is stale or invalid. Refresh workspaces, then choose a listed environment. Saved history remains available for any History only option.");
      setError("Choose an environment from the project workspace list before loading Lens history.");
      return;
    }
    setLoadingLens(true);
    setError(null);
    try {
      const [history, current, latestSynchronization] = await Promise.all([
        rpc.call("lens_list", { projectId, environmentId: environmentId.trim() }),
        rpc.call("lens_current", { projectId, environmentId: environmentId.trim() }),
        rpc.call("lens_sync_latest", { projectId, environmentId: environmentId.trim() }),
      ]);
      if (requestId !== historyRequestRef.current) return;
      const nextVersions = history.versions;
      setVersions(nextVersions);
      const nextPublishedVersionId = current.lens?.id ?? nextVersions.at(-1)?.id ?? null;
      let nextDocumentChanges: DocumentDiff[] = [];
      if (nextPublishedVersionId !== null) {
        try {
          nextDocumentChanges = (await rpc.call("lens_compare", {
            projectId,
            environmentId: environmentId.trim(),
          })).documentChanges;
        } catch {
          nextDocumentChanges = [];
        }
      }
      if (requestId !== historyRequestRef.current) return;
      setPublishedVersionId(nextPublishedVersionId);
      setViewingVersionId(nextPublishedVersionId);
      setSynchronization(latestSynchronization.synchronization);
      setDocumentChanges(nextDocumentChanges);
      setHistoryNotice(
        nextVersions.length === 0
          ? selectedEnvironment.status === "unavailable"
            ? "History only — this workspace is no longer available, and it has no saved Lens yet. Choose a ready workspace or generate after it returns."
            : "No saved Lens for this workspace yet. Update Lens will create Lens 0 when the workspace is ready."
          : selectedEnvironment.status === "unavailable"
            ? "History only — the live workspace is unavailable. Saved Lens bytes remain readable; Update Lens is disabled."
            : null,
      );
      setBaselineVersionId((previous) => {
        const previousIsUsable =
          previous !== null &&
          previous !== nextPublishedVersionId &&
          nextVersions.some((version) => version.id === previous) &&
          nextVersions.length > 1;
        return previousIsUsable
          ? previous
          : nextVersions.length > 1
            ? nextVersions.find((version) => version.versionNumber === 0 && version.id !== nextPublishedVersionId)?.id
              ?? nextVersions.find((version) => version.id !== nextPublishedVersionId)?.id
              ?? null
            : null;
      });
      setSelection(null);
      setEvidenceSelection(null);
      setFocusId(null);
      setFreshness({
        status: "checking",
        checkedAt: null,
        changedPaths: [],
        detail: "Reading the saved source paths from the selected environment…",
      });
    } catch (cause) {
      if (requestId !== historyRequestRef.current) return;
      setVersions([]);
      setPublishedVersionId(null);
      setViewingVersionId(null);
      setBaselineVersionId(null);
      setSynchronization(null);
      setDocumentChanges([]);
      setHistoryNotice(null);
      setError(`Could not load Lens history for the selected workspace. It may be stale or unavailable. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      if (requestId === historyRequestRef.current) setLoadingLens(false);
    }
  }, [controlledFixture, currentProject, environmentId, environments, loadControlledFixture, projectId, rpc]);

  useEffect(() => {
    if (controlledFixture) return;
    if (currentProject === undefined || currentProject.kind !== "standard") return;
    const selectedEnvironment = environments.find((environment) => environment.id === environmentId.trim());
    if (publishedVersion === null || projectId === "" || environmentId.trim() === "" || selectedEnvironment?.status !== "ready") {
      if (publishedVersion !== null && selectedEnvironment?.status === "unavailable") {
        setFreshness({
          status: "unavailable",
          checkedAt: Date.now(),
          changedPaths: [],
          detail: "The live workspace is unavailable; saved history remains readable without a freshness read.",
        });
      }
      return;
    }
    let active = true;
    setFreshness({
      status: "checking",
      checkedAt: null,
      changedPaths: [],
      detail: "Reading the saved source paths from the selected environment…",
    });
    const codePaths = publishedVersion.sources
      .filter((source) => source.kind === "code")
      .map((source) => source.path);
    Promise.all([
      rpc.call("settings_get", { projectId }),
      rpc.call("sources_capture", {
        projectId,
        environmentId: environmentId.trim(),
        codePaths,
      }),
    ]).then(
      ([settings, capture]) => {
        if (!active) return;
        if ("scope" in settings) {
          setFreshness({
            status: "unavailable",
            checkedAt: Date.now(),
            changedPaths: [],
            detail: settings.message,
          });
          return;
        }
        setFreshness(assessSourceFreshness(publishedVersion, capture, settings.revision));
      },
      (cause) => {
        if (!active) return;
        setFreshness({
          status: "unavailable",
          checkedAt: Date.now(),
          changedPaths: [],
          detail: `Unable to read current source freshness: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      },
    );
    return () => {
      active = false;
    };
  }, [controlledFixture, currentProject, environmentId, environments, projectId, publishedVersion, rpc]);

  useEffect(() => {
    if (
      controlledFixture ||
      projectId === "" ||
      environmentId.trim() === "" ||
      viewingVersionId === null
    ) return;
    let active = true;
    rpc.call("lens_compare", {
      projectId,
      environmentId: environmentId.trim(),
      currentVersionId: viewingVersionId,
      baselineVersionId,
    }).then(
      (result) => {
        if (active) setDocumentChanges(result.documentChanges);
      },
      () => {
        if (active) setDocumentChanges([]);
      },
    );
    return () => {
      active = false;
    };
  }, [baselineVersionId, controlledFixture, environmentId, projectId, rpc, viewingVersionId]);

  useEffect(() => loadProjects(), [loadProjects]);
  useEffect(() => loadEnvironments(), [loadEnvironments]);
  useEffect(() => {
    if (context.projectId !== null && projectId === "") setProjectId(context.projectId);
  }, [context.projectId, projectId]);

  useRealtime("project-lens-version-changed", (payload) => {
    if (typeof payload !== "object" || payload === null) return;
    const value = payload as { projectId?: unknown; environmentId?: unknown };
    if (value.projectId === projectId && value.environmentId === environmentId.trim()) void loadHistory();
  });

  useEffect(() => {
    if (currentProject?.kind !== "standard" || job === null || !["queued", "running", "cancelling"].includes(job.status)) return;
    const handle = window.setTimeout(() => {
      rpc.call("lens_generate_status", { projectId, environmentId: environmentId.trim(), operationId: job.operationId }).then(
        (next) => {
          setJob(next);
          if (next.status === "completed") void loadHistory();
        },
        (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
      );
    }, 900);
    return () => window.clearTimeout(handle);
  }, [currentProject?.kind, environmentId, job, loadHistory, projectId, rpc]);

  const startGeneration = async () => {
    if (controlledFixture) {
      setError(fixture?.copy.readOnlyError ?? "This view is read-only.");
      return;
    }
    if (currentProject?.kind !== "standard") {
      setError(projectLensUnsupportedScopeMessage);
      return;
    }
    const selectedEnvironment = environments.find((environment) => environment.id === environmentId.trim());
    if (projectId === "" || environmentId.trim() === "" || selectedEnvironment?.status !== "ready") {
      setError("Update Lens needs a ready environment. Choose a ready workspace from the picker.");
      return;
    }
    const refreshDecision = explicitUpdateLensPolicy({
      hasPublishedVersion: publishedVersion !== null,
      freshness,
      synchronizationStatus: synchronization?.status ?? null,
    });
    if (!refreshDecision.allowed) {
      setError(refreshDecision.message ?? "Update Lens is not available for the current workspace state.");
      return;
    }
    setError(null);
    try {
      const next = await rpc.call("lens_generate_start", {
        projectId,
        environmentId: environmentId.trim(),
        expectedParentVersionId: publishedVersion?.id ?? null,
      });
      setJob(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const cancelGeneration = async () => {
    if (job === null) return;
    try {
      setJob(await rpc.call("lens_generate_cancel", { projectId, environmentId: environmentId.trim(), operationId: job.operationId }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const openFlow = (componentId: string) => {
    setFocusId(componentId);
    setSelection({ kind: "component", id: componentId });
  };

  const switchViewingVersion = (nextId: string) => {
    const nextVersion = versions.find((version) => version.id === nextId) ?? null;
    const componentIds = nextVersion === null
      ? new Set<string>()
      : new Set(flattenComponents(nextVersion.graph).map((component) => component.id));
    const connectionIds = nextVersion === null
      ? new Set<string>()
      : new Set(flattenConnections(nextVersion.graph).map((connection) => connection.id));
    const selectionStillExists =
      selection === null ||
      (selection.kind === "component" ? componentIds.has(selection.id) : connectionIds.has(selection.id));
    const focusStillExists = focusId === null || componentIds.has(focusId);
    setViewingVersionId(nextId);
    setSelection(selectionStillExists ? selection : null);
    setEvidenceSelection(null);
    setFocusId(focusStillExists ? focusId : null);
    if (!selectionStillExists) {
      setHistoryNotice(
        "The previous selection is not present in Lens " +
        (nextVersion?.versionNumber ?? "this version") +
        "; selection cleared.",
      );
    }
    setBaselineVersionId((previous) => previous === nextId
      ? versions.find((version) => version.id !== nextId)?.id ?? null
      : previous);
  };

  const selectedEnvironment = environments.find((environment) => environment.id === environmentId);
  const focusComponent = focusId === null || viewingVersion === null
    ? null
    : flattenComponents(viewingVersion.graph).find((component) => component.id === focusId) ?? null;

  return (
    <div className="lens-panel">
      <header className="lens-topbar">
        <div className="lens-brand">
          <div className="lens-mark" aria-hidden="true"><span /><span /><span /></div>
          <div>
            <p className="eyebrow">Project map</p>
            <h1>Project Lens</h1>
          </div>
        </div>
        <div className="lens-controls">
          <label className="lens-control">
            <span>Project</span>
            <select value={projectId} onChange={(event) => {
              environmentRequestRef.current += 1;
              historyRequestRef.current += 1;
              setProjectId(event.target.value);
              setEnvironmentId("");
              setAdvancedEnvironmentId("");
              setEnvironments([]);
              setVersions([]);
              setJob(null);
              setHistoryNotice(null);
              setError(null);
              setUnsupportedScope(null);
              setPublishedVersionId(null);
              setViewingVersionId(null);
              setBaselineVersionId(null);
              setSynchronization(null);
              setDocumentChanges([]);
              setFreshness({
                status: "checking",
                checkedAt: null,
                changedPaths: [],
                detail: "Choose a standard BB project and workspace to check source freshness.",
              });
            }} aria-label="Project" disabled={controlledFixture}>
              <option value="">Select project</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.kind === "personal" ? "personal · unsupported" : project.kind}</option>)}
            </select>
          </label>
          <label className="lens-control lens-env-control">
            <span>Environment / workspace</span>
            <select
              value={environmentId}
              onChange={(event) => {
                historyRequestRef.current += 1;
                setEnvironmentId(event.target.value);
                setVersions([]);
                setPublishedVersionId(null);
                setViewingVersionId(null);
                setBaselineVersionId(null);
                setSynchronization(null);
                setDocumentChanges([]);
                setHistoryNotice(null);
              }}
              aria-label="Environment / workspace"
              disabled={loadingEnvironments || projectId === "" || !projectScopeSupported}
            >
              <option value="">{loadingEnvironments ? "Finding workspaces…" : environments.length === 0 ? "No workspaces found" : "Select workspace"}</option>
              {environments.map((environment) => (
                <option key={environment.id} value={environment.id}>{environmentOptionLabel(environment)}</option>
              ))}
            </select>
            {selectedEnvironment?.path !== null && selectedEnvironment?.path !== undefined ? (
              <small
                className="environment-detail"
                title={`${selectedEnvironment.path} · host ${selectedEnvironment.hostName ?? "unavailable"}`}
              >
                {selectedEnvironment.path} · host {selectedEnvironment.hostName ?? "unavailable"}
              </small>
            ) : selectedEnvironment?.status === "unavailable" ? (
              <small className="environment-detail is-unavailable">Saved history only · live checkout unavailable</small>
            ) : null}
          </label>
          {!controlledFixture ? (
            <details className="environment-advanced">
              <summary>Workspace not listed?</summary>
              <div className="environment-advanced-body">
                <span>Use a BB workspace ID only when this project has no visible thread or saved Lens yet.</span>
                <div className="environment-advanced-form">
                  <Input
                    value={advancedEnvironmentId}
                    onChange={(event) => setAdvancedEnvironmentId(event.target.value)}
                    placeholder="env_…"
                    aria-label="Advanced workspace ID"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void loadEnvironments(advancedEnvironmentId)}
                    disabled={loadingEnvironments || projectId === "" || !projectScopeSupported || advancedEnvironmentId.trim() === ""}
                  >
                    Find workspace
                  </Button>
                </div>
              </div>
            </details>
          ) : null}
          <Button type="button" variant="outline" onClick={() => void loadHistory()} disabled={loadingLens || loadingProjects || loadingEnvironments || projectId === "" || !projectScopeSupported || environmentId.trim() === ""}>
            {loadingLens ? "Loading…" : "Load Lens"}
          </Button>
        </div>
        <div className="lens-actions">
          <Button type="button" onClick={() => void startGeneration()} disabled={projectId === "" || !projectScopeSupported || environmentId.trim() === "" || selectedEnvironment?.status !== "ready" || job !== null && ["queued", "running", "cancelling"].includes(job.status)}>
            <Icon name="ArrowReloadHorizontal" aria-hidden="true" />
            Update Lens
          </Button>
        </div>
      </header>

      <GenerationNotice job={job} onCancel={() => void cancelGeneration()} />
      <SynchronizationNotice
        synchronization={synchronization}
        documentChanges={documentChanges}
        freshness={freshness}
        projectScopeSupported={projectScopeSupported}
        hasSelectedEnvironment={selectedEnvironment !== undefined}
        hasLoadedLens={publishedVersion !== null}
      />
      {controlledFixture && fixture !== undefined ? (
        <div className="environment-state is-fixture" role="status">
          <Icon name="Toolbox" aria-hidden="true" />
          <div><strong>{fixture.copy.title}</strong><span>{fixture.copy.detail}</span></div>
        </div>
      ) : null}
      {selectedEnvironment?.status === "unavailable" ? (
        <div className="environment-state is-history" role="status">
          <Icon name="Info" aria-hidden="true" />
          <div><strong>History only</strong><span>The selected workspace is unavailable. Saved Lens versions can still be opened; choose a ready workspace to update.</span></div>
          <Button type="button" variant="outline" size="sm" onClick={() => void loadEnvironments()}>Refresh workspaces</Button>
        </div>
      ) : null}
      {selectedProjectScope?.status === "unsupported" ? (
        <div className="environment-state is-unsupported" role="status" data-testid="unsupported-project-scope">
          <Icon name="Info" aria-hidden="true" />
          <div>
            <strong>Personal project is not supported</strong>
            <span>Select a standard BB project to configure Project Lens, load history, or generate a Lens. No Project Lens settings, environments, or Lens records are created for Personal.</span>
          </div>
        </div>
      ) : null}
      {environments.length === 0 && !loadingEnvironments && projectId !== "" && projectScopeSupported ? (
        <div className="environment-state" role="status">
          <Icon name="Info" aria-hidden="true" />
          <div><strong>No project workspaces found</strong><span>Refresh after the project has a ready environment, or use “Workspace not listed?” when BB has not surfaced it yet.</span></div>
          <Button type="button" variant="outline" size="sm" onClick={() => void loadEnvironments()}>Refresh workspaces</Button>
        </div>
      ) : null}
      {error !== null ? <div className="lens-error" role="alert"><Icon name="AlertCircle" aria-hidden="true" /><span>{error}</span><Button type="button" variant="outline" size="sm" onClick={() => void loadEnvironments()}>Refresh workspaces</Button><Button type="button" variant="ghost" size="sm" onClick={() => setError(null)}>Dismiss</Button></div> : null}
      {historyNotice !== null ? <div className="history-notice" role="status"><Icon name="Info" aria-hidden="true" /><span>{historyNotice}</span></div> : null}
      {viewingVersion === null || comparison === null ? (
        <main className="lens-empty-state">
          <div className="empty-glyph"><span /><span /><span /></div>
          <p className="eyebrow">Versioned architecture</p>
          <h2>{selectedProjectScope?.status === "unsupported" ? "Choose a standard project to use Project Lens." : "Load a Lens to explore the project map."}</h2>
          <p>{selectedProjectScope?.status === "unsupported" ? "Personal is a BB scope without a Project Lens environment. Select a standard project to configure documents, open history, and generate a versioned map." : "Choose a project and workspace, then open the captured graph. Code and Markdown evidence stay attached to each immutable version."}</p>
          {loadingProjects ? <span className="muted-copy">Finding available BB projects…</span> : null}
          {!loadingProjects && projects.length === 0 ? <span className="muted-copy">No BB projects are available to this plugin.</span> : null}
        </main>
      ) : (
        <main className="lens-workspace">
          <div className="lens-versionbar">
            <div className="lens-version-summary">
              <span className="live-dot" aria-hidden="true" />
              <span>
                Current Lens <strong>v{publishedVersion?.versionNumber ?? viewingVersion.versionNumber}</strong>
                {publishedVersion !== null && publishedVersion.id !== viewingVersion.id ? ` · Viewing Lens v${viewingVersion.versionNumber}` : ""}
              </span>
              <span className="muted-divider">·</span>
              <span>{currentProject?.name ?? viewingVersion.projectId}</span>
              <span className="version-freshness">
                {publishedVersion !== null && publishedVersion.id === viewingVersion.id
                  ? `Captured ${formatTimestamp(viewingVersion.createdAt)}`
                  : `Historical Lens · captured ${formatTimestamp(viewingVersion.createdAt)}`}
              </span>
              <SourceFreshnessBadge freshness={freshness} />
            </div>
            <div className="lens-version-controls">
              <label>
                <span>Viewing</span>
                <select value={viewingVersion.id} onChange={(event) => switchViewingVersion(event.target.value)} aria-label="Viewing Lens version">
                  {versions.map((version) => <option key={version.id} value={version.id}>Lens {version.versionNumber}{version.id === publishedVersionId ? " · current" : ""}</option>)}
                </select>
              </label>
              <label>
                <span>Compare with</span>
                <select value={baselineVersionId ?? ""} onChange={(event) => setBaselineVersionId(event.target.value || null)} aria-label="Compare with Lens version">
                  <option value="">No comparison</option>
                  {versions.filter((version) => version.id !== viewingVersion.id).map((version) => <option key={version.id} value={version.id}>Lens {version.versionNumber}{version.versionNumber === 0 ? " · baseline" : ""}</option>)}
                </select>
              </label>
            </div>
          </div>
          <div className="lens-contextbar">
            <div className="lens-breadcrumbs" aria-label="Diagram location">
              <button type="button" onClick={() => { setFocusId(null); setSelection(null); }}>Overview</button>
              {focusComponent !== null ? <><span aria-hidden="true">/</span><span aria-current="page">{focusComponent.name}</span></> : null}
            </div>
            <div className="lens-search-and-legend">
              <label className="lens-search">
                <Icon name="Search" aria-hidden="true" />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search components" aria-label="Search components" />
              </label>
              <div className="diagram-legend" aria-label="Change legend">
                <span className="legend-item text-emerald-600"><i />Added</span>
                <span className="legend-item text-amber-600"><i />Changed</span>
                <span className="legend-item text-destructive"><i />Removed</span>
                <span className="legend-item text-muted-foreground"><i className="is-dotted" />Review</span>
              </div>
            </div>
          </div>
          <MarkdownComparisonPanel
            baseline={baselineVersion}
            current={viewingVersion}
            documentChanges={documentChanges}
          />
          <CoverageNotice version={viewingVersion} comparison={comparison} />
          <div className="lens-content-grid">
            <section className="lens-diagram-column" aria-label="Component diagram">
              <DiagramCanvas
                graph={viewingVersion.graph}
                comparison={comparison}
                selection={selection}
                focusId={focusId}
                layoutScopeKey={`${projectId}:${environmentId}:${focusId ?? "overview"}`}
                query={query}
                onSelect={setSelection}
                onOpenFlow={openFlow}
              />
            </section>
            <EvidenceInspector
              version={viewingVersion}
              baseline={baselineVersion}
              comparison={comparison}
              selection={selection}
              onSelectEvidence={setEvidenceSelection}
              onOpenFlow={openFlow}
              graph={viewingVersion.graph}
            />
          </div>
          <footer className="lens-footer">
            <span>Graph supplied by the selected Lens analysis · viewer layout is deterministic and selection-safe.</span>
            <span>Components: {comparison.sourceOnlyChanges} source-only · {comparison.explanationOnlyChanges} explanation-only changes</span>
          </footer>
        </main>
      )}
    </div>
  );
}
