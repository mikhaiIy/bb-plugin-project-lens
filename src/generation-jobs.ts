import { randomUUID } from "node:crypto";
import type { AnalysisCleanup, AnalysisJobResult, AnalysisProgress, AnalysisPass } from "./project-analysis.js";
import type { LensVersion, SourceCapture } from "./model.js";
import type { SourceBoundaryExpectation } from "./source-boundary.js";

export interface GenerationJobInput {
  projectId: string;
  environmentId: string;
  expectedParentVersionId: string | null;
  providerId?: string;
  model?: string;
  /** Boundary captured after Markdown CAS and before generation began. */
  expectedBoundary?: SourceBoundaryExpectation;
}

export interface GenerationOutput {
  lens: LensVersion;
  capture: SourceCapture;
  job: AnalysisJobResult;
}

export type GenerationJobStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";

export interface GenerationAnalysisSummary {
  id: string;
  workerThreadId: string;
  providerId: string | null;
  status: "completed" | "failed" | "cancelled";
  cleanup: AnalysisCleanup;
  passes?: AnalysisPass[];
}

export interface GenerationJobView {
  operationId: string;
  projectId: string;
  environmentId: string;
  expectedParentVersionId: string | null;
  status: GenerationJobStatus;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  result: {
    lensId: string;
    versionNumber: number;
    parentVersionId: string | null;
  } | null;
  analysis: GenerationAnalysisSummary | null;
  progress: AnalysisProgress | null;
  error: string | null;
}

export class GenerationJobError extends Error {
  readonly job: GenerationAnalysisSummary | null;

  constructor(message: string, job: GenerationAnalysisSummary | null = null) {
    super(message);
    this.name = "GenerationJobError";
    this.job = job;
  }
}

type RunGeneration = (input: GenerationJobInput & { signal: AbortSignal; onProgress: (progress: AnalysisProgress) => void }) => Promise<GenerationOutput>;
type ReconcileAnalysis = (analysisJobId: string) => Promise<AnalysisCleanup | null>;

interface GenerationJobRecord {
  operationId: string;
  input: GenerationJobInput;
  controller: AbortController;
  createdAt: number;
  updatedAt: number;
  status: GenerationJobStatus;
  cancelRequested: boolean;
  result: GenerationOutput | null;
  analysis: GenerationAnalysisSummary | null;
  progress: AnalysisProgress | null;
  error: string | null;
  completion: Promise<GenerationOutput>;
  resolve: (output: GenerationOutput) => void;
  reject: (error: unknown) => void;
}

const MAX_ACTIVE_JOBS = 8;
const MAX_RETAINED_JOBS = 64;

function bounded(value: string, max = 500): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
  );
}

function analysisFromUnknown(error: unknown): GenerationAnalysisSummary | null {
  if (typeof error !== "object" || error === null || !("job" in error)) return null;
  const job = (error as { job?: unknown }).job;
  if (typeof job !== "object" || job === null) return null;
  const value = job as Partial<GenerationAnalysisSummary>;
  if (
    typeof value.id !== "string" ||
    typeof value.workerThreadId !== "string" ||
    (value.providerId !== null && typeof value.providerId !== "string") ||
    (value.status !== "failed" && value.status !== "cancelled") ||
    typeof value.cleanup !== "object" ||
    value.cleanup === null
  ) {
    return null;
  }
  return {
    id: value.id,
    workerThreadId: value.workerThreadId,
    providerId: value.providerId,
    status: value.status,
    cleanup: value.cleanup as AnalysisCleanup,
    ...(value.passes === undefined ? {} : {passes:value.passes}),
  };
}

