import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  projectEnvironmentOptionSchema,
  projectSummarySchema,
  projectWorkspaceSchema,
  type ProjectEnvironmentOption,
  type ProjectSummary,
  type ProjectWorkspace,
} from "./model.js";
import { normalizeHostRoot, ProjectPathError } from "./path-policy.js";

type BbSdk = BbPluginApi["sdk"];

export interface ResolveWorkspaceInput {
  projectId: string;
  environmentId: string;
  signal?: AbortSignal;
}

export interface ListEnvironmentsOptions {
  knownEnvironmentIds?: readonly string[];
  signal?: AbortSignal;
}

export interface ProjectWorkspaceResolver {
  getProject(projectId: string, signal?: AbortSignal): Promise<ProjectSummary>;
  listProjects(signal?: AbortSignal): Promise<ProjectSummary[]>;
  listEnvironments(projectId: string, options?: ListEnvironmentsOptions): Promise<ProjectEnvironmentOption[]>;
  resolve(input: ResolveWorkspaceInput): Promise<ProjectWorkspace>;
}

export type ProjectBoundaryErrorCode =
  | "invalid-project-id"
  | "invalid-environment-id"
  | "project-not-found"
  | "project-id-mismatch"
  | "environment-not-found"
  | "environment-project-mismatch"
  | "environment-not-ready"
  | "workspace-path-missing"
  | "host-not-found"
  | "host-id-mismatch"
  | "host-disconnected"
  | "invalid-root-path";

export class ProjectBoundaryError extends Error {
  readonly code: ProjectBoundaryErrorCode;

  constructor(code: ProjectBoundaryErrorCode, message: string) {
    super(message);
    this.name = "ProjectBoundaryError";
    this.code = code;
  }
}

function requireId(value: string, code: "invalid-project-id" | "invalid-environment-id"): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new ProjectBoundaryError(code, "A non-empty, trimmed BB identifier is required");
  }
  return value;
}

