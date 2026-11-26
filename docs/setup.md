# Project Lens setup

This is the user-facing first-run procedure for the local or extracted-package plugin.

## 1. Install the package

### Contributor checkout checks

Run these checks only from a contributor checkout. The test sources and development
dependencies are intentionally excluded from the consumer archive.

```sh
npm install
bb plugin types --check .
npm test -- --run
npm run typecheck
bb plugin build .
bb plugin install /absolute/path/to/bb-plugin-project-lens
bb plugin reload project-lens
```

Confirm with `bb plugin list`: the `project-lens` source should point to the
installed package and its status should be `running`. Reloading or rebuilding
does not initialize a project and does not clear Project Lens SQLite history.

### Consumer install from an extracted package

For a consumer install, obtain the `.tgz` archive, extract it, and install the
runtime dependencies from the extracted package directory. The archive does not
contain tests, development fixtures, or contributor-only files, so do not run
`npm test`, `bb plugin types`, or `npm run typecheck` as consumer setup steps.

```sh
tar -xzf bb-plugin-project-lens-0.2.0.tgz
cd package
npm install --omit=dev --ignore-scripts --no-audit --no-fund
bb plugin install "$PWD"
bb plugin reload project-lens
bb plugin list
```

The final `bb plugin list` entry should show `project-lens` as `running` and
point to the extracted package directory. This extracted-directory flow is the
verified local consumer path; installing the `.tgz` file directly is not a BB
local-plugin install path.

## 2. Configure one project

Open BB Settings → Plugins → Project Lens and select a standard BB project. BB's
`Personal` project is a supported BB pseudo-scope, but it has no Project Lens
environment or project storage. Project Lens recognizes it and leaves the
configuration controls disabled; it does not create settings or Lens records
for Personal. Select a standard project before continuing. Then:

1. Enable Project Lens.
2. Add each exact project-relative Markdown path, for example
   `docs/architecture.md` and `docs/components/storage.md`.
3. Enter an optional purpose for each path.
4. Set `Keep updated` for documents the builder may maintain, or `Reference
   only` for designs, historical decisions, and future intent.
5. Save and note the configuration revision.

Settings are keyed by project ID. A path configured in another project is a
different document. Missing, moved, invalid, or ambiguous paths are retained
as visible coverage issues; the plugin does not silently substitute another
file.

## 3. Before the first analysis

When enabled, the selected BB provider runs the analysis worker with
edit-capable `accept-edits` access in the host's configured unmanaged checkout.
This is not a detached read-only sandbox: Project Lens bounds captured evidence
and validates citations, but it cannot enforce provider filesystem permissions.
Start with a disposable project, verify the displayed host and path, and use BB's
normal approval controls before loading or updating a Lens.

## 4. Create Lens 0

In the main Project Lens panel, select the configured project. Select a `ready`
environment/workspace and verify the displayed host and path. If it is not
listed, open `Workspace not listed?`, enter the BB environment ID, choose
`Find workspace`, and verify the resolved details. Choose `Load Lens`, then
`Update Lens`.

The panel shows the generation operation and its final coverage. A successful
first operation saves immutable Lens 0; it does not make incomplete coverage
look complete.

## 5. Review the map

Select a component or connection in the diagram or its text navigation. The
evidence panel shows responsibility, explanation, provenance, captured code,
and Markdown heading links. Expand groups to inspect internal flows. Use Lens
history to reopen Lens 0 or another saved version; comparisons default to Lens
0 and include graph plus captured Markdown changes.

## 6. Synchronize implementation work

When Project Lens is enabled for a standard project, the next implementation
thread receives the `project-lens-completion` skill and project-scoped tools.
At a completed change boundary, the builder:

1. Reads the current code and configured Markdown.
2. Updates only affected sections of `Keep updated` documents, or records a
   justified no-change finding for each relevant maintained document.
3. Preserves unrelated sections and every `Reference only` document.
4. Calls `project_lens_synchronize` with the expected Lens and configuration
   revision.
5. Reviews the returned Lens comparison and synchronization state.

If the provider fails after a document write, the result is
`generation-failed`; call `project_lens_synchronize_retry` after the provider
is ready. The retry checks current hashes and does not repeat the successful
document write. A concurrent document or parent-Lens change returns `conflict`;
re-read and merge instead of overwriting it.

## 7. If the skill was skipped

The panel's independent freshness check can show `Update needed` after a known
code or document change. Follow the maintained-document decision before using
Update Lens. A bounded or unresolved read with no observed difference shows
`Freshness needs context`; Update Lens may publish another bounded graph, but
the new Lens remains explicitly incomplete and must not be reported as builder
synchronization. A passing build or idle thread is not synchronization proof.
