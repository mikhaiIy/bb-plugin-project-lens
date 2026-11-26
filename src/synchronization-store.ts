import type Database from "better-sqlite3";
import {
  synchronizationResultSchema,
  synchronizationScopeSchema,
  type SynchronizationResult,
  type SynchronizationScope,
} from "./model.js";

export class SynchronizationStorageError extends Error {
  readonly code = "synchronization-storage" as const;

  constructor(message: string) {
    super(message);
    this.name = "SynchronizationStorageError";
  }
}

export interface SynchronizationRepository {
  create(result: SynchronizationResult): Promise<void>;
  update(result: SynchronizationResult): Promise<void>;
  get(operationId: string, scope: SynchronizationScope): Promise<SynchronizationResult | null>;
  latest(scope: SynchronizationScope): Promise<SynchronizationResult | null>;
  getSync(operationId: string, scope: SynchronizationScope): SynchronizationResult | null;
  latestSync(scope: SynchronizationScope): SynchronizationResult | null;
}

type SyncRow = {
  operation_id: string;
  project_id: string;
  environment_id: string;
  host_id: string;
  root_path: string;
  status: string;
  created_at: number;
  updated_at: number;
  payload_json: string;
};

export const SYNCHRONIZATION_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS lens_sync_operations (
     operation_id TEXT PRIMARY KEY NOT NULL,
     project_id TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     host_id TEXT NOT NULL,
     root_path TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL CHECK (created_at >= 0),
     updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
     payload_json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS lens_sync_scope_idx
     ON lens_sync_operations(project_id, environment_id, updated_at)`,
] as const;

function scopeOf(value: SynchronizationScope): SynchronizationScope {
  return synchronizationScopeSchema.parse(value);
}

function parseRow(row: SyncRow): SynchronizationResult {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch (error) {
    throw new SynchronizationStorageError(
      `Synchronization ${row.operation_id} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const result = synchronizationResultSchema.parse(payload);
    if (
      result.operationId !== row.operation_id ||
      result.projectId !== row.project_id ||
      result.environmentId !== row.environment_id ||
      result.status !== row.status ||
      result.startedAt !== row.created_at ||
      result.updatedAt !== row.updated_at
    ) {
      throw new SynchronizationStorageError(`Synchronization ${row.operation_id} metadata does not match its index row`);
    }
    return result;
  } catch (error) {
    if (error instanceof SynchronizationStorageError) throw error;
    throw new SynchronizationStorageError(
      `Synchronization ${row.operation_id} failed validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function rowFor(db: Database.Database, operationId: string): SyncRow | undefined {
  return db
    .prepare(
      `SELECT operation_id, project_id, environment_id, host_id, root_path,
              status, created_at, updated_at, payload_json
       FROM lens_sync_operations WHERE operation_id = ?`,
    )
    .get(operationId) as SyncRow | undefined;
}

function belongs(result: SynchronizationResult, scope: SynchronizationScope): boolean {
  return result.projectId === scope.projectId && result.environmentId === scope.environmentId;
}

/** Durable, project/environment-guarded progress for builder-owned synchronization. */
export class SqliteSynchronizationRepository implements SynchronizationRepository {
  constructor(private readonly db: Database.Database) {}

  private parseScoped(operationId: string, scopeInput: SynchronizationScope): SynchronizationResult | null {
    const scope = scopeOf(scopeInput);
    const row = rowFor(this.db, operationId);
    if (row === undefined) return null;
    const result = parseRow(row);
    if (!belongs(result, scope)) {
      throw new SynchronizationStorageError(
        `Synchronization ${operationId} does not belong to project ${scope.projectId} environment ${scope.environmentId}`,
      );
    }
    return result;
  }

  async create(resultInput: SynchronizationResult): Promise<void> {
    const result = synchronizationResultSchema.parse(resultInput);
    try {
      this.db
        .prepare(
          `INSERT INTO lens_sync_operations
             (operation_id, project_id, environment_id, host_id, root_path,
              status, created_at, updated_at, payload_json)
           VALUES (@operationId, @projectId, @environmentId, @hostId, @rootPath,
                   @status, @createdAt, @updatedAt, @payloadJson)`,
        )
        .run({
          operationId: result.operationId,
          projectId: result.projectId,
          environmentId: result.environmentId,
          // The result intentionally does not expose host/root; they are kept
          // in the index row for scope diagnostics and are not agent context.
          hostId: "captured",
          rootPath: "captured",
          status: result.status,
          createdAt: result.startedAt,
          updatedAt: result.updatedAt,
          payloadJson: JSON.stringify(result),
        });
    } catch (error) {
      throw new SynchronizationStorageError(
        `Unable to create synchronization ${result.operationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async update(resultInput: SynchronizationResult): Promise<void> {
    const result = synchronizationResultSchema.parse(resultInput);
    try {
      const outcome = this.db
        .prepare(
          `UPDATE lens_sync_operations
           SET status = @status, updated_at = @updatedAt, payload_json = @payloadJson
           WHERE operation_id = @operationId
             AND project_id = @projectId AND environment_id = @environmentId`,
        )
        .run({
          operationId: result.operationId,
          projectId: result.projectId,
          environmentId: result.environmentId,
          status: result.status,
          updatedAt: result.updatedAt,
          payloadJson: JSON.stringify(result),
        });
      if (outcome.changes !== 1) {
        throw new SynchronizationStorageError(`Synchronization ${result.operationId} was not found in its project scope`);
      }
    } catch (error) {
      if (error instanceof SynchronizationStorageError) throw error;
      throw new SynchronizationStorageError(
        `Unable to update synchronization ${result.operationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async get(operationId: string, scope: SynchronizationScope): Promise<SynchronizationResult | null> {
    return this.getSync(operationId, scope);
  }

  getSync(operationId: string, scope: SynchronizationScope): SynchronizationResult | null {
    if (typeof operationId !== "string" || operationId.trim() === "") return null;
    return this.parseScoped(operationId, scope);
  }

  async latest(scopeInput: SynchronizationScope): Promise<SynchronizationResult | null> {
    return this.latestSync(scopeInput);
  }

  latestSync(scopeInput: SynchronizationScope): SynchronizationResult | null {
    const scope = scopeOf(scopeInput);
    const row = this.db
      .prepare(
        `SELECT operation_id, project_id, environment_id, host_id, root_path,
                status, created_at, updated_at, payload_json
         FROM lens_sync_operations
         WHERE project_id = ? AND environment_id = ?
         ORDER BY updated_at DESC, operation_id DESC
         LIMIT 1`,
      )
      .get(scope.projectId, scope.environmentId) as SyncRow | undefined;
    return row === undefined ? null : parseRow(row);
  }
}

