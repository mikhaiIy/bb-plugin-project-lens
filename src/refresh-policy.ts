import type { SourceFreshnessStatus } from "./diagram.js";
import type { SynchronizationStatus } from "./model.js";

/**
 * Freshness is evidence, while this status is the UI's ability to make a
 * refresh decision. A completed `unknown` read is actionable: it found no
 * known difference, but its bounded evidence cannot prove a whole-project
 * match. `checking` and `unavailable` are not completed reads.
 */
export type ExplicitUpdateFreshnessStatus = SourceFreshnessStatus | "checking" | "unavailable";

export interface ExplicitUpdateLensPolicyInput {
  hasPublishedVersion: boolean;
  freshness: {
    status: ExplicitUpdateFreshnessStatus;
    changedPaths: readonly string[];
  };
  synchronizationStatus: SynchronizationStatus | null;
}

export type ExplicitUpdateLensDecisionReason =
  | "initialization"
  | "fresh"
  | "bounded-unknown"
  | "known-change"
  | "checking"
  | "unavailable"
  | "retry";

export interface ExplicitUpdateLensDecision {
  allowed: boolean;
  reason: ExplicitUpdateLensDecisionReason;
  message: string | null;
}

const BUILDER_DECISION_MESSAGE =
  "Current sources are stale. Use the Project Lens completion skill to update maintained Markdown or record no-change findings before Update Lens.";

/**
 * Decide whether the explicit UI refresh may start. This is deliberately
 * separate from `assessSourceFreshness`: an incomplete read is uncertain
 * evidence, not a failed action precondition, while an observed difference
 * remains a builder-owned synchronization decision.
 */
export function explicitUpdateLensPolicy(
  input: ExplicitUpdateLensPolicyInput,
): ExplicitUpdateLensDecision {
  if (!input.hasPublishedVersion) {
    return { allowed: true, reason: "initialization", message: null };
  }

  if (input.synchronizationStatus === "generation-failed") {
    return {
      allowed: false,
      reason: "retry",
      message: "Markdown is retained from a failed synchronization. Retry that operation before publishing another Lens.",
    };
  }

  if (input.freshness.status === "checking") {
    return {
      allowed: false,
      reason: "checking",
      message: "Current source freshness is still being checked. Wait for the check before Update Lens.",
    };
  }

  if (input.freshness.status === "unavailable") {
    return {
      allowed: false,
      reason: "unavailable",
      message: "Current source freshness could not be read. Refresh the workspace before Update Lens.",
    };
  }

  if (input.freshness.status === "stale" || input.freshness.changedPaths.length > 0) {
    return {
      allowed: false,
      reason: "known-change",
      message: BUILDER_DECISION_MESSAGE,
    };
  }

  if (input.freshness.status === "unknown") {
    return { allowed: true, reason: "bounded-unknown", message: null };
  }

  return { allowed: true, reason: "fresh", message: null };
}
