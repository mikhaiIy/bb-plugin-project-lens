import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

const personal = { id: "proj_personal", name: "Personal", kind: "personal" as const };
const standard = { id: "proj_standard", name: "Disposable standard", kind: "standard" as const };

describe("Project Lens unsupported project scope", () => {
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
  });

  it("returns a typed Personal outcome without reading environments or creating settings", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "project-lens",
      sdk: {
        projects: {
          list: async () => [personal, standard],
          get: async ({ projectId }: { projectId: string }) => {
            if (projectId === standard.id) return standard;
            throw new Error(`project ${projectId} is not available through get`);
          },
          sidebarBootstrap: async () => ({
            personalProject: { id: personal.id, threads: [] },
            projects: [{ id: standard.id, threads: [] }],
          }),
        },
        environments: {
          get: async () => {
            throw new Error("Personal must not resolve an environment");
          },
        },
        hosts: {
          get: async () => {
            throw new Error("Personal must not resolve a host");
          },
        },
      },
    });
    await plugin(bb);
    dispose = harness.lifecycle.dispose;

    const settings = await harness.behavior.callRpc("settings_get", { projectId: personal.id });
    expect(settings).toEqual({
      scope: {
        status: "unsupported",
        projectKind: "personal",
        reason: "personal-project",
      },
      project: personal,
      message: expect.stringContaining("Select a standard BB project"),
    });

    const environments = await harness.behavior.callRpc("environments_list", {
      projectId: personal.id,
      contextThreadId: null,
    });
    expect(environments).toEqual({
      environments: [],
      scope: {
        status: "unsupported",
        projectKind: "personal",
        reason: "personal-project",
      },
    });

    const save = await harness.behavior.callRpc("settings_save", {
      projectId: personal.id,
      enabled: true,
      documents: [{ path: "docs/architecture.md", maintenance: "keep-updated" }],
      expectedRevision: 0,
    });
    expect(save).toMatchObject({
      scope: { status: "unsupported", projectKind: "personal", reason: "personal-project" },
      project: personal,
    });

    expect(harness.inspection.sdk.callsTo("projects.get")).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("environments.get")).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("hosts.get")).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("projects.sidebarBootstrap")).toHaveLength(0);

    const standardSettings = await harness.behavior.callRpc("settings_get", { projectId: standard.id });
    expect(standardSettings).toMatchObject({
      projectId: standard.id,
      enabled: false,
      revision: 0,
    });
    expect(harness.inspection.sdk.callsTo("projects.get")).toHaveLength(1);
  });

  it("keeps an arbitrary project ID on the real-project guard", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "project-lens",
      sdk: {
        projects: {
          list: async () => [personal, standard],
          get: async ({ projectId }: { projectId: string }) => {
            throw new Error(`project ${projectId} not found`);
          },
          sidebarBootstrap: async () => ({
            personalProject: { id: personal.id, threads: [] },
            projects: [{ id: standard.id, threads: [] }],
          }),
        },
      },
    });
    await plugin(bb);
    dispose = harness.lifecycle.dispose;

    await expect(
      harness.behavior.callRpc("settings_get", { projectId: "proj_not_real" }),
    ).rejects.toThrow(/Unable to resolve project proj_not_real/);
    await expect(
      harness.behavior.callRpc("environments_list", { projectId: "proj_not_real", contextThreadId: null }),
    ).rejects.toThrow(/Unable to resolve project proj_not_real/);

    expect(harness.inspection.sdk.callsTo("projects.get")).toHaveLength(2);
    expect(harness.inspection.sdk.callsTo("environments.get")).toHaveLength(0);
  });
});
