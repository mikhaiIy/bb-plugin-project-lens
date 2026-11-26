# API audit

W02 adds one plugin-owned agent tool and plugin RPCs. They are intentionally
plugin contracts rather than additions to the BB SDK:

| Surface | Current status | Audit note |
| --- | --- | --- |
| `project_lens_generate` agent tool | W02 experimental | Invokes a bounded analysis job for the current project context. It must remain project-scoped, use the configured BB provider, and return only a bounded summary to the calling agent. |
| `lens_generate` RPC | W02 experimental | Generates and publishes an immutable whole-project Lens version. The caller supplies the project/environment and expected parent version; provider output is validated before publication. |
| `lens_generate_start`, `lens_generate_status`, `lens_generate_cancel`, `lens_generate_reconcile` RPCs | W02 correction experimental | Own a bounded, project/environment-scoped operation lifecycle, expose an early cancellation handle, and reconcile only the exact owned worker after cleanup failure. |
| `project_lens_initialize` agent tool / `lens_initialize` RPC | W04 typed | Creates one immutable Lens 0 for an enabled standard project environment; refuses to reinitialize an existing current Lens. |
| `project_lens_synchronize` agent tool / `lens_synchronize` RPC | W04 typed | Applies builder-supplied focused Markdown final content or no-change findings with document CAS, re-captures final code/docs, and publishes through the existing immutable parent-CAS generation path. |
| `project_lens_synchronize_retry` agent tool / `lens_synchronize_retry` RPC | W04 typed | Rechecks a recorded partial operation after a provider failure and retries Lens publication without repeating successful Markdown writes. |
| `project_lens_compare` agent tool / `lens_compare` RPC | W04 typed | Returns graph comparison plus captured Markdown path/section changes and the latest scoped synchronization result. |

The SDK's `threads.spawn` permission vocabulary has no read-only mode. W02
requests an unmanaged workspace with a null path and supplies captured evidence
in the prompt. SDK 0.4.47 documents that `path: null` selects the host's
configured checkout; it is not a detached or empty workspace. The evidence-only
prompt is an instruction, not filesystem or write-enforcement. See
[`docs/provider-boundary-decision.md`](provider-boundary-decision.md). A live BB
check must record this residual risk rather than treating an unchanged fixture
as proof of confinement.

W04's synchronize path is intentionally a plugin contract rather than a new
SDK operation. The public tool receives the project ID from BB context and the
environment-specific input; only the plugin resolves settings, host/root,
source hashes, and the current Lens. Its final-content Markdown edit is not an
agent patch protocol: it is a bounded full-document value checked against
named sections and written through the SDK file CAS. The builder's reason and
no-change finding remain reviewable assessments, not semantic proofs.
