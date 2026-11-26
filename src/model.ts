import { z } from "zod";

export const sourceKindSchema = z.enum(["code", "markdown"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const maintenanceModeSchema = z.enum(["keep-updated", "reference-only"]);
export type MaintenanceMode = z.infer<typeof maintenanceModeSchema>;

export const documentSettingSchema = z
  .object({
    path: z.string().min(1),
    purpose: z.string().max(240).optional(),
    maintenance: maintenanceModeSchema,
  })
  .strict();
export type DocumentSetting = z.infer<typeof documentSettingSchema>;

export const projectLensSettingsSchema = z
  .object({
    projectId: z.string().min(1),
    enabled: z.boolean(),
    documents: z.array(documentSettingSchema),
    revision: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type ProjectLensSettings = z.infer<typeof projectLensSettingsSchema>;

export const projectLensSettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    documents: z.array(documentSettingSchema).max(256),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export type ProjectLensSettingsInput = z.infer<typeof projectLensSettingsInputSchema>;

export const workspaceIdentitySchema = z
  .object({
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
    hostId: z.string().min(1),
    rootPath: z.string().min(1),
  })
  .strict();
export type WorkspaceIdentity = z.infer<typeof workspaceIdentitySchema>;

/** Stored-history lookup scope; deliberately excludes live host/root inputs. */
export const lensHistoryScopeSchema = z
  .object({
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
  })
  .strict();
export type LensHistoryScope = z.infer<typeof lensHistoryScopeSchema>;

export const projectSummarySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(["personal", "standard"]),
  })
  .strict();
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

/**
 * Project metadata is the authority for whether Project Lens can operate.
 * BB's Personal project is a supported BB scope, but it has no Project Lens
 * environment/storage boundary and therefore remains an explicit unsupported
 * selection rather than being treated as a missing project.
 */
export const projectLensSupportedScopeSchema = z
  .object({
    status: z.literal("supported"),
    projectKind: z.literal("standard"),
  })
  .strict();

export const projectLensUnsupportedScopeSchema = z
  .object({
    status: z.literal("unsupported"),
    projectKind: z.literal("personal"),
    reason: z.literal("personal-project"),
  })
  .strict();

export const projectLensScopeSchema = z.discriminatedUnion("status", [
  projectLensSupportedScopeSchema,
  projectLensUnsupportedScopeSchema,
]);
export type ProjectLensScope = z.infer<typeof projectLensScopeSchema>;

export const projectLensUnsupportedScopeMessage =
  "Personal is not supported by Project Lens. Select a standard BB project to configure, capture, or generate a Lens.";

export function projectLensScopeFor(project: Pick<ProjectSummary, "kind">): ProjectLensScope {
  return project.kind === "standard"
    ? { status: "supported", projectKind: "standard" }
    : { status: "unsupported", projectKind: "personal", reason: "personal-project" };
}

export const projectEnvironmentOptionStatusSchema = z.enum([
  "destroyed",
  "destroying",
  "error",
  "provisioning",
  "ready",
  "retiring",
  "unavailable",
]);
export type ProjectEnvironmentOptionStatus = z.infer<typeof projectEnvironmentOptionStatusSchema>;

/**
 * A display-safe environment record for the Project Lens picker. The
 * environment ID remains the value submitted to Lens history/generation, but
 * the picker can explain where that value points without asking the user to
 * remember an internal identifier.
 */
export const projectEnvironmentOptionSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    name: z.string().nullable(),
    branchName: z.string().nullable(),
    path: z.string().nullable(),
    // History-only records intentionally retain no invented live host identity.
    hostId: z.string().min(1).nullable(),
    hostName: z.string().nullable(),
    hostStatus: z.enum(["connected", "disconnected"]).nullable(),
    status: projectEnvironmentOptionStatusSchema,
    workspaceProvisionType: z.enum(["managed-worktree", "personal", "unmanaged"]),
    hasSavedLens: z.boolean(),
  })
  .strict();
export type ProjectEnvironmentOption = z.infer<typeof projectEnvironmentOptionSchema>;

