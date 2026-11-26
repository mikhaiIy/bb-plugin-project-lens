import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

const project = { id: "synthetic-generation", name: "Synthetic Generation", kind: "standard" as const };
const environment = {
  id: "synthetic-generation-env",
  projectId: project.id,
  hostId: "synthetic-generation-host",
  status: "ready" as const,
  path: "/synthetic/generation",
  workspaceProvisionType: "unmanaged" as const,
  branchName: "main",
};
const host = {
  id: "synthetic-generation-host",
  name: "Synthetic generation host",
  status: "connected" as const,
  type: "persistent" as const,
};

function fileResult(path: string, text: string) {
  const bytes = Buffer.from(text, "utf8");
  return {
    content: text,
    contentEncoding: "utf8" as const,
    mimeType: path.endsWith(".md") ? "text/markdown" : "text/typescript",
    modifiedAtMs: 10,
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

function graphOutput(
  kind: "valid" | "invalid",
  projectName = project.name,
  includeDocumentMapping = true,
) {
  if (kind === "invalid") {
    return JSON.stringify({
      components: [
        {
          key: "invalid",
          name: "Invalid",
          responsibility: "Invalid citation",
          state: "implemented",
          provenance: "inferred",
          evidence: [
            {
              kind: "code",
              path: "src/missing.ts",
              claim: "does not exist",
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
    });
  }
  return JSON.stringify({
    components: [
      {
        key: "api",
        name: `${projectName} API`,
        responsibility: "Exposes the project API.",
        state: "implemented",
        provenance: "inferred",
        evidence: [
          {
            kind: "code",
            path: "src/api.ts",
            claim: "The API function is implemented.",
            startLine: 1,
            endLine: 1,
            provenance: "extracted",
          },
        ],
        documentMappings: includeDocumentMapping
          ? [
              {
                documentPath: "docs/architecture.md",
                sectionAnchor: "architecture",
                claim: "The architecture document describes the API boundary.",
                relation: "supports",
                provenance: "declared",
              },
            ]
          : [],
      },
    ],
    connections: [],
    unknownAreas: [],
  });
}

describe("whole-project generation RPC", () => {
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
  });

  it("uses the configured provider, publishes Lens 0 and a subsequent immutable version", async () => {
    const files: Record<string, ReturnType<typeof fileResult>> = {
      "/synthetic/generation/docs/architecture.md": fileResult(
        "/synthetic/generation/docs/architecture.md",
        "# Architecture\nThe generated project has an API boundary.\n",
      ),
      "/synthetic/generation/src/api.ts": fileResult(
        "/synthetic/generation/src/api.ts",
        "export function api() { return true; }\n",
      ),
      "/synthetic/generation/src/ignored.txt": fileResult(
        "/synthetic/generation/src/ignored.txt",
        "not analyzed\n",
      ),
    };
    let outputKind: "valid" | "invalid" = "valid";
    const { bb, harness } = createFakePluginHost({
      pluginId: "project-lens",
      sdk: {
        projects: {
          list: async () => [project],
          get: async () => project,
          defaultExecutionOptions: async () => ({
            providerId: "configured-provider",
            model: "configured-model",
            permissionMode: "accept-edits",
            reasoningLevel: "none",
            serviceTier: "default",
          }),
        },
        environments: { get: async () => environment },
        hosts: { get: async () => host },
        files: {
          listPaths: async () => ({
            paths: [
              { path: "docs/architecture.md", name: "architecture.md", kind: "file", positions: [], score: 0 },
              { path: "src/api.ts", name: "api.ts", kind: "file", positions: [], score: 0 },
              { path: "src/ignored.txt", name: "ignored.txt", kind: "file", positions: [], score: 0 },
            ],
            truncated: false,
          }),
          read: async (args: { path: string }) => {
            const value = files[args.path];
            if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
            return value;
          },
        },
        threads: {
          spawn: async () => makeThreadResponse({ id: "lens-worker", providerId: "configured-provider" }),
          wait: async () => ({
            matched: true as const,
            threadId: "lens-worker",
            target: { kind: "status" as const, status: "idle" as const },
            thread: makeThreadResponse({ id: "lens-worker", status: "idle" }),
          }),
          output: async () => ({ output: graphOutput(outputKind) }),
          archive: async () => ({ ok: true as const }),
          stop: async () => ({ ok: true as const }),
        },
      },
    });
    await plugin(bb);
    dispose = harness.lifecycle.dispose;

    const agentConfiguration = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        project: { id: project.id, name: project.name, kind: "standard" },
        origin: { pluginId: null, kind: null },
      }),
    );
    expect(
      agentConfiguration.tools.map((tool) => (typeof tool === "string" ? tool : tool.name)),
    ).toContain("project_lens_generate");
    const withoutResolvedEnvironmentConfiguration = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        project: { id: project.id, name: project.name, kind: "standard" },
        environment: { path: null },
        origin: { pluginId: null, kind: null },
      }),
    );
    expect(
      withoutResolvedEnvironmentConfiguration.tools.map((tool) => (typeof tool === "string" ? tool : tool.name)),
    ).not.toContain("project_lens_generate");

    await harness.behavior.callRpc("settings_save", {
      projectId: project.id,
      enabled: true,
      documents: [{ path: "docs/architecture.md", maintenance: "keep-updated" }],
      expectedRevision: 0,
    });
    const first = (await harness.behavior.callRpc("lens_generate", {
      projectId: project.id,
      environmentId: environment.id,
      expectedParentVersionId: null,
    })) as {
      lens: {
        id: string;
        versionNumber: number;
        analysisProviderId: string | null;
        graph: { components: Array<{ id: string; name: string; evidence: unknown[] }> };
        inventory: { entries: Array<{ path: string; kind: string; status: string }> };
        coverage: { scope: string; excluded: unknown[]; complete: boolean };
      };
      capture: { sources: Array<{ path: string }>; coverage: { scope: string } };
      job: { cleanup: { archived: boolean; stopped: boolean } };
    };
    expect(first.lens.versionNumber).toBe(0);
    expect(first.lens.analysisProviderId).toBe("configured-provider");
    expect(first.lens.graph.components[0]).toMatchObject({ name: "Synthetic Generation API" });
    expect(first.lens.inventory.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/ignored.txt", kind: "other", status: "excluded" }),
      ]),
    );
    expect(first.lens.coverage.scope).toBe("whole-project");
    expect(first.capture.coverage.scope).toBe("whole-project");
    expect(first.job.cleanup).toEqual({ archived: true, stopped: true });
    expect(harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      projectId: project.id,
      providerId: "configured-provider",
      model: "configured-model",
      environment: { workspace: { path: null } },
    });

    files["/synthetic/generation/src/api.ts"] = fileResult(
      "/synthetic/generation/src/api.ts",
      "export function api() { return false; }\n",
    );
    const second = (await harness.behavior.callRpc("lens_generate", {
      projectId: project.id,
      environmentId: environment.id,
      expectedParentVersionId: first.lens.id,
    })) as { lens: { id: string; versionNumber: number; parentVersionId: string | null; graph: { components: Array<{ id: string }> } } };
    expect(second.lens.versionNumber).toBe(1);
    expect(second.lens.parentVersionId).toBe(first.lens.id);
    expect(second.lens.graph.components[0]?.id).toBe(first.lens.graph.components[0]?.id);

    const reopened = (await harness.behavior.callRpc("lens_get", {
      projectId: project.id,
      environmentId: environment.id,
      versionId: first.lens.id,
    })) as { sources: Array<{ path: string; bytesBase64: string }> };
    expect(Buffer.from(reopened.sources.find((source) => source.path === "src/api.ts")!.bytesBase64, "base64").toString("utf8")).toContain(
      "return true",
    );
  });

  it("does not publish invalid provider citations and keeps missing configured scope visible", async () => {
    const files: Record<string, ReturnType<typeof fileResult>> = {
      "/synthetic/generation/src/api.ts": fileResult(
        "/synthetic/generation/src/api.ts",
        "export function api() { return true; }\n",
      ),
    };
    let outputKind: "valid" | "invalid" = "invalid";
    let includeDocumentMapping = false;
    const { bb, harness } = createFakePluginHost({
      pluginId: "project-lens",
      sdk: {
        projects: {
          list: async () => [project],
          get: async () => project,
          defaultExecutionOptions: async () => ({
            providerId: "configured-provider",
            model: "configured-model",
            permissionMode: "accept-edits",
            reasoningLevel: "none",
            serviceTier: "default",
          }),
        },
        environments: { get: async () => environment },
        hosts: { get: async () => host },
        files: {
          listPaths: async () => ({
            paths: [{ path: "src/api.ts", name: "api.ts", kind: "file", positions: [], score: 0 }],
            truncated: false,
          }),
          read: async (args: { path: string }) => {
            const value = files[args.path];
            if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
            return value;
          },
        },
        threads: {
          spawn: async () => makeThreadResponse({ id: "lens-worker", providerId: "configured-provider" }),
          wait: async () => ({
            matched: true as const,
            threadId: "lens-worker",
            target: { kind: "status" as const, status: "idle" as const },
            thread: makeThreadResponse({ id: "lens-worker", status: "idle" }),
          }),
          output: async () => ({ output: graphOutput(outputKind, project.name, includeDocumentMapping) }),
          archive: async () => ({ ok: true as const }),
          stop: async () => ({ ok: true as const }),
        },
      },
    });
    await plugin(bb);
    dispose = harness.lifecycle.dispose;
    await harness.behavior.callRpc("settings_save", {
      projectId: project.id,
      enabled: true,
      documents: [{ path: "docs/architecture.md", maintenance: "keep-updated" }],
      expectedRevision: 0,
    });
    await expect(
      harness.behavior.callRpc("lens_generate", {
        projectId: project.id,
        environmentId: environment.id,
        expectedParentVersionId: null,
      }),
    ).rejects.toThrow(/does not identify a captured source/);
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);

    outputKind = "valid";
    const generated = (await harness.behavior.callRpc("lens_generate", {
      projectId: project.id,
      environmentId: environment.id,
      expectedParentVersionId: null,
    })) as { lens: { versionNumber: number; coverage: { missing: Array<{ path: string }>; complete: boolean } } };
    expect(generated.lens.versionNumber).toBe(0);
    expect(generated.lens.coverage.missing).toEqual([
      expect.objectContaining({ path: "docs/architecture.md" }),
    ]);
    expect(generated.lens.coverage.complete).toBe(false);
  });

  it("publishes a subsequent bounded Lens while persistent unresolved inventory stays visible", async () => {
    const files: Record<string, ReturnType<typeof fileResult>> = {
      "/synthetic/generation/docs/architecture.md": fileResult(
        "/synthetic/generation/docs/architecture.md",
        "# Architecture\nThe generated project has an API boundary.\n",
      ),
      "/synthetic/generation/src/api.ts": fileResult(
        "/synthetic/generation/src/api.ts",
        "export function api() { return true; }\n",
      ),
    };
    const inventoryPaths = ["docs/architecture.md", "src/api.ts", "../unresolved.ts"];
    const { bb, harness } = createFakePluginHost({
      pluginId: "project-lens",
      sdk: {
        projects: {
          list: async () => [project],
          get: async () => project,
          defaultExecutionOptions: async () => ({
            providerId: "configured-provider",
            model: "configured-model",
            permissionMode: "accept-edits" as const,
            reasoningLevel: "none" as const,
            serviceTier: "default" as const,
          }),
        },
        environments: { get: async () => environment },
        hosts: { get: async () => host },
        files: {
          listPaths: async () => ({
            paths: inventoryPaths.map((path) => ({
              path,
              name: path.split("/").at(-1)!,
              kind: "file" as const,
              positions: [],
              score: 0,
            })),
            truncated: false,
          }),
          read: async (args: { path: string }) => {
            const value = files[args.path];
            if (value === undefined) throw Object.assign(new Error(`missing ${args.path}`), { code: "ENOENT" });
            return value;
          },
        },
        threads: {
          spawn: async () => makeThreadResponse({ id: "bounded-worker", providerId: "configured-provider" }),
          wait: async () => ({
            matched: true as const,
            threadId: "bounded-worker",
            target: { kind: "status" as const, status: "idle" as const },
            thread: makeThreadResponse({ id: "bounded-worker", status: "idle" }),
          }),
          output: async () => ({ output: graphOutput("valid") }),
          archive: async () => ({ ok: true as const }),
          stop: async () => ({ ok: true as const }),
        },
      },
    });
    await plugin(bb);
    dispose = harness.lifecycle.dispose;
    await harness.behavior.callRpc("settings_save", {
      projectId: project.id,
      enabled: true,
      documents: [{ path: "docs/architecture.md", maintenance: "keep-updated" }],
      expectedRevision: 0,
    });

    const first = (await harness.behavior.callRpc("lens_generate", {
      projectId: project.id,
      environmentId: environment.id,
      expectedParentVersionId: null,
    })) as { lens: { id: string; versionNumber: number; coverage: { complete: boolean; unknownAreas?: string[] }; inventory: { entries: Array<{ status: string }> } } };
    expect(first.lens.versionNumber).toBe(0);
    expect(first.lens.coverage.complete).toBe(false);
    expect(first.lens.inventory.entries).toEqual(expect.arrayContaining([expect.objectContaining({ status: "unresolved" })]));

    const second = (await harness.behavior.callRpc("lens_generate", {
      projectId: project.id,
      environmentId: environment.id,
      expectedParentVersionId: first.lens.id,
    })) as { lens: { versionNumber: number; parentVersionId: string; coverage: { complete: boolean }; inventory: { entries: Array<{ status: string }> } } };
    expect(second.lens).toMatchObject({
      versionNumber: 1,
      parentVersionId: first.lens.id,
      coverage: { complete: false },
    });
    expect(second.lens.inventory.entries).toEqual(expect.arrayContaining([expect.objectContaining({ status: "unresolved" })]));
  });

  it("returns an operation id early and cancels the same provider lifecycle without publishing", async () => {
    const files: Record<string, ReturnType<typeof fileResult>> = {
      "/synthetic/generation/docs/architecture.md": fileResult(
        "/synthetic/generation/docs/architecture.md",
        "# Architecture\nThe API boundary is documented.\n",
      ),
      "/synthetic/generation/src/api.ts": fileResult(
        "/synthetic/generation/src/api.ts",
        "export function api() { return true; }\n",
      ),
    };
    let waitStarted!: () => void;
    const waitStartedPromise = new Promise<void>((resolve) => {
      waitStarted = resolve;
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "project-lens",
      sdk: {
        projects: {
          list: async () => [project],
          get: async () => project,
          defaultExecutionOptions: async () => ({
            providerId: "configured-provider",
            model: "configured-model",
            permissionMode: "accept-edits",
            reasoningLevel: "none",
            serviceTier: "default",
          }),
        },
        environments: { get: async () => environment },
        hosts: { get: async () => host },
        files: {
          listPaths: async () => ({
            paths: [
              { path: "docs/architecture.md", name: "architecture.md", kind: "file", positions: [], score: 0 },
              { path: "src/api.ts", name: "api.ts", kind: "file", positions: [], score: 0 },
            ],
            truncated: false,
          }),
          read: async (args: { path: string }) => {
            const value = files[args.path];
            if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
            return value;
          },
        },
        threads: {
          spawn: async () => makeThreadResponse({ id: "cancellable-worker", providerId: "configured-provider" }),
          wait: async ({ signal }: { signal?: AbortSignal }) => {
            waitStarted();
            await new Promise<never>((_resolve, reject) => {
              if (signal?.aborted) {
                reject(new DOMException("cancelled", "AbortError"));
                return;
              }
              signal?.addEventListener(
                "abort",
                () => reject(new DOMException("cancelled", "AbortError")),
                { once: true },
              );
            });
            throw new DOMException("cancelled", "AbortError");
          },
          output: async () => ({ output: graphOutput("valid") }),
          archive: async () => ({ ok: true as const }),
          stop: async () => ({ ok: true as const }),
        },
      },
    });
    await plugin(bb);
    dispose = harness.lifecycle.dispose;
    await harness.behavior.callRpc("settings_save", {
      projectId: project.id,
      enabled: true,
      documents: [{ path: "docs/architecture.md", maintenance: "keep-updated" }],
      expectedRevision: 0,
    });

    const started = (await harness.behavior.callRpc("lens_generate_start", {
      projectId: project.id,
      environmentId: environment.id,
      expectedParentVersionId: null,
    })) as { operationId: string; status: string };
    expect(started.operationId).toMatch(/^generation:/);
    expect(["queued", "running"]).toContain(started.status);
    await waitStartedPromise;

    const cancelling = (await harness.behavior.callRpc("lens_generate_cancel", {
      projectId: project.id,
      environmentId: environment.id,
      operationId: started.operationId,
    })) as { status: string; cancelRequested: boolean };
    expect(cancelling.cancelRequested).toBe(true);
    expect(cancelling.status).toBe("cancelling");

    let terminal: { status: string; result: unknown; analysis: { status: string } | null } | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      terminal = (await harness.behavior.callRpc("lens_generate_status", {
        projectId: project.id,
        environmentId: environment.id,
        operationId: started.operationId,
      })) as typeof terminal;
      if (terminal !== undefined && (terminal.status === "cancelled" || terminal.status === "failed")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (terminal === undefined) throw new Error("generation status did not reach a terminal state");
    expect(terminal).toMatchObject({ status: "cancelled", result: null, analysis: { status: "cancelled" } });
    expect((await harness.behavior.callRpc("lens_current", {
      projectId: project.id,
      environmentId: environment.id,
    })) as { lens: unknown }).toEqual({ lens: null });
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
  });
});
