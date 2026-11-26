import { createHash } from "node:crypto";
import { z } from "zod";
import {
  documentDiffSchema,
  sourceIdentitySchema,
  type CapturedSource,
  type DocumentDiff,
  type DocumentDiffSection,
  type DocumentSection,
  type DocumentSetting,
  type LensComparisonSummary,
  type LensVersion,
  type SourceCapture,
  type SourceIdentity,
} from "./model.js";
import type { DiagramComparison } from "./diagram.js";
import { extractDocumentSections } from "./source-capture.js";

export const MAX_MARKDOWN_EDIT_BYTES = 4 * 1024 * 1024;

export const affectedSectionSchema = z
  .object({
    anchor: z.string().min(1).max(240),
    reason: z.string().min(1).max(1000),
  })
  .strict();
export type AffectedSection = z.infer<typeof affectedSectionSchema>;

/** A builder supplies the final document bytes; the plugin applies them with CAS. */
export const documentEditSchema = z
  .object({
    path: z.string().min(1).max(4096),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
    content: z.string().max(MAX_MARKDOWN_EDIT_BYTES),
    affectedSections: z.array(affectedSectionSchema).min(1).max(64),
    reason: z.string().min(1).max(1000),
  })
  .strict();
export type DocumentEdit = z.infer<typeof documentEditSchema>;

export const noChangeFindingSchema = z
  .object({
    path: z.string().min(1).max(4096),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
    checkedSections: z.array(z.string().min(1).max(240)).min(1).max(64),
    reason: z.string().min(1).max(1000),
  })
  .strict();
export type NoChangeFinding = z.infer<typeof noChangeFindingSchema>;

export const sourceIdentityListSchema = z.array(sourceIdentitySchema).max(4096);

export interface DocumentDiffInput {
  baseline: LensVersion | null;
  current: LensVersion;
  settings: readonly DocumentSetting[];
}

export interface FocusedDocumentEditResult {
  changed: boolean;
  changedSections: string[];
}

export class DocumentMaintenanceError extends Error {
  readonly code = "document-maintenance" as const;

  constructor(message: string) {
    super(message);
    this.name = "DocumentMaintenanceError";
  }
}

export class DocumentConcurrencyError extends Error {
  readonly code = "document-concurrency" as const;

  constructor(message: string) {
    super(message);
    this.name = "DocumentConcurrencyError";
  }
}

export function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function sourceIdentities(capture: SourceCapture): SourceIdentity[] {
  return capture.sources.map((source) => ({
    path: source.path,
    kind: source.kind,
    sha256: source.sha256,
    sizeBytes: source.sizeBytes,
  }));
}

export function decodeCapturedSource(source: Pick<CapturedSource, "bytesBase64" | "path">): string {
  const bytes = Buffer.from(source.bytesBase64, "base64");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DocumentMaintenanceError(`Captured Markdown ${source.path} is not valid UTF-8`);
  }
}

function lines(text: string): string[] {
  if (text === "") return [];
  const result = text.split(/\r\n|\n|\r/);
  if (result.at(-1) === "") result.pop();
  return result;
}

interface LineSpan {
  start: number;
  contentEnd: number;
  end: number;
}

/** Return raw string offsets without normalizing CRLF, LF, or CR. */
function lineSpans(text: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character !== "\r" && character !== "\n") {
      index += 1;
      continue;
    }
    const newlineLength = character === "\r" && text[index + 1] === "\n" ? 2 : 1;
    spans.push({ start, contentEnd: index, end: index + newlineLength });
    start = index + newlineLength;
    index = start;
  }
  if (start < text.length) spans.push({ start, contentEnd: text.length, end: text.length });
  return spans;
}

function sectionRange(
  text: string,
  section: DocumentSection,
): { start: number; end: number } | null {
  const spans = lineSpans(text);
  const start = spans[section.startLine - 1]?.start;
  const end = spans[section.endLine - 1]?.end;
  return start === undefined || end === undefined ? null : { start, end };
}

