import { describe, expect, it } from "vitest";
import { assembleArchitecture, prepareArchitecturePrompt } from "../src/project-architecture.js";
import { hierarchyForGraph, graphForComponent, stableLayout, type DiagramComparison } from "../src/diagram.js";
import type { LensComponent, LensGraph, LensVersion } from "../src/model.js";

function component(id: string): LensComponent {
  return {    
id, identityKey: id, name: id, responsibility: `Owns ${id}`, parentId: null, groupId: null, state: "implemented", provenance: "extracted",
    codeAnchors: [], documentMappings: [], evidence: [{ sourceId: id, kind: "code", path: `src/${id}.ts`, claim: `Defines ${id}`, startLine: 1, endLine: 2, capturedSha256: "a".repeat(64), provenance: "extracted" }]  
};
}
const graph: LensGraph = {  
components: ["api", "service", "storage", "queue"].map(component), connections: [
    { id: "call", fromComponentId: "api", toComponentId: "service", type: "calls", direction: "forward", label: "Submits request", state: "implemented", provenance: "extracted", evidence: component("api").evidence },
    { id: "write", fromComponentId: "service", toComponentId: "storage", type: "writes", direction: "forward", label: "Stores result", state: "implemented", provenance: "extracted", evidence: component("service").evidence },
  ]
};
function response() {  
return {    
subsystems: [
      { key: "delivery", name: "Request delivery", responsibility: "Handles incoming requests", componentIds: ["api", "service"] },
      { key: "durability", name: "Durability", responsibility: "Stores and queues work", componentIds: ["storage", "queue"] },
    ], connections: [] as Array<{ fromId: string; toId: string; type: string; direction: string; label: string; evidenceIds: string[] }>, unknownAreas: []  
};
}
const prepared = prepareArchitecturePrompt(graph, null, 900_000);
const assemble = (value: unknown) => assembleArchitecture(JSON.stringify(value), graph, prepared, null, 512_000);

describe("architecture membership and evidence", () => {
  it("preserves every leaf and edge, opens subsystem flows, and names layout groups", () => {
    const result = assemble(response()).graph;
    const roots = hierarchyForGraph(result).roots;
    expect(roots.map(c => c.name)).toEqual(["Request delivery", "Durability"]);
    expect(result.components.filter(c => c.parentId !== null).map(c => c.id)).toEqual(graph.components.map(c => c.id));
    expect(graphForComponent(result, roots[0]!.id)?.connections.map(c => c.id)).toEqual(["call"]);
    expect(result.connections.find(c => c.id.startsWith("overview:"))).toMatchObject({ fromComponentId: roots[0]!.id, toComponentId: roots[1]!.id, evidence: graph.connections[1]!.evidence });
    for (const leaf of graph.components) expect(result.components.find(c => c.id === leaf.id)?.evidence).toEqual(leaf.evidence);
    const comparison: DiagramComparison = { components: [], connections: [], uncertainty: [], baselineVersionId: null, currentVersionId: "test", canConfirmRemovals: false, sourceOnlyChanges: 0, explanationOnlyChanges: 0, architectureChanges: 0 };
    expect(stableLayout(result, comparison).groups.map(g => g.label).sort()).toEqual(["Durability", "Request delivery"]);
    expect(stableLayout(result, comparison, roots[0]!.id).groups[0]!.label).toBe("Request delivery");
  });
  it.each(["missing", "duplicate", "unknown", "key"])("rejects %s membership instead of losing components", kind => {
    const value = response();
    if (kind === "missing") value.subsystems[0]!.componentIds.pop();
    if (kind === "duplicate") value.subsystems[1]!.componentIds.push("api");
    if (kind === "unknown") value.subsystems[0]!.componentIds.push("imagined");
    if (kind === "key") value.subsystems[1]!.key = "delivery";
    expect(() => assemble(value)).toThrow();
  });
  it("rejects a generic single bucket for a substantial graph", () => {
    const large = { components: Array.from({ length: 12 }, (_, i) => component(`c${i}`)), connections: [] };
    const prompt = prepareArchitecturePrompt(large, null, 900_000);
    expect(() => assembleArchitecture(JSON.stringify({ subsystems: [{ key: "all", name: "All", responsibility: "All", componentIds: large.components.map(c => c.id) }] }), large, prompt, null, 512_000)).toThrow("one subsystem");
  });
  it("allows only supplied, endpoint-owned references for inferred cross-batch connections", () => {
    const value = response(); const queueRef = [...prepared.owners].find(([, owners]) => owners.has("queue"))![0];
    value.connections.push({ fromId: "storage", toId: "queue", type: "publishes", direction: "forward", label: "Queues durable work", evidenceIds: [queueRef] });
    const added = assemble(value).graph.connections.find(c => c.toComponentId === "queue");
    expect(added).toMatchObject({ provenance: "inferred", evidence: component("queue").evidence });
    value.connections[0]!.evidenceIds = ["not-in-prompt"];
    expect(() => assemble(value)).toThrow("unsupplied or unrelated");
    value.connections[0]!.evidenceIds = [[...prepared.owners].find(([, owners]) => owners.has("api"))![0]];
    expect(() => assemble(value)).toThrow("unsupplied or unrelated");
  });
  it("preserves subsystem identity on reorder and responsibility/name edits", () => {
    const first = assemble(response()).graph;
    const prior = { graph: first } as LensVersion;
    const value = response(); value.subsystems.reverse(); value.subsystems[0]!.name = "Persistent state";
    const next = assembleArchitecture(JSON.stringify(value), graph, prepareArchitecturePrompt(graph, prior, 900_000), prior, 512_000).graph;
    expect(next.components.find(c => c.identityKey === "subsystem:durability")?.id).toBe(first.components.find(c => c.identityKey === "subsystem:durability")?.id);
  });
  it("fails synthesis overflow before discarding any component", () => {
    expect(() => prepareArchitecturePrompt(graph, null, 500)).toThrow("no components were discarded");
    expect(() => assembleArchitecture(JSON.stringify(response()), graph, prepared, null, 10)).toThrow("result byte limit");
  });
});
