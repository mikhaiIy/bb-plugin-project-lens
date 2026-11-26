import { describe, expect, it } from "vitest";
import { SdkProjectWorkspaceResolver } from "../src/project-boundary.js";

describe("Project Lens environment picker boundary", () => {
  it("derives displayable project workspaces from supported BB context APIs", async () => {
    const sdk = {
      projects: {
        get: async () => ({ id: "proj_demo", name: "Synthetic Demo", kind: "standard" as const }),
        sidebarBootstrap: async () => ({
          personalProject: { id: "personal", threads: [] },
          projects: [
            {
              id: "proj_demo",
              threads: [
                { projectId: "proj_demo", environmentId: "env_demo" },
                { projectId: "proj_demo", environmentId: "env_demo" },
              ],
            },
          ],
        }),
      },
      environments: {
        get: async () => ({
          id: "env_demo",
          projectId: "proj_demo",
          hostId: "host_demo",
          name: "Demo workspace",
          branchName: "lens/rework",
          path: "/synthetic/demo",
          status: "ready" as const,
          workspaceProvisionType: "unmanaged" as const,
        }),
      },
      hosts: {
        get: async () => ({
          id: "host_demo",
          name: "Disposable host",
          status: "connected" as const,
          type: "persistent" as const,
        }),
      },
    } as unknown as ConstructorParameters<typeof SdkProjectWorkspaceResolver>[0];

    const options = await new SdkProjectWorkspaceResolver(sdk).listEnvironments("proj_demo");

    expect(options).toEqual([
      expect.objectContaining({
        id: "env_demo",
        name: "Demo workspace",
        branchName: "lens/rework",
        path: "/synthetic/demo",
        hostName: "Disposable host",
        status: "ready",
      }),
    ]);
  });

  it("resolves known history or current-context IDs even without sidebar threads", async () => {
    const sdk = {
      projects: {
        get: async () => ({ id: "proj_alpha", name: "Synthetic Alpha", kind: "standard" as const }),
        sidebarBootstrap: async () => ({
          personalProject: { id: "personal", threads: [] },
          projects: [{ id: "proj_alpha", threads: [] }],
        }),
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({
          id: environmentId,
          projectId: "proj_alpha",
          hostId: "host_alpha",
          name: "Alpha ready workspace",
          branchName: "main",
          path: "/synthetic/alpha",
          status: "ready" as const,
          workspaceProvisionType: "unmanaged" as const,
        }),
      },
      hosts: {
        get: async () => ({
          id: "host_alpha",
          name: "Disposable Alpha host",
          status: "connected" as const,
          type: "persistent" as const,
        }),
      },
    } as unknown as ConstructorParameters<typeof SdkProjectWorkspaceResolver>[0];

    const options = await new SdkProjectWorkspaceResolver(sdk).listEnvironments("proj_alpha", {
      knownEnvironmentIds: ["env_alpha"],
    });

    expect(options).toEqual([
      expect.objectContaining({
        id: "env_alpha",
        name: "Alpha ready workspace",
        path: "/synthetic/alpha",
        hostName: "Disposable Alpha host",
        status: "ready",
      }),
    ]);
  });

  it("falls back to the public project list when a listed project cannot be fetched directly", async () => {
    const sdk = {
      projects: {
        get: async () => { throw new Error("synthetic direct lookup miss"); },
        list: async () => [{ id: "proj_personal", name: "Personal", kind: "personal" as const }],
        sidebarBootstrap: async () => ({
          personalProject: { id: "proj_personal", threads: [] },
          projects: [],
        }),
      },
      environments: { get: async () => { throw new Error("no environments"); } },
      hosts: { get: async () => { throw new Error("no hosts"); } },
    } as unknown as ConstructorParameters<typeof SdkProjectWorkspaceResolver>[0];

    await expect(new SdkProjectWorkspaceResolver(sdk).listEnvironments("proj_personal")).resolves.toEqual([]);
  });
});
