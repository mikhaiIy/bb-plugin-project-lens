import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  capturedSourceSchema,
  documentSectionSchema,
  sourceCaptureSchema,
  type CapturedSource,
  type CoverageEntry,
  type DocumentSection,
  type DocumentSetting,
  type ProjectWorkspace,
  type SourceCapture,
  type SourceKind,
} from "./model.js";
import {
  isWithinRoot,
  validateProjectRelativePath,
  ProjectPathError,
  resolveWithinRoot,
} from "./path-policy.js";

type BbSdk = BbPluginApi["sdk"];

export interface SourceReaderInput {
  target: ProjectWorkspace;
  relativePath: string;
  absolutePath: string;
  signal?: AbortSignal;
}

export interface RawSourceRead {
  content: string;
  contentEncoding: "base64" | "utf8";
  sha256: string;
  sizeBytes: number;
  path?: string;
  mimeType?: string;
  modifiedAtMs?: number;
}

export interface SourceReader {
  read(input: SourceReaderInput): Promise<RawSourceRead>;
}

export interface SourceCollector {
  capture(
    target: ProjectWorkspace,
    documents: readonly DocumentSetting[],
    options?: SourceCaptureOptions,
  ): Promise<SourceCapture>;
}

/** Adapter that makes the explicit host/root boundary visible on every read. */
export class SdkSourceReader implements SourceReader {
  constructor(private readonly sdk: BbSdk) {}

  async read(input: SourceReaderInput): Promise<RawSourceRead> {
    const result = await this.sdk.files.read({
      hostId: input.target.hostId,
      path: input.absolutePath,
      rootPath: input.target.rootPath,
      signal: input.signal,
    });
    return {
      content: result.content,
      contentEncoding: result.contentEncoding,
      sha256: result.sha256,
      sizeBytes: result.sizeBytes,
      path: result.path,
      mimeType: result.mimeType,
      modifiedAtMs: result.modifiedAtMs,
    };
  }
}

export interface SourceCaptureOptions {
  codePaths?: readonly string[];
  signal?: AbortSignal;
  scope?: "configured-sources" | "whole-project";
  unknownAreas?: readonly string[];
}

export interface SourceCaptureLimits {
  /** Maximum number of requested paths considered in one retained capture. */
  maxRequestedSources: number;
  /** Maximum bytes retained for one captured source. */
  maxFileBytes: number;
  /** Maximum bytes retained across all successful sources in one capture. */
  maxRetainedBytes: number;
}

export const DEFAULT_SOURCE_CAPTURE_LIMITS: Readonly<SourceCaptureLimits> = {
  maxRequestedSources: 512,
  maxFileBytes: 4 * 1024 * 1024,
  maxRetainedBytes: 32 * 1024 * 1024,
};

export class SourceIntegrityError extends Error {
  readonly code = "source-integrity" as const;

  constructor(message: string) {
    super(message);
    this.name = "SourceIntegrityError";
  }
}

export class SourcePathEscapeError extends Error {
  readonly code = "source-path-escape" as const;

  constructor(message: string) {
    super(message);
    this.name = "SourcePathEscapeError";
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
  );
}

function classifyReaderError(error: unknown): "missing" | "unresolved" {
  // The public SDK does not currently expose a typed host confinement error.
  // Only standard filesystem codes carried on the error object are trusted;
  // filenames and prose are evidence, not security classifications.
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unresolved";
}

function pathErrorStatus(error: ProjectPathError): "unsupported" | "escaped" {
  return error.code === "absolute" || error.code === "traversal" || error.code === "backslash"
    ? "escaped"
    : "unsupported";
}

function coverageEntry(
  path: string,
  kind: SourceKind,
  status: CoverageEntry["status"],
  reason?: string,
  sourceId?: string,
): CoverageEntry {
  return {
    path: path.length === 0 ? "<empty>" : path,
    kind,
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(sourceId === undefined ? {} : { sourceId }),
  };
}

function decodeBytes(raw: RawSourceRead, path: string): Buffer {
  if (raw.contentEncoding === "utf8") {
    return Buffer.from(raw.content, "utf8");
  }
  if (
    raw.content.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.content)
  ) {
    throw new SourceIntegrityError(`Host returned invalid base64 for ${path}`);
  }
  const bytes = Buffer.from(raw.content, "base64");
  if (bytes.toString("base64") !== raw.content) {
    throw new SourceIntegrityError(`Host returned non-canonical base64 for ${path}`);
  }
  return bytes;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceId(kind: SourceKind, path: string, digest: string): string {
  return `source:${kind}:${path}:${digest}`;
}

