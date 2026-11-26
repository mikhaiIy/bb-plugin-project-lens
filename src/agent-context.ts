import { flattenComponents } from "./diagram.js";
import type {
  LensVersion,
  ProjectLensSettings,
  SynchronizationResult,
} from "./model.js";

export interface AgentContextData {
  project: { id: string; name: string; kind: "personal" | "standard" };
  environment: {
    id: string;
    name: string | null;
    path: string | null;
    workspaceProvisionType: "managed-worktree" | "personal" | "unmanaged";
    branchName: string | null;
  };
  host: { id: string; name: string };
  settings: ProjectLensSettings;
  currentLens: LensVersion | null;
  latestSynchronization: SynchronizationResult | null;
}

export interface AgentContextSelection {
  enabled: boolean;
  skills: string[];
  tools: string[];
  instructions?: string;
}

function syncLine(sync: SynchronizationResult | null): string {
  if (sync === null) return "Last synchronization: none recorded; Update needed after implementation changes.";
  const detail = sync.error === null ? "" : ` (${sync.error})`;
  if (sync.status === "completed") {
    return `Last synchronization: completed, operation ${sync.operationId}${detail}; this is historical completion, not proof of current freshness.`;
  }
  return `Last synchronization: ${sync.status}, operation ${sync.operationId}${detail}; current freshness must be checked before claiming the Lens is current.`;
}

const COMPLETION_DIRECTIVE =
  "Completion directive: At a completed implementation boundary, use the project-lens-completion skill; assess current freshness, decide every maintained Markdown path, synchronize, and inspect the captured comparison.";
const FRESHNESS_WARNING =
  "Freshness warning: A passing build or idle thread is not synchronization. If current freshness is stale, say Update needed; if it is unknown, say Freshness needs context. Do not claim the latest Lens is current without a matching boundary.";

function boundedInstructionLines(required: string[], optional: string[], max = 4096): string {
  const selected = [...required];
  let omitted = 0;
  const retrievalReserve = "Context budget: 999 document or mapping metadata item(s) were omitted; retrieve bounded captured Markdown and section details with project_lens_compare before editing.".length;
  for (const line of optional) {
    const candidate = [...selected, line].join("\n");
    // Keep enough room for a truthful retrieval instruction whenever any
    // metadata is omitted. This prevents truncation from deleting the safety
    // directive at the end of a large project context.
    if (candidate.length + retrievalReserve + 1 <= max) {
      selected.push(line);
    } else {
      omitted += 1;
    }
  }
  if (omitted > 0) {
    const retrieval = `Context budget: ${omitted} document or mapping metadata item(s) were omitted; retrieve bounded captured Markdown and section details with project_lens_compare before editing.`;
    if ([...selected, retrieval].join("\n").length <= max) selected.push(retrieval);
  }
  return selected.join("\n");
}

/**
 * Build the project-conditioned instructions used by BB's synchronous
 * `agents.configure` callback. It contains identities and hashes, never raw
 * repository content, and is intentionally absent for disabled projects.
 */
export function buildProjectLensAgentSelection(data: AgentContextData): AgentContextSelection {
  const baseTools = ["project_lens_generate"];
  if (!data.settings.enabled || data.environment.path === null) {
    return { enabled: false, skills: [], tools: baseTools };
  }

  const currentLens = data.currentLens;
  const mappingLines = (currentLens === null
    ? []
    : flattenComponents(currentLens.graph)
        .flatMap((component) =>
          component.documentMappings.map(
            (mapping) => `${component.name} ← ${mapping.documentPath}#${mapping.sectionAnchor} (${mapping.relation})`,
          ),
        )
        .slice(0, 16));
  const documentLines = data.settings.documents.map(
    (document) => `- ${document.path} · ${document.maintenance}${document.purpose === undefined ? "" : ` · ${document.purpose}`}`,
  );
  const currentLine = currentLens === null
    ? "Current Lens: none; initialize Lens 0 before synchronizing a completed change."
    : `Current Lens: ${currentLens.id} (Lens ${currentLens.versionNumber}), configuration revision ${currentLens.configurationRevision}.`;
  const mappings = mappingLines.length === 0 ? ["Relevant mappings: none recorded yet."] : ["Relevant mappings:", ...mappingLines.map((line) => `- ${line}`)];
  const requiredLines = [
    `Project Lens context for project ${data.project.name} (${data.project.id}), environment ${data.environment.id}, host ${data.host.id}.`,
    `Workspace identity: ${data.environment.path} · ${data.environment.workspaceProvisionType} · branch ${data.environment.branchName ?? "detached"}.`,
    currentLine,
    syncLine(data.latestSynchronization),
    COMPLETION_DIRECTIVE,
    FRESHNESS_WARNING,
  ];
  const optionalLines = ["Configured Markdown:", ...documentLines, ...mappings];
  const instructions = boundedInstructionLines(requiredLines, optionalLines);

  return {
    enabled: true,
    skills: ["project-lens-completion"],
    tools: [
      ...baseTools,
      "project_lens_initialize",
      "project_lens_synchronize",
      "project_lens_synchronize_retry",
      "project_lens_compare",
    ],
    instructions,
  };
}
