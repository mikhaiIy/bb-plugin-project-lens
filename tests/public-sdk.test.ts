import { describe, expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

describe("standalone package imports", () => {
  it("does not depend on private BB packages or paths outside the package", () => {
    const result = experimental_scanPublicSdkOnly(process.cwd(), {
      allow: [
        /^@\//,
        /^(?:react|react-dom|better-sqlite3|zod|clsx|tailwind-merge|class-variance-authority)$/,
        /^@(?:radix-ui|hugeicons)\//,
      ],
    });
    expect(result.violations).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });
});
