# Project Lens

> **Status: halted (November 2026).** Development stopped. An alternative
> approach replaced this plugin, so this code is a reference only. It is not
> maintained, and it is not tested against current BB releases.

Project Lens gives BB a versioned, source-linked map of a project. It captures
the selected project's code and configured Markdown, asks the configured BB
provider for a whole-project component graph, and keeps immutable Lens history
with code and document evidence attached.

## Requirements

- BB 0.42 or newer with the matching public Plugin SDK (this package is built
  and checked against SDK 0.4.47).
- A standard BB project with a connected host and a ready environment/workspace.
- A configured BB provider. Generation uses the provider selected for the
  project or the explicit provider/model override supplied by the caller.
- Explicit project-relative Markdown paths. Project Lens does not scan a whole
  documentation folder as a maintenance policy.

## Install and verify

From a checkout of this package:

```sh
npm install
bb plugin types --check .
npm test
npm run typecheck
bb plugin build .
bb plugin install /absolute/path/to/bb-plugin-project-lens
bb plugin reload project-lens
bb plugin list
```

The normal install registers the plugin and loads its server/app bundles; it
does not enable Project Lens for a project, create a Lens, or edit any project
file. `bb plugin list` should show `project-lens` as running with the same
source path. Settings and Lens history are stored in the plugin's own BB data
store and survive a build/reload.

For a packaged-file check, run `npm pack --dry-run --json` after building. The
package allowlist contains the runtime source/bundles, setup docs, and skill;
tests, dev fixtures, `.claude`, `node_modules`, and `src/fixtures` are not
included. Do not publish the resulting archive as part of local verification.

## Enable a project

1. Open BB Settings → Plugins → Project Lens.
2. Select the standard project to configure. Settings are keyed by BB project
   ID, so the same relative path in another project is a different document.
3. Enable Project Lens and add each exact project-relative Markdown path, its
   purpose, and its maintenance mode.
4. Choose `Keep updated` for documents the builder may edit and `Reference
   only` for intent, historical decisions, or future designs. Save the
   configuration and note its revision.
5. In the Project Lens panel, select the project's ready environment/workspace,
   then choose `Load Lens` and `Update Lens` to create immutable Lens 0.

Missing or moved documents remain visible in coverage; they are not silently
removed from a Lens. If the workspace is not listed, use the panel's
`Workspace not listed?` disclosure with the BB environment ID, then verify the
displayed host and path before loading or updating.

## Explore and compare

The panel renders the provider-generated grouped component graph. Select a
component or connection to inspect its responsibility, provenance, explanation,
code evidence, and Markdown heading sections. Expand a group to inspect its
internal flow; the text navigation mirrors the canvas for keyboard use.

The first saved version is Lens 0. Later updates preserve Lens 0 and create a
new version only after the expected parent and captured source identities pass
validation. The panel defaults comparisons to Lens 0 and can open another saved
version from history. Added, changed, removed, unchanged, and uncertain items
remain distinguishable; incomplete coverage keeps uncertain absences visible
instead of calling them removed.

Analysis partitions captured evidence across up to 16 sequential batches, each
containing at most 256 complete source records and 900,000 serialized UTF-8
bytes. A final agent pass assigns every retained component to a named
subsystem and infers supported connections across batches. Open a subsystem
in the overview to inspect its components and internal flow. Every component
must be assigned exactly once; invalid synthesis fails before publication.

Progress reports the current batch and architecture assembly. Each worker has
a ten-minute timeout and the update can be cancelled. Inventory (2,048 paths),
capture (512 sources / 32 MiB total / 4 MiB per file), and total-pass bounds
still apply. A source too large for one complete prompt remains captured but
explicitly omitted from analysis; source text is never silently clipped.
Stored coverage distinguishes supplied sources from sources cited by the
graph. Supplying every captured source does not prove complete understanding.
Architecture summary overflow or more than 1,024 total components / 4,096
connections fails without discarding components or publishing a partial merge.
Existing Lens versions retain their original graphs; run Update Lens to create
a new hierarchical version.

## Keep code, Markdown, and Lens aligned

For an enabled standard project with a resolved environment, BB injects the
`project-lens-completion` skill and these project-scoped tools into the next
implementation session:

- `project_lens_initialize` creates Lens 0 when none exists.
- `project_lens_synchronize` accepts final maintained-Markdown content or an
  explicit no-change finding, then captures the final code/docs and publishes a
  new Lens.
- `project_lens_synchronize_retry` retries Lens publication after a provider
  failure that already retained a successful Markdown write.
- `project_lens_compare` compares the current or selected version with Lens 0
  or another saved version, including captured Markdown section diffs.

The builder owns the document decision. It must preserve unrelated sections,
future plans, historical decisions, and reference-only documents. Maintained
edits use host-file compare-and-swap; a concurrent edit returns `conflict` and
requires a fresh read/merge. A `generation-failed` result retains the document
write and is retryable; code, Markdown, and plugin SQLite are not one
transaction.

If a builder changes code without this skill, the panel independently checks
the current workspace. A known difference shows `Update needed` and keeps the
maintained-document decision path. A bounded or unresolved read with no
observed difference shows `Freshness needs context`: an explicit `Update Lens`
may publish another bounded Lens, but that result is not a claim of complete
freshness or builder synchronization. A build or idle thread is never treated
as synchronization evidence.

## Boundary and limitation notes

Project Lens reads through the selected BB host API and applies lexical/root
checks, returned-byte integrity checks, exact-path preservation, and captured
source evidence. The public SDK does not currently expose a typed canonical
symlink identity/confinement result; a host that cannot prove a symlink stays
inside the selected root remains an explicit uncertainty in coverage.

Generation uses SDK 0.4.47's public `threads.spawn` with an unmanaged
`path: null` workspace and `accept-edits`. That selects the host's configured
checkout; it is not a detached or read-only sandbox. The evidence-only prompt
and citation validator reduce scope but do not enforce filesystem permissions.
Use a disposable project for first evaluation and review the provider's
normal BB approval controls.

The low-level `lens_generate` RPC and `project_lens_generate` tool are
generation operations, not a server-side maintained-Markdown gate. Use the
completion synchronization path, or the panel's explicit action, when a known
source difference must be resolved before publication.

More exact RPC shapes and the synchronization state machine are in
[`docs/plugin-guide.md`](docs/plugin-guide.md). A concise first-run procedure
is in [`docs/setup.md`](docs/setup.md).

## Status

Development stopped in November 2026. An alternative approach replaced this
plugin.

What this means:

- This code is a reference, not a supported package.
- BB 0.42+ and SDK 0.4.47 are the versions it was checked against. A later
  release may break it.
- Issues and pull requests may stay open without a reply.
- The design notes in `docs/` describe the problem and the trade-offs. They do
  not describe the alternative.
