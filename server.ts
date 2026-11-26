import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  projectLensSettingsInputSchema,
  projectLensSettingsSchema,
  projectEnvironmentOptionSchema,
  projectLensScopeFor,
  projectLensScopeSchema,
  projectLensUnsupportedScopeMessage,
  projectLensUnsupportedScopeSchema,
  projectSummarySchema,
  projectWorkspaceSchema,
  sourceCaptureSchema,
  lensVersionSchema,
  diagramComparisonSchema,
  synchronizationResultSchema,
  documentDiffSchema,
  type DocumentSetting,
  type LensVersion,
  type ProjectLensScope,
  type ProjectInventory,
  type ProjectSummary,
  type SourceCapture,
  type SynchronizationResult,
  type ProjectLensSettingsInput,
} from "./src/model.js";
import { createLensCandidate } from "./src/lens.js";
import { FOUNDATION_MIGRATIONS, SqliteLensRepository } from "./src/lens-store.js";
import { SqliteSynchronizationRepository } from "./src/synchronization-store.js";
import { SdkProjectWorkspaceResolver } from "./src/project-boundary.js";
import { resolveWithinRoot } from "./src/path-policy.js";
import {
  analyzableCodePaths,
  inventoryUnknownAreas,
  SdkProjectInventoryCollector,
} from "./src/project-inventory.js";
import {
  analysisCleanupSchema,
  analysisPassSchema,
  analysisProgressSchema,
  type AnalysisProgress,
  analysisJobResultSchema,
  BbProjectGraphAnalyzer,
} from "./src/project-analysis.js";
import {
  GenerationJobCoordinator,
  type GenerationJobInput,
  type GenerationJobView,
} from "./src/generation-jobs.js";
import { SqliteProjectSettingsRepository } from "./src/settings-store.js";
import {
  DEFAULT_SOURCE_CAPTURE_LIMITS,
  SdkSourceCollector,
  SdkSourceReader,
} from "./src/source-capture.js";
import { compareLensVersions } from "./src/diagram.js";
import {
  buildProjectLensAgentSelection,
  type AgentContextData,
} from "./src/agent-context.js";
import {
  compareDocumentSources,
  decodeCapturedSource,
  documentEditSchema,
  DocumentConcurrencyError,
  noChangeFindingSchema,
  sha256Text,
  summarizeComparison,
  validateFocusedDocumentEdit,
  type DocumentEdit,
  type NoChangeFinding,
} from "./src/synchronization.js";
import {
  boundaryDifferences,
  expectationForBoundary,
  inventoryDifferences,
  sourceIdentityDifferences,
  sourceIdentitiesForBoundary,
  type CapturedSourceBoundary,
  type SourceBoundaryExpectation,
} from "./src/source-boundary.js";

const projectIdSchema = z.string().trim().min(1).max(200);
const environmentIdSchema = z.string().trim().min(1).max(200);
const threadIdSchema = z.string().trim().min(1).max(200);
const versionIdSchema = z.string().trim().min(1).max(300);
const codePathsSchema = z
  .array(z.string().min(1).max(4096))
  .max(DEFAULT_SOURCE_CAPTURE_LIMITS.maxRequestedSources)
  .default([]);
const providerIdSchema = z.string().trim().min(1).max(200).optional();
const modelSchema = z.string().trim().min(1).max(300).optional();

const unsupportedProjectScopeResultSchema = z
  .object({
    scope: projectLensUnsupportedScopeSchema,
    project: projectSummarySchema,
    message: z.string().min(1).max(300),
  })
  .strict();

const settingsResultSchema = z.union([
  projectLensSettingsSchema,
  unsupportedProjectScopeResultSchema,
]);

const synchronizationInputSchema = z
  .object({
    projectId: projectIdSchema,
    environmentId: environmentIdSchema,
    expectedParentVersionId: versionIdSchema.nullable(),
    expectedConfigurationRevision: z.number().int().nonnegative(),
    codePaths: codePathsSchema,
    documentEdits: z.array(documentEditSchema).max(256),
    noChangeFindings: z.array(noChangeFindingSchema).max(256),
    providerId: providerIdSchema,
    model: modelSchema,
  })
  .strict();

const synchronizationRetryInputSchema = z
  .object({
    projectId: projectIdSchema,
    environmentId: environmentIdSchema,
    operationId: z.string().trim().min(1).max(300),
    providerId: providerIdSchema,
    model: modelSchema,
  })
  .strict();

const compareInputSchema = z
  .object({
    projectId: projectIdSchema,
    environmentId: environmentIdSchema,
    currentVersionId: versionIdSchema.optional(),
    baselineVersionId: versionIdSchema.nullable().optional(),
  })
  .strict();

const lensGenerationInputSchema = z
  .object({
    projectId: projectIdSchema,
    environmentId: environmentIdSchema,
    expectedParentVersionId: versionIdSchema.nullable().default(null),
    providerId: providerIdSchema,
    model: modelSchema,
  })
  .strict();

const lensGenerationOutputSchema = z
  .object({
    lens: lensVersionSchema,
    capture: sourceCaptureSchema,
    job: analysisJobResultSchema,
  })
  .strict();

const generationAnalysisSummarySchema = z
  .object({
    id: z.string().min(1),
    workerThreadId: z.string().min(1),
    providerId: z.string().min(1).nullable(),
    status: z.enum(["completed", "failed", "cancelled"]),
    cleanup: analysisCleanupSchema,
    passes: z.array(analysisPassSchema).max(17).optional(),
  })
  .strict();

