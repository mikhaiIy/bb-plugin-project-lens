import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { LensPanel } from "../components/lens-panel.js";
import type { LensPanelFixture } from "../components/lens-panel.js";
import {
  w03FixtureEnvironment,
  w03FixtureProject,
  w03FixtureVersions,
} from "../src/fixtures/w03-component-flow.js";
import "../app.css";

const fixture: LensPanelFixture = {
  project: w03FixtureProject,
  environment: w03FixtureEnvironment,
  versions: w03FixtureVersions,
  copy: {
    historyNotice: "Controlled fixture · synthetic multi-group/multi-level graph; provider output is not used.",
    freshnessDetail: "The controlled fixture is offline synthetic data; saved evidence remains available for inspection.",
    readOnlyError: "The controlled fixture is read-only. Select a real project workspace to update a Lens.",
    title: "Controlled fixture",
    detail: "Offline synthetic data for W03 verification. It exercises multiple groups, nested levels, comparison markers, and saved evidence.",
  },
};

function FixtureLensPanel() {
  return <LensPanel fixture={fixture} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "lens-fixture",
    title: "Project Lens fixture",
    icon: "Workflow",
    path: "lens-fixture",
    component: FixtureLensPanel,
  });
});
