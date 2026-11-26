import { describe, expect, it } from "vitest";
import { explicitUpdateLensPolicy } from "../src/refresh-policy.js";

function input(
  status: "fresh" | "stale" | "unknown" | "checking" | "unavailable",
  overrides: Partial<Parameters<typeof explicitUpdateLensPolicy>[0]> = {},
) {
  return {
    hasPublishedVersion: true,
    freshness: { status, changedPaths: [] },
    synchronizationStatus: null,
    ...overrides,
  } as Parameters<typeof explicitUpdateLensPolicy>[0];
}

describe("explicit Update Lens policy", () => {
  it("allows a bounded or legacy-unknown read to start another bounded refresh", () => {
    expect(explicitUpdateLensPolicy(input("unknown"))).toMatchObject({
      allowed: true,
      reason: "bounded-unknown",
    });
  });

  it("keeps known changes on the maintained-document path", () => {
    expect(explicitUpdateLensPolicy(input("unknown", {
      freshness: { status: "unknown", changedPaths: ["src/new-feature.ts"] },
    }))).toMatchObject({
      allowed: false,
      reason: "known-change",
      message: expect.stringContaining("maintained Markdown"),
    });
    expect(explicitUpdateLensPolicy(input("stale"))).toMatchObject({
      allowed: false,
      reason: "known-change",
    });
  });

  it("does not treat a pending check or failed read as a completed refresh boundary", () => {
    expect(explicitUpdateLensPolicy(input("checking"))).toMatchObject({ allowed: false, reason: "checking" });
    expect(explicitUpdateLensPolicy(input("unavailable"))).toMatchObject({ allowed: false, reason: "unavailable" });
  });

  it("preserves retry guidance after Markdown succeeded but generation failed", () => {
    expect(explicitUpdateLensPolicy(input("unknown", { synchronizationStatus: "generation-failed" }))).toMatchObject({
      allowed: false,
      reason: "retry",
      message: expect.stringContaining("Retry that operation"),
    });
  });

  it("allows Lens 0 creation without a prior freshness result", () => {
    expect(explicitUpdateLensPolicy({
      hasPublishedVersion: false,
      freshness: { status: "checking", changedPaths: [] },
      synchronizationStatus: null,
    })).toMatchObject({ allowed: true, reason: "initialization" });
  });
});
