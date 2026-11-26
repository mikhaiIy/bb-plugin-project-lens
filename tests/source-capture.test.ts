import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DocumentSetting, ProjectWorkspace } from "../src/model.js";
import type { RawSourceRead, SourceReader, SourceReaderInput } from "../src/source-capture.js";
import {
  DEFAULT_SOURCE_CAPTURE_LIMITS,
  extractDocumentSections,
  SdkSourceCollector,
  SourceIntegrityError,
} from "../src/source-capture.js";

const target: ProjectWorkspace = {
  project: { id: "proj_one", name: "Synthetic One", kind: "standard" },
  environment: {
    id: "env_one",
    projectId: "proj_one",
    hostId: "host_one",
    status: "ready",
    path: "/synthetic/proj-one",
    workspaceProvisionType: "unmanaged",
    branchName: "main",
  },
  host: { id: "host_one", name: "Synthetic host", status: "connected", type: "persistent" },
  projectId: "proj_one",
  environmentId: "env_one",
  hostId: "host_one",
  rootPath: "/synthetic/proj-one",
};

const documents: DocumentSetting[] = [
  { path: "docs/architecture.md", purpose: "structure", maintenance: "keep-updated" },
];

function rawFile(input: SourceReaderInput, bytes: Buffer): RawSourceRead {
  return {
    content: bytes.toString("utf8"),
    contentEncoding: "utf8",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
    path: input.absolutePath,
    mimeType: "text/plain",
    modifiedAtMs: 123,
  };
}

