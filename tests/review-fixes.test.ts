import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { mayAct, parseEvent, isGatingCheck } from "../src/github.js";
import { resolveCard } from "../src/waker.js";
import manifest from "../src/manifest.js";

const repo = "togetherweown/two-web-next";
const signal = { repo, number: 12, head: "abc", headRef: null, state: "ci_red" as const, url: `https://github.com/${repo}/pull/12`, draft: false, trusted: true, detail: {} };
const config = parseConfig({});
const item = (id: string, description: string) => ({ id, identifier: `TOG-${id}`, status: "in_progress", projectId: "project", title: "title", description });
const ctx = (items: any[], commentRows: any[] = []) => ({
  db: { query: async (_sql: string) => commentRows },
  projects: { list: async () => [{ id: "project" }], listWorkspaces: async () => [{ repoUrl: `https://github.com/${repo}.git` }] },
  issues: { list: async ({ projectId, status, limit }: any) => items.filter((i) => i.projectId === projectId && i.status === status).slice(0, limit), get: async (id: string) => items.find((i) => i.id === id) ?? null },
}) as any;

describe("review fixes", () => {
  it("resolves PR URLs in descriptions and holds conflicting candidates", async () => {
    const owner = item("1", `PR: https://github.com/${repo}/pull/12`);
    expect(await resolveCard(ctx([owner]), "company", config, signal)).toMatchObject({ kind: "card", card: { id: "1" } });
    expect(await resolveCard(ctx([owner], [item("2", "")]), "company", config, signal)).toMatchObject({ kind: "ambiguous" });
  });
  it("finds a title link after more than one hundred issues", async () => {
    const items = Array.from({ length: 150 }, (_, i) => item(String(i), "unrelated"));
    items.push({ ...item("200", ""), title: `See https://github.com/${repo}/pull/12` });
    expect(await resolveCard(ctx(items), "company", config, signal)).toMatchObject({ kind: "card", card: { id: "200" } });
  });
  it("reads full descriptions when the list contains a truncated preview", async () => {
    const owner = item("200", `PR: https://github.com/${repo}/pull/12`);
    const c = ctx([item("200", "preview")]);
    c.issues.get = async () => owner;
    expect(await resolveCard(c, "company", config, signal)).toMatchObject({ kind: "card", card: { id: "200" } });
  });
  it("does not match URL prefixes or links embedded in another URL", async () => {
    const items = [item("1", `https://github.com/${repo}/pull/123`), item("2", `https://evil.test/?url=https://github.com/${repo}/pull/12`)];
    expect(await resolveCard(ctx(items), "company", config, signal)).toEqual({ kind: "none" });
  });
  it("only lists open issues of the matching project and caps full reads, failing closed on overflow", async () => {
    const items = Array.from({ length: 201 }, (_, i) => item(String(i), "unrelated"));
    items.push({ ...item("foreign", `https://github.com/${repo}/pull/12`), projectId: "other" });
    items.push({ ...item("done", `https://github.com/${repo}/pull/12`), status: "done" });
    const c = ctx(items);
    const requests: any[] = [];
    const list = c.issues.list;
    c.issues.list = async (input: any) => { requests.push(input); return list(input); };
    let reads = 0;
    const get = c.issues.get;
    c.issues.get = async (...args: any[]) => { reads++; return get(...args); };
    const result = await resolveCard(c, "company", config, signal);
    expect(result.kind).toBe("ambiguous");
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request).toMatchObject({ companyId: "company", projectId: "project" });
      expect(["backlog", "todo", "in_progress", "in_review", "blocked"]).toContain(request.status);
      expect(request.limit).toBeLessThanOrEqual(201);
    }
    expect(reads).toBeLessThanOrEqual(200);
  });
  it("scans exactly 200 open issues and finds a link at the boundary", async () => {
    const items = Array.from({ length: 200 }, (_, i) => item(String(i), i === 199 ? `https://github.com/${repo}/pull/12` : "unrelated"));
    const c = ctx(items);
    let reads = 0;
    const get = c.issues.get;
    c.issues.get = async (...args: any[]) => { reads++; return get(...args); };
    expect(await resolveCard(c, "company", config, signal)).toMatchObject({ kind: "card", card: { id: "199" } });
    expect(reads).toBe(200);
  });
  it("holds even a branch owner when a project exceeds the scan cap", async () => {
    const c = ctx(Array.from({ length: 201 }, (_, i) => item(String(i), "unrelated")));
    c.db.query = async (sql: string) => sql.includes("i.identifier =") ? [item("branch", "")] : [];
    expect(await resolveCard(c, "company", config, { ...signal, headRef: "TOG-10-feature" })).toMatchObject({ kind: "ambiguous", detail: expect.stringMatching(/200/) });
  });
  it("never scans issues when no workspace identifies the repo", async () => {
    const c = ctx([item("1", `https://github.com/${repo}/pull/12`)]);
    c.projects.listWorkspaces = async () => [{ repoUrl: "https://github.com/unrelated/repo.git" }];
    c.issues.list = async () => { throw new Error("unexpected issue scan"); };
    expect(await resolveCard(c, "company", config, signal)).toEqual({ kind: "none" });
  });
  it("never scans issues from an unrelated project", async () => {
    const c = ctx([{ ...item("foreign", `https://github.com/${repo}/pull/12`), projectId: "other" }]);
    expect(await resolveCard(c, "company", config, signal)).toEqual({ kind: "none" });
  });
  it("defaults to stopping nntune and ignores stale required-check maps", () => {
    const c = parseConfig({ requiredChecks: { [repo]: ["build"] } });
    expect(c.stoppedRepos).toContain("togetherweown/nntune");
    expect(isGatingCheck(c, repo, "lint")).toBe(true);
  });
  it("accepts only desired webhook events and failure conclusions", () => {
    const repository = { full_name: repo };
    const run = (conclusion: string) => ({ action: "completed", repository, check_run: { conclusion } });
    expect(mayAct("check_run", run("action_required"))).toBe(true);
    expect(mayAct("check_run", run("startup_failure"))).toBe(false);
    expect(mayAct("push", { repository: { ...repository, default_branch: "main" }, ref: "refs/heads/main" })).toBe(false);
    expect(mayAct("pull_request", { action: "closed", pull_request: { number: 12 } })).toBe(true);
    expect(parseEvent("pull_request", { action: "opened", repository, pull_request: { number: 12, state: "open" } }, config).signals).toEqual([]);
  });
  it("ignores the configured review check as well as other checks", () => {
    const repository = { full_name: repo };
    const c = parseConfig({ ignoreChecks: ["Paperclip Review"] });
    const payload = { action: "completed", repository, check_run: { name: "Paperclip Review", conclusion: "failure", head_sha: "abc", pull_requests: [{ number: 12, head: { sha: "abc" } }] } };
    expect(parseEvent("check_run", payload, c).signals).toEqual([]);
  });
  it("never requests comment creation capability", () => {
    expect(manifest.capabilities).not.toContain("issue.comments.create");
  });
});