function projectSummary(project: Awaited<ReturnType<BbSdk["projects"]["get"]>>): ProjectSummary {
  try {
    return projectSummarySchema.parse({
      id: project.id,
      name: project.name,
      kind: project.kind,
    });
  } catch (error) {
    throw new ProjectBoundaryError(
      "project-not-found",
      `BB returned an invalid project record: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Resolves the three BB identities needed for a source operation. No source
 * read should happen before this object has been returned.
 */
export class SdkProjectWorkspaceResolver implements ProjectWorkspaceResolver {
  constructor(private readonly sdk: BbSdk) {}

  async getProject(projectId: string, signal?: AbortSignal): Promise<ProjectSummary> {
    const id = requireId(projectId, "invalid-project-id");
    try {
      const project = await this.sdk.projects.get({ projectId: id, signal });
      const summary = projectSummary(project);
      if (summary.id !== id) {
        throw new ProjectBoundaryError(
          "project-id-mismatch",
          `BB returned project ${summary.id} for requested project ${id}`,
        );
      }
      return summary;
    } catch (error) {
      if (error instanceof ProjectBoundaryError) throw error;
      throw new ProjectBoundaryError(
        "project-not-found",
        `Unable to resolve project ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async listProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
    const projects = await this.sdk.projects.list({ includePersonal: true, signal });
    return projects.map((project) => projectSummary(project));
  }

  async listEnvironments(projectId: string, listOptions: ListEnvironmentsOptions = {}): Promise<ProjectEnvironmentOption[]> {
    let project: ProjectSummary;
    try {
      project = await this.getProject(projectId, listOptions.signal);
    } catch (error) {
      if (!(error instanceof ProjectBoundaryError) || error.code !== "project-not-found") throw error;
      const listedProjects = await this.sdk.projects.list({ includePersonal: true, signal: listOptions.signal });
      const listedProject = listedProjects.find((candidate) => candidate.id === projectId);
      if (listedProject === undefined) throw error;
      project = projectSummary(listedProject as Awaited<ReturnType<BbSdk["projects"]["get"]>>);
    }
    const bootstrap = await this.sdk.projects.sidebarBootstrap({ signal: listOptions.signal });
    const projectRecord = [bootstrap.personalProject, ...bootstrap.projects].find(
      (candidate) => candidate.id === project.id,
    );
    const sidebarEnvironmentIds = projectRecord === undefined
      ? []
      : projectRecord.threads
          .filter((thread) => thread.projectId === project.id && thread.environmentId !== null)
          .map((thread) => thread.environmentId as string);
    const environmentIds = [
      ...new Set([
        ...sidebarEnvironmentIds,
        ...(listOptions.knownEnvironmentIds ?? []),
      ]),
    ].filter((environmentId) => environmentId.trim() !== "");

    const resolvedOptions = await Promise.all(
      environmentIds.map(async (environmentId) => {
        try {
          const environment = await this.sdk.environments.get({ environmentId, signal: listOptions.signal });
          if (environment.projectId !== project.id) return null;
          let host: Awaited<ReturnType<BbSdk["hosts"]["get"]>> | null = null;
          try {
            host = await this.sdk.hosts.get({ hostId: environment.hostId, signal: listOptions.signal });
          } catch {
            // An environment can remain useful for history while its host is unavailable.
          }
          return projectEnvironmentOptionSchema.parse({
            id: environment.id,
            projectId: environment.projectId,
            name: environment.name,
            branchName: environment.branchName,
            path: environment.path,
            hostId: environment.hostId,
            hostName: host?.name ?? null,
            hostStatus: host?.status ?? null,
            status: environment.status,
            workspaceProvisionType: environment.workspaceProvisionType,
            hasSavedLens: false,
          });
        } catch {
          // Sidebar data is advisory. An environment that disappeared between
          // the bootstrap and get calls is omitted; saved history is merged by
          // the RPC layer below.
          return null;
        }
      }),
    );

    return resolvedOptions
      .filter((option): option is ProjectEnvironmentOption => option !== null)
      .sort((left, right) => {
        const statusRank = (status: ProjectEnvironmentOption["status"]) => (status === "ready" ? 0 : 1);
        return statusRank(left.status) - statusRank(right.status) ||
          (left.name ?? left.id).localeCompare(right.name ?? right.id);
      });
  }

  async resolve(input: ResolveWorkspaceInput): Promise<ProjectWorkspace> {
    const projectId = requireId(input.projectId, "invalid-project-id");
    const environmentId = requireId(input.environmentId, "invalid-environment-id");
    const project = await this.getProject(projectId, input.signal);

    let environment: Awaited<ReturnType<BbSdk["environments"]["get"]>>;
    try {
      environment = await this.sdk.environments.get({ environmentId, signal: input.signal });
    } catch (error) {
      throw new ProjectBoundaryError(
        "environment-not-found",
        `Unable to resolve environment ${environmentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (environment.id !== environmentId) {
      throw new ProjectBoundaryError(
        "environment-not-found",
        `BB returned environment ${environment.id} for requested environment ${environmentId}`,
      );
    }
    if (environment.projectId !== project.id) {
      throw new ProjectBoundaryError(
        "environment-project-mismatch",
        `Environment ${environmentId} belongs to project ${environment.projectId}, not ${project.id}`,
      );
    }
    if (environment.status !== "ready") {
      throw new ProjectBoundaryError(
        "environment-not-ready",
        `Environment ${environmentId} is ${environment.status}; source capture requires ready`,
      );
    }
    if (environment.path === null || environment.path.trim() === "") {
      throw new ProjectBoundaryError(
        "workspace-path-missing",
        `Environment ${environmentId} has no workspace path`,
      );
    }

    let rootPath: string;
    try {
      // This also rejects relative roots. The SDK/host performs the final
      // realpath/symlink confinement when a file is read beneath this root.
      rootPath = normalizeHostRoot(environment.path);
    } catch (error) {
      throw new ProjectBoundaryError(
        "invalid-root-path",
        error instanceof ProjectPathError
          ? error.message
          : `Environment ${environmentId} returned an invalid root path`,
      );
    }

    let host: Awaited<ReturnType<BbSdk["hosts"]["get"]>>;
    try {
      host = await this.sdk.hosts.get({ hostId: environment.hostId, signal: input.signal });
    } catch (error) {
      throw new ProjectBoundaryError(
        "host-not-found",
        `Unable to resolve host ${environment.hostId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (host.id !== environment.hostId) {
      throw new ProjectBoundaryError(
        "host-id-mismatch",
        `BB returned host ${host.id} for requested host ${environment.hostId}`,
      );
    }
    if (host.status !== "connected") {
      throw new ProjectBoundaryError(
        "host-disconnected",
        `Host ${host.id} is disconnected; source capture requires a connected host`,
      );
    }

    const workspace = {
      project,
      environment: {
        id: environment.id,
        projectId: environment.projectId,
        hostId: environment.hostId,
        status: environment.status,
        path: environment.path,
        workspaceProvisionType: environment.workspaceProvisionType,
        branchName: environment.branchName,
      },
      host: {
        id: host.id,
        name: host.name,
        status: host.status,
        type: host.type,
      },
      projectId: project.id,
      environmentId: environment.id,
      hostId: host.id,
      rootPath,
    };
    return projectWorkspaceSchema.parse(workspace);
  }
}
