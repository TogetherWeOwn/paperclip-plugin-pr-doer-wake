import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import manifest, { registrationTool } from "../src/manifest.js";
import { parseCiConfig, parseRegistration, validateCiConfig, workspaceRepo } from "../src/ci-config.js";
import { collectSecretRefPaths, validateInstanceConfig } from "./fixtures/host-config-validator.js";

const ref = { type: "secret_ref", secretId: "aaaaaaaa-0000-4000-8000-000000000001" };
const enabled = { enabled: true, allowedRepos: ["example/project"], githubTokenSecretRef: ref };
const registration = { issueId: "aaaaaaaa-0000-4000-8000-000000000001", repo: "example/project", prNumber: 42, headSha: "a".repeat(40) };

describe("stock manifest and config contract", () => {
  it("passes the pinned stock manifest schema with only the accepted capability envelope", () => {
    expect(pluginManifestV1Schema.safeParse(manifest).success).toBe(true);
    expect(new Set(manifest.capabilities)).toEqual(new Set([
      "webhooks.receive", "jobs.schedule", "issues.read", "issues.wakeup", "issues.checkout", "execution.workspaces.read",
      "agent.tools.register", "plugin.state.read", "plugin.state.write", "http.outbound", "secrets.read-ref",
      "issues.create", "issue.documents.read", "issue.documents.write", "issue.relations.read",
      "projects.read", "project.workspaces.read", "database.namespace.read", "database.namespace.migrate", "events.subscribe",
    ]));
    expect(manifest.database?.coreReadTables).toEqual(["issues", "issue_comments", "issue_documents"]);
    expect(manifest.jobs?.find((job) => job.jobKey === "pr-custody")?.schedule).toBe("17 * * * *");
    expect(manifest.tools?.map((tool) => tool.name)).toEqual(["ci_wait_register"]);
    expect(manifest.jobs?.[0]?.schedule).toBe("*/15 * * * *");
  });

  it("accepts disabled defaults and allowlist revocation but refuses enabling an empty allowlist", () => {
    for (const config of [{}, { enabled: false, allowedRepos: [] }, { enabled: false, dryRun: true, allowedRepos: [] }]) {
      expect(validateInstanceConfig(config, manifest.instanceConfigSchema!).valid).toBe(true);
      expect(validateCiConfig(config)).toEqual([]);
    }
    expect(validateCiConfig({ ...enabled, allowedRepos: [] }).length).toBeGreaterThan(0);
  });

  it("accepts actual secret-picker objects without requiring a webhook in polling mode", () => {
    expect(validateInstanceConfig(enabled, manifest.instanceConfigSchema!).valid).toBe(true);
    expect(validateCiConfig(enabled)).toEqual([]);
    expect(collectSecretRefPaths(manifest.instanceConfigSchema)).toEqual(new Set(["githubTokenSecretRef", "githubAppPrivateKeySecretRef", "webhookSecretRef"]));
    expect(parseCiConfig(enabled)).toMatchObject({ dryRun: true, webhooksEnabled: false });
    expect(validateCiConfig({ ...enabled, webhooksEnabled: true })).toContain("webhooksEnabled requires webhookSecretRef");
    expect(validateCiConfig({ ...enabled, webhooksEnabled: true, webhookSecretRef: ref })).toEqual([]);
  });

  it("accepts custody fields alongside either authentication mode in the combined configuration", () => {
    const app = { enabled: true, allowedRepos: ["example/project"], githubAppId: "123", githubInstallationId: "456", githubAppPrivateKeySecretRef: ref };
    expect(validateCiConfig({ ...enabled, custodyEnabled: false })).toEqual([]);
    expect(validateCiConfig({ ...enabled, custodyEnabled: false, custodyDryRun: true })).toEqual([]);
    expect(validateCiConfig({ ...app, custodyEnabled: false })).toEqual([]);
    expect(validateCiConfig({ ...enabled, custodyEnabled: false, custodyTypo: true }).length).toBeGreaterThan(0);
  });

  it("accepts App secret-picker fields and rejects partial or ambiguous authentication at both validation layers", () => {
    const app = { enabled: true, allowedRepos: ["example/project"], githubAppId: "123", githubInstallationId: "456", githubAppPrivateKeySecretRef: ref };
    expect(validateInstanceConfig(app, manifest.instanceConfigSchema!).valid).toBe(true);
    expect(validateCiConfig(app)).toEqual([]);
    for (const config of [
      { ...app, githubTokenSecretRef: ref }, { ...app, githubAppPrivateKeySecretRef: "raw" },
      { enabled: false, githubAppId: "123" }, { enabled: true, allowedRepos: ["example/project"] },
    ]) {
      expect(validateInstanceConfig(config, manifest.instanceConfigSchema!).valid).toBe(false);
      expect(validateCiConfig(config).length).toBeGreaterThan(0);
    }
  });

  it("rejects raw credentials, legacy heuristic settings and malformed resource configuration", () => {
    for (const config of [
      { ...enabled, githubTokenSecretRef: "a-raw-credential" },
      { ...enabled, githubTokenSecretRef: { ...ref, token: "secret" } },
      { ...enabled, branchIdentifierPattern: ".*" },
      { ...enabled, allowedRepos: ["https://github.com/example/project"] },
      { ...enabled, allowedRepos: ["example/project/extra"] },
      { ...enabled, repoMedianMs: { "example/project": -1 } },
    ]) expect(validateInstanceConfig(config, manifest.instanceConfigSchema!).valid).toBe(false);
    expect(validateCiConfig({ ...enabled, allowedRepos: ["example/.."] }).length).toBeGreaterThan(0);
    expect(validateCiConfig({ ...enabled, repoMedianMs: { "example/project": NaN } }).length).toBeGreaterThan(0);
  });

  it("uses closed argument schemas and runtime parsing rather than model trust", () => {
    expect(registrationTool.parametersSchema.additionalProperties).toBe(false);
    expect(parseRegistration(registration)).toEqual(registration);
    for (const params of [null, [], "register", {}, { ...registration, token: "secret" }, { ...registration, prNumber: 1.5 }, { ...registration, prNumber: Infinity }, { ...registration, headSha: "main" }, { ...registration, repo: "example/%2e%2e" }, { ...registration, repo: "example/project\n" }, { ...registration, issueId: "issue" }]) {
      expect(() => parseRegistration(params)).toThrow("invalid_registration");
    }
  });

  it("matches exact GitHub origins and refuses credential-bearing or spoofed workspace URLs", () => {
    expect(workspaceRepo("https://github.com/example/project.git")).toBe("example/project");
    expect(workspaceRepo("git@github.com:example/project.git")).toBe("example/project");
    for (const url of ["https://github.com.evil.test/example/project", "https://secret@github.com/example/project", "https://github.com/example/project?token=secret", "https://evil.test/example/project", "https://github.com/example/project/other", null]) expect(workspaceRepo(url)).toBeNull();
  });
});
