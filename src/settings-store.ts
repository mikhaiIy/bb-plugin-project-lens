import type Database from "better-sqlite3";
import {
  documentSettingSchema,
  projectLensSettingsSchema,
  type DocumentSetting,
  type ProjectLensSettings,
  type ProjectLensSettingsInput,
} from "./model.js";
import {
  validateProjectRelativePath,
  ProjectPathError,
} from "./path-policy.js";

export class ProjectSettingsError extends Error {
  readonly code:
    | "invalid-project-id"
    | "invalid-document"
    | "duplicate-document"
    | "revision-conflict"
    | "corrupt-settings";

  constructor(
    code: ProjectSettingsError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ProjectSettingsError";
    this.code = code;
  }
}

export interface ProjectSettingsRepository {
  get(projectId: string): Promise<ProjectLensSettings>;
  getSync(projectId: string): ProjectLensSettings;
  save(projectId: string, input: ProjectLensSettingsInput): Promise<ProjectLensSettings>;
}

function assertProjectId(projectId: string): void {
  if (typeof projectId !== "string" || projectId.trim() === "" || projectId !== projectId.trim()) {
    throw new ProjectSettingsError(
      "invalid-project-id",
      "A non-empty, trimmed BB project ID is required",
    );
  }
}

export function normalizeDocumentSetting(input: DocumentSetting): DocumentSetting {
  try {
    const parsed = documentSettingSchema.parse(input);
    const path = validateProjectRelativePath(parsed.path, { markdown: true }).exact;
    const purpose = parsed.purpose?.trim();
    return purpose === undefined || purpose === ""
      ? { path, maintenance: parsed.maintenance }
      : { path, purpose, maintenance: parsed.maintenance };
  } catch (error) {
    if (error instanceof ProjectPathError) {
      throw new ProjectSettingsError("invalid-document", error.message);
    }
    throw new ProjectSettingsError(
      "invalid-document",
      error instanceof Error ? error.message : "Invalid Markdown document setting",
    );
  }
}

export function normalizeDocumentSettings(
  documents: readonly DocumentSetting[],
): DocumentSetting[] {
  const normalized: DocumentSetting[] = [];
  const paths = new Set<string>();
  for (const document of documents) {
    const next = normalizeDocumentSetting(document);
    if (paths.has(next.path)) {
      throw new ProjectSettingsError(
        "duplicate-document",
        `Document is configured more than once: ${next.path}`,
      );
    }
    paths.add(next.path);
    normalized.push(next);
  }
  return normalized;
}

function defaultSettings(projectId: string): ProjectLensSettings {
  return {
    projectId,
    enabled: false,
    documents: [],
    revision: 0,
    updatedAt: 0,
  };
}

type SettingsRow = {
  project_id: string;
  enabled: number;
  documents_json: string;
  revision: number;
  updated_at: number;
};

/** Project-keyed settings; BB declarative settings intentionally do not own this state. */
export class SqliteProjectSettingsRepository implements ProjectSettingsRepository {
  constructor(private readonly db: Database.Database) {}

  getSync(projectId: string): ProjectLensSettings {
    assertProjectId(projectId);
    const row = this.db
      .prepare(
        `SELECT project_id, enabled, documents_json, revision, updated_at
         FROM project_lens_settings WHERE project_id = ?`,
      )
      .get(projectId) as SettingsRow | undefined;
    if (row === undefined) return defaultSettings(projectId);

    try {
      const documents = normalizeDocumentSettings(JSON.parse(row.documents_json) as DocumentSetting[]);
      return projectLensSettingsSchema.parse({
        projectId: row.project_id,
        enabled: row.enabled === 1,
        documents,
        revision: row.revision,
        updatedAt: row.updated_at,
      });
    } catch (error) {
      throw new ProjectSettingsError(
        "corrupt-settings",
        `Stored Project Lens settings for ${projectId} are invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async get(projectId: string): Promise<ProjectLensSettings> {
    return this.getSync(projectId);
  }

  async save(projectId: string, input: ProjectLensSettingsInput): Promise<ProjectLensSettings> {
    assertProjectId(projectId);
    const documents = normalizeDocumentSettings(input.documents);
    const now = Date.now();

    const save = this.db.transaction(() => {
      const current = this.db
        .prepare(
          `SELECT project_id, enabled, documents_json, revision, updated_at
           FROM project_lens_settings WHERE project_id = ?`,
        )
        .get(projectId) as SettingsRow | undefined;
      const currentRevision = current?.revision ?? 0;
      if (input.expectedRevision !== currentRevision) {
        throw new ProjectSettingsError(
          "revision-conflict",
          `Project Lens settings changed from revision ${input.expectedRevision} to ${currentRevision}; reload before saving`,
        );
      }
      const next: ProjectLensSettings = {
        projectId,
        enabled: input.enabled,
        documents,
        revision: currentRevision + 1,
        updatedAt: now,
      };
      this.db
        .prepare(
          `INSERT INTO project_lens_settings
             (project_id, enabled, documents_json, revision, updated_at)
           VALUES (@projectId, @enabled, @documents, @revision, @updatedAt)
           ON CONFLICT(project_id) DO UPDATE SET
             enabled = excluded.enabled,
             documents_json = excluded.documents_json,
             revision = excluded.revision,
             updated_at = excluded.updated_at`,
        )
        .run({
          projectId,
          enabled: input.enabled ? 1 : 0,
          documents: JSON.stringify(documents),
          revision: next.revision,
          updatedAt: now,
        });
      return projectLensSettingsSchema.parse(next);
    });

    return save();
  }
}