const generationJobViewSchema = z
  .object({
    operationId: z.string().min(1),
    projectId: projectIdSchema,
    environmentId: environmentIdSchema,
    expectedParentVersionId: versionIdSchema.nullable(),
    status: z.enum(["queued", "running", "cancelling", "completed", "failed", "cancelled"]),
    cancelRequested: z.boolean(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    result: z
      .object({
        lensId: versionIdSchema,
        versionNumber: z.number().int().nonnegative(),
        parentVersionId: versionIdSchema.nullable(),
      })
      .strict()
      .nullable(),
    analysis: generationAnalysisSummarySchema.nullable(),
    progress: analysisProgressSchema.nullable(),
    error: z.string().nullable(),
  })
  .strict();

const synchronizationOutputSchema = synchronizationResultSchema;

const compareOutputSchema = z
  .object({
    current: lensVersionSchema,
    baseline: lensVersionSchema.nullable(),
    comparison: diagramComparisonSchema,
    documentChanges: z.array(documentDiffSchema),
    synchronization: synchronizationResultSchema.nullable(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  projects_list: {
    input: z.null(),
    output: z.object({ projects: z.array(projectSummarySchema) }).strict(),
  },
  environments_list: {
    input: z
      .object({
        projectId: projectIdSchema,
        contextThreadId: threadIdSchema.nullable().optional(),
        requestedEnvironmentId: environmentIdSchema.optional(),
      })
      .strict(),
    output: z
      .object({
        environments: z.array(projectEnvironmentOptionSchema),
        scope: projectLensScopeSchema,
      })
      .strict(),
  },
  settings_get: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: settingsResultSchema,
  },
  settings_save: {
    input: z
      .object({
        projectId: projectIdSchema,
        enabled: z.boolean(),
        documents: projectLensSettingsInputSchema.shape.documents,
        expectedRevision: z.number().int().nonnegative(),
      })
      .strict(),
    output: settingsResultSchema,
  },
  workspace_resolve: {
    input: z
      .object({
        projectId: projectIdSchema,
        environmentId: environmentIdSchema,
      })
      .strict(),
    output: projectWorkspaceSchema,
  },
  sources_capture: {
    input: z
      .object({
        projectId: projectIdSchema,
        environmentId: environmentIdSchema,
        codePaths: codePathsSchema,
      })
      .strict(),
    output: sourceCaptureSchema,
  },
  lens_capture: {
    input: z
      .object({
        projectId: projectIdSchema,
        environmentId: environmentIdSchema,
        codePaths: codePathsSchema,
        expectedParentVersionId: versionIdSchema.nullable().default(null),
      })
      .strict(),
    output: z
      .object({
        lens: lensVersionSchema,
        capture: sourceCaptureSchema,
      })
      .strict(),
  },
  lens_generate: {
    input: lensGenerationInputSchema,
    output: lensGenerationOutputSchema,
  },
  lens_generate_start: {
    input: lensGenerationInputSchema,
    output: generationJobViewSchema,
  },
  lens_generate_status: {
    input: z
      .object({
        projectId: projectIdSchema,
        environmentId: environmentIdSchema,
        operationId: z.string().trim().min(1).max(300),
      })
      .strict(),
    output: generationJobViewSchema,
  },
  lens_generate_cancel: {
    input: z
      .object({
        projectId: projectIdSchema,
        environmentId: environmentIdSchema,
        operationId: z.string().trim().min(1).max(300),
      })
      .strict(),
    output: generationJobViewSchema,
  },
  lens_generate_reconcile: {
    input: z
      .object({
        projectId: projectIdSchema,
        environmentId: environmentIdSchema,
        operationId: z.string().trim().min(1).max(300),
      })
      .strict(),
    output: generationJobViewSchema,
  },
  lens_current: {
    input: z
      .object({
        projectId: projectIdSchema,
        environmentId: environmentIdSchema,
      })
      .strict(),
    output: z.object({ lens: lensVersionSchema.nullable() }).strict(),
  },
  lens_list: {
    input: z
      .object({
        projectId: projectIdSchema,
        environmentId: environmentIdSchema,
      })
      .strict(),
    output: z.object({ versions: z.array(lensVersionSchema) }).strict(),
  },
  lens_get: {
    input: z
      .object({
        projectId: projectIdSchema,
        environmentId: environmentIdSchema,
        versionId: versionIdSchema,
      })
      .strict(),
    output: lensVersionSchema,
  },
  lens_initialize: {
    input: z
      .object({
        projectId: projectIdSchema,
        environmentId: environmentIdSchema,
        codePaths: codePathsSchema,
        providerId: providerIdSchema,
        model: modelSchema,
      })
      .strict(),
    output: z
      .object({
        initialized: z.boolean(),
        lens: lensVersionSchema,
        capture: sourceCaptureSchema,
        job: analysisJobResultSchema,
      })
      .strict(),
  },
  lens_synchronize: {
    input: synchronizationInputSchema,
    output: synchronizationOutputSchema,
  },
  lens_synchronize_retry: {
    input: synchronizationRetryInputSchema,
    output: synchronizationOutputSchema,
  },
  lens_sync_latest: {
    input: z.object({ projectId: projectIdSchema, environmentId: environmentIdSchema }).strict(),
    output: z.object({ synchronization: synchronizationResultSchema.nullable() }).strict(),
  },
  lens_compare: {
    input: compareInputSchema,
    output: compareOutputSchema,
  },
});

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...FOUNDATION_MIGRATIONS]);

  const boundary = new SdkProjectWorkspaceResolver(bb.sdk);
  const settingsRepository = new SqliteProjectSettingsRepository(db);
  const lensRepository = new SqliteLensRepository(db);
  const sourceReader = new SdkSourceReader(bb.sdk);
  const sourceCollector = new SdkSourceCollector(sourceReader);
  const synchronizationRepository = new SqliteSynchronizationRepository(db);
  const inventoryCollector = new SdkProjectInventoryCollector(bb.sdk);
  const graphAnalyzer = new BbProjectGraphAnalyzer(bb.sdk);

  function workspaceIdentityMatches(
    left: { projectId: string; environmentId: string; hostId: string; rootPath: string },
    right: { projectId: string; environmentId: string; hostId: string; rootPath: string },
  ): boolean {
    return left.projectId === right.projectId &&
      left.environmentId === right.environmentId &&
      left.hostId === right.hostId &&
      left.rootPath === right.rootPath;
  }

  function capturedBoundary(
    target: Awaited<ReturnType<SdkProjectWorkspaceResolver["resolve"]>>,
    configurationRevision: number,
    capture: SourceCapture,
    inventory: ProjectInventory,
  ): CapturedSourceBoundary {
    return {
      workspace: {
        projectId: target.projectId,
        environmentId: target.environmentId,
        hostId: target.hostId,
        rootPath: target.rootPath,
      },
      configurationRevision,
      capture: sourceCaptureSchema.parse({ ...capture, inventory }),
      inventory,
    };
  }

  async function captureProjectBoundary(
    target: Awaited<ReturnType<SdkProjectWorkspaceResolver["resolve"]>>,
    settings: Awaited<ReturnType<SqliteProjectSettingsRepository["get"]>>,
    extraCodePaths: readonly string[] = [],
    signal?: AbortSignal,
  ): Promise<CapturedSourceBoundary> {
    const inventory = await inventoryCollector.collect(target, signal);
    const codePaths = [...new Set([...analyzableCodePaths(inventory), ...extraCodePaths])];
    const capture = await sourceCollector.capture(target, settings.documents, {
      codePaths,
      scope: "whole-project",
      unknownAreas: inventoryUnknownAreas(inventory),
      signal,
    });
    return capturedBoundary(target, settings.revision, capture, inventory);
  }

  function boundaryConflict(
    expected: SourceBoundaryExpectation,
    actual: CapturedSourceBoundary,
    phase: string,
  ): DocumentConcurrencyError | null {
    const differences = boundaryDifferences(expected, actual);
    return differences.length === 0
      ? null
      : new DocumentConcurrencyError(
          `${phase} changed before Lens publication: ${differences.join(", ")}`,
        );
  }

  async function currentLiveLens(
    projectId: string,
    environmentId: string,
    signal?: AbortSignal,
  ): Promise<{ settings: Awaited<ReturnType<SqliteProjectSettingsRepository["get"]>>; target: Awaited<ReturnType<SdkProjectWorkspaceResolver["resolve"]>>; lens: LensVersion | null }> {
    const settings = await projectSettings(projectId, signal);
    const target = await boundary.resolve({ projectId, environmentId, signal });
    return { settings, target, lens: await lensRepository.current(target) };
  }

  async function contextEnvironmentIds(projectId: string, contextThreadId: string | null | undefined): Promise<string[]> {
    if (contextThreadId === null || contextThreadId === undefined || contextThreadId.trim() === "") return [];
    try {
      const thread = await bb.sdk.threads.get({ threadId: contextThreadId });
      return thread.projectId === projectId && thread.environmentId !== null
        ? [thread.environmentId]
        : [];
    } catch {
      return [];
    }
  }

  /**
   * Resolve the project scope from BB metadata before touching Project Lens
   * storage or environment APIs. The SDK's project list is the supported way
   * to recognize BB's Personal pseudo-project; projects.get is deliberately
   * reserved for standard projects and the final existence/ownership guard.
   */
  async function projectForLens(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<{ project: ProjectSummary; scope: ProjectLensScope }> {
    const listedProjects = await boundary.listProjects(signal);
    const listedProject = listedProjects.find((project) => project.id === projectId);
    if (listedProject?.kind === "personal") {
      return { project: listedProject, scope: projectLensScopeFor(listedProject) };
    }
    const project = await boundary.getProject(projectId, signal);
    return { project, scope: projectLensScopeFor(project) };
  }

  function unsupportedProjectScopeResult(project: ProjectSummary) {
    const scope = projectLensScopeFor(project);
    if (scope.status !== "unsupported") {
      throw new Error("Project Lens received an unsupported-scope response for a standard project");
    }
    return { scope, project, message: projectLensUnsupportedScopeMessage };
  }

  async function projectSettings(projectId: string, signal?: AbortSignal) {
    const resolved = await projectForLens(projectId, signal);
    if (resolved.scope.status !== "supported") throw new Error(projectLensUnsupportedScopeMessage);
    return settingsRepository.get(projectId);
  }

  async function captureFor(
    projectId: string,
    environmentId: string,
    codePaths: readonly string[],
    includeInventory = false,
    signal?: AbortSignal,
  ) {
    const settings = await projectSettings(projectId, signal);
    if (!settings.enabled) {
      throw new Error(`Project Lens is disabled for project ${projectId}`);
    }
    const target = await boundary.resolve({ projectId, environmentId, signal });
    const inventory = includeInventory ? await inventoryCollector.collect(target, signal) : undefined;
    const capture = await sourceCollector.capture(target, settings.documents, {
      codePaths,
      signal,
    });
    return {
      settings,
      target,
      inventory,
      capture: sourceCaptureSchema.parse({
        ...capture,
        ...(inventory === undefined ? {} : { inventory }),
      }),
    };
  }

  async function configuredAgentOptions(
    projectId: string,
    providerId: string | undefined,
    model: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ providerId?: string; model?: string }> {
    if (providerId !== undefined || model !== undefined) {
      return {
        ...(providerId === undefined ? {} : { providerId }),
        ...(model === undefined ? {} : { model }),
      };
    }
    const defaults = await bb.sdk.projects.defaultExecutionOptions({ projectId, signal });
    if (defaults === null) return {};
    return { providerId: defaults.providerId, model: defaults.model };
  }

  async function generateWholeProject(input: {
    projectId: string;
    environmentId: string;
    expectedParentVersionId: string | null;
    providerId?: string;
    model?: string;
    expectedBoundary?: SourceBoundaryExpectation;
    signal?: AbortSignal;
    onProgress?: (progress: AnalysisProgress) => void;
  }) {
    const settings = await projectSettings(input.projectId, input.signal);
    if (!settings.enabled) {
      throw new Error(`Project Lens is disabled for project ${input.projectId}`);
    }
    const target = await boundary.resolve({
      projectId: input.projectId,
      environmentId: input.environmentId,
      signal: input.signal,
    });
    const initialBoundary = await captureProjectBoundary(target, settings, [], input.signal);
    const expectedBoundaryConflict = input.expectedBoundary === undefined
      ? null
      : boundaryConflict(input.expectedBoundary, initialBoundary, "Recorded synchronization boundary");
    if (expectedBoundaryConflict !== null) throw expectedBoundaryConflict;
    const inventory = initialBoundary.inventory;
    const capture = initialBoundary.capture;
    const previousLens =
      input.expectedParentVersionId === null
        ? null
        : await lensRepository.get(input.expectedParentVersionId);
    if (input.expectedParentVersionId !== null && previousLens === null) {
      throw new Error(`Lens version ${input.expectedParentVersionId} was not found`);
    }
    if (
      previousLens !== null &&
      (previousLens.projectId !== target.projectId ||
        previousLens.environmentId !== target.environmentId ||
        previousLens.hostId !== target.hostId ||
        previousLens.rootPath !== target.rootPath)
    ) {
      throw new Error(
        `Lens version ${input.expectedParentVersionId} does not belong to the selected project workspace`,
      );
    }
    const agentOptions = await configuredAgentOptions(
      input.projectId,
      input.providerId,
      input.model,
      input.signal,
    );
    const analysis = await graphAnalyzer.analyze({
      projectId: input.projectId,
      target,
      inventory,
      capture,
      previousLens,
      onProgress: input.onProgress,
      providerId: agentOptions.providerId,
      model: agentOptions.model,
      signal: input.signal,
    });
    const unknownAreas = [...new Set(analysis.normalized.unknownAreas)];
    if (input.signal?.aborted) throw new DOMException("Generation cancelled before publication", "AbortError");
    const analyzedCapture = sourceCaptureSchema.parse({
      ...capture,
      coverage: {
        ...capture.coverage,
        scope: "whole-project",
        totalRequested: inventory.totalDiscovered,
        unknownAreas,
        complete: capture.coverage.complete && unknownAreas.length === 0,
      },
      inventory,
    });
    if (input.signal?.aborted) throw new DOMException("Generation cancelled before publication", "AbortError");
    // Code, Markdown and the provider job are separate operations. Re-resolve
    // the live target/settings and re-read every source that supported the
    // analysis before the immutable parent-CAS publish. A concurrent edit is
    // reported as a retryable synchronization conflict instead of publishing
    // a graph for stale bytes.
    const finalSettings = await projectSettings(input.projectId, input.signal);
    const finalTarget = await boundary.resolve({
      projectId: input.projectId,
      environmentId: input.environmentId,
      signal: input.signal,
    });
    if (finalSettings.revision !== settings.revision) {
      throw new DocumentConcurrencyError(
        `Project Lens configuration changed from revision ${settings.revision} to ${finalSettings.revision} before Lens publication`,
      );
    }
    if (!workspaceIdentityMatches(target, finalTarget)) {
      throw new DocumentConcurrencyError("Project Lens workspace identity changed before Lens publication");
    }
    const finalBoundary = await captureProjectBoundary(finalTarget, finalSettings, [], input.signal);
    const initialBoundaryConflict = boundaryConflict(
      expectationForBoundary(initialBoundary),
      finalBoundary,
      "Analyzed source boundary",
    );
    if (initialBoundaryConflict !== null) throw initialBoundaryConflict;
    if (input.expectedBoundary !== undefined) {
      const synchronizationBoundaryConflict = boundaryConflict(
        input.expectedBoundary,
        finalBoundary,
        "Recorded synchronization boundary",
      );
      if (synchronizationBoundaryConflict !== null) throw synchronizationBoundaryConflict;
    }
    // A final independent read closes the capture-to-publish gap. The
    // immutable candidate is built from this last captured boundary, while
    // the graph remains the analysis result proven against the earlier one.
    const validationBoundary = await captureProjectBoundary(finalTarget, finalSettings, [], input.signal);
    const finalBoundaryConflict = boundaryConflict(
      expectationForBoundary(finalBoundary),
      validationBoundary,
      "Final source boundary",
    );
    if (finalBoundaryConflict !== null) throw finalBoundaryConflict;
    const publishCapture = sourceCaptureSchema.parse({
      ...analyzedCapture,
      capturedAt: validationBoundary.capture.capturedAt,
      sources: validationBoundary.capture.sources,
      documentSections: validationBoundary.capture.documentSections,
      inventory: validationBoundary.inventory,
    });
    const candidate = createLensCandidate({
      target: finalTarget,
      settings: finalSettings,
      capture: publishCapture,
      parentVersionId: input.expectedParentVersionId,
      analyzerRevision: `bb-agent-project-graph@4:${analysis.providerId ?? "configured-default"}`,
      graph: analysis.normalized.graph,
      inventory: validationBoundary.inventory,
      identityWarnings: analysis.normalized.identityWarnings,
      analysisProviderId: analysis.providerId,
      analysisCoverage: analysis.coverage,
    });
    // The publication repository performs the parent CAS. This final signal
    // checkpoint ensures a cancellation observed during provider cleanup does
    // not turn a validated-but-cancelled run into a current Lens.
    if (input.signal?.aborted) throw new DOMException("Generation cancelled before publication", "AbortError");
    const lens = await lensRepository.publish(candidate, {
      parentVersionId: input.expectedParentVersionId,
    });
    bb.realtime.publish("project-lens-version-changed", {
      projectId: lens.projectId,
      environmentId: lens.environmentId,
      versionId: lens.id,
      versionNumber: lens.versionNumber,
    });
    return { lens, capture: publishCapture, job: analysis.job };
  }

  const generationJobs = new GenerationJobCoordinator(
    (input) => generateWholeProject(input),
    (analysisJobId) => graphAnalyzer.reconcileCleanup(analysisJobId),
  );

  function newSynchronizationResult(
    target: { projectId: string; environmentId: string; hostId: string; rootPath: string },
    expectedParentVersionId: string | null,
    configurationRevision: number,
    operationId = `sync:${randomUUID()}`,
  ): SynchronizationResult {
    const now = Date.now();
    return synchronizationResultSchema.parse({
      operationId,
      projectId: target.projectId,
      environmentId: target.environmentId,
      workspace: {
        projectId: target.projectId,
        environmentId: target.environmentId,
        hostId: target.hostId,
        rootPath: target.rootPath,
      },
      expectedParentVersionId,
      configurationRevision,
      status: "pending",
      startedAt: now,
      updatedAt: now,
      documents: [],
      sourceBefore: [],
      sourceFinal: [],
      lens: null,
      comparison: null,
      unresolvedItems: [],
      error: null,
      retryable: true,
    });
  }

  function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  }

  function syncDocumentResult(input: {
    path: string;
    maintenance: DocumentSetting["maintenance"];
    action: "updated" | "no-change" | "preserved" | "conflict";
    beforeSha256: string | null;
    afterSha256: string | null;
    changedSections?: readonly string[];
    checkedSections?: readonly string[];
    reason: string;
  }) {
    return {
      path: input.path,
      maintenance: input.maintenance,
      action: input.action,
      beforeSha256: input.beforeSha256,
      afterSha256: input.afterSha256,
      changedSections: [...(input.changedSections ?? [])],
      checkedSections: [...(input.checkedSections ?? [])],
      reason: input.reason.slice(0, 1000),
    };
  }

  function configuredDocumentMap(settings: { documents: readonly DocumentSetting[] }): Map<string, DocumentSetting> {
    return new Map(settings.documents.map((document) => [document.path, document]));
  }

  function capturedMarkdownMap(capture: SourceCapture): Map<string, SourceCapture["sources"][number]> {
    return new Map(capture.sources.filter((source) => source.kind === "markdown").map((source) => [source.path, source]));
  }

  function capturedSectionMap(capture: SourceCapture, path: string) {
    return capture.documentSections.filter((section) => section.path === path);
  }

  function sourceHashFor(capture: SourceCapture, path: string): string | null {
    return capturedMarkdownMap(capture).get(path)?.sha256 ?? null;
  }

  async function persistSynchronization(result: SynchronizationResult, existing: boolean): Promise<SynchronizationResult> {
    const parsed = synchronizationResultSchema.parse(result);
    if (existing) await synchronizationRepository.update(parsed);
    else await synchronizationRepository.create(parsed);
    return parsed;
  }

  async function applyBuilderDocuments(
    result: SynchronizationResult,
    target: Awaited<ReturnType<SdkProjectWorkspaceResolver["resolve"]>>,
    settings: Awaited<ReturnType<SqliteProjectSettingsRepository["get"]>>,
    beforeCapture: SourceCapture,
    documentEdits: readonly DocumentEdit[],
    noChangeFindings: readonly NoChangeFinding[],
    signal?: AbortSignal,
  ): Promise<SynchronizationResult> {
    const settingsByPath = configuredDocumentMap(settings);
    const beforeByPath = capturedMarkdownMap(beforeCapture);
    const editsByPath = new Map<string, DocumentEdit>();
    const findingsByPath = new Map<string, NoChangeFinding>();
    const documents: SynchronizationResult["documents"] = [];
    const unresolved = [...result.unresolvedItems];

    for (const edit of documentEdits) {
      if (editsByPath.has(edit.path) || findingsByPath.has(edit.path)) {
        unresolved.push(`Document ${edit.path} was supplied more than once`);
        continue;
      }
      editsByPath.set(edit.path, edit);
    }
    for (const finding of noChangeFindings) {
      if (editsByPath.has(finding.path) || findingsByPath.has(finding.path)) {
        unresolved.push(`Document ${finding.path} was supplied more than once`);
        continue;
      }
      findingsByPath.set(finding.path, finding);
    }

    const fail = (message: string, conflict = false) => {
      unresolved.push(message);
      result = synchronizationResultSchema.parse({
        ...result,
        status: conflict ? "conflict" : "failed",
        updatedAt: Date.now(),
        documents,
        unresolvedItems: [...new Set(unresolved)].slice(0, 128),
        error: message,
        retryable: false,
      });
    };

    for (const path of new Set([...editsByPath.keys(), ...findingsByPath.keys()])) {
      const setting = settingsByPath.get(path);
      if (setting === undefined) {
        fail(`Document ${path} is not configured for this project`);
        continue;
      }
      if (editsByPath.has(path) && setting.maintenance === "reference-only") {
        documents.push(syncDocumentResult({
          path,
          maintenance: setting.maintenance,
          action: "preserved",
          beforeSha256: sourceHashFor(beforeCapture, path),
          afterSha256: sourceHashFor(beforeCapture, path),
          checkedSections: findingsByPath.get(path)?.checkedSections,
          reason: "Reference-only Markdown is preserved and is not a maintenance target.",
        }));
        fail(`Reference-only document ${path} cannot be edited by synchronization`);
        continue;
      }
      const source = beforeByPath.get(path);
      if (source === undefined) {
        documents.push(syncDocumentResult({
          path,
          maintenance: setting.maintenance,
          action: "conflict",
          beforeSha256: null,
          afterSha256: null,
          reason: `Configured Markdown ${path} was not captured; re-read the current workspace before synchronizing.`,
        }));
        fail(`Configured Markdown ${path} could not be captured`, true);
        continue;
      }
      const beforeText = decodeCapturedSource(source);
      const sections = capturedSectionMap(beforeCapture, path);
      const edit = editsByPath.get(path);
      const finding = findingsByPath.get(path);
      if (edit !== undefined) {
        if (edit.expectedSha256 !== source.sha256) {
          documents.push(syncDocumentResult({
            path,
            maintenance: setting.maintenance,
            action: "conflict",
            beforeSha256: source.sha256,
            afterSha256: null,
            changedSections: edit.affectedSections.map((section) => section.anchor),
            reason: "The document changed after the builder read it; no content was overwritten.",
          }));
          fail(`Concurrent edit detected for ${path}; expected ${edit.expectedSha256}, found ${source.sha256}`, true);
          continue;
        }
        if (Buffer.byteLength(edit.content, "utf8") > 4 * 1024 * 1024) {
          fail(`Document edit ${path} exceeds the 4 MiB Markdown bound`);
          continue;
        }
        const desiredSha256 = sha256Text(edit.content);
        if (desiredSha256 === source.sha256) {
          documents.push(syncDocumentResult({
            path,
            maintenance: setting.maintenance,
            action: "updated",
            beforeSha256: source.sha256,
            afterSha256: source.sha256,
            changedSections: edit.affectedSections.map((section) => section.anchor),
            reason: `${edit.reason} (the requested final content was already present; no write was needed)`,
          }));
          continue;
        }
        try {
          const editCheck = validateFocusedDocumentEdit(
            path,
            beforeText,
            edit.content,
            sections,
            edit.affectedSections,
          );
          const write = await bb.sdk.files.write({
            hostId: target.hostId,
            path: resolveWithinRoot(target.rootPath, path),
            rootPath: target.rootPath,
            content: edit.content,
            contentEncoding: "utf8",
            expectedSha256: edit.expectedSha256,
            createParents: false,
          });
          if (write.outcome === "conflict") {
            documents.push(syncDocumentResult({
              path,
              maintenance: setting.maintenance,
              action: "conflict",
              beforeSha256: source.sha256,
              afterSha256: null,
              changedSections: edit.affectedSections.map((section) => section.anchor),
              reason: "The host rejected the compare-and-swap because the document changed.",
            }));
            fail(`Concurrent edit detected while writing ${path}; current hash is ${write.currentSha256 ?? "missing"}`, true);
            continue;
          }
          if (write.sha256 !== desiredSha256) {
            fail(`Host returned an unexpected hash after writing ${path}`);
            continue;
          }
          documents.push(syncDocumentResult({
            path,
            maintenance: setting.maintenance,
            action: "updated",
            beforeSha256: source.sha256,
            afterSha256: write.sha256,
            changedSections: editCheck.changedSections,
            reason: edit.reason,
          }));
        } catch (error) {
          const conflict = error instanceof DocumentConcurrencyError;
          documents.push(syncDocumentResult({
            path,
            maintenance: setting.maintenance,
            action: "conflict",
            beforeSha256: source.sha256,
            afterSha256: null,
            changedSections: edit.affectedSections.map((section) => section.anchor),
            reason: errorText(error),
          }));
          fail(errorText(error), conflict);
        }
        continue;
      }

      if (finding !== undefined) {
        if (finding.expectedSha256 !== source.sha256) {
          documents.push(syncDocumentResult({
            path,
            maintenance: setting.maintenance,
            action: "conflict",
            beforeSha256: source.sha256,
            afterSha256: null,
            checkedSections: finding.checkedSections,
            reason: "The document changed after the builder checked it; the no-change finding is no longer current.",
          }));
          fail(`Concurrent edit detected for no-change finding ${path}`, true);
          continue;
        }
        const sectionSet = new Set(sections.map((section) => section.anchor));
        const missing = finding.checkedSections.filter((anchor) => !sectionSet.has(anchor));
        if (missing.length > 0) {
          documents.push(syncDocumentResult({
            path,
            maintenance: setting.maintenance,
            action: "conflict",
            beforeSha256: source.sha256,
            afterSha256: source.sha256,
            checkedSections: finding.checkedSections,
            reason: `No-change finding names missing section(s): ${missing.join(", ")}`,
          }));
          fail(`No-change finding for ${path} names missing section(s): ${missing.join(", ")}`);
          continue;
        }
        documents.push(syncDocumentResult({
          path,
          maintenance: setting.maintenance,
          action: setting.maintenance === "reference-only" ? "preserved" : "no-change",
          beforeSha256: source.sha256,
          afterSha256: source.sha256,
          checkedSections: finding.checkedSections,
          reason: finding.reason,
        }));
      }
    }

    for (const setting of settings.documents) {
      if (setting.maintenance === "reference-only") {
        if (!documents.some((document) => document.path === setting.path)) {
          const source = beforeByPath.get(setting.path);
          documents.push(syncDocumentResult({
            path: setting.path,
            maintenance: setting.maintenance,
            action: "preserved",
            beforeSha256: source?.sha256 ?? null,
            afterSha256: source?.sha256 ?? null,
            reason: "Reference-only Markdown was retained as evidence and was not rewritten.",
          }));
        }
        continue;
      }
      if (!documents.some((document) => document.path === setting.path)) {
        fail(`No builder decision was supplied for maintained Markdown ${setting.path}`);
      }
    }

    const afterBoundary = await captureProjectBoundary(
      target,
      settings,
      beforeCapture.sources.filter((source) => source.kind === "code").map((source) => source.path),
      signal,
    );
    const afterCapture = afterBoundary.capture;
    const beforeInventory = beforeCapture.inventory;
    if (beforeInventory === undefined) {
      fail("Synchronization did not retain the inventory for its initial source boundary", true);
      return synchronizationResultSchema.parse({ ...result, documents });
    }
    const expectedPostSources = sourceIdentitiesForBoundary(beforeCapture).map((source) => {
      const document = documents.find((candidate) => candidate.path === source.path);
      const afterSource = capturedMarkdownMap(afterCapture).get(source.path);
      return document?.action === "updated" && document.afterSha256 !== null && afterSource !== undefined
        ? { ...source, sha256: document.afterSha256, sizeBytes: afterSource.sizeBytes }
        : source;
    });
    const sourceBoundaryError = boundaryConflict(
      {
        workspace: result.workspace ?? {
          projectId: target.projectId,
          environmentId: target.environmentId,
          hostId: target.hostId,
          rootPath: target.rootPath,
        },
        configurationRevision: result.configurationRevision,
        sources: expectedPostSources,
        inventory: beforeInventory,
      },
      afterBoundary,
      "Source or inventory boundary",
    );
    const documentHashProblems = documents.flatMap((document) => {
      if (document.action === "conflict") return [];
      const expectedHash = document.action === "updated" ? document.afterSha256 : document.beforeSha256;
      const actualHash = sourceHashFor(afterCapture, document.path);
      return expectedHash === actualHash
        ? []
        : [`Document ${document.path} no longer matches the recorded ${document.action} identity`];
    });
    if (sourceBoundaryError !== null || documentHashProblems.length > 0) {
      const problems = [
        ...(sourceBoundaryError === null ? [] : [sourceBoundaryError.message]),
        ...documentHashProblems,
      ];
      result = synchronizationResultSchema.parse({
        ...result,
        status: "conflict",
        updatedAt: Date.now(),
        documents,
        sourceBefore: sourceIdentitiesForBoundary(beforeCapture),
        sourceFinal: sourceIdentitiesForBoundary(afterCapture),
        inventoryBefore: beforeInventory,
        inventoryFinal: afterBoundary.inventory,
        unresolvedItems: [...new Set([...unresolved, ...problems])].slice(0, 128),
        error: problems.join("; ").slice(0, 1000),
        retryable: false,
      });
      return result;
    }
    const hadDocumentFailure = result.status === "failed" || result.status === "conflict";
    result = synchronizationResultSchema.parse({
      ...result,
      status: hadDocumentFailure ? result.status : "documents-written",
      updatedAt: Date.now(),
      documents,
      sourceBefore: sourceIdentitiesForBoundary(beforeCapture),
      sourceFinal: sourceIdentitiesForBoundary(afterCapture),
      inventoryBefore: beforeInventory,
      inventoryFinal: afterBoundary.inventory,
      unresolvedItems: [...new Set(unresolved)].slice(0, 128),
      error: hadDocumentFailure ? result.error : null,
      retryable: !hadDocumentFailure,
    });
    return result;
  }

  async function runSynchronization(
    input: z.infer<typeof synchronizationInputSchema>,
    signal?: AbortSignal,
  ): Promise<SynchronizationResult> {
    const { settings, target, lens: current } = await currentLiveLens(input.projectId, input.environmentId, signal);
    let result = newSynchronizationResult(target, input.expectedParentVersionId, settings.revision);
    await synchronizationRepository.create(result);
    const update = async (next: SynchronizationResult) => {
      result = await persistSynchronization(next, true);
      return result;
    };

    if (!settings.enabled) {
      return update(synchronizationResultSchema.parse({
        ...result,
        status: "failed",
        updatedAt: Date.now(),
        error: `Project Lens is disabled for project ${input.projectId}`,
        unresolvedItems: ["Enable Project Lens before synchronizing a builder change"],
        retryable: false,
      }));
    }
    if (current === null) {
      return update(synchronizationResultSchema.parse({
        ...result,
        status: "failed",
        updatedAt: Date.now(),
        error: "No current Lens exists for this workspace; initialize Lens 0 first",
        unresolvedItems: ["Initialize Lens 0 before synchronizing a completed change"],
        retryable: false,
      }));
    }
    if (current.id !== input.expectedParentVersionId) {
      return update(synchronizationResultSchema.parse({
        ...result,
        status: "conflict",
        updatedAt: Date.now(),
        error: `Current Lens is ${current.id}; the builder expected ${input.expectedParentVersionId ?? "none"}`,
        unresolvedItems: ["Re-read the current Project Lens context and reassess the change"],
        retryable: false,
      }));
    }
    if (settings.revision !== input.expectedConfigurationRevision) {
      return update(synchronizationResultSchema.parse({
        ...result,
        status: "conflict",
        updatedAt: Date.now(),
        error: `Project Lens configuration is revision ${settings.revision}; the builder expected ${input.expectedConfigurationRevision}`,
        unresolvedItems: ["Reload project Markdown configuration before synchronizing"],
        retryable: false,
      }));
    }

    try {
      const beforeBoundary = await captureProjectBoundary(target, settings, input.codePaths, signal);
      const beforeCapture = beforeBoundary.capture;
      result = await update(synchronizationResultSchema.parse({
        ...result,
        workspace: beforeBoundary.workspace,
        sourceBefore: sourceIdentitiesForBoundary(beforeCapture),
        inventoryBefore: beforeBoundary.inventory,
        updatedAt: Date.now(),
      }));
      result = await applyBuilderDocuments(
        result,
        target,
        settings,
        beforeCapture,
        input.documentEdits,
        input.noChangeFindings,
        signal,
      );
      result = await update(result);
    } catch (error) {
      const conflict = error instanceof DocumentConcurrencyError || error instanceof Error && error.name === "LensHeadConflictError";
      return update(synchronizationResultSchema.parse({
        ...result,
        status: conflict ? "conflict" : "failed",
        updatedAt: Date.now(),
        error: errorText(error),
        unresolvedItems: [...result.unresolvedItems, "Synchronization stopped before final Lens generation; re-read the current workspace and reassess the builder change"].slice(0, 128),
        retryable: false,
      }));
    }
    if (result.status !== "documents-written") return result;

    if (result.workspace === undefined || result.inventoryFinal === undefined) {
      return update(synchronizationResultSchema.parse({
        ...result,
        status: "conflict",
        updatedAt: Date.now(),
        error: "Synchronization has no complete source boundary; re-run from a fresh context",
        unresolvedItems: [...result.unresolvedItems, "The recorded operation predates inventory-bound synchronization"].slice(0, 128),
        retryable: false,
      }));
    }
    const expectedBoundary: SourceBoundaryExpectation = {
      workspace: result.workspace,
      configurationRevision: result.configurationRevision,
      sources: result.sourceFinal,
      inventory: result.inventoryFinal,
    };

    try {
      const output = await generationJobs.runAndWait({
        projectId: input.projectId,
        environmentId: input.environmentId,
        expectedParentVersionId: current.id,
        ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
        ...(input.model === undefined ? {} : { model: input.model }),
        expectedBoundary,
      }, signal);
      const comparison = summarizeComparison(compareLensVersions(output.lens, current));
      return update(synchronizationResultSchema.parse({
        ...result,
        status: "completed",
        updatedAt: Date.now(),
        sourceFinal: sourceIdentitiesForBoundary(output.capture),
        inventoryFinal: output.capture.inventory ?? result.inventoryFinal,
        lens: {
          versionId: output.lens.id,
          versionNumber: output.lens.versionNumber,
          parentVersionId: output.lens.parentVersionId,
        },
        comparison,
        error: null,
        retryable: false,
      }));
    } catch (error) {
      const conflict = error instanceof DocumentConcurrencyError || error instanceof Error && error.name === "LensHeadConflictError";
      return update(synchronizationResultSchema.parse({
        ...result,
        status: conflict ? "conflict" : "generation-failed",
        updatedAt: Date.now(),
        error: errorText(error),
        unresolvedItems: [
          ...result.unresolvedItems,
          conflict
            ? "Source, configuration, workspace or Lens parent changed during analysis; retry from a fresh context"
            : "Markdown edits remain in the workspace; retry Lens generation from the recorded operation",
        ].slice(0, 128),
        retryable: !conflict,
      }));
    }
  }

  async function retrySynchronization(
    input: z.infer<typeof synchronizationRetryInputSchema>,
    signal?: AbortSignal,
  ): Promise<SynchronizationResult> {
    let result = await synchronizationRepository.get(input.operationId, {
      projectId: input.projectId,
      environmentId: input.environmentId,
    });
    if (result === null) throw new Error(`Synchronization ${input.operationId} was not found`);
    if (result.status === "completed") return result;
    if (!result.retryable || result.status !== "generation-failed" && result.status !== "documents-written") {
      return result;
    }
    const { settings, target, lens: current } = await currentLiveLens(input.projectId, input.environmentId, signal);
    const update = async (next: SynchronizationResult) => {
      result = await persistSynchronization(next, true);
      return result;
    };
    if (
      !settings.enabled ||
      current === null ||
      current.id !== result.expectedParentVersionId ||
      settings.revision !== result.configurationRevision ||
      result.workspace === undefined ||
      !workspaceIdentityMatches(result.workspace, target)
    ) {
      return update(synchronizationResultSchema.parse({
        ...result,
        status: "conflict",
        updatedAt: Date.now(),
        error: "Retry context no longer matches the recorded project, configuration or Lens parent",
        unresolvedItems: [...result.unresolvedItems, "Reassess the completed change against the current Project Lens context"].slice(0, 128),
        retryable: false,
      }));
    }
    if (result.inventoryFinal === undefined) {
      return update(synchronizationResultSchema.parse({
        ...result,
        status: "conflict",
        updatedAt: Date.now(),
        error: "Retry cannot prove the recorded source boundary; re-run synchronization from fresh context",
        unresolvedItems: [...result.unresolvedItems, "The recorded operation has no complete final inventory"].slice(0, 128),
        retryable: false,
      }));
    }
    const codePaths = result.sourceFinal.filter((source) => source.kind === "code").map((source) => source.path);
    const currentBoundary = await captureProjectBoundary(target, settings, codePaths, signal);
    const expectedBoundary: SourceBoundaryExpectation = {
      workspace: result.workspace,
      configurationRevision: result.configurationRevision,
      sources: result.sourceFinal,
      inventory: result.inventoryFinal,
    };
    const boundaryError = boundaryConflict(expectedBoundary, currentBoundary, "Retry source boundary");
    const changed = sourceIdentityDifferences(result.sourceFinal, sourceIdentitiesForBoundary(currentBoundary.capture));
    const inventoryChanged = inventoryDifferences(result.inventoryFinal, currentBoundary.inventory);
    const expectedDocumentHashes = new Map(result.documents.map((document) => [document.path, document]));
    const currentDocuments = capturedMarkdownMap(currentBoundary.capture);
    const retryProblems: string[] = [];
    for (const [path, expected] of expectedDocumentHashes) {
      const currentSource = currentDocuments.get(path);
      const expectedHash = expected.action === "updated" ? expected.afterSha256 : expected.beforeSha256;
      const matches = expectedHash === null
        ? currentSource === undefined
        : currentSource !== undefined && currentSource.sha256 === expectedHash;
      if (!matches) {
        retryProblems.push(`Document ${path} no longer matches the recorded post-edit identity`);
      }
    }
    if (boundaryError !== null || changed.length > 0 || inventoryChanged.length > 0 || retryProblems.length > 0) {
      return update(synchronizationResultSchema.parse({
        ...result,
        status: "conflict",
        updatedAt: Date.now(),
        error: "Retry found content changes after the partial synchronization",
        sourceFinal: sourceIdentitiesForBoundary(currentBoundary.capture),
        inventoryFinal: currentBoundary.inventory,
        unresolvedItems: [
          ...result.unresolvedItems,
          ...(boundaryError === null ? [] : [boundaryError.message]),
          ...changed.map((path) => `Source changed after the failed generation: ${path}`),
          ...inventoryChanged.map((path) => `Project inventory changed after the failed generation: ${path}`),
          ...retryProblems,
        ].slice(0, 128),
        retryable: false,
      }));
    }
    result = await update(synchronizationResultSchema.parse({
      ...result,
      status: "documents-written",
      updatedAt: Date.now(),
      sourceFinal: sourceIdentitiesForBoundary(currentBoundary.capture),
      inventoryFinal: currentBoundary.inventory,
      error: null,
    }));
    try {
      const output = await generationJobs.runAndWait({
        projectId: input.projectId,
        environmentId: input.environmentId,
        expectedParentVersionId: current.id,
        ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
        ...(input.model === undefined ? {} : { model: input.model }),
        expectedBoundary,
      }, signal);
      return update(synchronizationResultSchema.parse({
        ...result,
        status: "completed",
        updatedAt: Date.now(),
        sourceFinal: sourceIdentitiesForBoundary(output.capture),
        inventoryFinal: output.capture.inventory ?? result.inventoryFinal,
        lens: {
          versionId: output.lens.id,
          versionNumber: output.lens.versionNumber,
          parentVersionId: output.lens.parentVersionId,
        },
        comparison: summarizeComparison(compareLensVersions(output.lens, current)),
        unresolvedItems: [],
        error: null,
        retryable: false,
      }));
    } catch (error) {
      return update(synchronizationResultSchema.parse({
        ...result,
        status: error instanceof DocumentConcurrencyError || error instanceof Error && error.name === "LensHeadConflictError" ? "conflict" : "generation-failed",
        updatedAt: Date.now(),
        error: errorText(error),
        unresolvedItems: [...result.unresolvedItems, "Markdown remains at the recorded final identity; retry generation again if the provider failure is transient"].slice(0, 128),
        retryable: !(error instanceof DocumentConcurrencyError || error instanceof Error && error.name === "LensHeadConflictError"),
      }));
    }
  }

  async function compareVersions(
    input: z.infer<typeof compareInputSchema>,
  ) {
    await boundary.getProject(input.projectId);
    const versions = await lensRepository.listForEnvironment({
      projectId: input.projectId,
      environmentId: input.environmentId,
    });
    const current = input.currentVersionId === undefined
      ? await lensRepository.currentForEnvironment({ projectId: input.projectId, environmentId: input.environmentId })
      : await lensRepository.get(input.currentVersionId);
    if (current === null) throw new Error(`No Lens version is saved for project ${input.projectId} environment ${input.environmentId}`);
    if (current.projectId !== input.projectId || current.environmentId !== input.environmentId) {
      throw new Error(`Lens version ${current.id} does not belong to this project environment`);
    }
    let baseline: LensVersion | null = null;
    if (input.baselineVersionId === undefined) {
      baseline = versions.find((version) => version.versionNumber === 0 && version.id !== current.id) ?? null;
    } else if (input.baselineVersionId !== null) {
      baseline = await lensRepository.get(input.baselineVersionId);
      if (baseline === null || baseline.projectId !== input.projectId || baseline.environmentId !== input.environmentId) {
        throw new Error(`Lens baseline ${input.baselineVersionId} does not belong to this project environment`);
      }
    }
    const settings = await projectSettings(input.projectId);
    const comparison = compareLensVersions(current, baseline);
    const synchronization = await synchronizationRepository.latest({
      projectId: input.projectId,
      environmentId: input.environmentId,
    });
    return {
      current,
      baseline,
      comparison,
      documentChanges: compareDocumentSources({ baseline, current, settings: settings.documents }),
      synchronization,
    };
  }

  bb.onDispose(() => generationJobs.dispose());

  bb.rpc.register(rpcContract, {
    projects_list: async () => ({ projects: await boundary.listProjects() }),
    environments_list: async ({ projectId, contextThreadId, requestedEnvironmentId }) => {
      const resolvedProject = await projectForLens(projectId);
      if (resolvedProject.scope.status !== "supported") {
        return { environments: [], scope: resolvedProject.scope };
      }
      const savedIds = await lensRepository.listEnvironmentIds(projectId);
      const contextIds = await contextEnvironmentIds(projectId, contextThreadId);
      const knownIds = [
        ...new Set([
          ...savedIds,
          ...contextIds,
          ...(requestedEnvironmentId === undefined ? [] : [requestedEnvironmentId]),
        ]),
      ];
      const live = await boundary.listEnvironments(projectId, { knownEnvironmentIds: knownIds });
      const liveIds = new Set(live.map((environment) => environment.id));
      if (
        requestedEnvironmentId !== undefined &&
        !liveIds.has(requestedEnvironmentId) &&
        !savedIds.includes(requestedEnvironmentId)
      ) {
        throw new Error(
          "Workspace " + requestedEnvironmentId + " could not be resolved for project " + projectId,
        );
      }
      const historyOnly = savedIds
        .filter((environmentId) => !liveIds.has(environmentId))
        .map((environmentId) =>
          projectEnvironmentOptionSchema.parse({
            id: environmentId,
            projectId,
            name: null,
            branchName: null,
            path: null,
            hostId: null,
            hostName: null,
            hostStatus: null,
            status: "unavailable",
            workspaceProvisionType: "unmanaged",
            hasSavedLens: true,
          }),
        );
      return {
        environments: [
          ...live.map((environment) => ({
            ...environment,
            hasSavedLens: savedIds.includes(environment.id),
          })),
          ...historyOnly,
        ],
        scope: resolvedProject.scope,
      };
    },
    settings_get: async ({ projectId }) => {
      const resolvedProject = await projectForLens(projectId);
      return resolvedProject.scope.status === "unsupported"
        ? unsupportedProjectScopeResult(resolvedProject.project)
        : settingsRepository.get(projectId);
    },
    settings_save: async ({ projectId, enabled, documents, expectedRevision }) => {
      const resolvedProject = await projectForLens(projectId);
      if (resolvedProject.scope.status !== "supported") {
        return unsupportedProjectScopeResult(resolvedProject.project);
      }
      const input: ProjectLensSettingsInput = {
        enabled,
        documents,
        expectedRevision,
      };
      const saved = await settingsRepository.save(projectId, input);
      bb.realtime.publish("project-lens-settings-changed", {
        projectId: saved.projectId,
        revision: saved.revision,
      });
      return saved;
    },
    workspace_resolve: ({ projectId, environmentId }) =>
      boundary.resolve({ projectId, environmentId }),
    sources_capture: async ({ projectId, environmentId, codePaths }) => {
      const { capture } = await captureFor(projectId, environmentId, codePaths, true);
      return capture;
    },
    lens_capture: async ({
      projectId,
      environmentId,
      codePaths,
      expectedParentVersionId,
    }) => {
      const { settings, target, inventory, capture } = await captureFor(projectId, environmentId, codePaths);
      const candidate = createLensCandidate({
        target,
        settings,
        capture,
        inventory,
        parentVersionId: expectedParentVersionId,
      });
      const lens = await lensRepository.publish(candidate, {
        parentVersionId: expectedParentVersionId,
      });
      bb.realtime.publish("project-lens-version-changed", {
        projectId: lens.projectId,
        environmentId: lens.environmentId,
        versionId: lens.id,
        versionNumber: lens.versionNumber,
      });
      return { lens, capture };
    },
    lens_generate: ({
      projectId,
      environmentId,
      expectedParentVersionId,
      providerId,
      model,
    }) =>
      generationJobs.runAndWait({
        projectId,
        environmentId,
        expectedParentVersionId,
        providerId,
        model,
      }),
    lens_generate_start: async ({
      projectId,
      environmentId,
      expectedParentVersionId,
      providerId,
      model,
    }) => {
      await boundary.getProject(projectId);
      const input: GenerationJobInput = {
        projectId,
        environmentId,
        expectedParentVersionId,
        ...(providerId === undefined ? {} : { providerId }),
        ...(model === undefined ? {} : { model }),
      };
      return generationJobs.start(input) as GenerationJobView;
    },
    lens_generate_status: async ({ projectId, environmentId, operationId }) => {
      await boundary.getProject(projectId);
      return generationJobs.status(operationId, projectId, environmentId);
    },
    lens_generate_cancel: async ({ projectId, environmentId, operationId }) => {
      await boundary.getProject(projectId);
      return generationJobs.cancel(operationId, projectId, environmentId);
    },
    lens_generate_reconcile: async ({ projectId, environmentId, operationId }) => {
      await boundary.getProject(projectId);
      return generationJobs.reconcile(operationId, projectId, environmentId);
    },
    lens_current: async ({ projectId, environmentId }) => {
      await boundary.getProject(projectId);
      return {
        lens: await lensRepository.currentForEnvironment({ projectId, environmentId }),
      };
    },
    lens_list: async ({ projectId, environmentId }) => {
      await boundary.getProject(projectId);
      return {
        versions: await lensRepository.listForEnvironment({ projectId, environmentId }),
      };
    },
    lens_get: async ({ projectId, environmentId, versionId }) => {
      await boundary.getProject(projectId);
      const lens = await lensRepository.get(versionId);
      if (lens === null) throw new Error(`Lens version ${versionId} was not found`);
      if (lens.projectId !== projectId || lens.environmentId !== environmentId) {
        throw new Error(`Lens version ${versionId} does not belong to this project environment`);
      }
      return lens;
    },
    lens_initialize: async ({ projectId, environmentId, codePaths, providerId, model }) => {
      const { settings, target } = await currentLiveLens(projectId, environmentId);
      if (!settings.enabled) throw new Error(`Project Lens is disabled for project ${projectId}`);
      const existing = await lensRepository.current(target);
      if (existing !== null) {
        throw new Error(`Project Lens is already initialized at Lens ${existing.id}; use compare or synchronize`);
      }
      const output = await generationJobs.runAndWait({
        projectId,
        environmentId,
        expectedParentVersionId: null,
        ...(providerId === undefined ? {} : { providerId }),
        ...(model === undefined ? {} : { model }),
      });
      return { initialized: true, lens: output.lens, capture: output.capture, job: output.job };
    },
    lens_synchronize: (input) => runSynchronization(input),
    lens_synchronize_retry: (input) => retrySynchronization(input),
    lens_sync_latest: async ({ projectId, environmentId }) => {
      await boundary.getProject(projectId);
      return {
        synchronization: await synchronizationRepository.latest({ projectId, environmentId }),
      };
    },
    lens_compare: (input) => compareVersions(input),
  });

  bb.agents.registerTool({
    name: "project_lens_generate",
    description: "Generate a validated whole-project Project Lens using the configured BB provider.",
    instructions:
      "Use project_lens_generate only at a completed implementation boundary. It inventories the selected project, analyzes bounded captured evidence, and publishes an immutable Lens version.",
    presentation: {
      label: {
        pending: "Generating Project Lens",
        completed: "Generated Project Lens",
      },
    },
    parameters: z
      .object({
        environmentId: environmentIdSchema,
        expectedParentVersionId: versionIdSchema.nullable().default(null),
        providerId: providerIdSchema,
        model: modelSchema,
      })
      .strict(),
    async execute({ environmentId, expectedParentVersionId, providerId, model }, context) {
      const result = await generationJobs.runAndWait(
        {
          projectId: context.projectId,
          environmentId,
          expectedParentVersionId,
          providerId,
          model,
        },
        context.signal,
      );
      return JSON.stringify({
        lens: {
          id: result.lens.id,
          versionNumber: result.lens.versionNumber,
          parentVersionId: result.lens.parentVersionId,
          componentCount: result.lens.graph.components.length,
          connectionCount: result.lens.graph.connections.length,
          coverage: result.lens.coverage,
        },
        job: result.job,
      });
    },
  });
  bb.agents.registerTool({
    name: "project_lens_initialize",
    description: "Initialize immutable Project Lens 0 for the selected project environment.",
    instructions: "Use only when the injected Project Lens context says no current Lens exists. Initialization captures the configured Markdown and publishes Lens 0.",
    presentation: {
      label: { pending: "Initializing Project Lens", completed: "Initialized Project Lens" },
    },
    parameters: z
      .object({
        environmentId: environmentIdSchema,
        codePaths: codePathsSchema,
        providerId: providerIdSchema,
        model: modelSchema,
      })
      .strict(),
    async execute({ environmentId, codePaths, providerId, model }, context) {
      const { settings, target } = await currentLiveLens(context.projectId, environmentId, context.signal);
      if (!settings.enabled) throw new Error(`Project Lens is disabled for project ${context.projectId}`);
      const existing = await lensRepository.current(target);
      if (existing !== null) {
        return JSON.stringify({ initialized: false, lens: { id: existing.id, versionNumber: existing.versionNumber }, detail: "Lens already exists; use compare." });
      }
      const output = await generationJobs.runAndWait({
        projectId: context.projectId,
        environmentId,
        expectedParentVersionId: null,
        ...(providerId === undefined ? {} : { providerId }),
        ...(model === undefined ? {} : { model }),
      }, context.signal);
      return JSON.stringify({
        initialized: true,
        lens: { id: output.lens.id, versionNumber: output.lens.versionNumber, parentVersionId: output.lens.parentVersionId },
        componentCount: output.lens.graph.components.length,
        connectionCount: output.lens.graph.connections.length,
        coverage: output.lens.coverage,
      });
    },
  });
  bb.agents.registerTool({
    name: "project_lens_synchronize",
    description: "Synchronize a completed builder change, maintained Markdown decisions and a final Project Lens version.",
    instructions: "Pass the expected parent Lens and configuration revision from Project Lens context. Supply every maintained document's edit or no-change finding. The tool uses CAS, preserves reference-only content, and returns a retryable result when Markdown succeeded but Lens generation failed.",
    presentation: {
      label: { pending: "Synchronizing Project Lens", completed: "Synchronized Project Lens" },
    },
    parameters: synchronizationInputSchema.omit({ projectId: true }),
    async execute(input, context) {
      const result = await runSynchronization({ ...input, projectId: context.projectId }, context.signal);
      return JSON.stringify({
        operationId: result.operationId,
        status: result.status,
        documents: result.documents,
        sourceBefore: result.sourceBefore.slice(0, 64),
        sourceFinal: result.sourceFinal.slice(0, 64),
        lens: result.lens,
        comparison: result.comparison,
        unresolvedItems: result.unresolvedItems,
        error: result.error,
        retryable: result.retryable,
      });
    },
  });
  bb.agents.registerTool({
    name: "project_lens_synchronize_retry",
    description: "Retry Project Lens publication after a recorded synchronization left Markdown edits in place.",
    instructions: "Use the operation ID from a generation-failed synchronization. Retry verifies current hashes and never repeats a successful document write.",
    presentation: {
      label: { pending: "Retrying Project Lens", completed: "Retried Project Lens" },
    },
    parameters: synchronizationRetryInputSchema.omit({ projectId: true }),
    async execute(input, context) {
      const result = await retrySynchronization({ ...input, projectId: context.projectId }, context.signal);
      return JSON.stringify({
        operationId: result.operationId,
        status: result.status,
        documents: result.documents,
        lens: result.lens,
        comparison: result.comparison,
        unresolvedItems: result.unresolvedItems,
        error: result.error,
        retryable: result.retryable,
      });
    },
  });
  bb.agents.registerTool({
    name: "project_lens_compare",
    description: "Compare a Project Lens version with Lens 0 or another saved version, including captured Markdown changes.",
    instructions: "Use the default baseline for Lens 0, or pass a saved baseline version ID. Historical comparisons read immutable captured bytes.",
    presentation: {
      label: { pending: "Comparing Project Lens", completed: "Compared Project Lens" },
    },
    parameters: compareInputSchema.omit({ projectId: true }),
    async execute(input, context) {
      const result = await compareVersions({ ...input, projectId: context.projectId });
      return JSON.stringify({
        current: { id: result.current.id, versionNumber: result.current.versionNumber },
        baseline: result.baseline === null ? null : { id: result.baseline.id, versionNumber: result.baseline.versionNumber },
        comparison: summarizeComparison(result.comparison),
        documentChanges: result.documentChanges,
        synchronization: result.synchronization,
      });
    },
  });
  bb.agents.configure((context) => {
    const eligible =
      context.project.kind === "standard" &&
      context.environment.path !== null &&
      context.origin.pluginId !== "project-lens";
    if (!eligible) return { tools: [], skills: [] };
    try {
      const settings = settingsRepository.getSync(context.project.id);
      const currentLens = lensRepository.currentForEnvironmentSync({
        projectId: context.project.id,
        environmentId: context.environment.id,
      });
      const latestSynchronization = synchronizationRepository.latestSync({
        projectId: context.project.id,
        environmentId: context.environment.id,
      });
      const data: AgentContextData = {
        project: context.project,
        environment: context.environment,
        host: context.host,
        settings,
        currentLens,
        latestSynchronization,
      };
      const selection = buildProjectLensAgentSelection(data);
      return {
        tools: selection.tools,
        skills: selection.skills,
        ...(selection.instructions === undefined ? {} : { instructions: selection.instructions }),
      };
    } catch (error) {
      bb.log.warn(`Project Lens context was unavailable for ${context.project.id}: ${errorText(error)}`);
      return {
        tools: ["project_lens_generate"],
        skills: [],
      };
    }
  });

  bb.log.info("Project Lens foundation loaded");
}