export const projectWorkspaceSchema = z
  .object({
    project: projectSummarySchema,
    environment: z
      .object({
        id: z.string().min(1),
        projectId: z.string().min(1),
        hostId: z.string().min(1),
        status: z.enum([
          "destroyed",
          "destroying",
          "error",
          "provisioning",
          "ready",
          "retiring",
        ]),
        path: z.string().min(1),
        workspaceProvisionType: z.enum([
          "managed-worktree",
          "personal",
          "unmanaged",
        ]),
        branchName: z.string().nullable(),
      })
      .strict(),
    host: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        status: z.enum(["connected", "disconnected"]),
        type: z.literal("persistent"),
      })
      .strict(),
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
    hostId: z.string().min(1),
    rootPath: z.string().min(1),
  })
  .strict();
export type ProjectWorkspace = z.infer<typeof projectWorkspaceSchema>;

export const sourceAnchorSchema = z
  .object({
    sourceId: z.string().min(1),
    path: z.string().min(1),
    startLine: z.number().int().positive().nullable(),
    endLine: z.number().int().positive().nullable(),
    capturedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type SourceAnchor = z.infer<typeof sourceAnchorSchema>;

export const capturedSourceSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    kind: sourceKindSchema,
    wireEncoding: z.enum(["base64", "utf8"]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
    bytesBase64: z.string(),
    mimeType: z.string().nullable(),
    modifiedAtMs: z.number().nonnegative().nullable(),
  })
  .strict();
export type CapturedSource = z.infer<typeof capturedSourceSchema>;

export const documentSectionSchema = z
  .object({
    sourceId: z.string().min(1),
    path: z.string().min(1),
    anchor: z.string().min(1),
    heading: z.string().min(1),
    level: z.number().int().min(1).max(6),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    capturedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((section, context) => {
    if (section.endLine < section.startLine) {
      context.addIssue({
        code: "custom",
        path: ["endLine"],
        message: "A document section cannot end before it starts",
      });
    }
  })
  .strict();
export type DocumentSection = z.infer<typeof documentSectionSchema>;

export const documentMappingSchema = z
  .object({
    componentId: z.string().min(1),
    documentPath: z.string().min(1),
    sectionAnchor: z.string().min(1),
    sectionHeading: z.string().min(1),
    sourceId: z.string().min(1),
    capturedSha256: z.string().regex(/^[a-f0-9]{64}$/),
    claim: z.string().min(1),
    relation: z.enum(["supports", "contradicts", "context"]),
    provenance: z.enum(["declared", "inferred", "extracted", "observed"]),
  })
  .strict();
export type DocumentMapping = z.infer<typeof documentMappingSchema>;

export const evidenceProvenanceSchema = z.enum([
  "declared",
  "inferred",
  "extracted",
  "observed",
]);
export type EvidenceProvenance = z.infer<typeof evidenceProvenanceSchema>;

export const evidenceRefSchema = z
  .object({
    sourceId: z.string().min(1),
    kind: sourceKindSchema,
    path: z.string().min(1),
    claim: z.string().min(1),
    capturedSha256: z.string().regex(/^[a-f0-9]{64}$/),
    startLine: z.number().int().positive().nullable(),
    endLine: z.number().int().positive().nullable(),
    sectionAnchor: z.string().min(1).optional(),
    provenance: evidenceProvenanceSchema,
  })
  .strict();
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const connectionTypeSchema = z.enum([
  "calls",
  "imports",
  "reads",
  "writes",
  "publishes",
  "depends-on",
  "contains",
  "unknown",
]);
export type ConnectionType = z.infer<typeof connectionTypeSchema>;

export const componentStateSchema = z.enum(["implemented", "planned", "unknown"]);
export type ComponentState = z.infer<typeof componentStateSchema>;

export interface LensGraph {
  components: LensComponent[];
  connections: LensConnection[];
}

export interface LensComponent {
  id: string;
  /** Provider-supplied semantic key retained for identity matching. */
  identityKey?: string;
  name: string;
  responsibility: string;
  parentId: string | null;
  groupId: string | null;
  provenance: EvidenceProvenance;
  state: ComponentState;
  codeAnchors: SourceAnchor[];
  documentMappings: DocumentMapping[];
  evidence: EvidenceRef[];
  nestedFlow?: LensGraph;
}

export interface LensConnection {
  id: string;
  fromComponentId: string;
  toComponentId: string;
  type: ConnectionType;
  direction: "forward" | "backward" | "bidirectional";
  label: string;
  provenance: EvidenceProvenance;
  state: ComponentState;
  evidence: EvidenceRef[];
}

export const lensGraphSchema: z.ZodType<LensGraph> = z.lazy(() =>
  z
    .object({
    components: z.array(lensComponentSchema),
    connections: z.array(lensConnectionSchema),
  })
    .strict(),
);

export const lensComponentSchema: z.ZodType<LensComponent> = z
  .object({
    id: z.string().min(1),
    identityKey: z.string().min(1).optional(),
    name: z.string().min(1),
    responsibility: z.string().min(1),
    parentId: z.string().nullable(),
    groupId: z.string().nullable(),
    provenance: evidenceProvenanceSchema,
    state: componentStateSchema,
    codeAnchors: z.array(sourceAnchorSchema),
    documentMappings: z.array(documentMappingSchema),
    evidence: z.array(evidenceRefSchema),
    nestedFlow: lensGraphSchema.optional(),
  })
  .strict();

export const lensConnectionSchema: z.ZodType<LensConnection> = z
  .object({
    id: z.string().min(1),
    fromComponentId: z.string().min(1),
    toComponentId: z.string().min(1),
    type: connectionTypeSchema,
    direction: z.enum(["forward", "backward", "bidirectional"]),
    label: z.string().min(1),
    provenance: evidenceProvenanceSchema,
    state: componentStateSchema,
    evidence: z.array(evidenceRefSchema),
  })
  .strict();

export const coverageStatusSchema = z.enum([
  "analyzed",
  "excluded",
  "unsupported",
  "unresolved",
  "missing",
  "escaped",
]);
export type CoverageStatus = z.infer<typeof coverageStatusSchema>;

export const coverageEntrySchema = z
  .object({
    path: z.string().min(1),
    kind: sourceKindSchema,
    status: coverageStatusSchema,
    reason: z.string().max(500).optional(),
    sourceId: z.string().min(1).optional(),
  })
  .strict();
export type CoverageEntry = z.infer<typeof coverageEntrySchema>;

export const coverageRecordSchema = z
  .object({
    scope: z.enum(["configured-sources", "whole-project"]),
    totalRequested: z.number().int().nonnegative(),
    analyzed: z.array(coverageEntrySchema),
    excluded: z.array(coverageEntrySchema),
    unsupported: z.array(coverageEntrySchema),
    unresolved: z.array(coverageEntrySchema),
    missing: z.array(coverageEntrySchema),
    escaped: z.array(coverageEntrySchema),
    /** Semantic or inventory areas the bounded run could not establish. */
    unknownAreas: z.array(z.string().min(1).max(500)).optional(),
    complete: z.boolean(),
  })
  .strict();
export type CoverageRecord = z.infer<typeof coverageRecordSchema>;

export const inventoryKindSchema = z.enum(["code", "markdown", "other"]);
export type InventoryKind = z.infer<typeof inventoryKindSchema>;

export const inventoryEntrySchema = z
  .object({
    path: z.string().min(1),
    kind: inventoryKindSchema,
    status: z.enum(["candidate", "excluded", "unresolved"]),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type InventoryEntry = z.infer<typeof inventoryEntrySchema>;

export const projectInventorySchema = z
  .object({
    capturedAt: z.number().int().nonnegative(),
    entries: z.array(inventoryEntrySchema),
    totalDiscovered: z.number().int().nonnegative(),
    truncated: z.boolean(),
    omittedCount: z.number().int().nonnegative(),
  })
  .strict();
export type ProjectInventory = z.infer<typeof projectInventorySchema>;

export const sourceCaptureSchema = z
  .object({
    capturedAt: z.number().int().nonnegative(),
    sources: z.array(capturedSourceSchema),
    documentSections: z.array(documentSectionSchema),
    coverage: coverageRecordSchema,
    /** The bounded project inventory read for the same capture boundary. */
    inventory: projectInventorySchema.optional(),
  })
  .strict();
export type SourceCapture = z.infer<typeof sourceCaptureSchema>;

export const analysisCoverageSchema = z.object({
  evidencePasses:z.number().int().min(1).max(16),
  suppliedSourceIds:z.array(z.string()), unrepresentedSourceIds:z.array(z.string()),
  architectureAssembled:z.boolean(),
}).strict();
export type AnalysisCoverage = z.infer<typeof analysisCoverageSchema>;

export const lensVersionSchema = z
  .object({
    id: z.string().min(1),
    versionNumber: z.number().int().nonnegative(),
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
    hostId: z.string().min(1),
    rootPath: z.string().min(1),
    parentVersionId: z.string().nullable(),
    createdAt: z.number().int().nonnegative(),
    configurationRevision: z.number().int().nonnegative(),
    documentSettings: z.array(documentSettingSchema),
    analyzerRevision: z.string().min(1),
    analysisCoverage: analysisCoverageSchema.optional(),
    sources: z.array(capturedSourceSchema),
    documentSections: z.array(documentSectionSchema),
    graph: lensGraphSchema,
    coverage: coverageRecordSchema,
    inventory: projectInventorySchema.optional(),
    identityWarnings: z.array(z.string().min(1).max(500)).optional(),
    analysisProviderId: z.string().min(1).nullable().optional(),
  })
  .strict();
export type LensVersion = z.infer<typeof lensVersionSchema>;

export type LensCandidate = Omit<LensVersion, "versionNumber">;

/** A bounded source identity used by the builder synchronization ledger. */
export const sourceIdentitySchema = z
  .object({
    path: z.string().min(1),
    kind: sourceKindSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type SourceIdentity = z.infer<typeof sourceIdentitySchema>;

export const documentSyncActionSchema = z.enum([
  "pending",
  "updated",
  "no-change",
  "preserved",
  "conflict",
]);
export type DocumentSyncAction = z.infer<typeof documentSyncActionSchema>;

/**
 * One builder-reported document outcome. `reason` is an assessment supplied by
 * the builder; it is not a semantic proof produced by the plugin.
 */
export const documentSyncResultSchema = z
  .object({
    path: z.string().min(1),
    maintenance: maintenanceModeSchema,
    action: documentSyncActionSchema,
    beforeSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    afterSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    changedSections: z.array(z.string().min(1)),
    checkedSections: z.array(z.string().min(1)),
    reason: z.string().min(1).max(1000),
  })
  .strict();
export type DocumentSyncResult = z.infer<typeof documentSyncResultSchema>;

export const documentDiffStatusSchema = z.enum(["added", "changed", "removed", "unchanged"]);
export type DocumentDiffStatus = z.infer<typeof documentDiffStatusSchema>;

/** One immutable, captured Markdown side of a comparison section. */
export const documentDiffSectionSchema = z
  .object({
    anchor: z.string().min(1),
    beforeText: z.string().nullable(),
    afterText: z.string().nullable(),
    beforeTruncated: z.boolean(),
    afterTruncated: z.boolean(),
  })
  .strict();
export type DocumentDiffSection = z.infer<typeof documentDiffSectionSchema>;

/** A source-backed, bounded Markdown change summary shown beside graph changes. */
export const documentDiffSchema = z
  .object({
    path: z.string().min(1),
    status: documentDiffStatusSchema,
    baselineVersionId: z.string().min(1).nullable(),
    currentVersionId: z.string().min(1),
    baselineSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    currentSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    changedSections: z.array(z.string().min(1)),
    sections: z.array(documentDiffSectionSchema),
    addedLines: z.number().int().nonnegative(),
    removedLines: z.number().int().nonnegative(),
    maintenance: maintenanceModeSchema.nullable(),
  })
  .strict();
export type DocumentDiff = z.infer<typeof documentDiffSchema>;

export const lensComparisonSummarySchema = z
  .object({
    currentVersionId: z.string().min(1),
    baselineVersionId: z.string().min(1).nullable(),
    addedComponents: z.number().int().nonnegative(),
    changedComponents: z.number().int().nonnegative(),
    removedComponents: z.number().int().nonnegative(),
    addedConnections: z.number().int().nonnegative(),
    changedConnections: z.number().int().nonnegative(),
    removedConnections: z.number().int().nonnegative(),
    sourceOnlyChanges: z.number().int().nonnegative(),
    explanationOnlyChanges: z.number().int().nonnegative(),
    architectureChanges: z.number().int().nonnegative(),
    uncertainty: z.array(z.string().min(1).max(500)),
  })
  .strict();
export type LensComparisonSummary = z.infer<typeof lensComparisonSummarySchema>;

export const diagramChangeSchema = z.enum(["added", "changed", "removed", "unchanged", "uncertain"]);

export const diagramComparisonSchema = z
  .object({
    currentVersionId: z.string().min(1),
    baselineVersionId: z.string().min(1).nullable(),
    components: z.array(
      z
        .object({
          id: z.string().min(1),
          current: lensComponentSchema.nullable(),
          baseline: lensComponentSchema.nullable(),
          change: diagramChangeSchema,
          sourceOnly: z.boolean(),
          explanationOnly: z.boolean(),
          architectureChanged: z.boolean(),
        })
        .strict(),
    ),
    connections: z.array(
      z
        .object({
          id: z.string().min(1),
          current: lensConnectionSchema.nullable(),
          baseline: lensConnectionSchema.nullable(),
          change: diagramChangeSchema,
          sourceOnly: z.boolean(),
          explanationOnly: z.boolean(),
          architectureChanged: z.boolean(),
        })
        .strict(),
    ),
    canConfirmRemovals: z.boolean(),
    uncertainty: z.array(z.string().min(1).max(500)),
    sourceOnlyChanges: z.number().int().nonnegative(),
    explanationOnlyChanges: z.number().int().nonnegative(),
    architectureChanges: z.number().int().nonnegative(),
  })
  .strict();
export type DiagramComparisonRecord = z.infer<typeof diagramComparisonSchema>;

export const synchronizationStatusSchema = z.enum([
  "pending",
  "documents-written",
  "generation-failed",
  "conflict",
  "failed",
  "completed",
]);
export type SynchronizationStatus = z.infer<typeof synchronizationStatusSchema>;

export const synchronizationResultSchema = z
  .object({
    operationId: z.string().min(1),
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
    /** Workspace identity and complete inventory for the synchronization boundary. */
    workspace: workspaceIdentitySchema.optional(),
    inventoryBefore: projectInventorySchema.optional(),
    inventoryFinal: projectInventorySchema.optional(),
    expectedParentVersionId: z.string().min(1).nullable(),
    configurationRevision: z.number().int().nonnegative(),
    status: synchronizationStatusSchema,
    startedAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    documents: z.array(documentSyncResultSchema),
    sourceBefore: z.array(sourceIdentitySchema),
    sourceFinal: z.array(sourceIdentitySchema),
    lens: z
      .object({
        versionId: z.string().min(1),
        versionNumber: z.number().int().nonnegative(),
        parentVersionId: z.string().min(1).nullable(),
      })
      .strict()
      .nullable(),
    comparison: lensComparisonSummarySchema.nullable(),
    unresolvedItems: z.array(z.string().min(1).max(1000)),
    error: z.string().nullable(),
    retryable: z.boolean(),
  })
  .strict();
export type SynchronizationResult = z.infer<typeof synchronizationResultSchema>;

export const synchronizationScopeSchema = z
  .object({
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
  })
  .strict();
export type SynchronizationScope = z.infer<typeof synchronizationScopeSchema>;

export function emptyLensGraph(): LensGraph {
  return { components: [], connections: [] };
}
