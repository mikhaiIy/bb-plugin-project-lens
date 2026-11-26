import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { projectLensScopeFor } from "./src/model.js";
import type { DocumentSetting, ProjectLensScope, ProjectLensSettings, ProjectSummary } from "./src/model.js";
import { settingsSyncDecision } from "./src/settings-sync.js";
import { editorDraft, settingsValues, type DocumentDraft, type EditorDraft } from "./src/settings-draft.js";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { LensPanel } from "./components/lens-panel.js";
import "./app.css";

function SettingsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [settings, setSettings] = useState<ProjectLensSettings | null>(null);
  const [draft, setDraft] = useState<EditorDraft>(editorDraft);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [externalChangePending, setExternalChangePending] = useState(false);
  const [unsupportedScope, setUnsupportedScope] = useState<ProjectLensScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const settingsRequestRef = useRef(0);

  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const selectedProjectScope = selectedProject === undefined
    ? unsupportedScope
    : projectLensScopeFor(selectedProject);

  const loadProjects = useCallback(() => {
    setLoadingProjects(true);
    rpc.call("projects_list").then(
      (result) => {
        setProjects(result.projects);
        setSelectedProjectId((current) => current || result.projects[0]?.id || "");
        setError(null);
      },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    ).finally(() => setLoadingProjects(false));
  }, [rpc]);

  const loadSettings = useCallback(() => {
    const requestId = ++settingsRequestRef.current;
    if (selectedProjectId === "") {
      setSettings(null);
      setDraft(editorDraft());
      setUnsupportedScope(null);
      setLoadingSettings(false);
      return;
    }
    const project = projects.find((candidate) => candidate.id === selectedProjectId);
    if (project === undefined || project.kind !== "standard") {
      setSettings(null);
      setDraft(editorDraft());
      setUnsupportedScope(project === undefined ? null : projectLensScopeFor(project));
      setExternalChangePending(false);
      setNotice(null);
      setError(null);
      setLoadingSettings(false);
      return;
    }
    setLoadingSettings(true);
    rpc.call("settings_get", { projectId: selectedProjectId }).then(
      (next) => {
        if (requestId !== settingsRequestRef.current) return;
        if (!("enabled" in next)) {
          setSettings(null);
          setDraft(editorDraft());
          setUnsupportedScope(next.scope);
          setExternalChangePending(false);
          setNotice(null);
          setError(null);
          return;
        }
        setUnsupportedScope(null);
        setSettings(next);
        setDraft(editorDraft(next));
        setExternalChangePending(false);
        setNotice(null);
        setError(null);
      },
      (cause) => {
        if (requestId === settingsRequestRef.current) setError(cause instanceof Error ? cause.message : String(cause));
      },
    ).finally(() => {
      if (requestId === settingsRequestRef.current) setLoadingSettings(false);
    });
  }, [projects, rpc, selectedProjectId]);

  useEffect(() => loadProjects(), [loadProjects]);
  useEffect(() => loadSettings(), [loadSettings]);
  useRealtime("project-lens-settings-changed", (payload) => {
    const decision = settingsSyncDecision(payload, selectedProjectId, settings, settingsValues(draft));
    if (decision === "ignore") return;
    if (decision === "conflict") {
      setExternalChangePending(true);
      setNotice("This project's settings changed elsewhere. Your edits are kept; reload before saving.");
      return;
    }
    loadSettings();
  });

  const updateDocument = (index: number, patch: Partial<DocumentSetting>) => {
    setDraft((current) => ({
      ...current,
      documents: current.documents.map((document, documentIndex) =>
        documentIndex === index ? { ...document, ...patch } : document,
      ),
    }));
  };

  const addDocument = () => {
    const document: DocumentDraft = {
      rowId: crypto.randomUUID(),
      path: "docs/architecture.md",
      purpose: "",
      maintenance: "keep-updated",
    };
    setDraft((current) => ({
      ...current,
      documents: [...current.documents, document],
    }));
  };

  const removeDocument = (index: number) => {
    setDraft((current) => ({
      ...current,
      documents: current.documents.filter((_, documentIndex) => documentIndex !== index),
    }));
  };

  const save = async () => {
    if (settings === null || selectedProjectId === "") return;
    setSaving(true);
    setNotice(null);
    try {
      const next = await rpc.call("settings_save", {
        projectId: selectedProjectId,
        enabled: draft.enabled,
        documents: settingsValues(draft).documents.map((document) => ({
          ...document,
          ...(document.purpose?.trim() === "" ? { purpose: undefined } : {}),
        })),
        expectedRevision: settings.revision,
      });
      if (!("enabled" in next)) {
        setSettings(null);
        setDraft(editorDraft());
        setUnsupportedScope(next.scope);
        setExternalChangePending(false);
        setNotice(null);
        setError(null);
        return;
      }
      setSettings(next);
      setDraft(editorDraft(next));
      setExternalChangePending(false);
      setNotice(`Saved project configuration revision ${next.revision}.`);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const onProjectChange = (event: ChangeEvent<HTMLSelectElement>) => {
    settingsRequestRef.current += 1;
    setSelectedProjectId(event.target.value);
    setSettings(null);
    setDraft(editorDraft());
    setUnsupportedScope(null);
    setExternalChangePending(false);
    setNotice(null);
    setError(null);
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">Project Lens documents</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure exact project-relative Markdown paths. Capture resolves them against the
          selected BB environment and retains their bytes for each Lens version.
        </p>
      </div>

      {loadingProjects ? <p className="text-sm text-muted-foreground">Loading projects…</p> : null}
      {!loadingProjects && projects.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
          No BB projects are available.
        </p>
      ) : null}
      {projects.length > 0 ? (
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Project</span>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={selectedProjectId}
            onChange={onProjectChange}
            aria-label="Project"
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name} ({project.kind === "personal" ? "personal · unsupported" : project.kind})
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {selectedProjectScope?.status === "unsupported" ? (
        <div className="project-scope-notice" role="status" data-testid="unsupported-project-scope">
          <strong>Personal project is not supported</strong>
          <span>Select a standard BB project to configure Project Lens. No Project Lens settings or Lens records are created for Personal.</span>
        </div>
      ) : null}

      {loadingSettings && selectedProjectScope?.status === "supported" ? <p className="text-sm text-muted-foreground">Loading configuration…</p> : null}
      {settings !== null ? (
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          <label className="flex items-start gap-3 text-sm">
            <Checkbox
              checked={draft.enabled}
              onCheckedChange={(checked) => setDraft((current) => ({ ...current, enabled: checked === true }))}
              aria-label="Enable Project Lens"
            />
            <span>
              <span className="block font-medium">Enable Project Lens</span>
              <span className="text-muted-foreground">
                Allow capture and Lens generation for this project.
              </span>
              <span className="mt-2 block text-xs text-muted-foreground">
                Before analysis, the selected BB provider uses edit-capable accept-edits access in the host&apos;s configured unmanaged checkout. This is not a detached read-only sandbox; Project Lens bounds evidence and validates citations but cannot enforce provider filesystem permissions. Start with a disposable project and use BB&apos;s normal approval controls.
              </span>
            </span>
          </label>

          <div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-medium">Maintained Markdown</h4>
                <p className="text-xs text-muted-foreground">
                  Reference-only documents inform analysis but are not rewritten by synchronization.
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addDocument}>
                Add document
              </Button>
            </div>
            <div className="mt-3 space-y-3">
              {draft.documents.length === 0 ? (
                <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                  No Markdown paths configured.
                </p>
              ) : null}
              {draft.documents.map((document, index) => (
                <div key={document.rowId} className="grid gap-2 rounded-md border border-border p-3">
                  <Input
                    value={document.path}
                    onChange={(event) => updateDocument(index, { path: event.target.value })}
                    placeholder="docs/architecture.md"
                    aria-label={`Markdown path ${index + 1}`}
                  />
                  <Input
                    value={document.purpose ?? ""}
                    onChange={(event) => updateDocument(index, { purpose: event.target.value })}
                    placeholder="Purpose (optional)"
                    aria-label={`Markdown purpose ${index + 1}`}
                  />
                  <div className="flex items-center justify-between gap-2">
                    <select
                      className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                      value={document.maintenance}
                      onChange={(event) =>
                        updateDocument(index, {
                          maintenance: event.target.value as DocumentSetting["maintenance"],
                        })
                      }
                      aria-label={`Maintenance mode ${index + 1}`}
                    >
                      <option value="keep-updated">Keep updated</option>
                      <option value="reference-only">Reference only</option>
                    </select>
                    <Button type="button" variant="ghost" size="sm" onClick={() => removeDocument(index)}>
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <span className="text-xs text-muted-foreground">Configuration revision {settings.revision}</span>
            <Button type="button" onClick={save} disabled={saving || loadingSettings}>
              {saving ? "Saving…" : "Save configuration"}
            </Button>
          </div>
        </div>
      ) : null}

      {notice === null ? null : (
        <div className="flex items-center justify-between gap-3 text-sm">
          <p className={externalChangePending ? "text-amber-600" : "text-emerald-600"}>{notice}</p>
          {externalChangePending ? (
            <Button type="button" variant="outline" size="sm" onClick={loadSettings}>
              Reload configuration
            </Button>
          ) : null}
        </div>
      )}
      {error === null ? null : <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "lens",
    title: "Project Lens",
    icon: "Workflow",
    path: "lens",
    component: LensPanel,
  });
  app.slots.settingsSection({
    id: "project-settings",
    title: "Project documents",
    description: "Choose the Markdown documents Project Lens reads and maintains per project.",
    component: SettingsPage,
  });
});
