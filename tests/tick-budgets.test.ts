import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/ci-runtime.js";
import { GATES_LIMITS } from "../src/gates-runtime.js";
import { CUSTODY_LIMITS } from "../src/custody-runtime.js";
import { DEPENDENCY_WAKE_LIMITS } from "../src/dependency-wake.js";

describe("scheduled job tick budgets", () => {
  it.each([
    ["ci", LIMITS.tickMs],
    ["gates", GATES_LIMITS.tickMs],
    ["custody", CUSTODY_LIMITS.tickMs],
    ["dependency", DEPENDENCY_WAKE_LIMITS.tickMs],
  ])("leaves at least 60 seconds of host timeout margin for %s", (_loop, tickMs) => {
    expect(tickMs).toBeLessThanOrEqual(300_000 - 60_000);
  });
});