function slugHeading(heading: string): string {
  const slug = heading
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[`*_~]/g, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "section" : slug;
}

export function extractDocumentSections(
  path: string,
  text: string,
  sourceIdValue: string,
  capturedSha256: string,
): DocumentSection[] {
  const lines = text.split(/\r\n|\n|\r/);
  const lineCount = /(?:\r\n|\n|\r)$/.test(text) ? lines.length - 1 : lines.length;
  const headings: Array<{ heading: string; level: number; startLine: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^( {0,3})(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(lines[index] ?? "");
    if (match === null) continue;
    const heading = match[3]?.trim();
    if (heading === undefined || heading === "") continue;
    headings.push({ heading, level: match[2]?.length ?? 1, startLine: index + 1 });
  }

  const usedAnchors = new Map<string, number>();
  return headings.map((heading, index) => {
    const baseAnchor = slugHeading(heading.heading);
    const occurrence = (usedAnchors.get(baseAnchor) ?? 0) + 1;
    usedAnchors.set(baseAnchor, occurrence);
    const anchor = occurrence === 1 ? baseAnchor : `${baseAnchor}-${occurrence}`;
    const nextBoundary = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    const endLine =
      nextBoundary === undefined ? Math.max(heading.startLine, lineCount) : nextBoundary.startLine - 1;
    return documentSectionSchema.parse({
      sourceId: sourceIdValue,
      path,
      anchor,
      heading: heading.heading,
      level: heading.level,
      startLine: heading.startLine,
      endLine,
      capturedSha256,
    });
  });
}

type RequestedSource = { path: string; kind: SourceKind };

type CapturedVariant = {
  requestedPath: string;
};

function collisionReason(priorVariants: readonly CapturedVariant[]): string {
  const priorPaths = priorVariants.map((variant) => variant.requestedPath).join(", ");
  const reason =
    `Potential path collision with earlier exact spelling(s): ${priorPaths}. ` +
    "The SDK's returned path string and digest do not verify filesystem identity";
  return reason.length <= 500 ? reason : `${reason.slice(0, 497)}...`;
}

function requestedSources(
  documents: readonly DocumentSetting[],
  codePaths: readonly string[],
): RequestedSource[] {
  return [
    ...documents.map((document) => ({ path: document.path, kind: "markdown" as const })),
    ...codePaths.map((path) => ({ path, kind: "code" as const })),
  ];
}

function addIssue(
  groups: Record<"excluded" | "unsupported" | "unresolved" | "missing" | "escaped", CoverageEntry[]>,
  entry: CoverageEntry,
): void {
  if (entry.status === "analyzed") return;
  groups[entry.status].push(entry);
}

/** Captures exact bytes and Markdown headings without making semantic claims. */
export class SdkSourceCollector implements SourceCollector {
  constructor(
    private readonly reader: SourceReader,
    private readonly limits: Readonly<SourceCaptureLimits> = DEFAULT_SOURCE_CAPTURE_LIMITS,
  ) {}

  async capture(
    target: ProjectWorkspace,
    documents: readonly DocumentSetting[],
    options: SourceCaptureOptions = {},
  ): Promise<SourceCapture> {
    const requests = requestedSources(documents, options.codePaths ?? []);
    const capturedSources: CapturedSource[] = [];
    const documentSections: DocumentSection[] = [];
    const analyzed: CoverageEntry[] = [];
    const groups: Record<"excluded" | "unsupported" | "unresolved" | "missing" | "escaped", CoverageEntry[]> = {
      excluded: [],
      unsupported: [],
      unresolved: [],
      missing: [],
      escaped: [],
    };
    const seenPaths = new Set<string>();
    const collisionVariants = new Map<string, CapturedVariant[]>();
    let retainedBytes = 0;

    for (const [requestIndex, request] of requests.entries()) {
      if (options.signal?.aborted) throw new DOMException("Capture aborted", "AbortError");
      if (requestIndex >= this.limits.maxRequestedSources) {
        addIssue(
          groups,
          coverageEntry(
            request.path,
            request.kind,
            "excluded",
            `Capture request limit (${this.limits.maxRequestedSources}) exceeded`,
          ),
        );
        continue;
      }
      let requestedPath: string;
      let collisionKey: string;
      try {
        const validated = validateProjectRelativePath(request.path, {
          markdown: request.kind === "markdown",
        });
        requestedPath = validated.exact;
        collisionKey = validated.collisionKey;
      } catch (error) {
        const status = error instanceof ProjectPathError ? pathErrorStatus(error) : "unsupported";
        addIssue(
          groups,
          coverageEntry(
            request.path,
            request.kind,
            status,
            error instanceof Error ? error.message : String(error),
          ),
        );
        continue;
      }
      if (seenPaths.has(requestedPath)) {
        addIssue(
          groups,
          coverageEntry(
            requestedPath,
            request.kind,
            "excluded",
            "Duplicate source request with the exact same spelling",
          ),
        );
        continue;
      }
      seenPaths.add(requestedPath);

      let absolutePath: string;
      try {
        absolutePath = resolveWithinRoot(target.rootPath, requestedPath);
      } catch (error) {
        addIssue(
          groups,
          coverageEntry(
            requestedPath,
            request.kind,
            "escaped",
            error instanceof Error ? error.message : String(error),
          ),
        );
        continue;
      }

      let raw: RawSourceRead;
      try {
        raw = await this.reader.read({
          target,
          relativePath: requestedPath,
          absolutePath,
          signal: options.signal,
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        const status = classifyReaderError(error);
        addIssue(
          groups,
          coverageEntry(
            requestedPath,
            request.kind,
            status,
            error instanceof Error ? error.message : String(error),
          ),
        );
        continue;
      }

      if (raw.path !== undefined && !isWithinRoot(target.rootPath, raw.path)) {
        addIssue(
          groups,
          coverageEntry(
            requestedPath,
            request.kind,
            "escaped",
            `Host resolved ${raw.path} outside ${target.rootPath}`,
          ),
        );
        continue;
      }

      let bytes: Buffer;
      let computedSha256: string;
      let documentText: string | undefined;
      try {
        if (raw.sizeBytes > this.limits.maxFileBytes) {
          throw new SourceIntegrityError(
            `Host size for ${requestedPath} exceeds the ${this.limits.maxFileBytes}-byte per-file retention limit`,
          );
        }
        const wireBytes =
          raw.contentEncoding === "utf8"
            ? Buffer.byteLength(raw.content, "utf8")
            : raw.content.length;
        const maxBase64Characters = Math.ceil(this.limits.maxFileBytes / 3) * 4;
        if (
          (raw.contentEncoding === "utf8" && wireBytes > this.limits.maxFileBytes) ||
          (raw.contentEncoding === "base64" && wireBytes > maxBase64Characters)
        ) {
          throw new SourceIntegrityError(
            `Host content for ${requestedPath} exceeds the ${this.limits.maxFileBytes}-byte per-file retention limit`,
          );
        }
        bytes = decodeBytes(raw, requestedPath);
        if (bytes.byteLength > this.limits.maxFileBytes) {
          throw new SourceIntegrityError(
            `Captured bytes for ${requestedPath} exceed the ${this.limits.maxFileBytes}-byte per-file retention limit`,
          );
        }
        computedSha256 = sha256(bytes);
        if (raw.sizeBytes !== bytes.byteLength) {
          throw new SourceIntegrityError(
            `Host size for ${requestedPath} was ${raw.sizeBytes}, captured ${bytes.byteLength}`,
          );
        }
        if (raw.sha256 !== computedSha256) {
          throw new SourceIntegrityError(
            `Host digest for ${requestedPath} did not match captured bytes`,
          );
        }
        if (retainedBytes + bytes.byteLength > this.limits.maxRetainedBytes) {
          throw new SourceIntegrityError(
            `Retained capture bytes would exceed the ${this.limits.maxRetainedBytes}-byte aggregate limit`,
          );
        }
        if (request.kind === "markdown") {
          try {
            documentText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw new SourceIntegrityError(`Markdown document ${requestedPath} is not valid UTF-8`);
          }
        }
      } catch (error) {
        if (!(error instanceof SourceIntegrityError)) throw error;
        addIssue(
          groups,
          coverageEntry(requestedPath, request.kind, "unsupported", error.message),
        );
        continue;
      }
      const id = sourceId(request.kind, requestedPath, computedSha256);
      let captured: CapturedSource;
      try {
        captured = capturedSourceSchema.parse({
          id,
          path: requestedPath,
          kind: request.kind,
          wireEncoding: raw.contentEncoding,
          sha256: computedSha256,
          sizeBytes: bytes.byteLength,
          bytesBase64: bytes.toString("base64"),
          mimeType: raw.mimeType ?? null,
          modifiedAtMs: raw.modifiedAtMs ?? null,
        });
      } catch (error) {
        addIssue(
          groups,
          coverageEntry(
            requestedPath,
            request.kind,
            "unsupported",
            `Host metadata for ${requestedPath} was invalid: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        continue;
      }
      // A collision key identifies only a possible spelling collision. The
      // public SDK returns a bare path string and a digest; neither proves
      // filesystem identity, so never merge or exclude a same-key variant on
      // either signal. Keep every successful exact spelling and make the
      // ambiguity visible in coverage.
      const priorVariants = collisionVariants.get(collisionKey) ?? [];
      if (priorVariants.length > 0) {
        addIssue(
          groups,
          coverageEntry(
            requestedPath,
            request.kind,
            "unresolved",
            collisionReason(priorVariants),
            id,
          ),
        );
      }
      capturedSources.push(captured);
      collisionVariants.set(collisionKey, [
        ...priorVariants,
        { requestedPath },
      ]);
      retainedBytes += bytes.byteLength;
      analyzed.push(coverageEntry(requestedPath, request.kind, "analyzed", undefined, id));
      if (documentText !== undefined) {
        documentSections.push(...extractDocumentSections(requestedPath, documentText, id, computedSha256));
      }
    }

    const coverage = {
      scope: options.scope ?? ("configured-sources" as const),
      totalRequested: requests.length,
      analyzed,
      ...groups,
      ...(options.unknownAreas === undefined || options.unknownAreas.length === 0
        ? {}
        : { unknownAreas: [...options.unknownAreas] }),
      complete:
        requests.length > 0 &&
        analyzed.length === seenPaths.size &&
        Object.values(groups).every((items) => items.length === 0) &&
        (options.unknownAreas?.length ?? 0) === 0,
    };
    return sourceCaptureSchema.parse({
      capturedAt: Date.now(),
      sources: capturedSources,
      documentSections,
      coverage,
    });
  }
}
