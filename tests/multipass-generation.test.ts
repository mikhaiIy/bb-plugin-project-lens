import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import type { GenerationJobView, GenerationOutput } from "../src/generation-jobs.js";

async function setup(mode: "valid" | "bad-citation" | "bad-membership" | "cancel") {
  const project = { id: "multipass", name: "Multi-pass", kind: "standard" as const };
  const env = { id: "multipass-env", projectId: project.id, hostId: "host", status: "ready" as const, path: "/synthetic/multipass", workspaceProvisionType: "unmanaged" as const, branchName: "main" };
  const paths = Array.from({ length: 258 }, (_, i) => `src/module-${String(i).padStart(3, "0")}.ts`);
  const files = new Map(paths.map((path, i) => [path, `export function operation${i}() { return ${i}; }\n`]));
  const prompts = new Map<string, string>(); const archived: string[] = [], stopped: string[] = [];
  let phase = 0;
  const { bb, harness } = createFakePluginHost({    
pluginId: "project-lens", sdk: {
      projects: { get: async () => project, list: async () => [project], defaultExecutionOptions: async () => ({ providerId: "test-provider", model: "test-model", permissionMode: "accept-edits", reasoningLevel: "none", serviceTier: "default" }) },
      environments: { get: async () => env }, hosts: { get: async () => ({ id: "host", name: "Host", status: "connected", type: "persistent" }) },
      files: {        
listPaths: async () => ({ paths: paths.map(path => ({ path, name: path.split("/").pop()!, kind: "file", positions: [], score: 0 })), truncated: false }), read: async ({ path }) => {
          const text = files.get(path.replace(env.path + "/", ""))!;
          return { content: text, contentEncoding: "utf8", path, sha256: createHash("sha256").update(text).digest("hex"), sizeBytes: Buffer.byteLength(text), mimeType: "text/typescript" };
        }      
},
      threads: {
        spawn: async args => { phase++; const id = `worker-${phase}`; prompts.set(id, args.prompt as string); return makeThreadResponse({ id, providerId: "test-provider" }); },
        wait: async args => {
          if (mode === "cancel" && phase === 2) await new Promise<void>((_, reject) => { const cancel = () => reject(new DOMException("Cancelled", "AbortError")); if (args.signal?.aborted) cancel(); else args.signal?.addEventListener("abort", cancel, { once: true }); });
          return { matched: true, threadId: args.threadId, target: { kind: "status", status: "idle" }, thread: makeThreadResponse({ id: args.threadId, status: "idle" }) };
        },
        output: async ({ threadId }) => {
          const prompt = prompts.get(threadId)!;
          if (prompt.startsWith("You are the Project Lens architecture assembler.")) {
            const components = JSON.parse(prompt.split("\n").find(l => l.startsWith("Components: "))!.slice(12)) as Array<{ id: string, evidenceIds: string[] }>;
            return {              
output: JSON.stringify({                
subsystems: [
                  { key: "delivery", name: "Delivery", responsibility: "Handles work", componentIds: components.slice(0, 2).map(c => c.id) },
                  { key: "state", name: "State", responsibility: "Stores work", componentIds: components.slice(2).map(c => c.id) },
                ].map((g, i) => mode === "bad-membership" && i === 1 ? { ...g, componentIds: ["fabricated"] } : g), connections: [{ fromId: components[1]!.id, toId: components[3]!.id, type: "calls", direction: "forward", label: "Calls the second batch", evidenceIds: [components[1]!.evidenceIds[0]] }], unknownAreas: []              
})            
};
          }
          const sources = JSON.parse(prompt.split("\nEvidence sources:\n")[1]!) as Array<{ path: string }>;
          const selected = sources.slice(0, threadId === "worker-1" ? 3 : 1);
          return { output: JSON.stringify({ components: selected.map(source => ({ key: source.path, name: source.path, responsibility: "Owns " + source.path, state: "implemented", provenance: "extracted", evidence: [{ kind: "code", path: mode === "bad-citation" && threadId === "worker-2" ? paths[0] : source.path, claim: "Defines operation", startLine: 1, endLine: 1, provenance: "extracted" }] })), connections: threadId === "worker-1" ? [{ key: "call", fromKey: selected[0]!.path, toKey: selected[1]!.path, type: "calls", direction: "forward", label: "Handles work", state: "implemented", provenance: "extracted", evidence: [{ kind: "code", path: selected[0]!.path, claim: "Defines operation", startLine: 1, endLine: 1, provenance: "extracted" }] }] : [], unknownAreas: [] }) };
        },
        archive: async ({ threadId }) => { archived.push(threadId); return { ok: true }; }, stop: async ({ threadId }) => { stopped.push(threadId); return { ok: true }; },
      },
    }  
});
  await plugin(bb);
  await harness.behavior.callRpc("settings_save", { projectId: project.id, enabled: true, documents: [], expectedRevision: 0 });
  return { harness, project, env, prompts, archived, stopped };
}
const scope = { projectId: "multipass", environmentId: "multipass-env" };
const args = { ...scope, expectedParentVersionId: null };

