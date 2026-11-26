import { describe, expect, it } from "vitest";
import {
  isWithinRoot,
  normalizeProjectRelativePath,
  projectPathCollisionKey,
  ProjectPathError,
  resolveWithinRoot,
} from "../src/path-policy.js";

describe("project-relative path policy", () => {
  it("canonicalizes safe Markdown paths and keeps them under the root", () => {
    expect(normalizeProjectRelativePath("docs/architecture.md", { markdown: true })).toBe(
      "docs/architecture.md",
    );
    expect(resolveWithinRoot("/synthetic/project", "docs/architecture.md")).toBe(
      "/synthetic/project/docs/architecture.md",
    );
    expect(isWithinRoot("/synthetic/project", "/synthetic/project/src/index.ts")).toBe(true);
    expect(isWithinRoot("/synthetic/project", "/synthetic/other/secret.ts")).toBe(false);
  });

  it.each([
    ["/etc/passwd", "absolute"],
    ["../secret.md", "traversal"],
    ["docs/../../secret.md", "traversal"],
    ["docs\\secret.md", "backslash"],
    ["C:\\secret.md", "absolute"],
    ["docs//architecture.md", "duplicate-separator"],
    ["docs/./architecture.md", "duplicate-separator"],
    ["docs/architecture.txt", "markdown-extension"],
  ] as const)("rejects %s", (path, code) => {
    expect(() => normalizeProjectRelativePath(path, { markdown: path.endsWith(".txt") })).toThrow(
      ProjectPathError,
    );
    try {
      normalizeProjectRelativePath(path, { markdown: path.endsWith(".txt") });
    } catch (error) {
      expect(error).toMatchObject({ code });
    }
  });

  it("supports Windows workspace roots without using the server OS as authority", () => {
    expect(resolveWithinRoot("C:\\work\\project", "docs/architecture.md")).toBe(
      "C:\\work\\project\\docs\\architecture.md",
    );
    expect(isWithinRoot("C:\\work\\project", "C:\\work\\other\\secret.ts")).toBe(false);
  });

  it("retains exact Unicode spelling while exposing a separate collision key", () => {
    const decomposed = "docs/cafe\u0301.md";
    expect(normalizeProjectRelativePath("docs/cafe\u0301.md", { markdown: true })).toBe(
      decomposed,
    );
    expect(resolveWithinRoot("/synthetic/project", decomposed)).toBe(
      "/synthetic/project/docs/cafe\u0301.md",
    );
    expect(projectPathCollisionKey("docs/Architecture.md")).toBe(
      projectPathCollisionKey("docs/architecture.md"),
    );
  });
});
