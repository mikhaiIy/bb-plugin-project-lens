# W02 decision: configured-provider analysis boundary

Date: 2026-09-08

SDK inspected: `@get-bb/plugin-sdk` 0.4.47 and its bundled public
declarations.

## Decision

Use the public `bb.sdk.threads.spawn` route to invoke the selected project's
configured provider. Spawn a hidden worker on the selected host with
`workspace: { type: "unmanaged", path: null }`, pass only the bounded captured
evidence prompt, use the least permissive public permission mode
(`accept-edits`), keep the host's existing approval controls, and validate the
returned JSON before publication.

This correction deliberately retains that tested spawn shape. It does not
detach the worker from the selected project: SDK 0.4.47 resolves an unmanaged
workspace with `path: null` to the host's configured checkout. The bounded
evidence prompt and its no-tool-use instruction constrain what the plugin asks
the provider to do, but they do not remove repository access or create a
read-only/filesystem-isolated worker.

## Verified SDK boundary

The public SDK exposes `threads.spawn`, `wait`, `output`, `archive`, and `stop`.
Its public permission modes are `accept-edits`, `auto`, and `full`; there is no
read-only mode, allowed-tool list, or disallowed-tool list in the public
`CreateThreadRequest`. The public provider area lists providers and models but
does not expose a direct provider-completion API for plugin consumers. The
selected worker still runs on the host that owns the selected project source.

The installed declaration at
`node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts:15092-15095`
states: “the seeded selection submits `path: null` (the host's configured
checkout).” The same declaration defines the unmanaged `path` as nullable and
includes `{ type: "personal" }` in the `CreateThreadRequest` workspace union at
`node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts:10345-10366`.
The parent's live observation in
`artifacts/harness/57a3c0ca/w02-rework-01-parent-check.md` confirms the
semantics: Alpha workers resolved to
`/home/mikhaily/.bb/thread-storage/thr_66tugbhq43/live-fixtures/project-alpha`
(`env_inffd25sbv`) and Beta workers to
`/home/mikhaily/.bb/thread-storage/thr_66tugbhq43/live-fixtures/project-beta`
(`env_4pw9yf2vkv`). The request argument and resolved worker environment are
different facts; the observed workers were in the configured fixture checkouts.

Repository bytes supplied as prompt evidence can therefore influence an
edit-capable provider agent with file tools. The prompt's evidence-only wording
is still useful as an instruction and the source-set validator remains the
actual citation restriction, but neither is a permission boundary. The plugin
must not describe this worker as read-only, isolated, or detached.

## Workspace alternatives considered

- An unmanaged workspace with a non-null `path` is type-supported by the
  public request schema. It could select an explicitly chosen directory, but
  this package has not live-tested its working-directory lifecycle or obtained
  a filesystem-confinement guarantee from the path field.
- `{ type: "personal" }` is also type-supported by the public workspace union
  and can select a different working-directory lifecycle. Its live resolution,
  ownership, and confinement behavior were not tested here; the type alone is
  not a security boundary.
- This correction keeps `path: null` because it preserves the current
  project/environment integration and the already verified configured-provider
  execution on the disposable fixtures. The tradeoff is explicit: the worker
  runs in the selected host's configured checkout. Selecting and verifying a
  different workspace lifecycle is a separate implementation change, not an
  impossible SDK option.

## Rejected alternatives for SDK 0.4.47

- A private provider bridge or internal inference endpoint is not used. It is
  not a supported Plugin SDK surface and would make the package dependent on
  undocumented internals.
- `auto` and `full` are not less permissive than `accept-edits`.
- Approval controls are not disabled or bypassed to make a smoke run appear
  confined.

## Operational safeguards and residual risk

The plugin captures and retains source bytes through the selected host before
the provider call, serializes only the bounded prompt subset, validates
citations against sources actually serialized into that prompt, and publishes
only a validated graph. Hidden-worker ownership is correlated with the exact
project, environment, plugin owner, and per-operation title; generic titles
are never used for cleanup.

These safeguards reduce the supplied evidence and cleanup risk. They do not
prevent a provider from using tools available under the SDK's permission mode
inside the selected host checkout. A tool-capable agent with auto-accepted
edits can inspect or change repository files; that residual risk is not bypassed
by this plugin, and the existing BB approval controls remain in place. A future
SDK with a documented read-only provider route or explicit tool allowlist may
replace this decision.

## Required live follow-up

W05 must run the installed plugin against dedicated disposable projects and
record the provider, worker, permission mode, workspace arguments, source-file
hashes before and after, and cleanup state. That smoke check can detect an
unexpected write; it cannot prove confinement. Host-side symlink/canonical
path confinement remains a separate W05 acceptance check.
