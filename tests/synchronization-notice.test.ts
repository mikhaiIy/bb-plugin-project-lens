import { describe, expect, it } from "vitest";
import { synchronizationNoticeStatus } from "../src/synchronization-notice.js";

function input(overrides: Partial<Parameters<typeof synchronizationNoticeStatus>[0]> = {}) {
  return {
    projectScopeSupported: true,
    hasSelectedEnvironment: true,
    hasLoadedLens: true,
    synchronization: null,
    freshnessStatus: "unknown" as const,
    ...overrides,
  };
}

describe("synchronization notice eligibility", () => {
  it("suppresses freshness claims outside a supported selected scope or before a Lens is loaded", () => {
    expect(synchronizationNoticeStatus(input({
      projectScopeSupported: false,
      hasLoadedLens: false,
      synchronization: { status: "generation-failed" },
    }))).toBeNull();
    expect(synchronizationNoticeStatus(input({
      hasSelectedEnvironment: false,
      hasLoadedLens: false,
      synchronization: { status: "conflict" },
    }))).toBeNull();
    expect(synchronizationNoticeStatus(input({ hasLoadedLens: false }))).toBeNull();
    expect(synchronizationNoticeStatus(input({}))).toBe("unknown");
  });

  it("keeps operation recovery states visible before initial Lens publication", () => {
    for (const status of ["pending", "documents-written", "generation-failed", "conflict", "failed"] as const) {
      expect(synchronizationNoticeStatus(input({ hasLoadedLens: false, synchronization: { status } }))).toBe(status);
    }
  });

  it("does not turn an unloaded completed operation into a current-source claim", () => {
    expect(synchronizationNoticeStatus(input({ hasLoadedLens: false, synchronization: { status: "completed" } }))).toBe("completed-unloaded");
    expect(synchronizationNoticeStatus(input({ synchronization: { status: "completed" }, freshnessStatus: "unknown" }))).toBe("completed-unknown");
  });
});
