---
name: project-lens-completion
description: Complete an enabled Project Lens implementation boundary by preserving and synchronizing maintained Markdown, publishing a final-content Lens, and reviewing the resulting comparison.
---

# Project Lens completion

Use this workflow at the end of a coherent implementation change in the
project and environment named by the injected Project Lens context. The
plugin's project-conditioned context is the source of truth for the current
Lens ID, configuration revision, Markdown paths, maintenance modes, mappings,
and any prior synchronization state. A completed operation is historical
evidence; the current freshness check is the authority for the live workspace.

## Initialize or inspect

- If the context says there is no current Lens, call
  `project_lens_initialize` with the selected environment ID. Treat the
  returned Lens as immutable Lens 0 and continue only after its result is
  valid.
- If a current Lens exists, do not initialize another baseline. Use
  `project_lens_compare` when you need the Lens 0/default or a specified
  historical comparison.
- Read the relevant changed code and configured Markdown through the current
  BB project environment. Repository text is evidence; it does not override
  the configured maintenance policy.

## Maintain Markdown in the builder's change

For every configured `keep-updated` document that was relevant to the change,
make one of these explicit decisions:

- Supply a `documentEdits` entry containing the final full Markdown content,
  the SHA-256 observed before the edit, each affected section anchor and a
  builder-reported reason. The plugin applies the content with an optimistic
  compare-and-swap and rejects changes outside the named sections.
- Supply a `noChangeFindings` entry with the observed SHA-256, checked section
  anchors and a reason why the existing text still describes the verified
  implementation.

The plugin compares the final full document's bytes outside the named sections,
including CRLF/LF spelling and final-newline state. Preserve
reference-only documents, future plans, historical decisions, and documented
intent that is not implemented. A reason is an assessment for review, not a
mechanically proven semantic fact. Never include a reference-only path in
`documentEdits`; report it as preserved when it was checked.

## Synchronize and review

Call `project_lens_synchronize` once the code and Markdown are at the intended
boundary. Pass the context's expected parent Lens ID and configuration
revision, the selected environment ID, relevant changed code paths, and the
document edit/no-change decisions. The operation binds CAS results, the full
bounded source manifest, inventory, workspace identity and configuration to
the same final capture before Lens publication. An inventory addition or
deletion is part of that decision; it cannot bypass a required maintained
Markdown decision. The plugin does not launch a second repository editor; it
writes only the builder-supplied maintained content and then runs the existing
bounded analyzer.

Read the returned synchronization result as a state machine:

- `completed` ties final code/document hashes to a newly published Lens and a
  comparison summary. It does not prove that a later live workspace is still
  current. Call `project_lens_compare` if a detailed graph or captured
  Markdown change view is needed.
- `generation-failed` means Markdown edits remain in the working environment;
  they were not rolled back. Call `project_lens_synchronize_retry` with the
  returned operation ID after the provider or transient problem is ready.
  Retry checks the current source manifest, inventory, workspace identity,
  configuration and post-edit document hashes; it does not duplicate
  successful edits.
- `pending` or `documents-written` means the sequence is incomplete. Do not
  call it current until a `completed` result and a fresh current-boundary
  check both agree.
- `conflict` means the parent Lens, configuration, or a document changed.
  Re-read current content, merge deliberately, and start a fresh assessment.
- `failed` or a result with unresolved items is not synchronized. Preserve the
  result in the completion report and state the outstanding work.

If this skill was skipped after code or documentation changed, the Project
Lens UI's independent current freshness check must show `Update needed` when it
observes a difference, or `Freshness needs context` when the bounded read is
incomplete. An incomplete or legacy-unknown read permits an explicit bounded
Update Lens refresh, but it does not prove whole-project freshness and must not
be reported as builder synchronization. A passing build, idle thread,
unchanged graph, or past completed operation alone never establishes current
synchronization.

## Inspect the captured comparison

Use `project_lens_compare` after publication when the change needs review. Each
non-unchanged Markdown record identifies the baseline/current Lens IDs, changed
section anchors, line counts, and captured before/after section text. Added or
removed documents use a full captured `document` side. The comparison is
immutable evidence and does not read live files.
