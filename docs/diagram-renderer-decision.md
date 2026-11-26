# Diagram renderer decision

W03 keeps the renderer behind the `DiagramCanvas` boundary in
`components/lens-panel.tsx`. The boundary accepts the typed graph,
`DiagramComparison`, selection, focus, and search inputs; it does not derive
project content or read files. `src/diagram.ts` owns hierarchy, comparison,
and deterministic layout so a different renderer can consume the same model.

## Candidate behavior

| Candidate | Strengths | Gaps for this viewer | Decision |
| --- | --- | --- | --- |
| Mermaid-like SVG output | Natural grouped regions, labels, arrows, and a familiar flowchart vocabulary | Generated SVG is presentation-first: stable node correspondence, precise evidence selection, retained Removed nodes, and keyboard hit targets would need a second mapping layer | Keep the visual language, do not make generated Mermaid text the stored state |
| Flow/graph library | Rich pan/zoom and edge interaction primitives | Adds a runtime dependency and library layout state; nested Lens history, uncertainty-safe comparisons, and BB token styling would still need custom adapters | Keep as a future swap behind the boundary if interaction needs outgrow the current surface |
| Typed custom SVG | Deterministic positions from stable IDs, explicit node/edge hit targets, ARIA labels, dashed uncertainty/removal paths, and no new dependency | Layout is intentionally compact rather than a general-purpose graph solver | **Chosen for W03** |

The chosen renderer is intentionally Mermaid-like rather than a Mermaid text
parser. It renders agent-supplied typed components and connections directly,
with grouped regions, labeled routed edges, explicit change badges, and
text-navigation buttons. The evidence inspector is a sibling surface, so
replacing the SVG implementation does not change code/Markdown navigation or
Lens comparison semantics.

## Interaction contract

- `stableLayout` derives the current visible level (including baseline-only
  comparison items), sorts groups and first-seen nodes by stable identity, and
  reuses a previous layout only within a project/environment/focus scope. The
  prior layout is a positioning hint, never the component identity.
- `routeConnections` is the renderer's routing seam. Same-group edges use a
  local side lane (alternating sides and per-endpoint channels for dense or
  reverse pairs); cross-group edges use the gap between groups or the row gap
  between vertically adjacent groups. Each label is selected from sampled
  points on its own cubic route, then checked against prior label boxes and
  route samples. The measured content bounds shift a routed surface back inside
  the declared canvas when a left lane would otherwise escape; there is no
  unrelated global top rail. Labels carry the full connection in a `<title>`
  even when the visible copy is wrapped.
- The camera uses the actual SVG viewport and its xMidYMid letterbox when
  fitting the measured content bounds. Small graphs can therefore enlarge into
  unused canvas space while retaining a padded, centered overview. Pointer drag is thresholded and handled through window listeners without
  pointer capture, so releasing outside the SVG cannot swallow a click; native
  non-passive wheel handling keeps zoom anchored at the cursor.
- Fit overview is the one explicit fit action; the initial camera uses the same
  content-to-viewport math. Focused nested levels therefore fit their own
  groups instead of inheriting root-level dimensions.
- `parentId`/`groupId` drive overview and child views. `nestedFlow` remains a
  supported optional input for future agent output.
- SVG nodes and edge hit paths expose Enter/Space activation and the text
  navigation mirrors the same selection model for keyboard and narrow layouts.
- Captured evidence is decoded from the selected immutable Lens version. The
  current source check is read-only and only claims freshness for retained
  paths; a whole-project update remains the explicit Update Lens action.
