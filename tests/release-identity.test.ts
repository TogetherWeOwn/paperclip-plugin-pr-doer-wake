import { describe, expect, it } from "vitest";
import { validReleaseIdentity, type ReleaseIdentity } from "../src/release-identity.js";

const identity: ReleaseIdentity = {
  confirmationId: "12345678-1234-1234-1234-123456789abc",
  repo: "example/repo.name",
  sha: "a".repeat(40),
  stagingRunId: "12345678901234567890",
  stagingRunAttempt: 1,
  expiresAt: "2028-02-29T12:34:56Z",
};

describe("validReleaseIdentity", () => {
  it("accepts canonical identities including boundary values", () => {
    expect(validReleaseIdentity(identity)).toBe(true);
    expect(validReleaseIdentity({ ...identity, stagingRunId: "1", stagingRunAttempt: 2147483647 })).toBe(true);
  });

  it.each([
    ["confirmationId", "12345678-1234-1234-1234-123456789ABC"],
    ["confirmationId", "invalid"],
    ["repo", "Example/repo"], ["repo", "example/."], ["repo", "example/.."], ["repo", "example"],
    ["sha", "A".repeat(40)], ["sha", "a".repeat(39)],
    ["stagingRunId", "0"], ["stagingRunId", "01"], ["stagingRunId", "1".repeat(21)],
    ["stagingRunAttempt", 0], ["stagingRunAttempt", 1.5], ["stagingRunAttempt", 2147483648],
    ["expiresAt", "2028-02-30T12:34:56Z"], ["expiresAt", "2028-02-29T12:34:56.000Z"],
    ["expiresAt", "2028-02-29T12:34:56+00:00"],
  ])("rejects noncanonical %s: %s", (key, value) => {
    expect(validReleaseIdentity({ ...identity, [key]: value })).toBe(false);
  });

  it("rejects missing and non-object values", () => {
    expect(validReleaseIdentity(null as unknown as ReleaseIdentity)).toBe(false);
    expect(validReleaseIdentity({} as ReleaseIdentity)).toBe(false);
  });
});
