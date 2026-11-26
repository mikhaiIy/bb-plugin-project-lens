import type { ProjectLensSettings } from "./model.js";

export type SettingsDraft = Pick<ProjectLensSettings, "enabled" | "documents">;
export type SettingsSyncDecision = "ignore" | "reload" | "conflict";

function hasDraftChanges(settings: ProjectLensSettings, draft: SettingsDraft): boolean {
  return (
    JSON.stringify({ enabled: settings.enabled, documents: settings.documents }) !==
    JSON.stringify(draft)
  );
}

function changedProjectId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("projectId" in payload)) return null;
  const projectId = (payload as { projectId?: unknown }).projectId;
  return typeof projectId === "string" ? projectId : null;
}

/**
 * Decide how the settings page handles one realtime notification. The
 * notification is project-scoped; a dirty same-project draft is never
 * replaced implicitly.
 */
export function settingsSyncDecision(
  payload: unknown,
  selectedProjectId: string,
  settings: ProjectLensSettings | null,
  draft: SettingsDraft,
): SettingsSyncDecision {
  if (changedProjectId(payload) !== selectedProjectId) return "ignore";
  return settings !== null && hasDraftChanges(settings, draft) ? "conflict" : "reload";
}

export function emptySettingsDraft(): SettingsDraft {
  return { enabled: false, documents: [] };
}
