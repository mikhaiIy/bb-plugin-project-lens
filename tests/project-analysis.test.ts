import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  BbProjectGraphAnalyzer,
  ProjectAnalysisError,
  normalizeAgentGraph,
  planEvidencePasses,
  type AgentGraphResponse,
} from "../src/project-analysis.js";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { SdkProjectInventoryCollector } from "../src/project-inventory.js";
import type {
  ProjectInventory,
  ProjectWorkspace,
  SourceCapture,
  LensVersion,
} from "../src/model.js";
import { SdkSourceCollector, type RawSourceRead, type SourceReader } from "../src/source-capture.js";

const target = (name: string, rootPath: string): ProjectWorkspace => ({
  project: { id: name, name, kind: "standard" },
  environment: {
    id: `${name}-environment`,
    projectId: name,
    hostId: `${name}-host`,
    status: "ready",
    path: rootPath,
    workspaceProvisionType: "unmanaged",
    branchName: "main",
  },
  host: {
    id: `${name}-host`,
    name: `${name} host`,
    status: "connected",
    type: "persistent",
  },
  projectId: name,
  environmentId: `${name}-environment`,
  hostId: `${name}-host`,
  rootPath,
});

function rawFile(input: { absolutePath: string }, text: string): RawSourceRead {
  const bytes = Buffer.from(text, "utf8");
  return {
    content: text,
    contentEncoding: "utf8",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
    path: input.absolutePath,
    mimeType: input.absolutePath.endsWith(".md") ? "text/markdown" : "text/typescript",
  };
}

