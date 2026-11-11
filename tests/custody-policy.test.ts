import { describe, expect, it } from "vitest";
import type { CustodyCard } from "../src/custody-reader.js";
import type { CustodyPull } from "../src/custody-github.js";
import { containsPrUrl, custodyTriggers, DAY, hasCardClosure, hasPrClosure, latestDisposition, mapCustodyCard } from "../src/custody-policy.js";
import { parseCustodyConfig, validateCustodyConfig } from "../src/custody-config.js";
import manifest from "../src/manifest.js";
import { validateInstanceConfig } from "./fixtures/host-config-validator.js";

export const COMPANY = "aaaaaaaa-0000-4000-8000-000000000001";
export const ISSUE = "bbbbbbbb-0000-4000-8000-000000000001";
export const PROJECT = "cccccccc-0000-4000-8000-000000000001";
export const NOW = Date.parse("2026-10-20T12:00:00Z");
export function pull(patch: Partial<CustodyPull> = {}): CustodyPull {
  return { repo: "example/project", number: 42, headSha: "a".repeat(40), headBranch: `work/${ISSUE}`, headRepo: "example/project", author: "contributor", authorIsBot: false, state: "open", merged: false, body: "", title: "Change", createdAt: NOW - 20 * DAY, updatedAt: NOW - 10 * DAY, closedAt: null, mergedAt: null, ...patch };
}
export function card(patch: Partial<CustodyCard> = {}): CustodyCard {
  return { id: ISSUE, companyId: COMPANY, projectId: PROJECT, identifier: "TASK-42", title: "Change", description: null, status: "in_progress", statusVersion: 2, assigneeAgentId: ISSUE, assigneeUserId: null, updatedAt: NOW - 10 * DAY, completedAt: null, cancelledAt: null, texts: [], ...patch };
}
const projects = () => new Map([[PROJECT, new Set(["example/project"])]]);
const map = (pr: CustodyPull, cards: CustodyCard[], registrations: Parameters<typeof mapCustodyCard>[2] = []) => mapCustodyCard(pr, cards, registrations, projects(), COMPANY);
const directive = (action: string, revisit: string, at: number) => ({ body: `PR disposition: example/project#42 ${action}; next actor contributor; revisit ${revisit}`, at, ownership: true });

describe("custody ownership is conservative and ordered", () => {
  it("uses registration before branch/text, deduplicating repeated waits", () => {
    const other = card({ id: PROJECT });
    const registration = { companyId: COMPANY, issueId: other.id, repo: "example/project", prNumber: 42, branchVerified: true };
    expect(map(pull(), [card(), other], [registration, registration])).toMatchObject({ source: "registration", card: other });
  });
  it("does not infer a primary owner from two registrations", () => {
    const other = card({ id: PROJECT });
    const registrations = [card(), other].map((c) => ({ companyId: COMPANY, issueId: c.id, repo: "example/project", prNumber: 42, branchVerified: true }));
    expect(map(pull(), [card(), other], registrations)).toMatchObject({ card: null, source: "registration", candidates: [ISSUE, PROJECT].sort() });
  });
  it("skips an unverified repo-only registration and maps the true workspace owner", () => {
    const attacker = card({ id: PROJECT });
    const unverified = { companyId: COMPANY, issueId: attacker.id, repo: "example/project", prNumber: 42, branchVerified: false };
    expect(map(pull(), [card(), attacker], [unverified])).toMatchObject({ source: "workspace", card: card() });
  });
  it("skips a legacy registration without binding proof and does not suppress the true owner", () => {
    const attacker = card({ id: PROJECT });
    const legacy = { companyId: COMPANY, issueId: attacker.id, repo: "example/project", prNumber: 42 };
    expect(map(pull(), [card(), attacker], [legacy])).toMatchObject({ source: "workspace", card: card() });
  });
  it("leaves a PR unmapped when only an unverified registration claims it", () => {
    const attacker = card({ id: PROJECT });
    const unverified = { companyId: COMPANY, issueId: attacker.id, repo: "example/project", prNumber: 42, branchVerified: false };
    expect(map(pull({ headBranch: "feat/change" }), [attacker], [unverified])).toMatchObject({ card: null, source: "unmapped", candidates: [] });
  });
  it("requires company, project/repo and same-repo branch identity", () => {
    expect(map(pull(), [card()]).source).toBe("workspace");
    for (const owner of [card({ companyId: PROJECT }), card({ projectId: null }), card({ projectId: ISSUE })]) expect(map(pull(), [owner]).card).toBeNull();
    expect(map(pull({ headRepo: "other/fork" }), [card()]).card).toBeNull();
  });
  it("matches URL tokens, including title/document/agent comment evidence, but not human-only ownership", () => {
    const pr = pull({ headBranch: "feat/change" });
    for (const body of ["https://github.com/example/project/pull/42", "[PR](https://github.com/example/project/pull/42)", "<https://github.com/example/project/pull/42>"]) {
      expect(map(pr, [card({ texts: [{ body, at: NOW, ownership: true }] })]).source).toBe("url");
    }
    expect(map(pr, [card({ texts: [{ body: "https://github.com/example/project/pull/42", at: NOW, ownership: false }] })]).card).toBeNull();
  });
  it.each(["https://evil.test/?u=https://github.com/example/project/pull/42", "https://github.com/example/project/pull/420", "https://github.com/example/project/pull/42evil", "https://github.com.evil.test/example/project/pull/42", "https://github.com/example/project/pull/42/files"]) ("rejects spoofed URL %s", (body) => expect(containsPrUrl(body, pull())).toBe(false));
  it("makes ambiguous URL ownership UNMAPPED rather than selecting latest", () => {
    const text = { body: "https://github.com/example/project/pull/42", at: NOW, ownership: true };
    expect(map(pull({ headBranch: "feat/change" }), [card({ texts: [text] }), card({ id: PROJECT, texts: [text] })]).card).toBeNull();
  });
  it("uses tracker identifiers last and never across repositories", () => {
    expect(map(pull({ headBranch: "TASK-42-change" }), [card()]).source).toBe("identifier");
    expect(map(pull({ headBranch: "TASK-42-change", headRepo: "other/fork" }), [card()]).card).toBeNull();
  });
});

