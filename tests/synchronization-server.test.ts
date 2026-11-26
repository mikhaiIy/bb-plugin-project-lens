import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { assessSourceFreshness } from "../src/diagram.js";
import { buildProjectLensAgentSelection } from "../src/agent-context.js";
import { compareDocumentSources, validateFocusedDocumentEdit } from "../src/synchronization.js";
import { extractDocumentSections } from "../src/source-capture.js";
import type { LensVersion, ProjectLensSettings } from "../src/model.js";

const project = { id: "w04-project", name: "Disposable W04 Project", kind: "standard" as const };
const environment = {
  id: "w04-environment",
  projectId: project.id,
  hostId: "w04-host",
  status: "ready" as const,
  path: "/synthetic/w04-project",
  workspaceProvisionType: "unmanaged" as const,
  branchName: "main",
};
const host = {
  id: environment.hostId,
  name: "Disposable W04 host",
  status: "connected" as const,
  type: "persistent" as const,
};

function fileResult(path: string, text: string) {
  const bytes = Buffer.from(text, "utf8");
  return {
    content: text,
    contentEncoding: "utf8" as const,
    mimeType: path.endsWith(".md") ? "text/markdown" : "text/typescript",
    modifiedAtMs: 100,
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

function graphOutput(kind: "valid" | "invalid" = "valid") {
  if (kind === "invalid") {
    return JSON.stringify({
      components: [
        {
          key: "invalid",
          name: "Invalid provider claim",
          responsibility: "The citation is intentionally outside the captured source set.",
          state: "implemented",
          provenance: "inferred",
          evidence: [
            {
              kind: "code",
              path: "src/not-captured.ts",
              claim: "invalid",
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
        name: "API boundary",
        responsibility: "Validates and serves the project API.",
        state: "implemented",
        provenance: "inferred",
        evidence: [
          {
            kind: "code",
            path: "src/api.ts",
            claim: "The API implementation is present.",
            startLine: 1,
            endLine: 1,
            provenance: "extracted",
          },
        ],
        documentMappings: [
          {
            documentPath: "docs/architecture.md",
            sectionAnchor: "api",
            claim: "The API section describes the implemented boundary.",
            relation: "supports",
            provenance: "declared",
          },
        ],
      },
    ],
    connections: [],
    unknownAreas: [],
  });
}

function pathFor(relativePath: string): string {
  return `${environment.path}/${relativePath}`;
}

describe("W04 Project Lens synchronization", () => {
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
  });

  function makeHost(options: {
    outputKind?: "valid" | "invalid";
    onWrite?: (path: string, content: string) => "conflict" | undefined;
    afterWrite?: (path: string, content: string, files: Record<string, ReturnType<typeof fileResult>>) => void;
    inventoryPaths?: () => string[];
  } = {}) {
    const files: Record<string, ReturnType<typeof fileResult>> = {
      [pathFor("docs/architecture.md")]: fileResult(
        pathFor("docs/architecture.md"),
        "# Architecture\n\n## API\nThe API exposes the original boundary.\n\n## Future\nKeep this planned migration.\n",
      ),
      [pathFor("docs/design-target.md")]: fileResult(
        pathFor("docs/design-target.md"),
        "# Design target\n\n## Future\nThis is a reference-only future design.\n",
      ),
      [pathFor("src/api.ts")]: fileResult(pathFor("src/api.ts"), "export function api() { return 'original'; }\n"),
    };
    let outputKind = options.outputKind ?? "valid";
    let writeCount = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "project-lens",
      agentSkillIds: ["project-lens-completion"],
      sdk: {
        projects: {
          list: async () => [project],
          get: async () => project,
          defaultExecutionOptions: async () => ({
            providerId: "configured-provider",
            model: "configured-model",
            permissionMode: "accept-edits" as const,
            reasoningLevel: "none" as const,
            serviceTier: "default",
          }),
        },
        environments: { get: async () => environment },
        hosts: { get: async () => host },
        files: {
          listPaths: async () => ({
            paths: (options.inventoryPaths?.() ?? [
              "docs/architecture.md",
              "docs/design-target.md",
              "src/api.ts",
            ]).map((path) => ({ path, name: path.split("/").at(-1)!, kind: "file" as const, positions: [], score: 0 })),
            truncated: false,
          }),
          read: async (args: { path: string }) => {
            const value = files[args.path];
            if (value === undefined) throw Object.assign(new Error(`missing ${args.path}`), { code: "ENOENT" });
            return value;
          },
          write: async (args: { path: string; content: string; expectedSha256?: string | null }) => {
            const current = files[args.path];
            const currentSha = current?.sha256 ?? null;
            if (options.onWrite?.(args.path, args.content) === "conflict") {
              return { outcome: "conflict" as const, currentSha256: currentSha };
            }
            if (args.expectedSha256 !== undefined && args.expectedSha256 !== currentSha) {
              return { outcome: "conflict" as const, currentSha256: currentSha };
            }
            files[args.path] = fileResult(args.path, args.content);
            writeCount += 1;
            options.afterWrite?.(args.path, args.content, files);
            return { outcome: "written" as const, sha256: files[args.path]!.sha256, sizeBytes: files[args.path]!.sizeBytes };
          },
        },
        threads: {
          spawn: async () => makeThreadResponse({ id: `w04-worker-${Date.now()}`, providerId: "configured-provider" }),
          wait: async ({ threadId }: { threadId: string }) => ({
            matched: true as const,
            threadId,
            target: { kind: "status" as const, status: "idle" as const },
            thread: makeThreadResponse({ id: threadId, status: "idle" }),
          }),
          output: async () => ({ output: graphOutput(outputKind) }),
          archive: async () => ({ ok: true as const }),
          stop: async () => ({ ok: true as const }),
        },
      },
    });
    return {
      bb,
      harness,
      files,
      setOutputKind(kind: "valid" | "invalid") { outputKind = kind; },
      getWriteCount() { return writeCount; },
    };
  }

  async function configure(hostHarness: ReturnType<typeof makeHost>, enabled = true) {
    await hostHarness.harness.behavior.callRpc("settings_save", {
      projectId: project.id,
      enabled,
      documents: [
        { path: "docs/architecture.md", purpose: "Current structure", maintenance: "keep-updated" },
        { path: "docs/design-target.md", purpose: "Future intent", maintenance: "reference-only" },
      ],
      expectedRevision: 0,
    });
  }

  it("injects project-conditioned skill/context and synchronizes final code to docs to Lens", async () => {
    const hostHarness = makeHost();
    await plugin(hostHarness.bb);
    dispose = hostHarness.harness.lifecycle.dispose;
    await configure(hostHarness);

    const beforeConfig = await hostHarness.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        project: project,
        environment: { id: environment.id, path: environment.path },
        host: { id: host.id, name: host.name },
      }),
    );
    expect(beforeConfig.skills).toContain("project-lens-completion");
    expect(beforeConfig.tools.map((tool) => typeof tool === "string" ? tool : tool.name)).toEqual(
      expect.arrayContaining([
        "project_lens_initialize",
        "project_lens_synchronize",
        "project_lens_compare",
      ]),
    );
    expect(beforeConfig.instructions).toContain(project.id);
    expect(beforeConfig.instructions).toContain(environment.id);
    expect(beforeConfig.instructions).toContain("docs/architecture.md");
    expect(beforeConfig.instructions).toContain("reference-only");

    const initialized = (await hostHarness.harness.behavior.callRpc("lens_initialize", {
      projectId: project.id,
      environmentId: environment.id,
      codePaths: [],
    })) as { lens: LensVersion; capture: { sources: Array<{ path: string }> } };
    expect(initialized.lens.versionNumber).toBe(0);
    const lensZero = initialized.lens;
    const architectureBefore = hostHarness.files[pathFor("docs/architecture.md")]!;
    hostHarness.files[pathFor("src/api.ts")] = fileResult(
      pathFor("src/api.ts"),
      "export function api() { return 'validated'; }\n",
    );
    const editedArchitecture = "# Architecture\n\n## API\nThe API now validates requests.\n\n## Future\nKeep this planned migration.\n";
    const synchronized = (await hostHarness.harness.behavior.callRpc("lens_synchronize", {
      projectId: project.id,
      environmentId: environment.id,
      expectedParentVersionId: lensZero.id,
      expectedConfigurationRevision: 1,
      codePaths: ["src/api.ts"],
      documentEdits: [{
        path: "docs/architecture.md",
        expectedSha256: architectureBefore.sha256,
        content: editedArchitecture,
        affectedSections: [{ anchor: "api", reason: "The API contract changed." }],
        reason: "Document the validated API boundary.",
      }],
      noChangeFindings: [],
    })) as { status: string; lens: { versionNumber: number; parentVersionId: string | null }; documents: Array<{ path: string; action: string }> };
    expect(synchronized.status).toBe("completed");
    expect(synchronized.lens).toMatchObject({ versionNumber: 1, parentVersionId: lensZero.id });
    expect(synchronized.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/architecture.md", action: "updated" }),
      expect.objectContaining({ path: "docs/design-target.md", action: "preserved" }),
    ]));
    expect(hostHarness.getWriteCount()).toBe(1);

    const comparison = (await hostHarness.harness.behavior.callRpc("lens_compare", {
      projectId: project.id,
      environmentId: environment.id,
    })) as {
      current: { id: string };
      baseline: { id: string } | null;
      documentChanges: Array<{
        path: string;
        status: string;
        changedSections: string[];
        baselineVersionId: string | null;
        currentVersionId: string;
        sections: Array<{ anchor: string; beforeText: string | null; afterText: string | null }>;
      }>;
    };
    expect(comparison.current.id).toBe(synchronized.lens && (await hostHarness.harness.behavior.callRpc("lens_current", { projectId: project.id, environmentId: environment.id }) as { lens: { id: string } }).lens.id);
    expect(comparison.baseline?.id).toBe(lensZero.id);
    expect(comparison.documentChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/architecture.md", status: "changed", changedSections: ["api"] }),
      expect.objectContaining({ path: "docs/design-target.md", status: "unchanged" }),
    ]));
    const architectureDiff = comparison.documentChanges.find((document) => document.path === "docs/architecture.md")!;
    expect(architectureDiff.baselineVersionId).toBe(lensZero.id);
    expect(architectureDiff.currentVersionId).toBe(synchronized.lens && (await hostHarness.harness.behavior.callRpc("lens_current", { projectId: project.id, environmentId: environment.id }) as { lens: { id: string } }).lens.id);
    expect(architectureDiff.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        anchor: "api",
        beforeText: expect.stringContaining("original boundary"),
        afterText: expect.stringContaining("validates requests"),
      }),
    ]));

    const reopenedZero = (await hostHarness.harness.behavior.callRpc("lens_get", {
      projectId: project.id,
      environmentId: environment.id,
      versionId: lensZero.id,
    })) as LensVersion;
    expect(Buffer.from(reopenedZero.sources.find((source) => source.path === "docs/architecture.md")!.bytesBase64, "base64").toString("utf8")).toBe(
      "# Architecture\n\n## API\nThe API exposes the original boundary.\n\n## Future\nKeep this planned migration.\n",
    );

    const afterConfig = await hostHarness.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ project: project, environment: { id: environment.id, path: environment.path } }),
    );
    expect(afterConfig.instructions).toContain(`Current Lens: ${synchronized.lens && (await hostHarness.harness.behavior.callRpc("lens_current", { projectId: project.id, environmentId: environment.id }) as { lens: { id: string } }).lens.id}`);
  });

  it("records no-change findings, exposes skipped-sync freshness, and retries after docs succeeded but generation failed", async () => {
    const hostHarness = makeHost();
    await plugin(hostHarness.bb);
    dispose = hostHarness.harness.lifecycle.dispose;
    await configure(hostHarness);
    const initial = (await hostHarness.harness.behavior.callRpc("lens_initialize", {
      projectId: project.id,
      environmentId: environment.id,
      codePaths: [],
    })) as { lens: LensVersion };
    const architecturePath = pathFor("docs/architecture.md");
    const currentDocument = () => hostHarness.files[architecturePath]!;

    hostHarness.files[pathFor("src/api.ts")] = fileResult(pathFor("src/api.ts"), "export function api() { return 'no-change'; }\n");
    const noChange = (await hostHarness.harness.behavior.callRpc("lens_synchronize", {
      projectId: project.id,
      environmentId: environment.id,
      expectedParentVersionId: initial.lens.id,
      expectedConfigurationRevision: 1,
      codePaths: ["src/api.ts"],
      documentEdits: [],
      noChangeFindings: [{
        path: "docs/architecture.md",
        expectedSha256: currentDocument().sha256,
        checkedSections: ["api"],
        reason: "The existing API wording remains accurate for this implementation-only change.",
      }],
    })) as { status: string; documents: Array<{ action: string; path: string }> ; lens: { versionId: string } };
    expect(noChange.status).toBe("completed");
    expect(noChange.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/architecture.md", action: "no-change" }),
    ]));
    expect(hostHarness.getWriteCount()).toBe(0);

    // A changed code file without a synchronization call is independently stale.
    const currentLens = (await hostHarness.harness.behavior.callRpc("lens_current", { projectId: project.id, environmentId: environment.id }) as { lens: LensVersion }).lens;
    hostHarness.files[pathFor("src/api.ts")] = fileResult(pathFor("src/api.ts"), "export function api() { return 'skipped'; }\n");
    const staleCapture = await hostHarness.harness.behavior.callRpc("sources_capture", {
      projectId: project.id,
      environmentId: environment.id,
      codePaths: ["src/api.ts"],
    });
    const stale = assessSourceFreshness(currentLens, staleCapture as Parameters<typeof assessSourceFreshness>[1], 1);
    expect(stale.status).toBe("stale");
    expect(stale.changedPaths).toContain("src/api.ts");

    // Restore the code to a new controlled change and make the provider fail.
    hostHarness.files[pathFor("src/api.ts")] = fileResult(pathFor("src/api.ts"), "export function api() { return 'retryable'; }\n");
    hostHarness.setOutputKind("invalid");
    const failed = (await hostHarness.harness.behavior.callRpc("lens_synchronize", {
      projectId: project.id,
      environmentId: environment.id,
      expectedParentVersionId: noChange.lens.versionId,
      expectedConfigurationRevision: 1,
      codePaths: ["src/api.ts"],
      documentEdits: [{
        path: architecturePath.replace(`${environment.path}/`, ""),
        expectedSha256: currentDocument().sha256,
        content: "# Architecture\n\n## API\nThe API now documents retry recovery.\n\n## Future\nKeep this planned migration.\n",
        affectedSections: [{ anchor: "api", reason: "Retry recovery changed the API documentation." }],
        reason: "Record the retryable provider boundary.",
      }],
      noChangeFindings: [],
    })) as { status: string; operationId: string; documents: Array<{ action: string }> };
    expect(failed.status).toBe("generation-failed");
    expect(failed.documents).toEqual(expect.arrayContaining([expect.objectContaining({ action: "updated" })]));
    expect(hostHarness.getWriteCount()).toBe(1);

    hostHarness.setOutputKind("valid");
    const retried = (await hostHarness.harness.behavior.callRpc("lens_synchronize_retry", {
      projectId: project.id,
      environmentId: environment.id,
      operationId: failed.operationId,
    })) as { status: string; lens: { versionNumber: number } | null; unresolvedItems: string[] };
    expect(retried.status).toBe("completed");
    expect(retried.lens).toMatchObject({ versionNumber: 2 });
    expect(retried.unresolvedItems).toEqual([]);
    expect(hostHarness.getWriteCount()).toBe(1);
  });

  it("does not leak completion context to disabled or other-project resolutions", async () => {
    const hostHarness = makeHost();
    await plugin(hostHarness.bb);
    dispose = hostHarness.harness.lifecycle.dispose;
    await configure(hostHarness, false);

    const disabled = await hostHarness.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        project,
        environment: { id: environment.id, path: environment.path },
        host: { id: host.id, name: host.name },
      }),
    );
    expect(disabled.skills).not.toContain("project-lens-completion");
    expect(disabled.instructions ?? "").not.toContain(project.id);

    const otherProject = await hostHarness.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        project: { id: "other-project", name: "Other project", kind: "standard" },
        environment: { id: "other-environment", path: "/synthetic/other-project" },
        host: { id: "other-host", name: "Other host" },
      }),
    );
    expect(otherProject.skills).not.toContain("project-lens-completion");
    expect(otherProject.instructions ?? "").not.toContain("docs/architecture.md");
  });

  it("rejects stale parent and host CAS conflicts without publishing or clobbering Markdown", async () => {
    const hostHarness = makeHost({
      onWrite: () => "conflict",
    });
    await plugin(hostHarness.bb);
    dispose = hostHarness.harness.lifecycle.dispose;
    await configure(hostHarness);
    const baseline = (await hostHarness.harness.behavior.callRpc("lens_initialize", {
      projectId: project.id,
      environmentId: environment.id,
      codePaths: [],
    })) as { lens: LensVersion };
    const architecturePath = "docs/architecture.md";
    const staleParent = (await hostHarness.harness.behavior.callRpc("lens_synchronize", {
      projectId: project.id,
      environmentId: environment.id,
      expectedParentVersionId: baseline.lens.id,
      expectedConfigurationRevision: 1,
      codePaths: ["src/api.ts"],
      documentEdits: [{
        path: architecturePath,
        expectedSha256: hostHarness.files[pathFor(architecturePath)]!.sha256,
        content: "# Architecture\n\n## API\nA focused edit.\n\n## Future\nKeep this planned migration.\n",
        affectedSections: [{ anchor: "api", reason: "Focused test edit." }],
        reason: "Test CAS conflict.",
      }],
      noChangeFindings: [],
    })) as { status: string; lens: unknown; error: string | null };
    expect(staleParent.status).toBe("conflict");
    expect(staleParent.lens).toBeNull();
    expect(hostHarness.getWriteCount()).toBe(0);
  });

  it("binds post-CAS document bytes to the generation boundary before publishing", async () => {
    const architecturePath = pathFor("docs/architecture.md");
    let foreignEditApplied = false;
    const hostHarness = makeHost({
      afterWrite: (path, _content, files) => {
        if (path !== architecturePath || foreignEditApplied) return;
        foreignEditApplied = true;
        files[path] = fileResult(
          path,
          "# Architecture\n\n## API\nA foreign editor changed this after CAS.\n\n## Future\nKeep this planned migration.\n",
        );
      },
    });
    await plugin(hostHarness.bb);
    dispose = hostHarness.harness.lifecycle.dispose;
    await configure(hostHarness);
    const initial = (await hostHarness.harness.behavior.callRpc("lens_initialize", {
      projectId: project.id,
      environmentId: environment.id,
      codePaths: [],
    })) as { lens: LensVersion };
    const before = hostHarness.files[architecturePath]!;
    const result = (await hostHarness.harness.behavior.callRpc("lens_synchronize", {
      projectId: project.id,
      environmentId: environment.id,
      expectedParentVersionId: initial.lens.id,
      expectedConfigurationRevision: 1,
      codePaths: ["src/api.ts"],
      documentEdits: [{
        path: "docs/architecture.md",
        expectedSha256: before.sha256,
        content: "# Architecture\n\n## API\nThe builder intended this update.\n\n## Future\nKeep this planned migration.\n",
        affectedSections: [{ anchor: "api", reason: "The API wording changed." }],
        reason: "Document the builder change.",
      }],
      noChangeFindings: [],
    })) as { status: string; lens: unknown; sourceFinal: Array<{ path: string; sha256: string }>; error: string | null };
    expect(result.status).toBe("conflict");
    expect(result.lens).toBeNull();
    expect(result.error).toMatch(/boundary|Document docs\/architecture\.md/i);
    expect(hostHarness.files[architecturePath]!.content).toContain("foreign editor");
    expect(result.sourceFinal.find((source) => source.path === "docs/architecture.md")?.sha256).toBe(hostHarness.files[architecturePath]!.sha256);
    expect((await hostHarness.harness.behavior.callRpc("lens_current", {
      projectId: project.id,
      environmentId: environment.id,
    }) as { lens: LensVersion }).lens.id).toBe(initial.lens.id);
  });

  it("treats inventory additions and deletions as stale, and requires a maintained decision for an addition", async () => {
    let inventoryPaths = ["docs/architecture.md", "docs/design-target.md", "src/api.ts"];
    const hostHarness = makeHost({ inventoryPaths: () => inventoryPaths });
    await plugin(hostHarness.bb);
    dispose = hostHarness.harness.lifecycle.dispose;
    await configure(hostHarness);
    const initial = (await hostHarness.harness.behavior.callRpc("lens_initialize", {
      projectId: project.id,
      environmentId: environment.id,
      codePaths: [],
    })) as { lens: LensVersion };

    const addedPath = "src/new-feature.ts";
    const addedAbsolutePath = pathFor(addedPath);
    hostHarness.files[addedAbsolutePath] = fileResult(addedAbsolutePath, "export const newFeature = true;\n");
    inventoryPaths = [...inventoryPaths, addedPath];
    const addedCapture = await hostHarness.harness.behavior.callRpc("sources_capture", {
      projectId: project.id,
      environmentId: environment.id,
      codePaths: ["src/api.ts"],
    });
    const staleAfterAddition = assessSourceFreshness(initial.lens, addedCapture as Parameters<typeof assessSourceFreshness>[1], 1);
    expect(staleAfterAddition.status).toBe("stale");
    expect(staleAfterAddition.changedPaths).toContain(addedPath);

    const skippedDecision = (await hostHarness.harness.behavior.callRpc("lens_synchronize", {
      projectId: project.id,
      environmentId: environment.id,
      expectedParentVersionId: initial.lens.id,
      expectedConfigurationRevision: 1,
      codePaths: ["src/new-feature.ts"],
      documentEdits: [],
      noChangeFindings: [],
    })) as { status: string; lens: unknown; unresolvedItems: string[] };
    expect(skippedDecision.status).toBe("failed");
    expect(skippedDecision.lens).toBeNull();
    expect(skippedDecision.unresolvedItems.some((item) => item.includes("maintained Markdown"))).toBe(true);

    inventoryPaths = inventoryPaths.filter((path) => path !== addedPath);
    delete hostHarness.files[addedAbsolutePath];
    inventoryPaths = inventoryPaths.filter((path) => path !== "src/api.ts");
    delete hostHarness.files[pathFor("src/api.ts")];
    const deletedCapture = await hostHarness.harness.behavior.callRpc("sources_capture", {
      projectId: project.id,
      environmentId: environment.id,
      codePaths: ["src/api.ts"],
    });
    const staleAfterDeletion = assessSourceFreshness(initial.lens, deletedCapture as Parameters<typeof assessSourceFreshness>[1], 1);
    expect(staleAfterDeletion.status).toBe("stale");
    expect(staleAfterDeletion.changedPaths).toContain("src/api.ts");
  });

  it("protects Markdown bytes and line endings outside the named section", () => {
    const before = "# Architecture\r\n\r\n## API\r\nOriginal API.\r\n\r\n## Future\r\nKeep this future note.\r\n";
    const beforeSha = "a".repeat(64);
    const sections = extractDocumentSections("docs/architecture.md", before, "source:before", beforeSha);
    const changedInside = "# Architecture\r\n\r\n## API\r\nUpdated API.\r\n\r\n## Future\r\nKeep this future note.\r\n";
    expect(validateFocusedDocumentEdit(
      "docs/architecture.md",
      before,
      changedInside,
      sections,
      [{ anchor: "api", reason: "API changed." }],
    ).changed).toBe(true);
    const changedOutsideLineEndings = changedInside.replaceAll("\r\n", "\n");
    expect(() => validateFocusedDocumentEdit(
      "docs/architecture.md",
      before,
      changedOutsideLineEndings,
      sections,
      [{ anchor: "api", reason: "API changed." }],
    )).toThrow(/outside the affected Markdown sections/);
    const droppedFinalNewline = changedInside.slice(0, -2);
    expect(() => validateFocusedDocumentEdit(
      "docs/architecture.md",
      before,
      droppedFinalNewline,
      sections,
      [{ anchor: "api", reason: "API changed." }],
    )).toThrow(/outside the affected Markdown sections/);
  });

  it("keeps the completion directive and freshness warning inside a bounded context", () => {
    const settings: ProjectLensSettings = {
      projectId: project.id,
      enabled: true,
      documents: Array.from({ length: 40 }, (_, index) => ({
        path: `docs/architecture-${index}.md`,
        purpose: "A deliberately long document purpose used to exercise the reserved context budget.",
        maintenance: "keep-updated" as const,
      })),
      revision: 7,
      updatedAt: 1,
    };
    const selection = buildProjectLensAgentSelection({
      project: { ...project },
      environment: {
        id: environment.id,
        name: environment.id,
        path: environment.path,
        workspaceProvisionType: environment.workspaceProvisionType,
        branchName: environment.branchName,
      },
      host: { id: host.id, name: host.name },
      settings,
      currentLens: null,
      latestSynchronization: null,
    });
    expect(selection.instructions).toBeDefined();
    expect(selection.instructions!.length).toBeLessThanOrEqual(4096);
    expect(selection.instructions).toContain("Completion directive:");
    expect(selection.instructions).toContain("A passing build or idle thread is not synchronization.");
    expect(selection.instructions).toContain("Context budget:");
    expect(selection.instructions).not.toMatch(/\.\.\.$/);
  });
});
