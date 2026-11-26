import type Database from "better-sqlite3";
import {
  lensVersionSchema,
  lensHistoryScopeSchema,
  workspaceIdentitySchema,
  type LensCandidate,
  type LensHistoryScope,
  type LensVersion,
  type WorkspaceIdentity,
} from "./model.js";
import { SYNCHRONIZATION_MIGRATIONS } from "./synchronization-store.js";

/** Append-only migrations; append new statements rather than editing old ones. */
export const FOUNDATION_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS project_lens_settings (
     project_id TEXT PRIMARY KEY NOT NULL,
     enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
     documents_json TEXT NOT NULL,
     revision INTEGER NOT NULL CHECK (revision >= 0),
     updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
   )`,
  `CREATE TABLE IF NOT EXISTS lens_versions (
     version_id TEXT PRIMARY KEY NOT NULL,
     version_number INTEGER NOT NULL CHECK (version_number >= 0),
     project_id TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     host_id TEXT NOT NULL,
     root_path TEXT NOT NULL,
     parent_version_id TEXT,
     created_at INTEGER NOT NULL CHECK (created_at >= 0),
     payload_json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS lens_versions_target_idx
     ON lens_versions(project_id, environment_id, host_id, root_path, version_number)`,
  `CREATE TABLE IF NOT EXISTS lens_heads (
     project_id TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     host_id TEXT NOT NULL,
     root_path TEXT NOT NULL,
     current_version_id TEXT NOT NULL,
     PRIMARY KEY (project_id, environment_id, host_id, root_path)
   )`,
  `CREATE TRIGGER IF NOT EXISTS lens_versions_immutable_update
     BEFORE UPDATE ON lens_versions
     BEGIN
       SELECT RAISE(ABORT, 'lens versions are immutable');
     END`,
  `CREATE TRIGGER IF NOT EXISTS lens_versions_immutable_delete
     BEFORE DELETE ON lens_versions
     BEGIN
       SELECT RAISE(ABORT, 'lens versions are immutable');
     END`,
  ...SYNCHRONIZATION_MIGRATIONS,
] as const;

/** Useful for pure repository tests; the BB host uses bb.storage.migrate instead. */
export function initializeFoundationDatabase(db: Database.Database): void {
  for (const statement of FOUNDATION_MIGRATIONS) db.exec(statement);
}

export class LensStorageError extends Error {
  readonly code: "lens-storage" | "lens-head-conflict" = "lens-storage";

  constructor(message: string) {
    super(message);
    this.name = "LensStorageError";
  }
}

export class LensHeadConflictError extends LensStorageError {
  readonly code = "lens-head-conflict" as const;

  constructor(target: WorkspaceIdentity, expectedParentVersionId: string | null) {
    super(
      `Lens head changed for project ${target.projectId}, environment ${target.environmentId}, host ${target.hostId}; expected parent ${expectedParentVersionId ?? "none"}`,
    );
    this.name = "LensHeadConflictError";
  }
}

export interface LensRepository {
  publish(
    candidate: LensCandidate,
    expected: { parentVersionId: string | null },
  ): Promise<LensVersion>;
  current(target: WorkspaceIdentity): Promise<LensVersion | null>;
  get(versionId: string): Promise<LensVersion | null>;
  list(target: WorkspaceIdentity): Promise<LensVersion[]>;
  currentForEnvironment(scope: LensHistoryScope): Promise<LensVersion | null>;
  listForEnvironment(scope: LensHistoryScope): Promise<LensVersion[]>;
  listEnvironmentIds(projectId: string): Promise<string[]>;
  currentForEnvironmentSync(scope: LensHistoryScope): LensVersion | null;
}

type LensHeadRow = {
  project_id: string;
  environment_id: string;
  host_id: string;
  root_path: string;
  current_version_id: string;
};

type LensVersionRow = {
  version_id: string;
  version_number: number;
  project_id: string;
  environment_id: string;
  host_id: string;
  root_path: string;
  parent_version_id: string | null;
  created_at: number;
  payload_json: string;
};

function targetOf(value: Pick<WorkspaceIdentity, "projectId" | "environmentId" | "hostId" | "rootPath">): WorkspaceIdentity {
  return workspaceIdentitySchema.parse({
    projectId: value.projectId,
    environmentId: value.environmentId,
    hostId: value.hostId,
    rootPath: value.rootPath,
  });
}

function historyScopeOf(value: LensHistoryScope): LensHistoryScope {
  return lensHistoryScopeSchema.parse(value);
}

function targetMatches(row: LensVersionRow, target: WorkspaceIdentity): boolean {
  return (
    row.project_id === target.projectId &&
    row.environment_id === target.environmentId &&
    row.host_id === target.hostId &&
    row.root_path === target.rootPath
  );
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}

function parseRow(row: LensVersionRow): LensVersion {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch (error) {
    throw new LensStorageError(
      `Lens version ${row.version_id} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const version = lensVersionSchema.parse(payload);
    if (
      version.id !== row.version_id ||
      version.versionNumber !== row.version_number ||
      version.projectId !== row.project_id ||
      version.environmentId !== row.environment_id ||
      version.hostId !== row.host_id ||
      version.rootPath !== row.root_path ||
      version.parentVersionId !== row.parent_version_id ||
      version.createdAt !== row.created_at
    ) {
      throw new LensStorageError(`Lens version ${row.version_id} metadata does not match its index row`);
    }
    return freeze(version);
  } catch (error) {
    if (error instanceof LensStorageError) throw error;
    throw new LensStorageError(
      `Lens version ${row.version_id} failed validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function rowFor(db: Database.Database, versionId: string): LensVersionRow | undefined {
  return db
    .prepare(
      `SELECT version_id, version_number, project_id, environment_id, host_id,
              root_path, parent_version_id, created_at, payload_json
       FROM lens_versions WHERE version_id = ?`,
    )
    .get(versionId) as LensVersionRow | undefined;
}

/** SQLite-backed append-only Lens history with a guarded current pointer. */
export class SqliteLensRepository implements LensRepository {
  constructor(private readonly db: Database.Database) {}

  async publish(
    candidate: LensCandidate,
    expected: { parentVersionId: string | null },
  ): Promise<LensVersion> {
    const target = targetOf(candidate);
    if (candidate.parentVersionId !== expected.parentVersionId) {
      throw new LensHeadConflictError(target, expected.parentVersionId);
    }

    const publish = this.db.transaction(() => {
      const head = this.db
        .prepare(
          `SELECT project_id, environment_id, host_id, root_path, current_version_id
           FROM lens_heads
           WHERE project_id = ? AND environment_id = ? AND host_id = ? AND root_path = ?`,
        )
        .get(target.projectId, target.environmentId, target.hostId, target.rootPath) as
        | LensHeadRow
        | undefined;

      let versionNumber = 0;
      if (head === undefined) {
        if (expected.parentVersionId !== null) throw new LensHeadConflictError(target, expected.parentVersionId);
      } else {
        if (head.current_version_id !== expected.parentVersionId) {
          throw new LensHeadConflictError(target, expected.parentVersionId);
        }
        const parent = rowFor(this.db, expected.parentVersionId);
        if (parent === undefined || !targetMatches(parent, target)) {
          throw new LensHeadConflictError(target, expected.parentVersionId);
        }
        versionNumber = parent.version_number + 1;
      }

      const version = lensVersionSchema.parse({ ...candidate, versionNumber });
      this.db
        .prepare(
          `INSERT INTO lens_versions
             (version_id, version_number, project_id, environment_id, host_id,
              root_path, parent_version_id, created_at, payload_json)
           VALUES (@versionId, @versionNumber, @projectId, @environmentId, @hostId,
                   @rootPath, @parentVersionId, @createdAt, @payloadJson)`,
        )
        .run({
          versionId: version.id,
          versionNumber: version.versionNumber,
          projectId: version.projectId,
          environmentId: version.environmentId,
          hostId: version.hostId,
          rootPath: version.rootPath,
          parentVersionId: version.parentVersionId,
          createdAt: version.createdAt,
          payloadJson: JSON.stringify(version),
        });

      if (head === undefined) {
        this.db
          .prepare(
            `INSERT INTO lens_heads
               (project_id, environment_id, host_id, root_path, current_version_id)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(target.projectId, target.environmentId, target.hostId, target.rootPath, version.id);
      } else {
        const result = this.db
          .prepare(
            `UPDATE lens_heads SET current_version_id = ?
             WHERE project_id = ? AND environment_id = ? AND host_id = ? AND root_path = ?
               AND current_version_id = ?`,
          )
          .run(
            version.id,
            target.projectId,
            target.environmentId,
            target.hostId,
            target.rootPath,
            expected.parentVersionId,
          );
        if (result.changes !== 1) throw new LensHeadConflictError(target, expected.parentVersionId);
      }
      return version;
    });

    try {
      return freeze(publish());
    } catch (error) {
      if (error instanceof LensHeadConflictError || error instanceof LensStorageError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("UNIQUE") || message.includes("constraint")) {
        throw new LensHeadConflictError(target, expected.parentVersionId);
      }
      throw new LensStorageError(`Unable to publish Lens version: ${message}`);
    }
  }

  async current(targetInput: WorkspaceIdentity): Promise<LensVersion | null> {
    const target = targetOf(targetInput);
    const head = this.db
      .prepare(
        `SELECT project_id, environment_id, host_id, root_path, current_version_id
         FROM lens_heads
         WHERE project_id = ? AND environment_id = ? AND host_id = ? AND root_path = ?`,
      )
      .get(target.projectId, target.environmentId, target.hostId, target.rootPath) as LensHeadRow | undefined;
    if (head === undefined) return null;
    const row = rowFor(this.db, head.current_version_id);
    if (row === undefined || !targetMatches(row, target)) {
      throw new LensStorageError(`Lens head points to missing or foreign version ${head.current_version_id}`);
    }
    return parseRow(row);
  }

  async get(versionId: string): Promise<LensVersion | null> {
    if (typeof versionId !== "string" || versionId.trim() === "") return null;
    const row = rowFor(this.db, versionId);
    return row === undefined ? null : parseRow(row);
  }

  async list(targetInput: WorkspaceIdentity): Promise<LensVersion[]> {
    const target = targetOf(targetInput);
    const rows = this.db
      .prepare(
        `SELECT version_id, version_number, project_id, environment_id, host_id,
                root_path, parent_version_id, created_at, payload_json
         FROM lens_versions
         WHERE project_id = ? AND environment_id = ? AND host_id = ? AND root_path = ?
         ORDER BY version_number ASC`,
      )
      .all(target.projectId, target.environmentId, target.hostId, target.rootPath) as LensVersionRow[];
    return rows.map((row) => parseRow(row));
  }

  /**
   * Reopen the current stored history without resolving a live environment.
   * The query chooses the latest stored current head if an environment
   * identity has accumulated more than one host/root incarnation. Creation
   * time, not the version counter local to one root, determines recency; the
   * version ID makes equal timestamps deterministic. The returned record still
   * exposes the exact stored host and root identity.
   */
  async currentForEnvironment(scopeInput: LensHistoryScope): Promise<LensVersion | null> {
    return this.currentForEnvironmentSync(scopeInput);
  }

  currentForEnvironmentSync(scopeInput: LensHistoryScope): LensVersion | null {
    const scope = historyScopeOf(scopeInput);
    const row = this.db
      .prepare(
        `SELECT v.version_id, v.version_number, v.project_id, v.environment_id,
                v.host_id, v.root_path, v.parent_version_id, v.created_at, v.payload_json
         FROM lens_heads h
         INNER JOIN lens_versions v ON v.version_id = h.current_version_id
         WHERE h.project_id = ? AND h.environment_id = ?
           AND v.project_id = h.project_id
           AND v.environment_id = h.environment_id
           AND v.host_id = h.host_id
           AND v.root_path = h.root_path
         ORDER BY v.created_at DESC, v.version_id DESC
         LIMIT 1`,
      )
      .get(scope.projectId, scope.environmentId) as LensVersionRow | undefined;
    return row === undefined ? null : parseRow(row);
  }

  /** Reopen all stored versions for an environment without a live host. */
  async listForEnvironment(scopeInput: LensHistoryScope): Promise<LensVersion[]> {
    const scope = historyScopeOf(scopeInput);
    const rows = this.db
      .prepare(
        `SELECT version_id, version_number, project_id, environment_id, host_id,
                root_path, parent_version_id, created_at, payload_json
         FROM lens_versions
         WHERE project_id = ? AND environment_id = ?
         ORDER BY version_number ASC, created_at ASC, version_id ASC`,
      )
      .all(scope.projectId, scope.environmentId) as LensVersionRow[];
    return rows.map((row) => parseRow(row));
  }

  async listEnvironmentIds(projectId: string): Promise<string[]> {
    if (typeof projectId !== "string" || projectId.trim() === "") return [];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT environment_id
         FROM lens_versions
         WHERE project_id = ?
         ORDER BY environment_id ASC`,
      )
      .all(projectId) as Array<{ environment_id: string }>;
    return rows.map((row) => row.environment_id);
  }
}