describe("PR-specific trigger policy", () => {
  const trigger = (owner = card(), activity = NOW - 8 * DAY) => custodyTriggers(pull(), owner, activity, null, NOW);
  it("fires idle at exactly seven days, never from a missing activity read", () => {
    expect(trigger(card(), NOW - 7 * DAY).map((t) => t.kind)).toEqual(["idle"]);
    expect(trigger(card(), NOW - 7 * DAY + 1)).toEqual([]);
    expect(custodyTriggers(pull(), card(), null, null, NOW)).toEqual([]);
  });
  it("resets idle by a newer disposition but finish lines become stale again", () => {
    expect(trigger(card({ texts: [directive("finish", "event", NOW - DAY)] }))).toEqual([]);
    expect(trigger(card({ texts: [directive("finish", "event", NOW - 8 * DAY)] }))).toHaveLength(1);
  });
  it("honors the latest defer through its deadline, not an older hold", () => {
    expect(trigger(card({ texts: [directive("defer", "2026-10-21T12:00:00Z", NOW - 8 * DAY)] }))).toEqual([]);
    expect(trigger(card({ texts: [directive("defer", "2026-10-19T12:00:00Z", NOW - 8 * DAY)] }))).toHaveLength(1);
    expect(trigger(card({ texts: [directive("defer", "2026-10-21T12:00:00Z", NOW - 9 * DAY), directive("rework", "event", NOW - 8 * DAY)] }))).toHaveLength(1);
  });
  it.each([
    "2027-02-30", "2027-02-29", "2027-04-31", "2027-13-01", "2027-00-01", "2027-03-00",
    "2027-02-30T12:00:00Z", "2027-03-01T24:00:00Z", "2027-03-01T12:60:00Z", "2027-03-01T12:00:60Z",
  ])("does not let an invalid revisit establish a future deferral: %s", (revisit) => {
    const now = Date.parse("2027-03-01T00:00:00Z");
    const owner = card({ texts: [directive("defer", revisit, now - 8 * DAY)] });
    expect(latestDisposition(owner, pull())?.revisit).toBeNull();
    expect(custodyTriggers(pull(), owner, now - 8 * DAY, null, now).map((t) => t.kind)).toEqual(["idle"]);
  });
  it.each(["2028-02-29", "2028-02-29T12:34:56Z", "2027-03-02", "2027-03-02T00:00:00Z"])("honors a valid calendar revisit: %s", (revisit) => {
    const now = Date.parse("2027-03-01T00:00:00Z");
    const owner = card({ texts: [directive("defer", revisit, now - 8 * DAY)] });
    expect(latestDisposition(owner, pull())?.revisit).toBe(Date.parse(revisit));
    expect(custodyTriggers(pull(), owner, now - 8 * DAY, null, now)).toEqual([]);
  });
  it("does not apply another PR's disposition to this PR", () => {
    expect(latestDisposition(card({ texts: [{ ...directive("defer", "2026-10-21T12:00:00Z", NOW), body: directive("defer", "2026-10-21T12:00:00Z", NOW).body.replace("#42", "#43") }] }), pull())).toBeNull();
  });
  it.each(["done", "cancelled", "backlog"])("terminal %s fires even without activity", (status) => {
    const a = custodyTriggers(pull(), card({ status }), null, null, NOW)[0]!;
    const b = custodyTriggers(pull(), card({ status, updatedAt: NOW }), null, null, NOW + DAY)[0]!;
    expect(a.kind).toBe("terminal");
    expect(a.key).toBe(b.key);
    expect(custodyTriggers(pull(), card({ status, statusVersion: 3 }), null, null, NOW)[0]!.key).not.toBe(a.key);
  });
  it("requires closure rationale on both the mapped card and PR", () => {
    const pr = pull({ state: "closed", closedAt: NOW - DAY });
    const owner = card({ texts: [{ body: "Closed unmerged: superseded by example/project#99; source example/project#42; unique work: kept", at: NOW, ownership: true }] });
    const closure = ["Closed unmerged: superseded by #99; unique work: kept"];
    expect(custodyTriggers(pr, owner, null, closure, NOW)).toEqual([]);
    expect(custodyTriggers(pr, owner, null, [], NOW)).toHaveLength(1);
    expect(custodyTriggers(pr, card(), null, closure, NOW)).toHaveLength(1);
    expect(custodyTriggers({ ...pr, merged: true }, card(), null, [], NOW)).toEqual([]);
    expect(custodyTriggers(pr, card(), null, null, NOW)).toEqual([]);
  });
  it("attributes card closure to the source, not its successor", () => {
    const owner = card({ texts: [{ body: "Closed unmerged: superseded by example/project#42; source example/project#43", at: NOW, ownership: true }] });
    expect(hasCardClosure(owner, pull({ number: 43 }))).toBe(true);
    expect(hasCardClosure(owner, pull())).toBe(false);
  });
  it.each([
    "example/project#42",
    "https://github.com/example/project/pull/42",
    "<https://github.com/example/project/pull/42>",
    "[PR](https://github.com/example/project/pull/42)",
  ])("accepts an explicit, unique source %s", (source) => {
    expect(hasCardClosure(card({ texts: [{ body: `Closed unmerged: superseded by example/project#43; source ${source}; unique work: kept`, at: NOW, ownership: true }] }), pull())).toBe(true);
  });
  it.each([
    "Closed unmerged: superseded by example/project#42",
    "Closed unmerged: burden; notes example/project#42",
    "Closed unmerged: burden; source example/project#420",
    "Closed unmerged: burden; source other/project#42",
    "Closed unmerged: burden; source example/project#42; source example/project#43",
    "Closed unmerged: burden; source example/project#43; source example/project#42",
    "Closed unmerged: burden; source example/project#42; source example/project#42",
    "Closed unmerged: burden; source example/project#42; source",
    "Closed unmerged: burden; source example/project#42 and example/project#43",
    "Closed unmerged: burden; source example/project#43, example/project#42",
    "Closed unmerged: burden; source https://evil.test/?u=https://github.com/example/project/pull/42",
    "Closed unmerged: burden; source https://github.com/example/project/pull/420",
    "> Closed unmerged: burden; source example/project#42",
  ])("rejects missing, ambiguous or invalid card sources: %s", (body) => {
    expect(hasCardClosure(card({ texts: [{ body, at: NOW, ownership: true }] }), pull())).toBe(false);
  });
  it("does not borrow card rationale from a different PR or quotes", () => {
    expect(hasCardClosure(card({ texts: [{ body: "Closed unmerged: superseded by example/project#43", at: NOW, ownership: true }] }), pull())).toBe(false);
    expect(hasPrClosure(["> Closed unmerged: superseded by #99"])).toBe(false);
  });
});

describe("custody opt-in configuration", () => {
  const config = { custodyEnabled: true, custodyCompanyId: COMPANY, custodySummaryAgentId: ISSUE, custodyOrg: "example", custodyClosedSince: "2026-10-01T00:00:00Z", githubTokenSecretRef: { type: "secret_ref", secretId: PROJECT } };
  it("is disabled by default with independent dry-run and org scope", () => {
    expect(parseCustodyConfig({})).toBeNull();
    expect(validateCustodyConfig(config)).toEqual([]);
    expect(parseCustodyConfig(config)).toMatchObject({ dryRun: true, companyId: COMPANY, org: "example" });
    expect(validateInstanceConfig(config, manifest.instanceConfigSchema!).valid).toBe(true);
  });
  it.each(["custodyCompanyId", "custodySummaryAgentId", "custodyOrg", "custodyClosedSince", "githubTokenSecretRef"])("refuses missing %s", (field) => {
    expect(validateCustodyConfig({ ...config, [field]: undefined }).length).toBeGreaterThan(0);
  });
});
