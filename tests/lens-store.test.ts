import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeFoundationDatabase,
  LensHeadConflictError,
  SqliteLensRepository,
} from "../src/lens-store.js";
import { createLensCandidate } from "../src/lens.js";
import type {
  ProjectLensSettings,
  ProjectWorkspace,
  SourceCapture,
} from "../src/model.js";

const project = (id: string, rootPath: string): ProjectWorkspace => ({
  project: { id, name: id, kind: "standard" },
  environment: {
    id: `${id}_env`,
    projectId: id,
    hostId: `${id}_host`,
    status: "ready",
    path: rootPath,
    workspaceProvisionType: "unmanaged",
    branchName: "main",
  },
  host: {
    id: `${id}_host`,
    name: `${id} host`,
    status: "connected",
    type: "persistent",
  },
  projectId: id,
  environmentId: `${id}_env`,
  hostId: `${id}_host`,
  rootPath,
});

const settings: ProjectLensSettings = {
  projectId: "proj_one",
  enabled: true,
  documents: [{ path: "docs/architecture.md", maintenance: "keep-updated" }],
  revision: 1,
  updatedAt: 10,
};

function sourceCapture(): SourceCapture {
  const bytes = Buffer.from("# Architecture\n\n## Storage\nExact bytes\n", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    capturedAt: 11,
    sources: [
      {
        id: `source:markdown:docs/architecture.md:${sha256}`,
        path: "docs/architecture.md",
        kind: "markdown",
        wireEncoding: "utf8",
        sha256,
        sizeBytes: bytes.byteLength,
        bytesBase64: bytes.toString("base64"),
        mimeType: "text/markdown",
        modifiedAtMs: 12,
      },
    ],
    documentSections: [
      {
        sourceId: `source:markdown:docs/architecture.md:${sha256}`,
        path: "docs/architecture.md",
        anchor: "architecture",
        heading: "Architecture",
        level: 1,
        startLine: 1,
        endLine: 4,
        capturedSha256: sha256,
      },
      {
        sourceId: `source:markdown:docs/architecture.md:${sha256}`,
        path: "docs/architecture.md",
        anchor: "storage",
        heading: "Storage",
        level: 2,
        startLine: 3,
        endLine: 4,
        capturedSha256: sha256,
      },
    ],
    coverage: {
      scope: "configured-sources",
      totalRequested: 1,
      analyzed: [
        {
          path: "docs/architecture.md",
          kind: "markdown",
          status: "analyzed",
          sourceId: `source:markdown:docs/architecture.md:${sha256}`,
        },
      ],
      excluded: [],
      unsupported: [],
      unresolved: [],
      missing: [],
      escaped: [],
      complete: true,
    },
  };
}

function targetFor(
  projectId: string,
  environmentId: string,
  hostId: string,
  rootPath: string,
): ProjectWorkspace {
  return {
    project: { id: projectId, name: projectId, kind: "standard" },
    environment: {
      id: environmentId,
      projectId,
      hostId,
      status: "ready",
      path: rootPath,
      workspaceProvisionType: "unmanaged",
      branchName: "main",
    },
    host: { id: hostId, name: `${hostId} host`, status: "connected", type: "persistent" },
    projectId,
    environmentId,
    hostId,
    rootPath,
  };
}

