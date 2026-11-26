import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { initializeFoundationDatabase } from "../src/lens-store.js";
import {
  ProjectSettingsError,
  SqliteProjectSettingsRepository,
} from "../src/settings-store.js";
import type { ProjectLensSettingsInput } from "../src/model.js";

describe("project-scoped Markdown settings", () => {
  let db: Database.Database | undefined;

  afterEach(() => db?.close());

  it("keeps identical relative paths isolated by BB project ID", async () => {
    db = new Database(":memory:");
    initializeFoundationDatabase(db);
    const repository = new SqliteProjectSettingsRepository(db);

    const first = await repository.save("proj_one", {
      enabled: true,
      documents: [
        { path: "docs/architecture.md", purpose: "One", maintenance: "keep-updated" },
        { path: "docs/design-target.md", maintenance: "reference-only" },
      ],
      expectedRevision: 0,
    });
    const second = await repository.save("proj_two", {
      enabled: false,
      documents: [
        { path: "docs/architecture.md", purpose: "Two", maintenance: "reference-only" },
      ],
      expectedRevision: 0,
    });

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(1);
    expect(await repository.get("proj_one")).toMatchObject({
      enabled: true,
      documents: [
        { path: "docs/architecture.md", purpose: "One", maintenance: "keep-updated" },
        { path: "docs/design-target.md", maintenance: "reference-only" },
      ],
    });
    expect(await repository.get("proj_two")).toMatchObject({
      enabled: false,
      documents: [{ path: "docs/architecture.md", purpose: "Two", maintenance: "reference-only" }],
    });
  });

  it("uses revisions to reject a stale concurrent save", async () => {
    db = new Database(":memory:");
    initializeFoundationDatabase(db);
    const repository = new SqliteProjectSettingsRepository(db);
    const first = await repository.save("proj_one", {
      enabled: true,
      documents: [{ path: "docs/architecture.md", maintenance: "keep-updated" }],
      expectedRevision: 0,
    });
    const second = await repository.save("proj_one", {
      enabled: true,
      documents: [{ path: "docs/components.md", maintenance: "keep-updated" }],
      expectedRevision: first.revision,
    });
    expect(second.revision).toBe(2);
    await expect(
      repository.save("proj_one", {
        enabled: false,
        documents: [],
        expectedRevision: first.revision,
      }),
    ).rejects.toMatchObject({ code: "revision-conflict" });
    expect(await repository.get("proj_one")).toMatchObject({
      revision: 2,
      documents: [{ path: "docs/components.md" }],
    });
  });

  it("requires a revision at the repository boundary before changing stored settings", async () => {
    db = new Database(":memory:");
    initializeFoundationDatabase(db);
    const repository = new SqliteProjectSettingsRepository(db);
    const initial = await repository.save("proj_one", {
      enabled: true,
      documents: [{ path: "docs/architecture.md", maintenance: "keep-updated" }],
      expectedRevision: 0,
    });

    const missingRevision = {
      enabled: false,
      documents: [],
    } as unknown as ProjectLensSettingsInput;
    await expect(repository.save("proj_one", missingRevision)).rejects.toMatchObject({
      code: "revision-conflict",
    });
    expect(await repository.get("proj_one")).toEqual(initial);

    const updated = await repository.save("proj_one", {
      enabled: false,
      documents: [],
      expectedRevision: initial.revision,
    });
    expect(updated).toMatchObject({
      projectId: "proj_one",
      enabled: false,
      documents: [],
      revision: initial.revision + 1,
    });
  });

  it.each([
    "../secret.md",
    "/tmp/secret.md",
    "docs\\secret.md",
    "docs/architecture.txt",
  ])("rejects unsafe document path %s", async (path) => {
    db = new Database(":memory:");
    initializeFoundationDatabase(db);
    const repository = new SqliteProjectSettingsRepository(db);
    await expect(
      repository.save("proj_one", {
        enabled: true,
        documents: [{ path, maintenance: "keep-updated" }],
        expectedRevision: 0,
      }),
    ).rejects.toBeInstanceOf(ProjectSettingsError);
  });

  it("rejects duplicate document paths with the exact same spelling", async () => {
    db = new Database(":memory:");
    initializeFoundationDatabase(db);
    const repository = new SqliteProjectSettingsRepository(db);
    await expect(
      repository.save("proj_one", {
        enabled: true,
        documents: [
          { path: "docs/architecture.md", maintenance: "keep-updated" },
          { path: "docs/architecture.md", maintenance: "reference-only" },
        ],
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "duplicate-document" });
  });

  it("preserves exact spellings and defers alias decisions to capture", async () => {
    db = new Database(":memory:");
    initializeFoundationDatabase(db);
    const repository = new SqliteProjectSettingsRepository(db);

    const decomposed = "docs/cafe\u0301.md";
    const saved = await repository.save("proj_one", {
      enabled: true,
      documents: [
        { path: decomposed, maintenance: "keep-updated" },
        { path: "docs/café.md", maintenance: "reference-only" },
        { path: "docs/Architecture.md", maintenance: "reference-only" },
        { path: "docs/architecture.md", maintenance: "reference-only" },
      ],
      expectedRevision: 0,
    });

    expect(saved.documents.map((document) => document.path)).toEqual([
      decomposed,
      "docs/café.md",
      "docs/Architecture.md",
      "docs/architecture.md",
    ]);
    expect((await repository.get("proj_one")).documents.map((document) => document.path)).toEqual(
      saved.documents.map((document) => document.path),
    );
  });
});