function mergedSectionRanges(
  text: string,
  sections: readonly DocumentSection[],
  anchors: ReadonlySet<string>,
): Array<{ start: number; end: number }> {
  const ranges = sections
    .filter((section) => anchors.has(section.anchor))
    .map((section) => sectionRange(text, section))
    .filter((range): range is { start: number; end: number } => range !== null)
    .sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const prior = merged.at(-1);
    if (prior !== undefined && range.start <= prior.end) {
      prior.end = Math.max(prior.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function outsideBytes(text: string, ranges: readonly { start: number; end: number }[]): Buffer {
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) chunks.push(Buffer.from(text.slice(cursor, range.start), "utf8"));
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < text.length) chunks.push(Buffer.from(text.slice(cursor), "utf8"));
  return Buffer.concat(chunks);
}

function outsideBytesEqual(
  beforeText: string,
  afterText: string,
  beforeSections: readonly DocumentSection[],
  afterSections: readonly DocumentSection[],
  anchors: ReadonlySet<string>,
): boolean {
  return outsideBytes(
    beforeText,
    mergedSectionRanges(beforeText, beforeSections, anchors),
  ).equals(
    outsideBytes(afterText, mergedSectionRanges(afterText, afterSections, anchors)),
  );
}

function sectionMap(text: string, path: string, sourceId: string, sha256: string): Map<string, DocumentSection> {
  return new Map(extractDocumentSections(path, text, sourceId, sha256).map((section) => [section.anchor, section]));
}

/**
 * Check that a builder's full final document changed only the named current
 * Markdown sections. Bytes outside the named ranges are compared without
 * changing line endings or final-newline state, so future plans, history and
 * unrelated sections remain builder-owned.
 */
export function validateFocusedDocumentEdit(
  path: string,
  beforeText: string,
  afterText: string,
  beforeSections: readonly DocumentSection[],
  affectedSections: readonly AffectedSection[],
): FocusedDocumentEditResult {
  const anchors = new Set(affectedSections.map((section) => section.anchor));
  if (anchors.size === 0) throw new DocumentMaintenanceError(`Document edit ${path} must name an affected section`);
  const afterSha256 = sha256Text(afterText);
  const afterSectionMap = sectionMap(path === "" ? "" : afterText, path, `pending:${path}`, afterSha256);
  for (const anchor of anchors) {
    if (!beforeSections.some((section) => section.anchor === anchor)) {
      throw new DocumentMaintenanceError(`Document edit ${path} names missing section #${anchor}`);
    }
    if (!afterSectionMap.has(anchor)) {
      throw new DocumentMaintenanceError(`Document edit ${path} removed named section #${anchor}`);
    }
  }
  if (!outsideBytesEqual(beforeText, afterText, beforeSections, [...afterSectionMap.values()], anchors)) {
    throw new DocumentMaintenanceError(
      `Document edit ${path} changes content outside the affected Markdown sections`,
    );
  }
  const changedSections = affectedSections
    .filter((section) => {
      const before = beforeSections.find((candidate) => candidate.anchor === section.anchor);
      const after = afterSectionMap.get(section.anchor);
      if (before === undefined || after === undefined) return true;
      const beforeSlice = sectionRange(beforeText, before);
      const afterSlice = sectionRange(afterText, after);
      const beforeValue = beforeSlice === null ? null : beforeText.slice(beforeSlice.start, beforeSlice.end);
      const afterValue = afterSlice === null ? null : afterText.slice(afterSlice.start, afterSlice.end);
      return beforeValue !== afterValue;
    })
    .map((section) => section.anchor);
  return {
    changed: sha256Text(beforeText) !== afterSha256,
    changedSections: changedSections.length > 0 ? changedSections : [...anchors],
  };
}

function lineDelta(before: string, after: string): { addedLines: number; removedLines: number } {
  const beforeLines = lines(before);
  const afterLines = lines(after);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1;
  return {
    addedLines: Math.max(0, afterLines.length - prefix - suffix),
    removedLines: Math.max(0, beforeLines.length - prefix - suffix),
  };
}

function sourceMap(version: LensVersion | null): Map<string, CapturedSource> {
  return new Map((version?.sources ?? []).filter((source) => source.kind === "markdown").map((source) => [source.path, source]));
}

function sectionMapForVersion(version: LensVersion | null, path: string): Map<string, DocumentSection> {
  return new Map((version?.documentSections ?? []).filter((section) => section.path === path).map((section) => [section.anchor, section]));
}

function sectionText(text: string, section: DocumentSection | undefined): string | null {
  if (section === undefined) return null;
  const range = sectionRange(text, section);
  return range === null ? null : text.slice(range.start, range.end);
}

const MAX_DIFF_SIDE_BYTES = 128 * 1024;

function boundedDiffSide(value: string | null): { value: string | null; truncated: boolean } {
  if (value === null || Buffer.byteLength(value, "utf8") <= MAX_DIFF_SIDE_BYTES) {
    return { value, truncated: false };
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= MAX_DIFF_SIDE_BYTES) low = middle;
    else high = middle - 1;
  }
  return { value: value.slice(0, low), truncated: true };
}

