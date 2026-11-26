import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { assessSourceFreshness } from "../src/diagram.js";
import type { LensVersion } from "../src/model.js";

const project = { id: "correction2-q11", name: "Correction 2 Q11", kind: "standard" as const };
const environment = {
  id: "correction2-q11-env",
  projectId: project.id,
  hostId: "correction2-q11-host",
  status: "ready" as const,
  path: "/synthetic/correction2-q11",
  workspaceProvisionType: "unmanaged" as const,
  branchName: "main",
};
const host = {
  id: environment.hostId,
  name: "Correction 2 Q11 host",
  status: "connected" as const,
  type: "persistent" as const,
};

function fileResult(path: string, content: string) {
  const bytes = Buffer.from(content, "utf8");
  return {
    content,
    contentEncoding: "utf8" as const,
    mimeType: path.endsWith(".md") ? "text/markdown" : "text/typescript",
    modifiedAtMs: 100,
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

const graphOutput = JSON.stringify({
  components: [
    {
      key: "api",
      name: "API",
      responsibility: "Serves the API.",
      state: "implemented",
      provenance: "inferred",
      evidence: [
        {
          kind: "code",
          path: "src/api.ts",
          claim: "The API is implemented.",
          startLine: 1,
          endLine: 1,
          provenance: "extracted",
        },
      ],
      documentMappings: [
        {
          documentPath: "docs/architecture.md",
          sectionAnchor: "api",
          claim: "The API boundary is documented.",
          relation: "supports",
          provenance: "declared",
        },
      ],
    },
  ],
  connections: [],
  unknownAreas: [],
});

describe("correction 2 Q11 bounded refresh", () => {
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
  });

  it("keeps both unchanged captures unknown and still publishes the next bounded Lens", async () => {
    const files = {
      [`${environment.path}/docs/architecture.md`]: fileResult(
        `${environment.path}/docs/architecture.md`,
        "# Architecture\n\n## API\nThe API boundary is documented.\n",
      ),
      [`${environment.path}/src/api.ts`]: fileResult(
        `${environment.path}/src/api.ts`,
        "export const api = 1;\n",
      ),
    };
    const inventory = [
      "docs/architecture.md",
      "src/api.ts",
      ...Array.from({ length: 2500 }, (_value, index) => `generated/file-${index}.txt`),
    ];
    const { bb, harness } = createFakePluginHost({
      pluginId: "project-lens",
      sdk: {
        projects: {
          list: async () => [project],
          get: async () => project,
          defaultExecutionOptions: async () => ({
            providerId: "q11-provider",
            model: "q11-model",
            permissionMode: "accept-edits" as const,
            reasoningLevel: "none" as const,
            serviceTier: "default" as const,
          }),
        },
        environments: { get: async () => environment },
        hosts: { get: async () => host },
        files: {
          listPaths: async ({ limit }: { limit?: number }) => {
            const paths = inventory.slice(0, limit ?? inventory.length);
            return {
              paths: paths.map((path) => ({
                path,
                name: path.split("/").at(-1)!,
                kind: "file" as const,
                positions: [],
                score: 0,
              })),
              truncated: paths.length < inventory.length,
            };
          },
          read: async (args: { path: string }) => {
            const result = files[args.path as keyof typeof files];
            if (result === undefined) {
              throw Object.assign(new Error(`missing ${args.path}`), { code: "ENOENT" });
            }
            return result;
          },
        },
        threads: {
          spawn: async () => makeThreadResponse({ id: "correction2-q11-worker", providerId: "q11-provider" }),
          wait: async () => ({
            matched: true as const,
            threadId: "correction2-q11-worker",
            target: { kind: "status" as const, status: "idle" as const },
            thread: makeThreadResponse({ id: "correction2-q11-worker", status: "idle" as const }),
          }),
          output: async () => ({ output: graphOutput }),
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
      documents: [{ path: "docs/architecture.md", purpose: "structure", maintenance: "keep-updated" }],
      expectedRevision: 0,
    });

    const initialized = (await harness.behavior.callRpc("lens_initialize", {
      projectId: project.id,
      environmentId: environment.id,
      codePaths: ["src/api.ts"],
    })) as { lens: LensVersion };
    expect(initialized.lens.inventory).toMatchObject({ truncated: true });
    expect(initialized.lens.inventory?.entries).toHaveLength(2048);

    const codePaths = initialized.lens.sources
      .filter((source) => source.kind === "code")
      .map((source) => source.path);
    const firstCapture = await harness.behavior.callRpc("sources_capture", {
      projectId: project.id,
      environmentId: environment.id,
      codePaths,
    });
    const firstFreshness = assessSourceFreshness(
      initialized.lens,
      firstCapture as Parameters<typeof assessSourceFreshness>[1],
      1,
    );
    expect(firstFreshness).toMatchObject({ status: "unknown", changedPaths: [] });

    const refreshed = (await harness.behavior.callRpc("lens_generate", {
      projectId: project.id,
      environmentId: environment.id,
      expectedParentVersionId: initialized.lens.id,
    })) as { lens: LensVersion };
    expect(refreshed.lens).toMatchObject({
      versionNumber: 1,
      parentVersionId: initialized.lens.id,
      inventory: { truncated: true },
    });

    const secondCapture = await harness.behavior.callRpc("sources_capture", {
      projectId: project.id,
      environmentId: environment.id,
      codePaths,
    });
    const secondFreshness = assessSourceFreshness(
      refreshed.lens,
      secondCapture as Parameters<typeof assessSourceFreshness>[1],
      1,
    );
    expect(secondFreshness).toMatchObject({ status: "unknown", changedPaths: [] });
  }, 120_000);
});
