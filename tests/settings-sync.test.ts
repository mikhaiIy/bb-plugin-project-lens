import { describe, expect, it } from "vitest";
import { settingsSyncDecision } from "../src/settings-sync.js";
import type { ProjectLensSettings } from "../src/model.js";

const settings: ProjectLensSettings = {
  projectId: "proj_one",
  enabled: true,
  documents: [{ path: "docs/architecture.md", maintenance: "keep-updated" }],
  revision: 3,
  updatedAt: 10,
};

describe("project-scoped settings realtime reconciliation", () => {
  it("ignores notifications for another project", () => {
    expect(
      settingsSyncDecision(
        { projectId: "proj_two", revision: 4 },
        "proj_one",
        settings,
        { enabled: false, documents: [] },
      ),
    ).toBe("ignore");
  });

  it("reloads a clean draft for the selected project", () => {
    expect(
      settingsSyncDecision(
        { projectId: "proj_one", revision: 4 },
        "proj_one",
        settings,
        { enabled: true, documents: settings.documents },
      ),
    ).toBe("reload");
  });

  it("keeps a dirty draft and reports a same-project conflict", () => {
    expect(
      settingsSyncDecision(
        { projectId: "proj_one", revision: 4 },
        "proj_one",
        settings,
        { enabled: false, documents: settings.documents },
      ),
    ).toBe("conflict");
  });
});