describe("exact source capture", () => {
  it("retains exact bytes and creates Markdown section records", async () => {
    const architecture = Buffer.from(
      "# System\r\nIntro\r\n\r\n## Storage\r\nBytes stay exact.\r\n\r\n## Storage\r\nDuplicate heading.\r\n",
      "utf8",
    );
    const sourceReader: SourceReader = {
      async read(input) {
        if (input.relativePath === "docs/architecture.md") return rawFile(input, architecture);
        if (input.relativePath === "src/index.ts") return rawFile(input, Buffer.from("export {}\n"));
        throw new Error(`ENOENT: ${input.relativePath}`);
      },
    };

    const result = await new SdkSourceCollector(sourceReader).capture(target, documents, {
      codePaths: ["src/index.ts"],
    });
    const markdown = result.sources.find((source) => source.path === "docs/architecture.md");
    expect(markdown).toBeDefined();
    expect(Buffer.from(markdown!.bytesBase64, "base64")).toEqual(architecture);
    expect(markdown!.sizeBytes).toBe(architecture.byteLength);
    expect(markdown!.sha256).toBe(createHash("sha256").update(architecture).digest("hex"));
    expect(result.documentSections.map((section) => [section.anchor, section.startLine, section.endLine])).toEqual([
      ["system", 1, 8],
      ["storage", 4, 6],
      ["storage-2", 7, 8],
    ]);
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.analyzed).toHaveLength(2);
  });

  it("records missing and escaping requests without reading outside the boundary", async () => {
    const calls: SourceReaderInput[] = [];
    const sourceReader: SourceReader = {
      async read(input) {
        calls.push(input);
        throw Object.assign(new Error(`file unavailable: ${input.relativePath}`), { code: "ENOENT" });
      },
    };
    const result = await new SdkSourceCollector(sourceReader).capture(target, documents, {
      codePaths: ["../secret.ts", "docs/missing.md"],
    });
    expect(calls.map((call) => call.relativePath)).toEqual(["docs/architecture.md", "docs/missing.md"]);
    expect(result.coverage.escaped).toEqual([
      expect.objectContaining({ path: "../secret.ts", status: "escaped" }),
    ]);
    expect(result.coverage.missing).toEqual([
      expect.objectContaining({ path: "docs/architecture.md", status: "missing" }),
      expect.objectContaining({ path: "docs/missing.md", status: "missing" }),
    ]);
    expect(result.coverage.complete).toBe(false);
  });

  it("records a source whose returned bytes do not match its digest as unsupported", async () => {
    const sourceReader: SourceReader = {
      async read(input) {
        return {
          content: "actual",
          contentEncoding: "utf8",
          sha256: "0".repeat(64),
          sizeBytes: 6,
          path: input.absolutePath,
        };
      },
    };
    const result = await new SdkSourceCollector(sourceReader).capture(target, [], {
      codePaths: ["src/index.ts"],
    });
    expect(result.sources).toEqual([]);
    expect(result.coverage.unsupported).toEqual([
      expect.objectContaining({ path: "src/index.ts", status: "unsupported" }),
    ]);
    expect(result.coverage.complete).toBe(false);
    expect(SourceIntegrityError).toBeDefined();
  });

  it.each([
    ["# A\nbody\n", 2],
    ["# A\r\nbody\r\n", 2],
    ["# A\nbody", 2],
  ])("keeps final section ranges inside captured lines for %s", (text, endLine) => {
    const digest = createHash("sha256").update(text).digest("hex");
    const sections = extractDocumentSections("docs/empty.md", text, "source", digest);
    expect(sections).toEqual([
      expect.objectContaining({ startLine: 1, endLine }),
    ]);
  });

  it("returns no sections for an empty Markdown document", () => {
    const digest = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
    expect(extractDocumentSections("docs/empty.md", "", "source", digest)).toEqual([]);
  });

  it("keeps valid files when a configured Markdown file is invalid UTF-8", async () => {
    const valid = Buffer.from("# Good\n", "utf8");
    const invalid = Buffer.from([0xc3, 0x28]);
    const sourceReader: SourceReader = {
      async read(input) {
        const bytes = input.relativePath === "docs/bad.md" ? invalid : valid;
        return {
          content: bytes.toString("base64"),
          contentEncoding: "base64",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: bytes.byteLength,
          path: input.absolutePath,
        };
      },
    };
    const result = await new SdkSourceCollector(sourceReader).capture(
      target,
      [
        { path: "docs/bad.md", maintenance: "keep-updated" },
        { path: "docs/good.md", maintenance: "keep-updated" },
      ],
    );
    expect(result.sources.map((source) => source.path)).toEqual(["docs/good.md"]);
    expect(result.coverage.unsupported).toEqual([
      expect.objectContaining({ path: "docs/bad.md", status: "unsupported" }),
    ]);
    expect(result.coverage.analyzed).toEqual([
      expect.objectContaining({ path: "docs/good.md", status: "analyzed" }),
    ]);
  });

  it("does not classify permission or filename prose as a boundary escape", async () => {
    const sourceReader: SourceReader = {
      async read() {
        throw new Error("EACCES: permission denied, open '/ws/docs/root-map.md'");
      },
    };
    const result = await new SdkSourceCollector(sourceReader).capture(target, [], {
      codePaths: ["docs/root-map.md"],
    });
    expect(result.coverage.unresolved).toEqual([
      expect.objectContaining({ path: "docs/root-map.md", status: "unresolved" }),
    ]);
    expect(result.coverage.escaped).toEqual([]);
  });

  it("retains case variants across Markdown/code paths and reports ambiguity", async () => {
    const calls: string[] = [];
    const sharedBytes = Buffer.from("# Shared architecture\n", "utf8");
    const sourceReader: SourceReader = {
      async read(input) {
        calls.push(input.relativePath);
        return rawFile(input, sharedBytes);
      },
    };
    const result = await new SdkSourceCollector(sourceReader).capture(
      target,
      [{ path: "docs/Architecture.md", maintenance: "keep-updated" }],
      {
        codePaths: ["docs/architecture.md", "docs/Architecture.md", "src/Index.ts", "src/index.ts"],
      },
    );
    expect(calls).toEqual([
      "docs/Architecture.md",
      "docs/architecture.md",
      "src/Index.ts",
      "src/index.ts",
    ]);
    expect(result.sources.map((source) => source.path)).toEqual([
      "docs/Architecture.md",
      "docs/architecture.md",
      "src/Index.ts",
      "src/index.ts",
    ]);
    expect(result.coverage.unresolved).toEqual([
      expect.objectContaining({ path: "docs/architecture.md", status: "unresolved" }),
      expect.objectContaining({ path: "src/index.ts", status: "unresolved" }),
    ]);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.excluded).toEqual([
      expect.objectContaining({ path: "docs/Architecture.md", status: "excluded" }),
    ]);
  });

  it("retains composed and decomposed Unicode variants with exact returned paths", async () => {
    const decomposed = "docs/cafe\u0301.md";
    const composed = "docs/café.md";
    const sharedBytes = Buffer.from("# Café\n", "utf8");
    const sourceReader: SourceReader = {
      async read(input) {
        return rawFile(input, sharedBytes);
      },
    };
    const result = await new SdkSourceCollector(sourceReader).capture(
      target,
      [{ path: decomposed, maintenance: "keep-updated" }],
      { codePaths: [composed] },
    );
    expect(result.sources.map((source) => source.path)).toEqual([decomposed, composed]);
    expect(result.coverage.unresolved).toEqual([
      expect.objectContaining({ path: composed, status: "unresolved" }),
    ]);
    expect(result.coverage.complete).toBe(false);
  });

  it("reports same-key variants with different bytes instead of inferring distinct identity", async () => {
    const sourceReader: SourceReader = {
      async read(input) {
        return rawFile(input, Buffer.from(`# ${input.relativePath}\n`, "utf8"));
      },
    };
    const result = await new SdkSourceCollector(sourceReader).capture(
      target,
      [{ path: "docs/Architecture.md", maintenance: "keep-updated" }],
      { codePaths: ["docs/architecture.md"] },
    );
    expect(result.sources.map((source) => source.path)).toEqual([
      "docs/Architecture.md",
      "docs/architecture.md",
    ]);
    expect(result.coverage.unresolved).toEqual([
      expect.objectContaining({ path: "docs/architecture.md", status: "unresolved" }),
    ]);
    expect(result.coverage.complete).toBe(false);
  });

  it("does not treat equal returned paths and equal bytes as verified identity", async () => {
    const returnedPath = "/synthetic/proj-one/docs/café.md";
    const bytes = Buffer.from("# Same bytes\n", "utf8");
    const sourceReader: SourceReader = {
      async read(input) {
        return {
          ...rawFile(input, bytes),
          path: returnedPath,
        };
      },
    };
    const result = await new SdkSourceCollector(sourceReader).capture(
      target,
      [{ path: "docs/cafe\u0301.md", maintenance: "keep-updated" }],
      { codePaths: ["docs/café.md"] },
    );
    expect(result.sources.map((source) => source.path)).toEqual([
      "docs/cafe\u0301.md",
      "docs/café.md",
    ]);
    expect(result.coverage.unresolved).toEqual([
      expect.objectContaining({ path: "docs/café.md", status: "unresolved" }),
    ]);
    expect(result.coverage.excluded).toEqual([]);
    expect(result.coverage.complete).toBe(false);
  });

  it("defensively reports uncertainty when an internal reader omits host identity", async () => {
    const sourceReader: SourceReader = {
      async read(input) {
        const bytes = Buffer.from(`# ${input.relativePath}\n`, "utf8");
        return {
          ...rawFile(input, bytes),
          // SdkSourceReader receives a required string path from the public
          // SDK. This optional shape covers only the internal reader seam.
          path: undefined,
        };
      },
    };
    const result = await new SdkSourceCollector(sourceReader).capture(
      target,
      [{ path: "docs/cafe\u0301.md", maintenance: "keep-updated" }],
      { codePaths: ["docs/café.md"] },
    );
    expect(result.sources.map((source) => source.path)).toEqual([
      "docs/cafe\u0301.md",
      "docs/café.md",
    ]);
    expect(result.coverage.unresolved).toEqual([
      expect.objectContaining({ path: "docs/café.md", status: "unresolved" }),
    ]);
    expect(result.coverage.excluded).toEqual([]);
    expect(result.coverage.complete).toBe(false);
  });

  it("enforces per-file and aggregate retention limits without retaining rejected bytes", async () => {
    const sourceReader: SourceReader = {
      async read(input) {
        const bytes = Buffer.from(input.relativePath === "src/large.ts" ? "123456" : "1234", "utf8");
        return rawFile(input, bytes);
      },
    };
    const result = await new SdkSourceCollector(sourceReader, {
      ...DEFAULT_SOURCE_CAPTURE_LIMITS,
      maxFileBytes: 5,
      maxRetainedBytes: 5,
    }).capture(target, [], { codePaths: ["src/large.ts", "src/small.ts", "src/other.ts"] });
    expect(result.sources.map((source) => source.path)).toEqual(["src/small.ts"]);
    expect(result.coverage.unsupported).toEqual([
      expect.objectContaining({ path: "src/large.ts", status: "unsupported" }),
      expect.objectContaining({ path: "src/other.ts", status: "unsupported" }),
    ]);
  });
});
