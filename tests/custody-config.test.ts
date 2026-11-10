import { describe, expect, it } from "vitest";
import { parseCustodyConfig, validateCustodyConfig } from "../src/custody-config.js";

const ref = { type: "secret_ref", secretId: "aaaaaaaa-0000-4000-8000-000000000001" };
const app = { githubAppId: "123", githubInstallationId: "456", githubAppPrivateKeySecretRef: ref };
const base = {
  custodyEnabled: true,
  custodyCompanyId: "bbbbbbbb-0000-4000-8000-000000000002",
  custodySummaryAgentId: "cccccccc-0000-4000-8000-000000000003",
  custodyOrg: "Acme",
  custodyClosedSince: "2026-01-01T00:00:00Z",
};

describe("custody authentication configuration", () => {
  it("accepts the bearer mode and the App mode independently", () => {
    expect(validateCustodyConfig({ ...base, githubTokenSecretRef: ref })).toEqual([]);
    expect(validateCustodyConfig({ ...base, ...app })).toEqual([]);
    expect(parseCustodyConfig({ ...base, githubTokenSecretRef: ref })?.tokenRef?.secretId).toBe(ref.secretId);
    const parsed = parseCustodyConfig({ ...base, ...app });
    expect(parsed?.tokenRef).toBeNull();
    expect(parsed?.githubApp).toEqual({ appId: "123", installationId: "456", privateKeySecretRef: ref });
  });

  it("requires exactly one complete mode", () => {
    expect(validateCustodyConfig(base)).toEqual(["custody requires exactly one authentication mode: githubTokenSecretRef OR githubAppId, githubInstallationId and githubAppPrivateKeySecretRef"]);
    expect(validateCustodyConfig({ ...base, githubTokenSecretRef: ref, ...app })).toEqual(["custody requires exactly one authentication mode: githubTokenSecretRef OR githubAppId, githubInstallationId and githubAppPrivateKeySecretRef"]);
    expect(validateCustodyConfig({ ...base, githubAppId: "123" })).toEqual(["custody requires exactly one authentication mode: githubTokenSecretRef OR githubAppId, githubInstallationId and githubAppPrivateKeySecretRef"]);
    expect(validateCustodyConfig({ ...base, githubTokenSecretRef: "raw-token" })).toEqual(["custody requires exactly one authentication mode: githubTokenSecretRef OR githubAppId, githubInstallationId and githubAppPrivateKeySecretRef"]);
  });

  it("lowercases the org and stays disabled without custodyEnabled", () => {
    expect(parseCustodyConfig({ ...base, ...app })?.org).toBe("acme");
    expect(validateCustodyConfig({ ...base, custodyEnabled: false })).toEqual([]);
    expect(parseCustodyConfig({ ...base, custodyEnabled: false })).toBeNull();
  });
});
