# Project Lens foundation design

This is the W01 interface sketch. It is intentionally limited to the project
boundary, project-scoped Markdown configuration, exact source capture, typed
Lens records, and immutable persistence. The analyzer, diagram renderer, and
builder synchronization workflow consume these seams in later workers.

## Caller usage

```ts
const target = await projectBoundary.resolve({
  projectId,
  environmentId,
});

const settings = await settingsRepository.get(projectId);
const capture = await sourceCollector.capture(target, settings.documents, {
  codePaths: ["src/index.ts"],
});

const lens = lensFactory.create({
  target,
  configuration: settings,
  capture,
  graph: emptyGraph(),
  coverage: capture.coverage,
});
await lensRepository.publish(lens, { parentVersionId: null });

const history = await lensRepository.listForEnvironment({
  projectId,
  environmentId,
});
```

The caller must provide a concrete BB environment for a source capture. The
resolver fetches and checks the project, environment, and host before any file
read. Captures pass both the absolute root and host ID to `bb.sdk.files.read`,
so remote and local workspaces use the same requested boundary. The current
SDK declares `rootPath` as optional and does not expose a typed host
confinement error; lexical checks and host-returned-path checks are this
package's verified guarantees, while real-host symlink confinement remains a
later live integration check.

History reads are a separate path. The RPC first verifies that `projectId` is
an existing BB project namespace. `currentForEnvironment` and
`listForEnvironment` then query stored project/environment ownership, while
`get` checks the returned version against that same scope. They do not resolve
a live environment, require a connected host, or accept a caller-supplied
root/host identity. Returned versions retain the stored host and root identity,
so an unavailable environment cannot make evidence unreadable and an arbitrary
project ID cannot become a durable namespace. When there are several stored
host/root incarnations, the latest stored current head is selected by
`created_at DESC` and `version_id DESC`; this is history recency, not live
environment resolution.

## Records

- `ProjectWorkspace` is the resolved project/environment/host identity and
  canonical root path. It is required by every capture and Lens version.
- `ProjectLensSettings` is keyed by `projectId`, has a monotonic `revision`,
  and contains explicit `.md` paths with purpose and maintenance mode.
- `CapturedSource` retains the project-relative path, source kind, returned
  content identity, and exact bytes as base64. It is historical evidence, not
  a live-file pointer.
- `LensVersion` contains the parent identity, configuration/analyzer revision,
  captured sources, graph/evidence slots for later workers, and whole-project
  `CoverageRecord`.
- `DocumentSection` and `DocumentMapping` identify headings with line spans,
  captured content identity, and supported claims without treating document
  text as instructions.

## Module map and interfaces

```text
project-boundary.ts  -> ProjectWorkspaceResolver
path-policy.ts       -> validateProjectRelativePath / collision key / resolveWithinRoot
settings-store.ts    -> ProjectSettingsRepository
settings-sync.ts     -> project-scoped realtime conflict decision
source-capture.ts    -> SourceCollector
model.ts             -> Zod schemas + Lens records
lens-store.ts        -> LensRepository
server.ts            -> SDK RPC wiring only
app.tsx              -> project settings form only
```

```ts
interface ProjectWorkspaceResolver {
  resolve(input: ResolveWorkspaceInput): Promise<ProjectWorkspace>;
}

interface ProjectSettingsRepository {
  get(projectId: string): Promise<ProjectLensSettings>;
  save(projectId: string, input: ProjectLensSettingsInput): Promise<ProjectLensSettings>;
}

interface ValidatedProjectRelativePath {
  /** Exact validated spelling used for settings, reads, and evidence. */
  exact: string;
  /** NFC + case-folded comparison key; never used to rewrite a path. */
  collisionKey: string;
}

interface ProjectPathPolicy {
  validate(value: string, options?: { markdown?: boolean }): ValidatedProjectRelativePath;
  resolveWithinRoot(rootPath: string, exactRelativePath: string): string;
}

interface SourceCollector {
  capture(
    target: ProjectWorkspace,
    documents: readonly DocumentSetting[],
    options?: { codePaths?: readonly string[]; signal?: AbortSignal },
  ): Promise<SourceCapture>;
}

interface LensRepository {
  publish(
    lens: LensCandidate,
    expected: { parentVersionId: string | null },
  ): Promise<LensVersion>;
  current(target: WorkspaceIdentity): Promise<LensVersion | null>;
  get(versionId: string): Promise<LensVersion | null>;
  list(target: WorkspaceIdentity): Promise<LensVersion[]>;
  currentForEnvironment(scope: LensHistoryScope): Promise<LensVersion | null>;
  listForEnvironment(scope: LensHistoryScope): Promise<LensVersion[]>;
}

interface LensHistoryScope {
  projectId: string;
  environmentId: string;
}

interface SourceCaptureLimits {
  maxRequestedSources: number;
  maxFileBytes: number;
  maxRetainedBytes: number;
}
```