describe("immutable Lens history", () => {
  let db: Database.Database | undefined;

  afterEach(() => db?.close());

  it("publishes Lens 0, reopens captured bytes, and guards the current pointer", async () => {
    db = new Database(":memory:");
    initializeFoundationDatabase(db);
    const repository = new SqliteLensRepository(db);
    const target = project("proj_one", "/synthetic/proj-one");
    const capture = sourceCapture();

    const first = await repository.publish(
      createLensCandidate({ target, settings, capture, parentVersionId: null, createdAt: 20 }),
      { parentVersionId: null },
    );
    expect(first.versionNumber).toBe(0);
    expect((await repository.current(target))?.id).toBe(first.id);
    expect((await repository.get(first.id))?.sources[0]?.bytesBase64).toBe(
      capture.sources[0]?.bytesBase64,
    );

    const second = await repository.publish(
      createLensCandidate({
        target,
        settings,
        capture,
        parentVersionId: first.id,
        createdAt: 21,
      }),
      { parentVersionId: first.id },
    );
    expect(second.versionNumber).toBe(1);
    expect((await repository.list(target)).map((version) => version.versionNumber)).toEqual([0, 1]);
    expect((await repository.current(target))?.id).toBe(second.id);

    await expect(
      repository.publish(
        createLensCandidate({ target, settings, capture, parentVersionId: first.id, createdAt: 22 }),
        { parentVersionId: first.id },
      ),
    ).rejects.toBeInstanceOf(LensHeadConflictError);

    expect(() =>
      db!.prepare("UPDATE lens_versions SET payload_json = '{}' WHERE version_id = ?").run(first.id),
    ).toThrow(/immutable/);
    expect(() => db!.prepare("DELETE FROM lens_versions WHERE version_id = ?").run(first.id)).toThrow(
      /immutable/,
    );
    expect((await repository.get(first.id))?.versionNumber).toBe(0);
  });

  it("keeps the same path separate when the BB project or workspace changes", async () => {
    db = new Database(":memory:");
    initializeFoundationDatabase(db);
    const repository = new SqliteLensRepository(db);
    const firstTarget = project("proj_one", "/synthetic/shared-name");
    const secondTarget = project("proj_two", "/synthetic/shared-name");
    const first = await repository.publish(
      createLensCandidate({ target: firstTarget, settings, capture: sourceCapture(), parentVersionId: null }),
      { parentVersionId: null },
    );
    const second = await repository.publish(
      createLensCandidate({
        target: secondTarget,
        settings: { ...settings, projectId: "proj_two" },
        capture: sourceCapture(),
        parentVersionId: null,
      }),
      { parentVersionId: null },
    );
    expect(first.id).not.toBe(second.id);
    expect((await repository.current(firstTarget))?.projectId).toBe("proj_one");
    expect((await repository.current(secondTarget))?.projectId).toBe("proj_two");
  });

  it("chooses the latest stored head by creation time across root incarnations", async () => {
    db = new Database(":memory:");
    initializeFoundationDatabase(db);
    const repository = new SqliteLensRepository(db);
    const oldTarget = targetFor("proj_shared", "env_shared", "host_old", "/synthetic/old");
    const newTarget = targetFor("proj_shared", "env_shared", "host_new", "/synthetic/new");
    const sharedSettings = { ...settings, projectId: "proj_shared" };
    let oldParent: string | null = null;
    for (const createdAt of [1000, 1001, 1002]) {
      const version = await repository.publish(
        createLensCandidate({
          target: oldTarget,
          settings: sharedSettings,
          capture: sourceCapture(),
          parentVersionId: oldParent,
          createdAt,
        }),
        { parentVersionId: oldParent },
      );
      oldParent = version.id;
    }
    const latestNew = await repository.publish(
      createLensCandidate({
        target: newTarget,
        settings: sharedSettings,
        capture: sourceCapture(),
        parentVersionId: null,
        createdAt: 9999,
      }),
      { parentVersionId: null },
    );

    expect(await repository.currentForEnvironment({ projectId: "proj_shared", environmentId: "env_shared" })).toMatchObject({
      id: latestNew.id,
      versionNumber: 0,
      createdAt: 9999,
      hostId: "host_new",
      rootPath: "/synthetic/new",
    });
    expect(await repository.current(oldTarget)).toMatchObject({
      versionNumber: 2,
      hostId: "host_old",
      rootPath: "/synthetic/old",
      createdAt: 1002,
    });
    expect((await repository.current(newTarget))?.id).toBe(latestNew.id);
    expect((await repository.listForEnvironment({ projectId: "proj_shared", environmentId: "env_shared" }))).toHaveLength(4);
  });
});