describe("multi-pass production RPC", () => {
  it("supplies every source once, assembles an openable hierarchy, and persists exact coverage", async () => {
    const t = await setup("valid");
    try {
      const output = await t.harness.behavior.callRpc("lens_generate", args) as GenerationOutput;
      expect(t.prompts.size).toBe(3);
      const sources = [...t.prompts.values()].filter(p => p.includes("\nEvidence sources:\n")).flatMap(p => JSON.parse(p.split("\nEvidence sources:\n")[1]!) as Array<{ path: string }>);
      expect(sources).toHaveLength(258); expect(new Set(sources.map(s => s.path)).size).toBe(258);
      expect(output.lens.analysisCoverage).toMatchObject({ evidencePasses: 2, architectureAssembled: true });
      expect(output.lens.analysisCoverage?.suppliedSourceIds).toHaveLength(258);
      expect(output.lens.analysisCoverage?.unrepresentedSourceIds).toHaveLength(254);
      expect(output.lens.graph.components.filter(c => c.parentId === null).map(c => c.name)).toEqual(["Delivery", "State"]);
      expect(output.lens.graph.components.filter(c => c.parentId !== null)).toHaveLength(4);
      expect(output.lens.graph.connections.some(connection => connection.id.startsWith("overview:"))).toBe(true);
      expect(output.job.passes).toHaveLength(3);
      expect(t.archived).toEqual(["worker-1", "worker-2", "worker-3"]); expect(t.stopped).toEqual(t.archived);
      const reopened = await t.harness.behavior.callRpc("lens_current", scope) as { lens: GenerationOutput["lens"] };
      expect(reopened.lens.analysisCoverage).toEqual(output.lens.analysisCoverage);
      expect(output.lens.coverage.complete).toBe(false);
    } finally { await t.harness.lifecycle.dispose(); }
  });
  it.each(["bad-citation", "bad-membership"] as const)("rejects %s without publishing partial work", async mode => {
    const t = await setup(mode);
    try {
      await expect(t.harness.behavior.callRpc("lens_generate", args)).rejects.toThrow(mode === "bad-citation" ? "supplied to the provider analysis prompt" : "unknown component");
      const current = await t.harness.behavior.callRpc("lens_current", scope) as { lens: unknown }; expect(current.lens).toBeNull();
      expect(t.stopped).toHaveLength(mode === "bad-citation" ? 2 : 3); expect(t.archived).toEqual(t.stopped);
    } finally { await t.harness.lifecycle.dispose(); }
  });
  it("reports pass progress and cancels the second worker without synthesis or publication", async () => {
    const t = await setup("cancel");
    try {
      const job = await t.harness.behavior.callRpc("lens_generate_start", args) as GenerationJobView;
      let status = job;
      for (let i = 0; i < 30; i++) {
        status = await t.harness.behavior.callRpc("lens_generate_status", { ...scope, operationId: job.operationId }) as GenerationJobView;
        if (status.progress?.pass === 2) break;
        await new Promise(r => setTimeout(r, 0));
      }
      expect(status.progress).toEqual({ phase: "evidence", pass: 2, totalPasses: 2, analyzedSources: 256, totalSources: 258 });
      await t.harness.behavior.callRpc("lens_generate_cancel", { ...scope, operationId: job.operationId });
      for (let i = 0; i < 30; i++) {
        status = await t.harness.behavior.callRpc("lens_generate_status", { ...scope, operationId: job.operationId }) as GenerationJobView;
        if (status.status === "cancelled") break; await new Promise(r => setTimeout(r, 0));
      }
      expect(status.status).toBe("cancelled"); expect(status.result).toBeNull(); expect(status.analysis?.passes).toHaveLength(2);
      expect(t.prompts.size).toBe(2); expect(t.stopped).toEqual(["worker-1", "worker-2"]);
    } finally { await t.harness.lifecycle.dispose(); }
  });
});
