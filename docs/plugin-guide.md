# Project Lens plugin guide

## Generate a whole-project Lens

The `lens_generate` RPC accepts a selected `projectId` and `environmentId`.
Pass `expectedParentVersionId: null` for Lens 0 and the current version ID for
an update. The plugin resolves the live workspace, inventories files through
the selected host, captures configured Markdown and bounded source evidence,
asks the configured BB provider for strict graph JSON, validates citations, and
publishes only after the parent guard succeeds.

Interactive callers should use `lens_generate_start`, retain the operation ID,
and poll `lens_generate_status`. `lens_generate_cancel` aborts the owned
capture/provider lifecycle; it never publishes a cancelled Lens.
`lens_generate_reconcile` retries cleanup for that exact operation when a
worker release was incomplete.

The stored Lens contains exact source bytes, Markdown heading spans, bounded
inventory, component/connection provenance, provider identity, and coverage.
Missing, unsupported, unresolved, escaped, or truncated areas remain visible
and prevent a complete-coverage claim. Known excluded file types are explicit
exclusions, not generation failures.

Evidence is partitioned deterministically into up to 16 sequential prompts,
each with at most 256 complete source records and 900,000 UTF-8 bytes. Exact
JSON serialization, inventory, instructions, and coverage notes count toward
the bound. Every source that fits is scheduled once until the pass limit.
Oversized records and files beyond that limit remain explicit unknowns. The
inventory and capture bounds remain in force (2,048 paths; 512 sources;
32 MiB aggregate and 4 MiB per file). Metadata overflow fails before a worker.

Each fragment is citation-validated against only the sources in its own prompt.
A separate architecture agent receives validated component summaries and up to
eight exact evidence references per component. It assigns every component once
to a named subsystem; unknown or duplicate membership is rejected. Added
cross-batch connections can use only supplied references belonging to an
endpoint and are marked inferred. Existing component connections remain intact;
subsystem-level connections summarize those component flows. The graph and
source checks publish one immutable version after all passes succeed.

The panel reports evidence-batch and architecture progress. Cancellation stops
the active worker and prevents later passes or publication. Cleanup records and
bounded recovery cover every worker. Each worker can run for up to ten minutes.
The final summary must fit 900,000 bytes; graph bounds are 1,024 components and
4,096 connections including subsystem nodes and overview edges. An overflow
fails explicitly rather than deleting evidence or components.

Stored analysisCoverage reports evidence pass count, supplied source IDs,
sources with no component/connection reference, and whether architecture was
assembled. Full source delivery is distinct from complete semantic coverage.
Old versions remain readable and unchanged; Update Lens creates the hierarchy
in a new version. A one-component project needs no assembly pass.

The public SDK analysis worker uses `threads.spawn` with
`workspace: { type: "unmanaged", path: null }`, hidden visibility, and
`accept-edits`. In SDK 0.4.47, `path: null` resolves to the host's configured
checkout. The prompt asks the worker to use only supplied evidence, but this is
an instruction, not a filesystem or permission boundary. The plugin does not
claim that this worker is detached or read-only.

## Complete a builder change

The bundled `project-lens-completion` skill is selected by the project's
`agents.configure` context. It is offered only to an enabled standard project
with a resolved environment, and not to Project Lens's own analysis worker.
The context carries the project/environment/host identity, current Lens,
configuration revision, document maintenance modes, relevant mappings, and
the latest synchronization state.

For every relevant `keep-updated` document, the builder supplies either a full
final Markdown value with its observed SHA-256 and affected heading anchors or
a no-change finding with checked anchors and a reason. The plugin preserves
reference-only documents and rejects edits outside named sections, including
newline and final-newline changes. Writes use host-file CAS and are followed by
a final source/inventory capture before publication.

`project_lens_synchronize` is the maintained-document path. Its durable states
are `pending`, `documents-written`, `generation-failed`, `conflict`, `failed`,
and `completed`:

- `completed` links final code/document hashes to a new Lens and comparison.
- `generation-failed` retains a successful Markdown write and is retryable with
  `project_lens_synchronize_retry`; the write is not repeated.
- `conflict` requires a fresh context and deliberate merge.
- `pending`, `documents-written`, `failed`, or unresolved items are not
  synchronization proof.

The raw `lens_generate` operation does not enforce the UI's maintained-document
gate. Use synchronization for a known source difference; the panel's explicit
`Update Lens` handler applies the same decision policy before starting a job.

## Freshness and comparison

A known source, inventory, or configuration difference is `stale` and keeps the
maintained-Markdown decision visible. A bounded or unresolved read with no
observed difference is `unknown`, not `fresh`; an explicit Update Lens can
publish another bounded version while keeping incomplete coverage visible. A
legacy Lens without inventory is also `unknown`. Checking, unavailable, and
generation-failed states remain blocked and are not relabelled as a successful
incomplete refresh.

Lens 0 remains immutable. Historical reads are project/environment guarded and
reopen captured evidence even when a live environment is unavailable. The
comparison includes Added/Changed/Removed/Uncertain graph items and captured
Markdown path/section differences; uncertainty prevents a failed analysis from
being presented as a confident removal.
