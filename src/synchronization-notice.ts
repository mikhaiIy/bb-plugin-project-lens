import type { SourceFreshnessStatus } from "./diagram.js";
import type { SynchronizationResult, SynchronizationStatus } from "./model.js";

export type SynchronizationNoticeFreshnessStatus = SourceFreshnessStatus | "checking" | "unavailable";

export type SynchronizationNoticeStatus =
  | SynchronizationStatus
  | Exclude<SourceFreshnessStatus, "fresh">
  | "unavailable"
  | "completed-stale"
  | "completed-unknown"
  | "completed-unavailable"
  | "completed-checking"
  | "completed-unloaded";

export interface SynchronizationNoticeDecisionInput {
  projectScopeSupported: boolean;
  hasSelectedEnvironment: boolean;
  hasLoadedLens: boolean;
  synchronization: Pick<SynchronizationResult, "status"> | null;
  freshnessStatus: SynchronizationNoticeFreshnessStatus;
}

/**
 * Freshness-only notices need both a supported, selected scope and a loaded
 * Lens. Operation records remain visible on a supported scope even before a
 * Lens is loaded so failures and their recovery instructions are not hidden.
 */
export function synchronizationNoticeStatus(
  input: SynchronizationNoticeDecisionInput,
): SynchronizationNoticeStatus | null {
  if (!input.projectScopeSupported || !input.hasSelectedEnvironment) return null;

  if (input.synchronization !== null) {
    if (input.synchronization.status !== "completed") return input.synchronization.status;
    if (!input.hasLoadedLens) return "completed-unloaded";
    return input.freshnessStatus === "fresh"
      ? "completed"
      : input.freshnessStatus === "stale"
        ? "completed-stale"
        : input.freshnessStatus === "unknown"
          ? "completed-unknown"
          : input.freshnessStatus === "unavailable"
            ? "completed-unavailable"
            : "completed-checking";
  }

  if (!input.hasLoadedLens) return null;
  return input.freshnessStatus === "stale" || input.freshnessStatus === "unknown" || input.freshnessStatus === "unavailable"
    ? input.freshnessStatus
    : null;
}
