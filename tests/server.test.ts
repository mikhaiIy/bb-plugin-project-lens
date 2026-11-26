import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

type FileReadArgs = {
  hostId?: string;
  path: string;
  rootPath?: string;
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

const projects = [
  { id: "proj_one", name: "Synthetic One", kind: "standard" as const },
  { id: "proj_two", name: "Synthetic Two", kind: "standard" as const },
];

const environments = {
  env_one: {
    id: "env_one",
    projectId: "proj_one",
    hostId: "host_one",
    status: "ready" as const,
    path: "/synthetic/proj-one",
    workspaceProvisionType: "unmanaged" as const,
    branchName: "main",
  },
  env_two: {
    id: "env_two",
    projectId: "proj_two",
    hostId: "host_two",
    status: "ready" as const,
    path: "/synthetic/proj-two",
    workspaceProvisionType: "unmanaged" as const,
    branchName: "main",
  },
  env_wrong_project: {
    id: "env_wrong_project",
    projectId: "proj_two",
    hostId: "host_two",
    status: "ready" as const,
    path: "/synthetic/proj-two",
    workspaceProvisionType: "unmanaged" as const,
    branchName: "main",
  },
};

const hosts = {
  host_one: { id: "host_one", name: "Synthetic host one", status: "connected" as const, type: "persistent" as const },
  host_two: { id: "host_two", name: "Synthetic host two", status: "connected" as const, type: "persistent" as const },
};

describe("Project Lens foundation server", () => {
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
  });

  it("routes through the selected BB identities and keeps project settings isolated", async () => {
    const files: Record<string, ReturnType<typeof fileResult>> = {
      "/synthetic/proj-one/docs/architecture.md": fileResult(
        "/synthetic/proj-one/docs/architecture.md",
        "# One Architecture\n\n## Storage\nProject one bytes\n",
      ),
      "/synthetic/proj-one/src/main.ts": fileResult(
        "/synthetic/proj-one/src/main.ts",
        "export const one = true;\n",
      ),
      "/synthetic/proj-two/docs/architecture.md": fileResult(
        "/synthetic/proj-two/docs/architecture.md",
        "# Two Architecture\n\n## Queue\nProject two bytes\n",
      ),
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "project-lens",
      sdk: {
        projects: {
          list: async () => projects,
          get: async (args: { projectId: string }) => {
            const project = projects.find((candidate) => candidate.id === args.projectId);
            if (project === undefined) throw new Error(`project ${args.projectId} not found`);
            return project;
          },
        },
        environments: {
          get: async (args: { environmentId: string }) => {
            const environment = environments[args.environmentId as keyof typeof environments];
            if (environment === undefined) throw new Error(`environment ${args.environmentId} not found`);
            return environment;
          },
        },
        hosts: {
          get: async (args: { hostId: string }) => {
            const host = hosts[args.hostId as keyof typeof hosts];
            if (host === undefined) throw new Error(`host ${args.hostId} not found`);
            return host;
          },
        },
        files: {
          read: async (args: FileReadArgs) => {
            const file = files[args.path];
            if (file === undefined) {
              throw Object.assign(new Error(`file unavailable: ${args.path}`), { code: "ENOENT" });
            }
            return file;
          },
        },
      },
    });
    await plugin(bb);
    dispose = harness.lifecycle.dispose;

    await expect(
      harness.behavior.callRpc("lens_capture", {
        projectId: "proj_one",
        environmentId: "env_one",
        codePaths: [],
        expectedParentVersionId: null,
      }),
    ).rejects.toThrow(/disabled for project proj_one/);
    expect(harness.inspection.sdk.callsTo("files.read")).toHaveLength(0);

    const oneSettings = await harness.behavior.callRpc("settings_save", {
      projectId: "proj_one",
      enabled: true,
      documents: [{ path: "docs/architecture.md", purpose: "One", maintenance: "keep-updated" }],
      expectedRevision: 0,
    });
    const twoSettings = await harness.behavior.callRpc("settings_save", {
      projectId: "proj_two",
      enabled: true,
      documents: [{ path: "docs/architecture.md", purpose: "Two", maintenance: "reference-only" }],
      expectedRevision: 0,
    });
    expect(oneSettings).toMatchObject({ projectId: "proj_one", revision: 1 });
    expect(twoSettings).toMatchObject({ projectId: "proj_two", revision: 1 });
    await expect(
      harness.behavior.callRpc("settings_save", {
        projectId: "proj_one",
        enabled: false,
        documents: [],
        expectedRevision: 0,
      }),
    ).rejects.toThrow(/changed from revision 0 to 1/);
    expect(
      await harness.behavior.callRpc("settings_get", { projectId: "proj_one" }),
    ).toMatchObject({ documents: [{ purpose: "One" }] });
    expect(
      await harness.behavior.callRpc("settings_get", { projectId: "proj_two" }),
    ).toMatchObject({ documents: [{ purpose: "Two", maintenance: "reference-only" }] });

    const workspace = await harness.behavior.callRpc("workspace_resolve", {
      projectId: "proj_one",
      environmentId: "env_one",
    });
    expect(workspace).toMatchObject({
      projectId: "proj_one",
      environmentId: "env_one",
      hostId: "host_one",
      rootPath: "/synthetic/proj-one",
    });
    await expect(
      harness.behavior.callRpc("workspace_resolve", {
        projectId: "proj_one",
        environmentId: "env_wrong_project",
      }),
    ).rejects.toThrow(/belongs to project proj_two/);

    const captured = (await harness.behavior.callRpc("lens_capture", {
      projectId: "proj_one",
      environmentId: "env_one",
      codePaths: ["src/main.ts", "docs/missing.md", "../outside.ts"],
      expectedParentVersionId: null,
    })) as {
      lens: { id: string; versionNumber: number; sources: Array<{ path: string; bytesBase64: string }> };
      capture: { documentSections: Array<{ anchor: string }>; coverage: { missing: unknown[]; escaped: unknown[] } };
    };
    expect(captured.lens.versionNumber).toBe(0);
    expect(captured.lens.sources.map((source) => source.path)).toEqual([
      "docs/architecture.md",
      "src/main.ts",
    ]);
    expect(Buffer.from(captured.lens.sources[0]!.bytesBase64, "base64").toString("utf8")).toContain(
      "Project one bytes",
    );
    expect(captured.capture.documentSections.map((section) => section.anchor)).toEqual([
      "one-architecture",
      "storage",
    ]);
    expect(captured.capture.coverage.missing).toHaveLength(1);
    expect(captured.capture.coverage.escaped).toHaveLength(1);

    const reads = harness.inspection.sdk.callsTo("files.read");
    expect(reads).toHaveLength(3);
    expect(reads[0]?.[0]).toMatchObject({
      hostId: "host_one",
      rootPath: "/synthetic/proj-one",
    });
    expect(reads[1]?.[0]).toMatchObject({
      hostId: "host_one",
      rootPath: "/synthetic/proj-one",
    });

    await expect(
      harness.behavior.callRpc("lens_capture", {
        projectId: "proj_one",
        environmentId: "env_one",
        codePaths: [],
        expectedParentVersionId: null,
      }),
    ).rejects.toThrow(/Lens head changed/);

    const current = (await harness.behavior.callRpc("lens_current", {
      projectId: "proj_one",
      environmentId: "env_one",
    })) as { lens: { id: string } };
    expect(current.lens.id).toBe(captured.lens.id);

    const other = (await harness.behavior.callRpc("lens_capture", {
      projectId: "proj_two",
      environmentId: "env_two",
      codePaths: [],
      expectedParentVersionId: null,
    })) as { lens: { projectId: string; environmentId: string } };
    expect(other.lens).toMatchObject({ projectId: "proj_two", environmentId: "env_two" });
    await expect(
      harness.behavior.callRpc("lens_get", {
        projectId: "proj_two",
        environmentId: "env_two",
        versionId: captured.lens.id,
      }),
    ).rejects.toThrow(/does not belong/);
  });

  it("preserves a decomposed Unicode Markdown path through settings and capture RPCs", async () => {
    const decomposed = "docs/cafe\u0301.md";
    const absolutePath = `/synthetic/proj-one/${decomposed}`;
    const file = fileResult(absolutePath, "# Café\n\n## Storage\nExact path\n");
    const { bb, harness } = createFakePluginHost({
      pluginId: "project-lens",
      sdk: {
        projects: {
          list: async () => projects,
          get: async (args: { projectId: string }) => {
            const project = projects.find((candidate) => candidate.id === args.projectId);
            if (project === undefined) throw new Error(`project ${args.projectId} not found`);
            return project;
          },
        },
        environments: {
          get: async (args: { environmentId: string }) => {
            if (args.environmentId !== "env_one") throw new Error("environment not found");
            return environments.env_one;
          },
        },
        hosts: {
          get: async (args: { hostId: string }) => {
            if (args.hostId !== "host_one") throw new Error("host not found");
            return hosts.host_one;
          },
        },
        files: {
          read: async (args: FileReadArgs) => {
            if (args.path !== absolutePath) {
              throw Object.assign(new Error(`unexpected path ${args.path}`), { code: "ENOENT" });
            }
            return file;
          },
        },
      },
    });
    await plugin(bb);
    dispose = harness.lifecycle.dispose;

    const saved = (await harness.behavior.callRpc("settings_save", {
      projectId: "proj_one",
      enabled: true,
      documents: [{ path: decomposed, purpose: "Unicode path", maintenance: "keep-updated" }],
      expectedRevision: 0,
    })) as { documents: Array<{ path: string }> };
    expect(saved.documents[0]?.path).toBe(decomposed);

    const captured = (await harness.behavior.callRpc("lens_capture", {
      projectId: "proj_one",
      environmentId: "env_one",
      codePaths: [],
      expectedParentVersionId: null,
    })) as {
      lens: { sources: Array<{ path: string }> };
      capture: { sources: Array<{ path: string }>; documentSections: Array<{ path: string }> };
    };
    expect(harness.inspection.sdk.callsTo("files.read")[0]?.[0]).toMatchObject({
      path: absolutePath,
      rootPath: "/synthetic/proj-one",
    });
    expect(captured.lens.sources.map((source) => source.path)).toEqual([decomposed]);
    expect(captured.capture.sources.map((source) => source.path)).toEqual([decomposed]);
    expect(captured.capture.documentSections.map((section) => section.path)).toEqual([
      decomposed,
      decomposed,
    ]);
    const reloaded = (await harness.behavior.callRpc("settings_get", {
      projectId: "proj_one",
    })) as { documents: Array<{ path: string }> };
    expect(reloaded.documents[0]?.path).toBe(decomposed);
  });

  it("reopens Lens history through RPC after the environment and host disappear", async () => {
    let environmentStatus: "ready" | "destroyed" = "ready";
    let hostStatus: "connected" | "disconnected" = "connected";
    const file = fileResult("/synthetic/proj-one/docs/architecture.md", "# Stored bytes\n");
    const { bb, harness } = createFakePluginHost({
      pluginId: "project-lens",
      sdk: {
        projects: {
          list: async () => projects,
          get: async (args: { projectId: string }) => {
            const project = projects.find((candidate) => candidate.id === args.projectId);
            if (project === undefined) throw new Error(`project ${args.projectId} not found`);
            return project;
          },
        },
        environments: {
          get: async (args: { environmentId: string }) => {
            if (args.environmentId !== "env_one") throw new Error("environment not found");
            return { ...environments.env_one, status: environmentStatus };
          },
        },
        hosts: {
          get: async (args: { hostId: string }) => {
            if (args.hostId !== "host_one") throw new Error("host not found");
            return { ...hosts.host_one, status: hostStatus };
          },
        },
        files: {
          read: async (args: FileReadArgs) => {
            if (args.path !== file.path) throw Object.assign(new Error("missing"), { code: "ENOENT" });
            return file;
          },
        },
      },
    });
    await plugin(bb);

    await harness.behavior.callRpc("settings_save", {
      projectId: "proj_one",
      enabled: true,
      documents: [{ path: "docs/architecture.md", maintenance: "keep-updated" }],
      expectedRevision: 0,
    });
    const published = (await harness.behavior.callRpc("lens_capture", {
      projectId: "proj_one",
      environmentId: "env_one",
      codePaths: [],
      expectedParentVersionId: null,
    })) as { lens: { id: string } };
    const environmentReads = harness.inspection.sdk.callsTo("environments.get").length;
    const hostReads = harness.inspection.sdk.callsTo("hosts.get").length;
    environmentStatus = "destroyed";
    hostStatus = "disconnected";

    const listed = (await harness.behavior.callRpc("lens_list", {
      projectId: "proj_one",
      environmentId: "env_one",
    })) as { versions: Array<{ id: string; rootPath: string }> };
    const current = (await harness.behavior.callRpc("lens_current", {
      projectId: "proj_one",
      environmentId: "env_one",
    })) as { lens: { id: string; sources: Array<{ bytesBase64: string }> } | null };
    const reopened = (await harness.behavior.callRpc("lens_get", {
      projectId: "proj_one",
      environmentId: "env_one",
      versionId: published.lens.id,
    })) as { sources: Array<{ bytesBase64: string }> };

    expect(listed.versions).toEqual([
      expect.objectContaining({ id: published.lens.id, rootPath: "/synthetic/proj-one" }),
    ]);
    expect(current.lens?.id).toBe(published.lens.id);
    expect(Buffer.from(reopened.sources[0]!.bytesBase64, "base64").toString("utf8")).toBe(
      "# Stored bytes\n",
    );
    await expect(
      harness.behavior.callRpc("lens_list", {
        projectId: "proj_missing",
        environmentId: "env_one",
      }),
    ).rejects.toThrow(/Unable to resolve project proj_missing/);
    await expect(
      harness.behavior.callRpc("lens_current", {
        projectId: "proj_missing",
        environmentId: "env_one",
      }),
    ).rejects.toThrow(/Unable to resolve project proj_missing/);
    await expect(
      harness.behavior.callRpc("lens_get", {
        projectId: "proj_missing",
        environmentId: "env_one",
        versionId: published.lens.id,
      }),
    ).rejects.toThrow(/Unable to resolve project proj_missing/);
    expect(harness.inspection.sdk.callsTo("environments.get")).toHaveLength(environmentReads);
    expect(harness.inspection.sdk.callsTo("hosts.get")).toHaveLength(hostReads);
    await harness.lifecycle.dispose();
  });
});