async function captureProject(projectName: string, rootPath: string): Promise<SourceCapture> {
  const files: Record<string, string> = {
    "docs/architecture.md": `# ${projectName} architecture\n\n## Storage\nThe storage boundary owns durable state.\n\n## Future\nA planned cache is documented but not implemented.\n`,
    "src/api.ts": `export function ${projectName.toLowerCase()}Api() { return storage(); }\n`,
    "src/storage.ts": "export function storage() { return { read: true }; }\n",
  };
  const sourceReader: SourceReader = {
    async read(input) {
      const text = files[input.relativePath];
      if (text === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return rawFile(input, text);
    },
  };
  return new SdkSourceCollector(sourceReader).capture(
    target(projectName, rootPath),
    [{ path: "docs/architecture.md", maintenance: "keep-updated" }],
    { codePaths: ["src/api.ts", "src/storage.ts"], scope: "whole-project" },
  );
}

function inventory(projectName: string): ProjectInventory {
  return {
    capturedAt: 1,
    entries: [
      { path: "docs/architecture.md", kind: "markdown", status: "candidate" },
      { path: "src/api.ts", kind: "code", status: "candidate" },
      { path: "src/storage.ts", kind: "code", status: "candidate" },
      {
        path: "src/unreadable.bin",
        kind: "other",
        status: "excluded",
        reason: "File type is outside the bounded source analysis set",
      },
      ...(projectName === "Beta"
        ? [{ path: "src/queue.ts", kind: "code" as const, status: "unresolved" as const, reason: "collision" }]
        : []),
    ],
    totalDiscovered: projectName === "Beta" ? 5 : 4,
    truncated: false,
    omittedCount: 0,
  };
}

function graphFor(capture: SourceCapture, project: "Alpha" | "Beta"): AgentGraphResponse {
  const markdown = capture.sources.find((source) => source.kind === "markdown")!;
  const api = capture.sources.find((source) => source.path === "src/api.ts")!;
  const storage = capture.sources.find((source) => source.path === "src/storage.ts")!;
  const storageSection = capture.documentSections.find((section) => section.anchor === "storage")!;
  const futureSection = capture.documentSections.find((section) => section.anchor === "future")!;
  const components = [
    {
      key: "api",
      name: project === "Alpha" ? "Alpha API" : "Beta Queue API",
      responsibility: "Accepts project requests and delegates to storage.",
      parentKey: null,
      groupKey: null,
      state: "implemented" as const,
      provenance: "inferred" as const,
      evidence: [
        {
          kind: "code" as const,
          path: api.path,
          claim: "The API function delegates to storage.",
          startLine: 1,
          endLine: 1,
          provenance: "extracted" as const,
        },
        {
          kind: "markdown" as const,
          path: markdown.path,
          claim: "Architecture documentation names the storage boundary.",
          startLine: null,
          endLine: null,
          sectionAnchor: storageSection.anchor,
          provenance: "declared" as const,
        },
      ],
      documentMappings: [
        {
          documentPath: markdown.path,
          sectionAnchor: storageSection.anchor,
          claim: "The document describes the durable storage boundary.",
          relation: "supports" as const,
          provenance: "declared" as const,
        },
      ],
    },
    {
      key: "storage",
      name: "Storage",
      responsibility: "Owns durable project state.",
      parentKey: null,
      groupKey: null,
      state: "implemented" as const,
      provenance: "inferred" as const,
      evidence: [
        {
          kind: "code" as const,
          path: storage.path,
          claim: "The storage function exposes the durable state boundary.",
          startLine: 1,
          endLine: 1,
          provenance: "extracted" as const,
        },
      ],
      documentMappings: [],
    },
    {
      key: "future-cache",
      name: "Planned cache",
      responsibility: "A documented future cache boundary.",
      parentKey: null,
      groupKey: null,
      state: "planned" as const,
      provenance: "declared" as const,
      evidence: [
        {
          kind: "markdown" as const,
          path: markdown.path,
          claim: "The cache is described as planned future work.",
          startLine: null,
          endLine: null,
          sectionAnchor: futureSection.anchor,
          provenance: "declared" as const,
        },
      ],
      documentMappings: [
        {
          documentPath: markdown.path,
          sectionAnchor: futureSection.anchor,
          claim: "The cache is future intent, not implemented behavior.",
          relation: "context" as const,
          provenance: "declared" as const,
        },
      ],
    },
  ];
  return {
    components,
    connections: [
      {
        key: "api-to-storage",
        fromKey: "api",
        toKey: "storage",
        type: "calls",
        direction: "forward",
        label: "delegates storage read",
        state: "implemented",
        provenance: "extracted",
        evidence: [
          {
            kind: "code",
            path: api.path,
            claim: "The API calls storage.",
            startLine: 1,
            endLine: 1,
            provenance: "extracted",
          },
        ],
      },
    ],
    unknownAreas: project === "Beta" ? ["Queue implementation was not captured"] : [],
  };
}

function fakeSdk(
  outputForPrompt: (prompt: string) => string,
  hooks: {
    onSpawn?: (args: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]) => void;
    onWait?: (signal: AbortSignal | undefined) => Promise<void>;
    onArchive?: () => Promise<void> | void;
    onStop?: () => Promise<void> | void;
    list?: () => Promise<unknown>;
    spawnError?: Error;
  } = {},
) {
  const sdk = {
    threads: {
      spawn: async (args: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]) => {
        hooks.onSpawn?.(args);
        if (hooks.spawnError !== undefined) throw hooks.spawnError;
        return { id: "analysis-worker", providerId: "synthetic-provider" };
      },
      wait: async (args: { signal?: AbortSignal }) => {
        await hooks.onWait?.(args.signal);
        return { matched: true, threadId: "analysis-worker", target: { kind: "status", status: "idle" }, thread: {} };
      },
      output: async () => ({ output: lastPrompt.startsWith("You are the Project Lens architecture assembler.") ? JSON.stringify({
        subsystems:[{key:"service",name:"Service",responsibility:"Owns the service flow",componentIds:JSON.parse(lastPrompt.split("\n").find(line => line.startsWith("Components: "))!.slice(12)).map((c:{id:string})=>c.id)}],connections:[],unknownAreas:[],
      }) : outputForPrompt(lastPrompt) }),
      archive: async () => {
        await hooks.onArchive?.();
        return { ok: true };
      },
      stop: async () => {
        await hooks.onStop?.();
        return { ok: true };
      },
      list: async () =>
        (hooks.list === undefined ? [] : await hooks.list()) as Awaited<
          ReturnType<BbPluginApi["sdk"]["threads"]["list"]>
        >,
    },
  } as unknown as BbPluginApi["sdk"];
  let lastPrompt = "";
  const spawn = sdk.threads.spawn;
  sdk.threads.spawn = (async (args: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]) => {
    lastPrompt = typeof args.prompt === "string" ? args.prompt : "";
    return spawn(args);
  }) as typeof sdk.threads.spawn;
  return sdk;
}

