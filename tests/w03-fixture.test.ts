import { describe, expect, it } from "vitest";
import { compareLensVersions, stableLayout } from "../src/diagram.js";
import { w03FixtureVersions } from "../src/fixtures/w03-component-flow.js";
import { lensVersionSchema } from "../src/model.js";

describe("W03 controlled component-flow fixture", () => {
  it("is a schema-valid saved-history fixture with nested groups and evidence bytes", () => {
    for (const version of w03FixtureVersions) {
      expect(() => lensVersionSchema.parse(version)).not.toThrow();
    }
    expect(w03FixtureVersions[1]?.graph.components.find((component) => component.id === "orchestrator")?.nestedFlow?.components).toHaveLength(4);
    expect(w03FixtureVersions[0]?.sources.some((source) => source.kind === "markdown")).toBe(true);
    expect(w03FixtureVersions[0]?.sources.every((source) => source.bytesBase64.length > 0)).toBe(true);
  });

  it("exercises status and change-type semantics across complete and incomplete comparisons", () => {
    const baseline = w03FixtureVersions[0]!;
    const changed = w03FixtureVersions[1]!;
    const incomplete = w03FixtureVersions[2]!;
    const completeComparison = compareLensVersions(changed, baseline);
    const incompleteComparison = compareLensVersions(incomplete, changed);

    expect(completeComparison.components.find((item) => item.id === "gateway")).toMatchObject({ change: "changed", sourceOnly: true });
    expect(completeComparison.components.find((item) => item.id === "orchestrator")).toMatchObject({ change: "changed", explanationOnly: true, architectureChanged: false });
    expect(completeComparison.components.find((item) => item.id === "store")).toMatchObject({ change: "changed", architectureChanged: true });
    expect(completeComparison.components.find((item) => item.id === "telemetry")).toMatchObject({ change: "changed", sourceOnly: false, explanationOnly: false, architectureChanged: false });
    expect(completeComparison.components.find((item) => item.id === "queue-worker")?.change).toBe("added");
    expect(completeComparison.components.find((item) => item.id === "legacy-adapter")?.change).toBe("removed");
    expect(completeComparison.architectureChanges).toBe(5);
    expect(incompleteComparison.canConfirmRemovals).toBe(false);
    expect(incompleteComparison.components.find((item) => item.id === "audit")?.change).toBe("uncertain");
    expect(incompleteComparison.uncertainty).not.toHaveLength(0);
    expect(completeComparison.connections.some((item) => item.change === "added")).toBe(true);

    const firstLayout = stableLayout(changed.graph, completeComparison);
    const reorderedLayout = stableLayout(incomplete.graph, incompleteComparison, null, firstLayout);
    for (const id of ["gateway", "orchestrator", "scheduler", "policy", "queue-worker", "store", "result-encoder", "telemetry"]) {
      expect(reorderedLayout.nodes.get(id)?.y).toBe(firstLayout.nodes.get(id)?.y);
    }
  });
});
