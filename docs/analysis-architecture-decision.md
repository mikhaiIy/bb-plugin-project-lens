# Evidence batches and subsystem assembly

The first real project produced 42 components with no parent or group. The
viewer correctly rendered all of them in its fallback Project surface group.
The generation contract permitted this: one evidence prompt named nullable
parent/group fields but did not require a usable architecture hierarchy.

## Chosen boundary

Keep one captured source boundary and one publication transaction. Schedule
captured sources deterministically into disjoint, exact-byte-bounded evidence
prompts. Validate each response against the evidence actually supplied to that
worker before merging fragments. A separate agent then assigns every retained
component to a named subsystem. This agent sees validated component summaries,
existing connections, and a bounded bank of exact evidence references.

Every component must be assigned once. Unknown IDs, duplicate assignments,
missing assignments, duplicate subsystem keys, and collapsing more than eight
components into one subsystem are rejected. This structural gate does not
prove the semantic quality of the model's chosen boundaries. A small cohesive
project can have one subsystem; a single-component project uses its original
component directly.

Subsystem claims and newly inferred component connections are labelled
inferred. New connections can cite only bank references owned by an endpoint.
That establishes reference provenance, not runtime observation or semantic
proof. Existing component connections remain intact. Overview edges summarize
connections whose endpoints belong to different subsystems. Opening a subsystem
shows its children and internal connections; cross-subsystem flows remain on
the overview. The viewer does not invent component relationships.

## Rejected alternative

A model scout could select subsystems first and choose files for each worker.
That would make source coverage depend on an agent's initial guesses. The
chosen design accounts for captured inputs independently of architecture
interpretation. Directory order affects evidence batches, never the subsystem
assignment contract.

## Identity and boundedness

Component semantic keys and exact anchors retain the existing identity rules.
Subsystem keys have a separate namespace and never compete with component
anchors. Matching subsystem keys preserve identities across new versions.
Conflicting component keys across evidence batches retain separate components
and an explicit identity warning rather than silently overwriting one.

The assembly agent also reassesses local batch questions against the combined
summaries. A file missing from an early batch is not automatically a final
project-wide uncertainty. Inventory, capture and scheduling omissions remain
separate and cannot be cleared by the model. Same-key unknown dependencies can
be enriched by a later implementation without retaining a duplicate placeholder.

At most 16 evidence workers plus one assembly worker run sequentially. Each
prompt is at most 900,000 serialized UTF-8 bytes, each response at most 512,000
bytes, and each worker has a ten-minute timeout. Each evidence prompt holds at
most 256 complete sources and permits up to 256 exact references per component
or connection, so a catalogue can cite every file in its batch. The existing 2,048-path inventory, 512-source capture,
4 MiB per-file capture and 32 MiB total capture limits remain. A source too
large for an evidence prompt is explicitly omitted; this version does not
split individual files. Assembly overflow or a graph above 1,024 components /
4,096 connections fails without publishing a silently reduced graph.

Coverage records which captured sources were supplied, how many evidence
passes ran, and which supplied sources have no component/connection reference.
This keeps successful input delivery distinct from complete understanding.
Old immutable Lens versions are not rewritten or upgraded in place.

Cancellation stops the active worker and prevents later passes or publication.
Every worker retains its own cleanup result; aggregate recovery retries only
owned workers with incomplete cleanup. Provider access is unchanged: SDK
0.4.47 `accept-edits` workers run in the configured checkout, and evidence-only
instructions are not a filesystem sandbox.
