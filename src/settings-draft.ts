import type { DocumentSetting } from "./model.js";
import { emptySettingsDraft, type SettingsDraft } from "./settings-sync.js";

export type DocumentDraft = DocumentSetting & { rowId: string };
export type EditorDraft = { enabled: boolean; documents: DocumentDraft[] };

export function editorDraft(settings: SettingsDraft = emptySettingsDraft()): EditorDraft {
  return {
    enabled: settings.enabled,
    documents: settings.documents.map((document) => ({ ...document, rowId: crypto.randomUUID() })),
  };
}

// Row identity belongs to the editor, not to project settings or their CAS comparison.
export function settingsValues(draft: EditorDraft): SettingsDraft {
  return {
    enabled: draft.enabled,
    documents: draft.documents.map(({ rowId: _rowId, ...document }) => document),
  };
}