## Boundary rationale

Project settings are not declared BB settings: the SDK's `PluginSettingsHandle`
has no project-keyed get/set operation, and a `type: "project"` descriptor is
only a project picker. The plugin therefore owns a SQLite table keyed by the
verified BB project ID.

Lens versions are append-only rows. A trigger rejects updates/deletes, while a
separate `(project, environment, host, root)` head row advances only when its
current version still equals the caller's expected parent. This makes Lens 0
reopenable and prevents two jobs based on the same parent from silently
overwriting one another. The history-by-environment methods are discovery
helpers only; capture and publication still use the full four-part identity.

The foundation retains at most 4 MiB per source and 32 MiB per capture, and
processes at most 512 requested sources. These are plugin retention bounds,
not claims that the SDK or host limits the allocation performed by
`files.read`; the current API provides no read-size argument. A source whose
wire bytes, decoded bytes, declared size, digest, or Markdown encoding cannot
be verified is recorded as `unsupported` and is never added as evidence.
Valid sources in the same capture remain usable. A host read rejection is
`missing` only when it carries a verified filesystem code (`ENOENT` or
`ENOTDIR`); otherwise it is `unresolved`. `escaped` is reserved for this
package's lexical/root checks or a verified returned-path containment failure,
not free-text matching.

Document section ranges are calculated from captured source bytes. A final LF
or CRLF terminator does not create an extra content line, and an empty
document produces no sections. Relative paths retain their exact validated
Unicode and case spelling through settings, host reads, captured source IDs,
and section mappings. NFC/case folding exists only in a separate collision
key. Exact repeated requests are excluded. Different spellings with the same
collision key are both read when possible, but the SDK's returned path is a
bare string with no canonical identity guarantee: neither different/equal
returned paths nor equal/different digests can prove an alias. Every successful
variant is retained and later same-key variants receive `unresolved` coverage,
including equal returned paths with equal bytes. Settings therefore reject only
exact duplicates and defer the conservative ambiguity report to
environment-aware capture. A configured Markdown path wins over an exact
overlapping explicit code path, which is recorded as an excluded duplicate.

The graph is structured data, not a rendered diagram. W01 persists empty graph
slots without choosing a renderer or inventing analysis. W02 fills those slots
through the `lens_generate` RPC and `project_lens_generate` agent tool:

- `project-inventory.ts` lists files through `bb.sdk.files.listPaths` with a
  hard entry bound. Returned paths are treated as host evidence and are not
  rewritten or read through server-local filesystem APIs.
- `project-analysis.ts` serializes only bounded captured source bytes and
  Markdown sections into a provider prompt. The spawned hidden thread requests
  an unmanaged workspace with `path: null`; SDK 0.4.47 documents that this
  selects the host's configured checkout, so the worker is not detached from
  the selected repository. The SDK has no read-only permission mode, and the
  evidence-only prompt is an instruction rather than filesystem enforcement.
  The result is parsed as strict JSON and every citation is resolved against
  captured source IDs, SHA-256 values, line ranges, or section anchors before
  publication.
- Provider output retains provenance (`declared`, `inferred`, `extracted`, or
  `observed`), implementation state, planned intent, unknown areas, and
  explicit identity warnings. Stable component IDs reuse an earlier ID only
  when an exact code/document anchor or provider identity key supports
  continuity; split/merge ambiguity is recorded rather than silently merged.
- Worker threads are hidden and both archive and stop are attempted after
  success, provider failure, invalid citations, timeout, or cancellation.
  A validated graph is retained when cleanup reports an error, with explicit
  cleanup state and a bounded reconciliation path for the exact owned worker.
  Publication occurs only after graph/evidence validation and a final
  cancellation check, so a failed or cancelled job cannot replace a current
  Lens head. The configured-provider boundary and its residual risk are
  recorded in [`docs/provider-boundary-decision.md`](provider-boundary-decision.md).