describe("whole-project BB agent analysis", () => {
  async function budgetFixture(files: Record<string, string>) {
    const workspace = target("Budget", "/synthetic/budget");
    const capture = await new SdkSourceCollector({
      async read(input) {
        return rawFile(input, files[input.relativePath]!);
      },
    }).capture(
      workspace,
      Object.keys(files).filter((path) => path.endsWith(".md"))
        .map((path) => ({ path, maintenance: "reference-only" as const })),
      { codePaths: Object.keys(files).filter((path) => !path.endsWith(".md")), scope: "whole-project" },
    );
    const projectInventory: ProjectInventory = {
      capturedAt: 1,
      entries: Object.keys(files).map((path) => ({
        path, kind: path.endsWith(".md") ? "markdown" : "code", status: "candidate",
      })),
      totalDiscovered: Object.keys(files).length,
      truncated: false,
      omittedCount: 0,
    };
    return { projectId: "Budget", target: workspace, capture, inventory: projectInventory };
  }

  const promptEvidence = (prompt: string) => JSON.parse(prompt.split("\nEvidence sources:\n")[1]!) as Array<{
    path: string; content: string; sha256: string;
    sections: Array<{ anchor: string; heading: string; startLine: number; endLine: number }>;
  }>;

  it("fits the serialized 900KB prompt with hundreds of escaped sources and coverage notes", async () => {
    const files = Object.fromEntries(Array.from({ length: 309 }, (_, index) => [
      `src/module-${String(index).padStart(3, "0")}.ts`,
      `// ${index}: \"quoted\" \\paths\\ 中文\t\r\n`.repeat(300),
    ]));
    const request = await budgetFixture(files);
    for (let index = 0; index < 26; index++) {
      request.inventory.entries.push({ path: `docs/unconfigured-${index}.md`, kind: "markdown", status: "candidate" });
    }
    request.inventory.totalDiscovered = request.inventory.entries.length;
    const plan = planEvidencePasses(request);
    expect(plan.passes.length).toBeGreaterThan(1);
    const supplied = plan.passes.flatMap(pass => promptEvidence(pass.prompt));
    expect(supplied).toHaveLength(309);
    expect(new Set(supplied.map(entry => entry.path)).size).toBe(309);
    for (const pass of plan.passes) expect(Buffer.byteLength(pass.prompt,"utf8")).toBeLessThanOrEqual(900_000);
    for (const entry of supplied) {
      expect(entry.content).toBe(files[entry.path]);
      expect(entry.sha256).toBe(createHash("sha256").update(files[entry.path]!).digest("hex"));
    }
    expect(plan.unknownAreas.some(area => area.includes("omitted"))).toBe(false);
    expect(plan.unknownAreas).toContain("Markdown path is inventoried but not configured as Lens evidence: docs/unconfigured-25.md");
    expect(planEvidencePasses(request).passes.map(pass=>pass.prompt)).toEqual(plan.passes.map(pass=>pass.prompt));
  });

  it("resolves a same-key unknown dependency when a later batch supplies its implementation", async () => {
    const request=await budgetFixture({"src/a.ts":"export const caller = true;\n","src/b.ts":"export const queue = [];\n"});
    const result=await new BbProjectGraphAnalyzer(fakeSdk(prompt=>{
      const source=promptEvidence(prompt)[0]!;const known=source.path.endsWith("b.ts");
      return JSON.stringify({components:[{key:"queue",name:known?"Queue":"Queue dependency",responsibility:known?"Stores pending work":"Imported dependency",state:known?"implemented":"unknown",provenance:"extracted",evidence:[{kind:"code",path:source.path,claim:"Queue boundary",startLine:1,endLine:1,provenance:"extracted"}]}],connections:[],unknownAreas:[]});
    })).analyze({...request,limits:{maxAnalyzedSources:1}});
    expect(result.normalized.graph.components).toHaveLength(1);
    expect(result.normalized.graph.components[0]).toMatchObject({name:"Queue",state:"implemented",responsibility:"Stores pending work"});
    expect(result.normalized.graph.components[0]!.evidence).toHaveLength(2);
    expect(result.normalized.identityWarnings).toEqual([]);
  });

  it("retains a component citing more than 64 files from its supplied batch", async () => {
    const files=Object.fromEntries(Array.from({length:80},(_,i)=>[`src/event-${i}.ts`,`export const event${i} = ${i};\n`]));
    const request=await budgetFixture(files);
    const result=await new BbProjectGraphAnalyzer(fakeSdk(prompt=>JSON.stringify({components:[{
      key:"event-catalogue",name:"Event catalogue",responsibility:"Defines event codes",state:"implemented",provenance:"extracted",
      evidence:promptEvidence(prompt).map(source=>({kind:"code",path:source.path,claim:"Defines an event code",startLine:1,endLine:1,provenance:"extracted"})),
    }],connections:[],unknownAreas:[]}))).analyze(request);
    expect(result.normalized.graph.components[0]!.evidence).toHaveLength(80);
    expect(result.coverage.unrepresentedSourceIds).toEqual([]);
  });

  it("includes Markdown section metadata in the budget and keeps a later small source intact", async () => {
    const request = await budgetFixture({
      "docs/a.md": Array.from({ length: 80 }, (_, i) => `## Heading ${i} \"quoted\" \\path\nText\n`).join(""),
      "src/small.ts": "export const small = true;\n",
    });
    let sent = "";
    const result = await new BbProjectGraphAnalyzer(fakeSdk((prompt) => {
      sent = prompt;
      return JSON.stringify({ components: [], connections: [], unknownAreas: [] });
    })).analyze({ ...request, limits: { maxPromptBytes: 8_000 } });
    expect(Buffer.byteLength(sent, "utf8")).toBeLessThanOrEqual(8_000);
    expect(promptEvidence(sent).map((entry) => entry.path)).toEqual(["src/small.ts"]);
    expect(result.normalized.unknownAreas).toContain("Source cannot fit a complete evidence prompt; omitted docs/a.md");
  });

  it("accepts the exact serialized limit and omits whole evidence at one byte below it", async () => {
    const request = await budgetFixture({ "src/中文.ts": '// \"quote\" \\backslash\t中文\r\n'.repeat(40) });
    const prompts: string[] = [];
    const analyzer = new BbProjectGraphAnalyzer(fakeSdk((prompt) => {
      prompts.push(prompt);
      return JSON.stringify({ components: [], connections: [], unknownAreas: [] });
    }));
    await analyzer.analyze(request);
    const exact = Buffer.byteLength(prompts[0]!, "utf8");
    await analyzer.analyze({ ...request, limits: { maxPromptBytes: exact } });
    expect(prompts[1]).toBe(prompts[0]);
    const reduced = await analyzer.analyze({ ...request, limits: { maxPromptBytes: exact - 1 } });
    expect(Buffer.byteLength(prompts[2]!, "utf8")).toBeLessThanOrEqual(exact - 1);
    expect(promptEvidence(prompts[2]!)).toEqual([]);
    expect(reduced.normalized.unknownAreas).toContain("Source cannot fit a complete evidence prompt; omitted src/中文.ts");
  });

  it("honors the per-pass source-count limit and names omissions at the total pass bound", async () => {
    const request = await budgetFixture({ "src/a.ts": "a\n", "src/b.ts": "b\n", "src/c.ts": "c\n" });
    let sent = "";
    const result = await new BbProjectGraphAnalyzer(fakeSdk((prompt) => {
      sent = prompt;
      return JSON.stringify({ components: [], connections: [], unknownAreas: [] });
    })).analyze({ ...request, limits: { maxAnalyzedSources: 1, maxPromptBytes: 4_000, maxEvidencePasses: 1 } });
    expect(promptEvidence(sent).map((entry) => entry.path)).toEqual(["src/a.ts"]);
    expect(Buffer.byteLength(sent, "utf8")).toBeLessThanOrEqual(4_000);
    expect(result.normalized.unknownAreas).toContain("Evidence pass limit reached; omitted src/b.ts");
    expect(sent).toContain("Analysis source limit reached; omitted src/c.ts");
  });

  it("rejects oversized metadata before spawning any worker", async () => {
    const request = await budgetFixture({ "src/a.ts": "a\n" });
    for (let i = 0; i < 100; i++) {
      request.inventory.entries.push({ path: `docs/${"long".repeat(40)}-${i}.md`, kind: "markdown", status: "candidate" });
    }
    let spawned = false;
    const analyzer = new BbProjectGraphAnalyzer(fakeSdk(() => "", { onSpawn: () => { spawned = true; } }));
    await expect(analyzer.analyze({ ...request, limits: { maxPromptBytes: 4_000 } }))
      .rejects.toThrow("inventory and coverage notes exceed the 4000-byte prompt limit before source content");
    expect(spawned).toBe(false);
  });

  it("generates materially different graphs from different bounded projects and preserves exact citations", async () => {
    const alphaCapture = await captureProject("Alpha", "/synthetic/alpha");
    const betaCapture = await captureProject("Beta", "/synthetic/beta");
    const spawned: unknown[] = [];
    const sdk = fakeSdk((prompt) =>
      JSON.stringify(graphFor(prompt.includes('"Beta"') ? betaCapture : alphaCapture, prompt.includes('"Beta"') ? "Beta" : "Alpha")),
    { onSpawn: (args) => spawned.push(args) });
    const analyzer = new BbProjectGraphAnalyzer(sdk);

    const alpha = await analyzer.analyze({
      projectId: "Alpha",
      target: target("Alpha", "/synthetic/alpha"),
      inventory: inventory("Alpha"),
      capture: alphaCapture,
      providerId: "synthetic-provider",
    });
    const beta = await analyzer.analyze({
      projectId: "Beta",
      target: target("Beta", "/synthetic/beta"),
      inventory: inventory("Beta"),
      capture: betaCapture,
      providerId: "synthetic-provider",
    });

    expect(alpha.normalized.graph.components.map((component) => component.name)).toContain("Alpha API");
    expect(beta.normalized.graph.components.map((component) => component.name)).toContain("Beta Queue API");
    expect(alpha.normalized.graph.components).not.toEqual(beta.normalized.graph.components);
    expect(alpha.normalized.graph.components.find((component) => component.name === "Planned cache")?.state).toBe(
      "planned",
    );
    const storage = alpha.normalized.graph.components.find((component) => component.name === "Storage")!;
    expect(storage.evidence[0]).toMatchObject({
      path: "src/storage.ts",
      capturedSha256: alphaCapture.sources.find((source) => source.path === "src/storage.ts")!.sha256,
      provenance: "extracted",
    });
    expect(alpha.job.cleanup).toEqual({ archived: true, stopped: true });
    expect(spawned).toHaveLength(4);
    expect(spawned[0]).toMatchObject({
      providerId: "synthetic-provider",
      permissionMode: "accept-edits",
      // SDK 0.4.47 interprets this request as the host's configured checkout;
      // the null value is not a detached or empty-workspace guarantee.
      environment: { type: "host", workspace: { type: "unmanaged", path: null } },
    });
    expect((spawned[0] as { prompt: string }).prompt).not.toContain("/synthetic/alpha");
  });

  it("rejects invalid citations before a graph can be published and cleans the worker", async () => {
    const capture = await captureProject("Alpha", "/synthetic/alpha");
    const sdk = fakeSdk(() =>
      JSON.stringify({
        components: [
          {
            key: "bad",
            name: "Bad citation",
            responsibility: "Should never publish",
            state: "implemented",
            provenance: "inferred",
            evidence: [
              {
                kind: "code",
                path: "src/not-captured.ts",
                claim: "not real",
                startLine: 1,
                endLine: 1,
                provenance: "extracted",
              },
            ],
            documentMappings: [],
          },
        ],
        connections: [],
        unknownAreas: [],
      }),
    );

    await expect(
      new BbProjectGraphAnalyzer(sdk).analyze({
        projectId: "Alpha",
        target: target("Alpha", "/synthetic/alpha"),
        inventory: inventory("Alpha"),
        capture,
      }),
    ).rejects.toMatchObject({
      name: "ProjectAnalysisError",
      job: { status: "failed", cleanup: { archived: true, stopped: true } },
    });
  });

  it("retains a validated graph when cleanup fails and reconciles the owned worker", async () => {
    const capture = await captureProject("Alpha", "/synthetic/alpha");
    let archiveCalls = 0;
    let stopCalls = 0;
    const sdk = fakeSdk(() => JSON.stringify(graphFor(capture, "Alpha")), {
      onArchive: () => {
        archiveCalls += 1;
      },
      onStop: () => {
        stopCalls += 1;
        if (stopCalls === 1) throw new Error("stop temporarily unavailable");
      },
    });

    const analyzer = new BbProjectGraphAnalyzer(sdk);
    const result = await analyzer.analyze({
      projectId: "Alpha",
      target: target("Alpha", "/synthetic/alpha"),
      inventory: inventory("Alpha"),
      capture,
    });
    expect(result.normalized.graph.components.length).toBeGreaterThan(0);
    expect(result.job.cleanup).toMatchObject({
      archived: true,
      stopped: false,
      archiveAttempted: true,
      stopAttempted: true,
      recovery: { state: "retryable", retryable: true, attempts: 1 },
    });
    expect(archiveCalls).toBe(2);
    expect(stopCalls).toBe(2);

    const reconciled = await analyzer.reconcileCleanup(result.job.id);
    expect(reconciled).toMatchObject({
      archived: true,
      stopped: true,
      recovery: { state: "reconciled", retryable: false, attempts: 2 },
    });
    expect(archiveCalls).toBe(3);
    expect(stopCalls).toBe(3);
  });

  it("records missing configured scope without turning it into a provider claim", async () => {
    const missingReader: SourceReader = {
      async read(input) {
        if (input.relativePath === "src/main.ts") return rawFile(input, "export const main = true;\n");
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
    };
    const capture = await new SdkSourceCollector(missingReader).capture(
      target("Missing", "/synthetic/missing"),
      [{ path: "docs/architecture.md", maintenance: "keep-updated" }],
      { codePaths: ["src/main.ts"], scope: "whole-project" },
    );
    expect(capture.coverage.missing).toEqual([
      expect.objectContaining({ path: "docs/architecture.md", kind: "markdown" }),
    ]);
    expect(capture.coverage.complete).toBe(false);
    expect(capture.sources.map((source) => source.path)).toEqual(["src/main.ts"]);
  });

  it("rejects citations to captured Markdown that was omitted from the provider prompt", async () => {
    const files: Record<string, string> = {
      "docs/a.md": "# A\nSmall configured context.\n",
      "docs/b.md": `# B\n${"large-only-content ".repeat(1500)}\n`,
    };
    const capture = await new SdkSourceCollector({
      async read(input) {
        const content = files[input.relativePath];
        if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return rawFile(input, content);
      },
    }).capture(
      target("Omitted", "/synthetic/omitted"),
      [
        { path: "docs/a.md", maintenance: "keep-updated" },
        { path: "docs/b.md", maintenance: "reference-only" },
      ],
      { scope: "whole-project" },
    );
    const inventoryRecord: ProjectInventory = {
      capturedAt: 1,
      entries: [
        { path: "docs/a.md", kind: "markdown", status: "candidate" },
        { path: "docs/b.md", kind: "markdown", status: "candidate" },
      ],
      totalDiscovered: 2,
      truncated: false,
      omittedCount: 0,
    };
    let prompt = "";
    const sdk = fakeSdk(
      () =>
        JSON.stringify({
          components: [
            {
              key: "b",
              name: "B",
              responsibility: "Documented B boundary",
              parentKey: null,
              groupKey: null,
              state: "planned",
              provenance: "declared",
              evidence: [
                {
                  kind: "markdown",
                  path: "docs/b.md",
                  claim: "B is planned",
                  startLine: null,
                  endLine: null,
                  sectionAnchor: "b",
                  provenance: "declared",
                },
              ],
              documentMappings: [],
            },
          ],
          connections: [],
          unknownAreas: [],
        }),
      {
        onSpawn: (args) => {
          prompt = typeof args.prompt === "string" ? args.prompt : "";
        },
      },
    );
    await expect(
      new BbProjectGraphAnalyzer(sdk).analyze({
        projectId: "Omitted",
        target: target("Omitted", "/synthetic/omitted"),
        inventory: inventoryRecord,
        capture,
        limits: { maxPromptBytes: 10_000 },
      }),
    ).rejects.toMatchObject({
      name: "ProjectAnalysisError",
      message: expect.stringContaining("supplied to the provider analysis prompt"),
    });
    expect(prompt).toContain("omitted docs/b.md");
    expect(prompt).not.toContain("large-only-content");
  });

  it("cancels a running provider job and attempts both cleanup operations", async () => {
    const capture = await captureProject("Alpha", "/synthetic/alpha");
    const controller = new AbortController();
    const sdk = fakeSdk(
      () => JSON.stringify({ components: [], connections: [], unknownAreas: ["cancelled"] }),
      {
        onWait: async () => {
          controller.abort();
          throw new DOMException("cancelled", "AbortError");
        },
      },
    );
    const error = await new BbProjectGraphAnalyzer(sdk)
      .analyze({
        projectId: "Alpha",
        target: target("Alpha", "/synthetic/alpha"),
        inventory: inventory("Alpha"),
        capture,
        signal: controller.signal,
      })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ProjectAnalysisError);
    expect((error as ProjectAnalysisError).job).toMatchObject({
      status: "cancelled",
      workerThreadId: "analysis-worker",
      cleanup: { archived: true, stopped: true },
    });
  });

  it("uses the host inventory boundary and marks a truncated listing as unknown", async () => {
    const sdk = {
      files: {
        listPaths: async () => ({
          paths: [
            { path: "src/a.ts", name: "a.ts", kind: "file", positions: [], score: 0 },
            { path: "src/b.ts", name: "b.ts", kind: "file", positions: [], score: 0 },
          ],
          truncated: true,
        }),
      },
    } as unknown as BbPluginApi["sdk"];
    const result = await new SdkProjectInventoryCollector(sdk, { maxEntries: 1 }).collect(
      target("Alpha", "/synthetic/alpha"),
    );
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.omittedCount).toBeGreaterThan(0);
  });

  it("reconciles only an exactly correlated owned worker after spawn reports an error", async () => {
    const capture = await captureProject("Alpha", "/synthetic/alpha");
    let title = "";
    const sdk = fakeSdk(() => JSON.stringify(graphFor(capture, "Alpha")), {
      onSpawn: (args) => {
        title = args.title ?? "";
      },
      spawnError: new Error("spawn response lost after worker creation"),
      list: async () => [
        makeThreadResponse({
          id: "orphan-worker",
          projectId: "Alpha",
          environmentId: "Alpha-environment",
          originPluginId: "project-lens",
          title,
        }),
        makeThreadResponse({
          id: "unrelated-worker",
          projectId: "Alpha",
          environmentId: "Alpha-environment",
          originPluginId: "project-lens",
          title: "Project Lens bounded graph analysis",
        }),
      ],
    });

    await expect(
      new BbProjectGraphAnalyzer(sdk).analyze({
        projectId: "Alpha",
        target: target("Alpha", "/synthetic/alpha"),
        inventory: inventory("Alpha"),
        capture,
      }),
    ).rejects.toMatchObject({
      name: "ProjectAnalysisError",
      job: {
        workerThreadId: "orphan-worker",
        cleanup: { archived: true, stopped: true },
      },
    });
    expect(sdk.threads.list).toBeDefined();
  });
});