function linkSignal(parent: AbortSignal | undefined, controller: AbortController): () => void {
  if (parent === undefined) return () => undefined;
  if (parent.aborted) {
    controller.abort();
    return () => undefined;
  }
  const onAbort = () => controller.abort();
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

/** Owns cancellable whole-project operations and retains only bounded summaries. */
export class GenerationJobCoordinator {
  private readonly records = new Map<string, GenerationJobRecord>();

  constructor(
    private readonly runGeneration: RunGeneration,
    private readonly reconcileAnalysis: ReconcileAnalysis,
  ) {}

  private activeCount(): number {
    return [...this.records.values()].filter(
      (record) =>
        record.status === "queued" || record.status === "running" || record.status === "cancelling",
    ).length;
  }

  private prune(): void {
    while (this.records.size > MAX_RETAINED_JOBS) {
      const terminal = [...this.records.values()]
        .filter((record) =>
          record.status === "completed" || record.status === "failed" || record.status === "cancelled",
        )
        .sort((left, right) => left.updatedAt - right.updatedAt)[0];
      if (terminal === undefined) return;
      this.records.delete(terminal.operationId);
    }
  }

  private view(record: GenerationJobRecord): GenerationJobView {
    return {
      operationId: record.operationId,
      projectId: record.input.projectId,
      environmentId: record.input.environmentId,
      expectedParentVersionId: record.input.expectedParentVersionId,
      status: record.status,
      cancelRequested: record.cancelRequested,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      result:
        record.result === null
          ? null
          : {
              lensId: record.result.lens.id,
              versionNumber: record.result.lens.versionNumber,
              parentVersionId: record.result.lens.parentVersionId,
            },
      analysis: record.analysis,
      progress: record.progress,
      error: record.error,
    };
  }

  start(input: GenerationJobInput, parentSignal?: AbortSignal): GenerationJobView {
    if (this.activeCount() >= MAX_ACTIVE_JOBS) {
      throw new GenerationJobError(`At most ${MAX_ACTIVE_JOBS} Project Lens generations may run at once`);
    }
    const operationId = `generation:${randomUUID()}`;
    const controller = new AbortController();
    const createdAt = Date.now();
    let resolve!: (output: GenerationOutput) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<GenerationOutput>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // A start RPC deliberately returns before completion. Mark the shared
    // promise as handled so a cancelled/failed background job does not become
    // an unhandled process rejection; callers of wait() still observe it.
    void completion.catch(() => undefined);
    const record: GenerationJobRecord = {
      operationId,
      input: { ...input },
      controller,
      createdAt,
      updatedAt: createdAt,
      status: "queued",
      cancelRequested: false,
      result: null,
      analysis: null,
      progress: null,
      error: null,
      completion,
      resolve,
      reject,
    };
    this.records.set(operationId, record);
    this.prune();
    const unlink = linkSignal(parentSignal, controller);
    void this.execute(record, unlink);
    return this.view(record);
  }

  private async execute(record: GenerationJobRecord, unlink: () => void): Promise<void> {
    record.status = "running";
    record.updatedAt = Date.now();
    try {
      const output = await this.runGeneration({ ...record.input, signal: record.controller.signal, onProgress:progress => {record.progress=progress;record.updatedAt=Date.now();} });
      if (record.controller.signal.aborted) {
        throw new DOMException("Generation cancelled", "AbortError");
      }
      record.result = output;
      record.analysis = output.job;
      record.status = "completed";
      record.updatedAt = Date.now();
      record.resolve(output);
    } catch (error) {
      const analysis = analysisFromUnknown(error);
      record.analysis = analysis;
      record.error = bounded(error instanceof Error ? error.message : String(error));
      record.status = record.controller.signal.aborted || isAbortError(error) ? "cancelled" : "failed";
      record.updatedAt = Date.now();
      record.reject(error);
    } finally {
      unlink();
      this.prune();
    }
  }

  async wait(operationId: string): Promise<GenerationOutput> {
    const record = this.records.get(operationId);
    if (record === undefined) throw new GenerationJobError(`Generation operation ${operationId} was not found`);
    return record.completion;
  }

  status(operationId: string, projectId: string, environmentId: string): GenerationJobView {
    const record = this.records.get(operationId);
    if (record === undefined) throw new GenerationJobError(`Generation operation ${operationId} was not found`);
    if (record.input.projectId !== projectId || record.input.environmentId !== environmentId) {
      throw new GenerationJobError(`Generation operation ${operationId} does not belong to this project environment`);
    }
    return this.view(record);
  }

  cancel(operationId: string, projectId: string, environmentId: string): GenerationJobView {
    const record = this.records.get(operationId);
    if (record === undefined) throw new GenerationJobError(`Generation operation ${operationId} was not found`);
    if (record.input.projectId !== projectId || record.input.environmentId !== environmentId) {
      throw new GenerationJobError(`Generation operation ${operationId} does not belong to this project environment`);
    }
    if (record.status === "queued" || record.status === "running") {
      record.cancelRequested = true;
      record.status = "cancelling";
      record.updatedAt = Date.now();
      record.controller.abort();
    }
    return this.view(record);
  }

  async reconcile(operationId: string, projectId: string, environmentId: string): Promise<GenerationJobView> {
    const record = this.records.get(operationId);
    if (record === undefined) throw new GenerationJobError(`Generation operation ${operationId} was not found`);
    if (record.input.projectId !== projectId || record.input.environmentId !== environmentId) {
      throw new GenerationJobError(`Generation operation ${operationId} does not belong to this project environment`);
    }
    if (record.analysis === null) return this.view(record);
    const cleanup = await this.reconcileAnalysis(record.analysis.id);
    if (cleanup !== null) {
      record.analysis = { ...record.analysis, cleanup };
      record.updatedAt = Date.now();
    }
    return this.view(record);
  }

  runAndWait(input: GenerationJobInput, parentSignal?: AbortSignal): Promise<GenerationOutput> {
    const started = this.start(input, parentSignal);
    return this.wait(started.operationId);
  }

  dispose(): void {
    for (const record of this.records.values()) {
      if (record.status === "queued" || record.status === "running" || record.status === "cancelling") {
        record.cancelRequested = true;
        record.status = "cancelling";
        record.controller.abort();
      }
    }
  }
}
