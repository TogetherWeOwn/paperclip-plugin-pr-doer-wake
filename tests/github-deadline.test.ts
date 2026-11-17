import { describe, expect, it } from "vitest";
import { advanceGithubDeadline, githubDeadline } from "../src/github-deadline.js";

describe("inert GitHub deadline arithmetic", () => {
  it.each([[100, 150], [150, 100], [100, 100]])("selects the earlier deadline (%i, %i)", (tick, operation) => {
    expect(advanceGithubDeadline(githubDeadline(tick, operation, 50), 50)).toMatchObject({ remainingMs: 50, expired: false });
  });

  it.each([100, 101])("expires at or after the exact boundary (%i)", (now) => {
    expect(advanceGithubDeadline(githubDeadline(100, 150, now), now)).toMatchObject({ remainingMs: 0, expired: true });
  });

  it("shares one decreasing budget across auth, fetch, body and retry", () => {
    let budget = githubDeadline(200, 180, 100);
    for (const [now, expected] of [[110, 70], [130, 50], [160, 20], [175, 5], [180, 0], [181, 0], [120, 0]] as const) {
      const result = advanceGithubDeadline(budget, now);
      expect(result.remainingMs).toBe(expected);
      expect(result.expired).toBe(expected === 0);
      budget = result.budget;
    }
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid timestamps (%s)", (invalid) => {
    expect(() => githubDeadline(invalid, 100, 0)).toThrow(RangeError);
    expect(() => githubDeadline(100, invalid, 0)).toThrow(RangeError);
    expect(() => githubDeadline(100, 100, invalid)).toThrow(RangeError);
    expect(() => advanceGithubDeadline(githubDeadline(100, 100, 0), invalid)).toThrow(RangeError);
    expect(() => advanceGithubDeadline({ deadline: invalid, observedAt: 0 }, 0)).toThrow(RangeError);
    expect(() => advanceGithubDeadline({ deadline: 100, observedAt: invalid }, 0)).toThrow(RangeError);
  });
});
