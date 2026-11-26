import { describe, expect, it } from "vitest";
import { editorDraft, settingsValues } from "../src/settings-draft.js";
import { projectLensSettingsInputSchema, type ProjectLensSettings } from "../src/model.js";
import { settingsSyncDecision } from "../src/settings-sync.js";

const settings: ProjectLensSettings = {
  projectId: "draft-project",
  enabled: false,
  documents: [{ path: "docs/components.md", purpose: "Component boundaries", maintenance: "reference-only" }],
  revision: 2,
  updatedAt: 10,
};

describe("document editor identity and settings boundaries", () => {
  it("keeps row identity out of the strict save payload and clean-draft comparison", () => {
    const draft = editorDraft(settings);
    expect(draft.documents[0]!.rowId).toBeTruthy();
    const values = settingsValues(draft);
    expect(projectLensSettingsInputSchema.parse({ ...values, expectedRevision: settings.revision })).toEqual({
      enabled: settings.enabled,
      documents: settings.documents,
      expectedRevision: settings.revision,
    });
    expect(settingsSyncDecision({ projectId: settings.projectId }, settings.projectId, settings, values)).toBe("reload");

    draft.documents[0]!.path = "docs/project-components.md";
    const edited = settingsValues(draft);
    expect(projectLensSettingsInputSchema.parse({ ...edited, expectedRevision: settings.revision }).documents[0]!.path).toBe("docs/project-components.md");
    expect(settingsSyncDecision({ projectId: settings.projectId }, settings.projectId, settings, edited)).toBe("conflict");
    expect(settings.documents[0]!.path).toBe("docs/components.md");
  });

  it("distinguishes rows with the same initial path without changing their saved fields", () => {
    const documents = [settings.documents[0]!, settings.documents[0]!];
    const draft = editorDraft({ enabled: false, documents });
    expect(new Set(draft.documents.map((row) => row.rowId)).size).toBe(2);
    expect(settingsValues(draft)).toEqual({ enabled: false, documents });
  });
});