function diffSection(
  anchor: string,
  beforeText: string | null,
  afterText: string | null,
): DocumentDiffSection {
  const before = boundedDiffSide(beforeText);
  const after = boundedDiffSide(afterText);
  return {
    anchor,
    beforeText: before.value,
    afterText: after.value,
    beforeTruncated: before.truncated,
    afterTruncated: after.truncated,
  };
}

function maintenanceFor(path: string, settings: readonly DocumentSetting[]): DocumentSetting["maintenance"] | null {
  return settings.find((document) => document.path === path)?.maintenance ?? null;
}

/** Compare captured Markdown bytes and section identities without reading live files. */
export function compareDocumentSources(input: DocumentDiffInput): DocumentDiff[] {
  const baselineSources = sourceMap(input.baseline);
  const currentSources = sourceMap(input.current);
  const paths = [...new Set([...baselineSources.keys(), ...currentSources.keys()])].sort();
  return paths.map((path) => {
    const baseline = baselineSources.get(path);
    const current = currentSources.get(path);
    const status: DocumentDiff["status"] =
      baseline === undefined ? "added" : current === undefined ? "removed" : baseline.sha256 === current.sha256 ? "unchanged" : "changed";
    const changedSections = new Set<string>();
    const baselineSections = sectionMapForVersion(input.baseline, path);
    const currentSections = sectionMapForVersion(input.current, path);
    const baselineText = baseline === undefined ? "" : decodeCapturedSource(baseline);
    const currentText = current === undefined ? "" : decodeCapturedSource(current);
    for (const anchor of new Set([...baselineSections.keys(), ...currentSections.keys()])) {
      if (sectionText(baselineText, baselineSections.get(anchor)) !== sectionText(currentText, currentSections.get(anchor))) {
        changedSections.add(anchor);
      }
    }
    const changedSectionNames = [...changedSections];
    const filteredChangedSections = changedSectionNames.filter((anchor) => {
      const section = currentSections.get(anchor) ?? baselineSections.get(anchor);
      if (section === undefined) return true;
      return !changedSectionNames.some((candidate) => {
        if (candidate === anchor) return false;
        const child = currentSections.get(candidate) ?? baselineSections.get(candidate);
        return child !== undefined && child.startLine > section.startLine && child.endLine <= section.endLine;
      });
    });
    const beforeText = baselineText;
    const afterText = currentText;
    const delta = lineDelta(beforeText, afterText);
    const sectionAnchors = status === "unchanged"
      ? []
      : status === "added" || status === "removed"
        ? ["document"]
        : filteredChangedSections.length > 0
          ? filteredChangedSections.sort()
          : ["document"];
    const sections = sectionAnchors.map((anchor) =>
      anchor === "document"
        ? diffSection(
            anchor,
            baseline === undefined ? null : beforeText,
            current === undefined ? null : afterText,
          )
        : diffSection(
            anchor,
            sectionText(beforeText, baselineSections.get(anchor)),
            sectionText(afterText, currentSections.get(anchor)),
          ),
    );
    return documentDiffSchema.parse({
      path,
      status,
      baselineVersionId: input.baseline?.id ?? null,
      currentVersionId: input.current.id,
      baselineSha256: baseline?.sha256 ?? null,
      currentSha256: current?.sha256 ?? null,
      changedSections: filteredChangedSections.sort(),
      sections,
      addedLines: delta.addedLines,
      removedLines: delta.removedLines,
      maintenance: maintenanceFor(path, input.settings),
    });
  });
}

export function summarizeComparison(comparison: DiagramComparison): LensComparisonSummary {
  const count = (items: readonly { change: string }[], change: string) => items.filter((item) => item.change === change).length;
  return {
    currentVersionId: comparison.currentVersionId,
    baselineVersionId: comparison.baselineVersionId,
    addedComponents: count(comparison.components, "added"),
    changedComponents: count(comparison.components, "changed"),
    removedComponents: count(comparison.components, "removed"),
    addedConnections: count(comparison.connections, "added"),
    changedConnections: count(comparison.connections, "changed"),
    removedConnections: count(comparison.connections, "removed"),
    sourceOnlyChanges: comparison.sourceOnlyChanges,
    explanationOnlyChanges: comparison.explanationOnlyChanges,
    architectureChanges: comparison.architectureChanges,
    uncertainty: comparison.uncertainty.slice(0, 32),
  };
}