describe("graph normalization", () => {
  it("reuses a component identity when anchors support continuity despite a renamed provider label", async () => {
    const capture = await captureProject("Alpha", "/synthetic/alpha");
    const first = normalizeAgentGraph(graphFor(capture, "Alpha"), capture, inventory("Alpha"));
    const renamed = graphFor(capture, "Alpha");
    renamed.components[0]!.name = "Renamed API boundary";
    const second = normalizeAgentGraph(renamed, capture, inventory("Alpha"), {
      id: "old",
      versionNumber: 0,
      projectId: "Alpha",
      environmentId: "Alpha-environment",
      hostId: "Alpha-host",
      rootPath: "/synthetic/alpha",
      parentVersionId: null,
      createdAt: 1,
      configurationRevision: 1,
      documentSettings: [{ path: "docs/architecture.md", maintenance: "keep-updated" }],
      analyzerRevision: "test",
      sources: capture.sources,
      documentSections: capture.documentSections,
      graph: first.graph,
      coverage: capture.coverage,
    });
    expect(second.graph.components.find((component) => component.identityKey === "api")?.id).toBe(
      first.graph.components.find((component) => component.identityKey === "api")?.id,
    );
  });

  it("keeps identities distinct for shared-file components when wording and anchors change", async () => {
    const files: Record<string, string> = {
      "src/app.ts": "export function read() { return true; }\nexport function write() { return true; }\n",
      "src/extra.ts": "export const extra = true;\n",
    };
    const capture = await new SdkSourceCollector({
      async read(input) {
        const content = files[input.relativePath];
        if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return rawFile(input, content);
      },
    }).capture(
      target("Shared", "/synthetic/shared"),
      [],
      { codePaths: ["src/app.ts", "src/extra.ts"], scope: "whole-project" },
    );
    const sharedInventory: ProjectInventory = {
      capturedAt: 1,
      entries: [
        { path: "src/app.ts", kind: "code", status: "candidate" },
        { path: "src/extra.ts", kind: "code", status: "candidate" },
      ],
      totalDiscovered: 2,
      truncated: false,
      omittedCount: 0,
    };
    const citation = (path: string, startLine: number) => ({
      kind: "code" as const,
      path,
      claim: `${path}:${startLine}`,
      startLine,
      endLine: startLine,
      provenance: "extracted" as const,
    });
    const firstResponse: AgentGraphResponse = {
      components: [
        {
          key: "reader",
          name: "Reader",
          responsibility: "Reads input",
          parentKey: null,
          groupKey: null,
          state: "implemented",
          provenance: "inferred",
          evidence: [citation("src/app.ts", 1)],
          documentMappings: [],
        },
        {
          key: "writer",
          name: "Writer",
          responsibility: "Writes output",
          parentKey: null,
          groupKey: null,
          state: "implemented",
          provenance: "inferred",
          evidence: [citation("src/app.ts", 2)],
          documentMappings: [],
        },
      ],
      connections: [],
      unknownAreas: [],
    };
    const first = normalizeAgentGraph(firstResponse, capture, sharedInventory);
    const secondResponse: AgentGraphResponse = {
      ...firstResponse,
      components: [
        {
          ...firstResponse.components[0]!,
          name: "Read boundary renamed",
          evidence: [citation("src/app.ts", 1), citation("src/extra.ts", 1)],
        },
        {
          ...firstResponse.components[1]!,
          name: "Write boundary renamed",
        },
      ],
    };
    const previous: LensVersion = {
      id: "lens-shared-0",
      versionNumber: 0,
      projectId: "Shared",
      environmentId: "Shared-environment",
      hostId: "Shared-host",
      rootPath: "/synthetic/shared",
      parentVersionId: null,
      createdAt: 1,
      configurationRevision: 1,
      documentSettings: [],
      analyzerRevision: "test",
      sources: capture.sources,
      documentSections: capture.documentSections,
      graph: first.graph,
      coverage: capture.coverage,
    };
    const second = normalizeAgentGraph(secondResponse, capture, sharedInventory, previous);
    const firstReader = first.graph.components.find((component) => component.identityKey === "reader")!;
    const firstWriter = first.graph.components.find((component) => component.identityKey === "writer")!;
    const secondReader = second.graph.components.find((component) => component.identityKey === "reader")!;
    const secondWriter = second.graph.components.find((component) => component.identityKey === "writer")!;
    expect(secondReader.id).toBe(firstReader.id);
    expect(secondWriter.id).toBe(firstWriter.id);
    expect(second.identityWarnings).toEqual([]);
  });
});
