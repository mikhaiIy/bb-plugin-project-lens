> **Status: halted (November 2026).** An alternative approach replaced this
> plugin. The code is a reference only.

Project Lens gives BB a durable, source-linked map of a project over time. It
stores project-scoped Markdown configuration, exact captured code and document
bytes, provider-generated component graphs, and immutable Lens versions.

## What you get

- A project settings view for multiple explicit Markdown files, each with a
  purpose and `Keep updated` or `Reference only` maintenance mode.
- Lens 0 plus guarded version history. Every component and connection can lead
  back to captured code and Markdown sections.
- A grouped, keyboard-navigable diagram with nested flows, evidence inspection,
  source freshness, and Lens 0 or historical comparisons.
- A builder completion workflow that focuses Markdown edits, preserves
  unrelated/reference-only content, uses compare-and-swap writes, and records
  retryable partial failures.
- Honest incomplete coverage: missing, unresolved, unsupported, planned, and
  inferred areas stay visible instead of becoming false removals or freshness
  claims.

Project Lens does not initialize or edit a project when it is installed. The
first Lens is created only after a user enables a selected standard project,
chooses a ready workspace, and starts an explicit generation action.

The package requires BB 0.42+ and a configured provider. The provider worker
uses the public SDK's edit-capable `accept-edits` request in the host's
configured checkout; this is not a read-only or detached sandbox. Use the
setup guide and a disposable project for the first run.
