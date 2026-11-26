import { randomUUID } from "node:crypto";
import {
  emptyLensGraph,
  type LensCandidate,
  type AnalysisCoverage,
  type LensGraph,
  type ProjectInventory,
  type ProjectLensSettings,
  type ProjectWorkspace,
  type SourceCapture,
} from "./model.js";

export interface CreateLensCandidateInput {
  target: ProjectWorkspace;
  settings: ProjectLensSettings;
  capture: SourceCapture;
  parentVersionId: string | null;
  analyzerRevision?: string;
  createdAt?: number;
  graph?: LensGraph;
  inventory?: ProjectInventory;
  identityWarnings?: readonly string[];
  analysisProviderId?: string | null;
  analysisCoverage?: AnalysisCoverage;
}

/** Build a publishable Lens candidate from captured and validated analysis data. */
export function createLensCandidate(input: CreateLensCandidateInput): LensCandidate {
  return {
    id: `lens_${randomUUID()}`,
    projectId: input.target.projectId,
    environmentId: input.target.environmentId,
    hostId: input.target.hostId,
    rootPath: input.target.rootPath,
    parentVersionId: input.parentVersionId,
    createdAt: input.createdAt ?? Date.now(),
    configurationRevision: input.settings.revision,
    documentSettings: input.settings.documents.map((document) => ({ ...document })),
    analyzerRevision: input.analyzerRevision ?? "foundation-empty@1",
    ...(input.analysisCoverage === undefined ? {} : {analysisCoverage:input.analysisCoverage}),
    sources: input.capture.sources.map((source) => ({ ...source })),
    documentSections: input.capture.documentSections.map((section) => ({ ...section })),
    graph: input.graph ?? emptyLensGraph(),
    coverage: {
      ...input.capture.coverage,
      scope: input.capture.coverage.scope,
    },
    ...(input.inventory === undefined ? {} : { inventory: input.inventory }),
    ...(input.identityWarnings === undefined
      ? {}
      : { identityWarnings: [...input.identityWarnings] }),
    ...(input.analysisProviderId === undefined
      ? {}
      : { analysisProviderId: input.analysisProviderId }),
  };
}
