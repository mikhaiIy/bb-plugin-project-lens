import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  projectInventorySchema,
  type InventoryEntry,
  type ProjectInventory,
  type ProjectWorkspace,
} from "./model.js";
import { ProjectPathError, validateProjectRelativePath } from "./path-policy.js";

type BbSdk = BbPluginApi["sdk"];

export interface ProjectInventoryLimits {
  maxEntries: number;
}

export const DEFAULT_PROJECT_INVENTORY_LIMITS: Readonly<ProjectInventoryLimits> = {
  maxEntries: 2048,
};

export class ProjectInventoryError extends Error {
  readonly code = "project-inventory" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProjectInventoryError";
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
  );
}

const CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".kt",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);

function extension(path: string): string {
  const lastDot = path.lastIndexOf(".");
  return lastDot < 0 ? "" : path.slice(lastDot).toLowerCase();
}

export function inventoryKind(path: string): InventoryEntry["kind"] {
  if (extension(path) === ".md") return "markdown";
  if (CODE_EXTENSIONS.has(extension(path))) return "code";
  return "other";
}

function boundedReason(reason: string): string {
  return reason.length <= 500 ? reason : `${reason.slice(0, 497)}...`;
}

/**
 * Lists the selected workspace through BB's host file surface. The returned
 * path strings are evidence and are never resolved through the server's own
 * filesystem. The SDK contract returns paths relative to the requested
 * workspace root; an absolute or traversal result is retained as unresolved
 * rather than being rewritten into a different identity.
 */
export class SdkProjectInventoryCollector {
  constructor(
    private readonly sdk: BbSdk,
    private readonly limits: Readonly<ProjectInventoryLimits> = DEFAULT_PROJECT_INVENTORY_LIMITS,
  ) {}

  async collect(target: ProjectWorkspace, signal?: AbortSignal): Promise<ProjectInventory> {
    if (signal?.aborted) throw new DOMException("Inventory aborted", "AbortError");

    let result: Awaited<ReturnType<BbSdk["files"]["listPaths"]>>;
    try {
      result = await this.sdk.files.listPaths({
        hostId: target.hostId,
        path: target.rootPath,
        includeFiles: true,
        includeDirectories: false,
        limit: this.limits.maxEntries + 1,
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ProjectInventoryError(
        `Unable to inventory ${target.rootPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const rawEntries = result.paths.filter((entry) => entry.kind === "file");
    const truncated = result.truncated || rawEntries.length > this.limits.maxEntries;
    const retained = rawEntries.slice(0, this.limits.maxEntries);
    const collisionKeys = new Map<string, string[]>();
    const entries: InventoryEntry[] = [];

    for (const raw of retained) {
      const kind = inventoryKind(raw.path);
      if (kind === "other") {
        entries.push({
          path: raw.path,
          kind,
          status: "excluded",
          reason: "File type is outside the bounded source analysis set",
        });
        continue;
      }

      try {
        const validated = validateProjectRelativePath(raw.path, { markdown: kind === "markdown" });
        const prior = collisionKeys.get(validated.collisionKey) ?? [];
        const status = prior.length > 0 ? "unresolved" : "candidate";
        entries.push({
          path: validated.exact,
          kind,
          status,
          ...(prior.length > 0
            ? {
                reason: boundedReason(
                  `Potential path collision with earlier exact spelling(s): ${prior.join(", ")}`,
                ),
              }
            : {}),
        });
        collisionKeys.set(validated.collisionKey, [...prior, validated.exact]);
      } catch (error) {
        entries.push({
          path: raw.path.length > 0 ? raw.path : "<empty-inventory-path>",
          kind,
          status: "unresolved",
          reason: boundedReason(
            error instanceof ProjectPathError
              ? error.message
              : error instanceof Error
                ? error.message
                : String(error),
          ),
        });
      }
    }

    entries.sort((left, right) => left.path.localeCompare(right.path));
    const omittedCount = Math.max(
      0,
      rawEntries.length - retained.length,
      result.truncated ? 1 : 0,
    );
    return projectInventorySchema.parse({
      capturedAt: Date.now(),
      entries,
      totalDiscovered: entries.length + omittedCount,
      truncated,
      omittedCount,
    });
  }
}

export function analyzableCodePaths(inventory: ProjectInventory): string[] {
  return inventory.entries
    .filter((entry) => entry.kind === "code" && entry.status !== "unresolved")
    .map((entry) => entry.path);
}

export function inventoryUnknownAreas(inventory: ProjectInventory): string[] {
  const areas: string[] = [];
  if (inventory.truncated) {
    areas.push(`Project inventory was bounded; at least ${inventory.omittedCount} path(s) were omitted`);
  }
  for (const entry of inventory.entries) {
    if (entry.status === "unresolved") {
      areas.push(`${entry.path}: ${entry.reason ?? "path identity is unresolved"}`);
    }
  }
  return areas;
}
