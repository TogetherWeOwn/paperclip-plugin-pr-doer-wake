import { describe, expect, it } from "vitest";
import { CiGithubCache, type CiFetch, type CiGithubOptions, type CiHttpResponse } from "../src/ci-github.js";
import { CustodyGithub, type CustodyPull } from "../src/custody-github.js";

const REPO = "acme/widgets";
const SHA = "a".repeat(40);
const TOKEN = "ghp_custody_fixture_credential_not_for_output";
const CREATED = "2026-01-01T00:00:00Z";
const UPDATED = "2026-01-02T00:00:00Z";
const RECENT = "2026-01-03T00:00:00Z";
function response(data: unknown, status = 200, headers: Record<string, string> = {}): CiHttpResponse {
  return { status, headers, body: JSON.stringify(data) };
}
function rawPull(number = 1, patch: Record<string, unknown> = {}) {
  return {
    number, head: { sha: SHA, ref: "task-123", repo: { full_name: REPO } },
    base: { repo: { full_name: REPO } }, user: { login: "builder", type: "User" },
    title: "Fix widget", body: "Owning card ACME-123", state: "open",
    created_at: CREATED, updated_at: UPDATED, closed_at: null, merged_at: null, ...patch,
  };
}
function pr(patch: Partial<CustodyPull> = {}): CustodyPull {
  return {
    repo: REPO, number: 1, headSha: SHA, headBranch: "task-123", headRepo: REPO,
    author: "builder", authorIsBot: false, title: "Fix widget", body: "Owning card ACME-123",
    state: "open", merged: false, createdAt: Date.parse(CREATED), updatedAt: Date.parse(UPDATED),
    closedAt: null, mergedAt: null, ...patch,
  };
}
function closed(number = 1, updated = UPDATED) {
  return rawPull(number, { state: "closed", closed_at: updated, updated_at: updated });
}
function connection(nodes: unknown[], totalCount = nodes.length, hasNextPage = false, endCursor: string | null = null) {
  return { nodes, totalCount, pageInfo: { hasNextPage, endCursor } };
}
function commit(oid = SHA) {
  return { commit: { oid, committedDate: CREATED } };
}
function review(id = "review-1", submittedAt: string | null = UPDATED) {
  return { id, state: "APPROVED", submittedAt };
}
function suite(id = "suite-1", updatedAt = RECENT) {
  return { id, status: "IN_PROGRESS", createdAt: CREATED, updatedAt };
}
type Kind = "commits" | "reviews" | "checkSuites";
function graphql(kind: Kind, result: unknown, patch: Record<string, unknown> = {}, commitCount = 1) {
  const selection = kind === "checkSuites" ? { commits: { totalCount: commitCount, nodes: [{ commit: { oid: SHA, checkSuites: result } }] } } : { [kind]: result };
  return { data: { repository: { nameWithOwner: REPO, pullRequest: {
    number: 1, state: "OPEN", headRefOid: SHA, createdAt: CREATED, repository: { nameWithOwner: REPO }, ...selection, ...patch,
  } } } };
}
function fixtures(overrides: (url: URL, init: RequestInit | undefined) => CiHttpResponse | Response | undefined = () => undefined, options: CiGithubOptions = {}) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetch: CiFetch = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    const override = overrides(url, init);
    if (override) return override;
    if (url.pathname === "/graphql") {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      const kind = query.includes("checkSuites(") ? "checkSuites" : query.includes("reviews(") ? "reviews" : "commits";
      return response(graphql(kind, connection(kind === "commits" ? [commit()] : [])));
    }
    if (url.pathname.endsWith("/pulls")) return response([rawPull()]);
    if (url.pathname.endsWith("/comments") || url.pathname.endsWith("/repos")) return response([]);
    throw new Error("Unexpected fixture request");
  };
  return { calls, client: new CustodyGithub(fetch, TOKEN, options), fetch };
}

describe("CustodyGithub REST enumeration", () => {
  it("fully paginates organization repos, validates all rows, and filters archived", async () => {
    const { client, calls } = fixtures((url) => {
      const page = Number(url.searchParams.get("page"));
      return response(Array.from({ length: page === 1 ? 100 : 2 }, (_, index) => {
        const id = (page - 1) * 100 + index + 1;
        return { id, full_name: `Acme/repo-${id}`, archived: id === 1 };
      }));
    });
    const repos = await client.repositories("Acme");
    expect(repos).toHaveLength(101);
    expect(repos).toContain("acme/repo-102");
    expect(repos).not.toContain("acme/repo-1");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.searchParams.get("type")).toBe("all");
  });

  it("lists more than 100 open PRs without search or requiring total_count", async () => {
    const { client, calls } = fixtures((url) => response(Number(url.searchParams.get("page")) === 1
      ? Array.from({ length: 100 }, (_, index) => rawPull(index + 1)) : [rawPull(101)]));
    expect(await client.pulls(REPO, "open")).toHaveLength(101);
    expect(calls.map((value) => value.url.pathname)).toEqual(["/repos/acme/widgets/pulls", "/repos/acme/widgets/pulls"]);
    expect(calls[0]!.url.searchParams.get("state")).toBe("open");
  });

  it.each(["open", "closed"] as const)("accepts format characters in bounded %s PR titles without losing the listing", async (state) => {
    const title = "Fix developer 👩‍💻 workflow​";
    const { client } = fixtures(() => response([state === "open" ? rawPull(1, { title }) : { ...closed(), title }]));
    const values = await client.pulls(REPO, state, Date.parse(CREATED));
    expect(values).toHaveLength(1);
    expect(values[0]!.title).toBe(title);
  });

  it.each([undefined, null, 3, "", " ", "x".repeat(1025), "bad\nline", "bad\u0000title"])("rejects malformed or unbounded PR titles: %j", async (title) => {
    const { client } = fixtures(() => response([rawPull(1, { title })]));
    await expect(client.pulls(REPO, "open")).rejects.toMatchObject({ code: "response" });
  });

  it.each([
    { head: { sha: SHA, ref: "work‍flow", repo: { full_name: REPO } } },
    { user: { login: "build‍er", type: "User" } },
  ])("still refuses format characters in ownership identifiers: %j", async (patch) => {
    const { client } = fixtures(() => response([rawPull(1, patch)]));
    await expect(client.pulls(REPO, "open")).rejects.toMatchObject({ code: "response" });
  });

  it("checks a terminal full array with one additional numbered page", async () => {
    const { client, calls } = fixtures((url) => response(Number(url.searchParams.get("page")) === 1
      ? Array.from({ length: 100 }, (_, index) => rawPull(index + 1)) : []));
    expect(await client.pulls(REPO, "open")).toHaveLength(100);
    expect(calls).toHaveLength(2);
  });

  it("replays the closed timestamp boundary across pages and stops only below it", async () => {
    const { client, calls } = fixtures((url) => response(Number(url.searchParams.get("page")) === 1
      ? Array.from({ length: 100 }, (_, index) => closed(index + 1, RECENT))
      : [closed(101, RECENT), closed(102, UPDATED)]));
    expect(await client.pulls(REPO, "closed", Date.parse(RECENT))).toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.searchParams.get("sort")).toBe("updated");
    expect(calls[0]!.url.searchParams.get("direction")).toBe("desc");
  });

  it("requires a bounded bootstrap or stored cursor for closed pulls", async () => {
    const { client, calls } = fixtures();
    await expect(client.pulls(REPO, "closed")).rejects.toMatchObject({ code: "input" });
    await expect(client.pulls(REPO, "closed", NaN)).rejects.toMatchObject({ code: "input" });
    await expect(client.repositories("acme/../../evil")).rejects.toMatchObject({ code: "input" });
    expect(calls).toHaveLength(0);
  });

  it("includes closure time/body and bot status, while preserving fork identity", async () => {
    const { client } = fixtures(() => response([closed(1, RECENT), rawPull(2, {
      state: "closed", closed_at: UPDATED, merged_at: UPDATED, user: { login: "renovate[bot]", type: "Bot" },
      head: { sha: SHA, ref: "task-123", repo: { full_name: "someone/widgets" } },
    })]));
    const values = await client.pulls(REPO, "closed", Date.parse(CREATED));
    expect(values[0]).toMatchObject({ body: "Owning card ACME-123", closedAt: Date.parse(RECENT), merged: false, authorIsBot: false });
    expect(values[1]).toMatchObject({ merged: true, mergedAt: Date.parse(UPDATED), authorIsBot: true, headRepo: "someone/widgets", headBranch: "task-123" });
  });

  it.each([
    { state: "open", merged_at: UPDATED },
    { state: "open", closed_at: UPDATED },
    { state: "closed", closed_at: null },
    { state: "closed", closed_at: UPDATED, merged: true, merged_at: null },
    { state: "closed", closed_at: UPDATED, merged_at: RECENT },
    { state: "closed", closed_at: UPDATED, merged_at: UPDATED, merged: false },
    { base: { repo: { full_name: "other/widgets" } } },
    { head: { sha: "bad", ref: "task", repo: null } },
    { user: { login: "builder" } },
    { user: { login: "builder", type: "Organization" } },
    { created_at: "2026-02-30T00:00:00Z" },
    { updated_at: "not-a-date" },
    { updated_at: CREATED, created_at: UPDATED },
    { body: undefined },
  ])("rejects malformed or contradictory pull data: %j", async (patch) => {
    const state = patch.state === "closed" ? "closed" : "open";
    const { client } = fixtures(() => response([rawPull(1, patch)]));
    await expect(client.pulls(REPO, state, Date.parse(CREATED))).rejects.toMatchObject({ code: "response" });
  });

  it("accepts deleted forks and conservatively marks bot-suffixed authors", async () => {
    const { client } = fixtures(() => response([rawPull(1, {
      head: { sha: SHA, ref: "task-123", repo: null }, user: { login: "renovate[bot]", type: "User" }, body: null,
    })]));
    expect((await client.pulls(REPO, "open"))[0]).toMatchObject({ headRepo: null, authorIsBot: true, body: "" });
  });

  it("rejects duplicate pull numbers across pages instead of returning partial coverage", async () => {
    const { client } = fixtures((url) => response(Number(url.searchParams.get("page")) === 1
      ? Array.from({ length: 100 }, (_, index) => rawPull(index + 1)) : [rawPull(1)]));
    await expect(client.pulls(REPO, "open")).rejects.toMatchObject({ code: "response" });
  });

  it.each([
    [{ id: 1, full_name: "other/widgets", archived: true }],
    [{ id: 1, full_name: REPO }],
    [{ id: 1, full_name: REPO, archived: false }, { id: 2, full_name: REPO, archived: true }],
    [{ id: 1, full_name: REPO, archived: false }, { id: 1, full_name: "acme/other", archived: false }],
  ])("rejects invalid or duplicate repo rows even when archived: %j", async (...rows) => {
    const { client } = fixtures(() => response(rows));
    await expect(client.repositories("acme")).rejects.toMatchObject({ code: "response" });
  });

  it("validates the entire fetched closed page, including rows below the cursor", async () => {
    const { client } = fixtures(() => response([closed(1, RECENT), { ...closed(2, UPDATED), body: 3 }]));
    await expect(client.pulls(REPO, "closed", Date.parse(RECENT))).rejects.toMatchObject({ code: "response" });
  });

  it("rejects non-descending closed results", async () => {
    const { client } = fixtures(() => response([closed(1, UPDATED), closed(2, RECENT)]));
    await expect(client.pulls(REPO, "closed", Date.parse(CREATED))).rejects.toMatchObject({ code: "response" });
  });

  it("never follows Link URLs and rejects a short partial page", async () => {
    const { client, calls } = fixtures(() => response([rawPull()], 200, { link: '<https://evil.test/leak>; rel="next"' }));
    await expect(client.pulls(REPO, "open")).rejects.toMatchObject({ code: "response" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.origin).toBe("https://api.github.com");
  });

  it("reconstructs numbered pages on GitHub rather than following a next Link host/path", async () => {
    const { client, calls } = fixtures((url) => Number(url.searchParams.get("page")) === 1
      ? response(Array.from({ length: 100 }, (_, index) => rawPull(index + 1)), 200, { link: '<https://evil.test/leak?page=900>; rel="next"' })
      : response([rawPull(101)]));
    expect(await client.pulls(REPO, "open")).toHaveLength(101);
    expect(calls[1]!.url.href).toBe("https://api.github.com/repos/acme/widgets/pulls?state=open&sort=updated&direction=desc&per_page=100&page=2");
  });

  it("exhausts the page budget rather than silently truncating a full page", async () => {
    const { client } = fixtures(() => response(Array.from({ length: 100 }, (_, index) => rawPull(index + 1))), { maxPages: 1 });
    await expect(client.pulls(REPO, "open")).rejects.toMatchObject({ code: "pages" });
  });

  it("keeps custody inventory when PR title/body contain token-like examples, without retaining them in the ETag cache", async () => {
    const sample = "ghp_synthetic_example_not_a_credential";
    const cache = new CiGithubCache();
    const { client } = fixtures(() => response([
      rawPull(1, { title: `Example ${sample} title`, body: `See ${sample} for format` }),
      rawPull(2, { title: "Unrelated PR", body: "Owning card ACME-456" }),
    ], 200, { etag: '"safe"' }), { cache });
    const values = await client.pulls(REPO, "open");
    expect(values).toHaveLength(2);
    const flagged = values.find((value) => value.number === 1)!;
    expect(flagged.title).not.toContain(sample);
    expect(flagged.body).not.toContain(sample);
    expect(flagged.title).toContain("[REDACTED]");
    expect(flagged.body).toContain("[REDACTED]");
    const unrelated = values.find((value) => value.number === 2)!;
    expect(unrelated.title).toBe("Unrelated PR");
    expect(unrelated.body).toBe("Owning card ACME-456");
    const cached = cache.get(`https://api.github.com/repos/${REPO}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=1`)!;
    expect(cached.body).not.toContain(sample);
  });

  it("keeps closure rationale when closure comments contain token-like examples", async () => {
    const sample = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJleGFtcGxlIn0.abcdefghijklmnop";
    const { client } = fixtures((url) => url.pathname.endsWith("/comments") ? response([
      { id: 1, body: `Closed unmerged: duplicate of #2\nExample: ${sample}`, created_at: CREATED, updated_at: UPDATED },
    ]) : undefined);
    const texts = await client.closureTexts(pr({ state: "closed", closedAt: Date.parse(UPDATED) }));
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("Closed unmerged: duplicate of #2");
    expect(texts[1]).not.toContain(sample);
    expect(texts[1]).toContain("[REDACTED]");
  });

  it("redacts a PEM block in custody prose without retaining key material", async () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIE synthetic material\n-----END PRIVATE KEY-----";
    const { client } = fixtures(() => response([rawPull(1, { body: `Example\n${pem}` })]));
    const values = await client.pulls(REPO, "open");
    expect(values).toHaveLength(1);
    expect(values[0]!.body).not.toContain("MIIE synthetic material");
    expect(values[0]!.body).not.toContain("PRIVATE KEY");
    expect(values[0]!.body).toContain("[REDACTED]");
  });

  it("still refuses the active credential reflected in custody prose", async () => {
    const { client } = fixtures(() => response([rawPull(1, { body: `Issued ${TOKEN} here` })]));
    await expect(client.pulls(REPO, "open")).rejects.toMatchObject({ code: "response" });
  });

  it("gets all issue comments for closure rationale, including comments beyond 100", async () => {
    const { client } = fixtures((url) => response(Number(url.searchParams.get("page")) === 1
      ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: "discussion", created_at: CREATED, updated_at: UPDATED }))
      : [{ id: 101, body: "Superseded by #102", created_at: CREATED, updated_at: UPDATED }]));
    const texts = await client.closureTexts(pr({ state: "closed", closedAt: Date.parse(UPDATED) }));
    expect(texts).toHaveLength(102);
    expect(texts[0]).toBe("Owning card ACME-123");
    expect(texts.at(-1)).toBe("Superseded by #102");
  });
});

describe("CustodyGithub exact activity", () => {
  it("does not select retired pushedDate when the head observation supplies the push floor", async () => {
    const { client, calls } = fixtures((_url, init) => {
      if (String(init?.body).includes("pushedDate")) return response({ errors: [{ message: "field removed" }] });
      return undefined;
    });
    expect(await client.activity(pr(), Date.parse(UPDATED))).toBe(Date.parse(UPDATED));
    expect(calls.every((call) => !String(call.init?.body).includes("pushedDate"))).toBe(true);
  });
  it("uses the head observation instead of PR metadata updatedAt", async () => {
    const { client } = fixtures();
    expect(await client.activity(pr({ updatedAt: Date.parse(RECENT) }), Date.parse(UPDATED))).toBe(Date.parse(UPDATED));
  });

  it("requires a persisted head observation before requests", async () => {
    const { client, calls } = fixtures();
    await expect(client.activity(pr())).rejects.toMatchObject({ code: "response" });
    expect(calls).toHaveLength(0);
  });

  it("starts idle warmup at first observation when push history is unavailable", async () => {
    const { client } = fixtures((url, init) => url.pathname === "/graphql" && String(init?.body).includes("commits(first:")
      ? response(graphql("commits", connection([commit()]))) : undefined);
    const observedAt = Date.parse(RECENT);
    const lastActivity = await client.activity(pr({ updatedAt: Date.parse("2026-02-01T00:00:00Z") }), observedAt);
    expect(lastActivity).toBe(observedAt);
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(observedAt + sevenDays - 1 - lastActivity).toBeLessThan(sevenDays);
    expect(observedAt + sevenDays - lastActivity).toBe(sevenDays);
  });

  it("includes the persisted observation floor above commit dates", async () => {
    const { client } = fixtures();
    expect(await client.activity(pr(), Date.parse(RECENT))).toBe(Date.parse(RECENT));
  });

  it("keeps later submitted reviews and running-suite updates above the observation floor", async () => {
    const { client } = fixtures((url, init) => {
      if (url.pathname !== "/graphql") return undefined;
      if (String(init?.body).includes("commits(first:")) return response(graphql("commits", connection([commit()])));
      if (String(init?.body).includes("reviews(")) return response(graphql("reviews", connection([review("later", RECENT)])));
      return response(graphql("checkSuites", connection([suite("running", "2026-01-04T00:00:00Z")])));
    });
    expect(await client.activity(pr(), Date.parse(UPDATED))).toBe(Date.parse("2026-01-04T00:00:00Z"));
  });

  it.each([NaN, Infinity, -Infinity, -1, 8_640_000_000_000_001])("rejects invalid head observation floors before requests: %s", async (floor) => {
    const { client, calls } = fixtures();
    await expect(client.activity(pr(), floor)).rejects.toMatchObject({ code: "input" });
    expect(calls).toHaveLength(0);
  });

  it("accepts a zero observation floor but still rejects missing commit dates", async () => {
    const { client } = fixtures((url, init) => url.pathname === "/graphql" && String(init?.body).includes("commits(first:")
      ? response(graphql("commits", connection([commit()]))) : undefined);
    expect(await client.activity(pr(), 0)).toBe(Date.parse(CREATED));
    const malformed = fixtures(() => response(graphql("commits", connection([{ commit: { oid: SHA } }]))));
    await expect(malformed.client.activity(pr(), Date.parse(RECENT))).rejects.toMatchObject({ code: "response" });
  });

  it("includes running suite updatedAt", async () => {
    const { client } = fixtures((url, init) => url.pathname === "/graphql" && String(init?.body).includes("checkSuites(")
      ? response(graphql("checkSuites", connection([suite()]))) : undefined);
    expect(await client.activity(pr(), Date.parse(UPDATED))).toBe(Date.parse(RECENT));
  });

  it("fully paginates more than 100 submitted reviews", async () => {
    const { client, calls } = fixtures((url, init) => {
      if (url.pathname !== "/graphql" || !String(init?.body).includes("reviews(")) return undefined;
      const { variables } = JSON.parse(String(init?.body)) as { variables: { cursor: string | null } };
      return response(graphql("reviews", variables.cursor === null
        ? connection(Array.from({ length: 100 }, (_, index) => review(`r-${index}`)), 101, true, "next-reviews")
        : connection([review("r-100", RECENT)], 101, false, "last-review")));
    });
    expect(await client.activity(pr(), Date.parse(UPDATED))).toBe(Date.parse(RECENT));
    expect(calls.filter((call) => String(call.init?.body).includes("reviews("))).toHaveLength(2);
  });

  it("fully paginates more than 100 commits and head suites", async () => {
    const { client } = fixtures((url, init) => {
      if (url.pathname !== "/graphql") return undefined;
      const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { cursor: string | null } };
      if (query.includes("reviews(")) return undefined;
      const kind = query.includes("checkSuites(") ? "checkSuites" : "commits";
      const nodes = kind === "commits" ? Array.from({ length: 100 }, (_, index) => commit((index + 1).toString(16).padStart(40, "0")))
        : Array.from({ length: 100 }, (_, index) => suite(`s-${index}`, UPDATED));
      return response(graphql(kind, variables.cursor === null ? connection(nodes, 101, true, "next")
        : connection(kind === "commits" ? [commit()] : [suite("latest")], 101, false, "last"), {}, 101));
    });
    expect(await client.activity(pr(), Date.parse(UPDATED))).toBe(Date.parse(RECENT));
  });

  it.each([
    { errors: [{ message: "Upstream private diagnostics" }] },
    { data: null },
    graphql("commits", connection([null])),
    graphql("commits", connection([{ commit: { oid: SHA, committedDate: null } }])),
    graphql("commits", connection([commit("b".repeat(40))])),
    graphql("commits", connection([commit()]), { headRefOid: "b".repeat(40) }),
    graphql("commits", connection([commit()]), { repository: { nameWithOwner: "other/widgets" } }),
    graphql("commits", connection([commit()]), { state: "CLOSED" }),
    graphql("commits", connection([commit()], 2)),
    graphql("commits", { totalCount: 1, nodes: [commit()] }),
    graphql("commits", connection([commit()], 2, true, "cursor")),
  ])("fails UNKNOWN on malformed, partial or mismatched GraphQL data: %j", async (data) => {
    const { client } = fixtures(() => response(data));
    await expect(client.activity(pr(), Date.parse(UPDATED))).rejects.toMatchObject({ code: "response" });
  });

  it("rejects GraphQL partial errors even alongside apparently complete data", async () => {
    const { client } = fixtures(() => response({ ...graphql("commits", connection([commit()])), errors: [{ message: "partial" }] }));
    await expect(client.activity(pr(), Date.parse(UPDATED))).rejects.toMatchObject({ code: "response" });
  });

  it.each([
    connection([review("r", null)]),
    connection([review("r"), review("r")]),
    connection([{ id: "r", state: "PENDING", submittedAt: UPDATED }]),
  ])("rejects invalid reviews: %j", async (data) => {
    const { client } = fixtures((url, init) => url.pathname === "/graphql" && String(init?.body).includes("reviews(")
      ? response(graphql("reviews", data)) : undefined);
    await expect(client.activity(pr(), Date.parse(UPDATED))).rejects.toMatchObject({ code: "response" });
  });

  it.each([
    connection([suite("s", "bad timestamp")]),
    connection([{ ...suite(), updatedAt: CREATED, createdAt: UPDATED }]),
    connection([{ ...suite(), status: "UNKNOWN" }]),
    connection([suite(), suite()]),
    connection([suite()], 2),
  ])("rejects malformed or incomplete head suite activity: %j", async (data) => {
    const { client } = fixtures((url, init) => url.pathname === "/graphql" && String(init?.body).includes("checkSuites(")
      ? response(graphql("checkSuites", data)) : undefined);
    await expect(client.activity(pr(), Date.parse(UPDATED))).rejects.toMatchObject({ code: "response" });
  });

  it("applies the configured page budget to GraphQL without silently truncating", async () => {
    const { client } = fixtures(() => response(graphql("commits", connection(
      Array.from({ length: 100 }, (_, index) => commit((index + 1).toString(16).padStart(40, "0"))), 101, true, "next",
    ))), { maxPages: 1 });
    await expect(client.activity(pr(), Date.parse(UPDATED))).rejects.toMatchObject({ code: "pages" });
  });

  it("accepts empty review/suite connections and ignores unsubmitted reviews, but not empty commits", async () => {
    const { client } = fixtures((url, init) => url.pathname === "/graphql" && String(init?.body).includes("reviews(")
      ? response(graphql("reviews", connection([{ id: "pending", state: "PENDING", submittedAt: null }]))) : undefined);
    expect(await client.activity(pr(), Date.parse(UPDATED))).toBe(Date.parse(UPDATED));
    const empty = fixtures(() => response(graphql("commits", connection([]))));
    await expect(empty.client.activity(pr(), Date.parse(UPDATED))).rejects.toMatchObject({ code: "response" });
  });

  it("rejects repeated cursors/duplicate nodes and total changes across pages", async () => {
    for (const mode of ["duplicate", "total", "cursor"]) {
      const { client } = fixtures((_url, init) => {
        const { variables } = JSON.parse(String(init?.body)) as { variables: { cursor: string | null } };
        const first = variables.cursor === null;
        const offset = first || mode === "duplicate" ? 0 : 100;
        return response(graphql("commits", connection(Array.from({ length: 100 }, (_, index) => commit((offset + index + 1).toString(16).padStart(40, "0"))),
          !first && mode === "total" ? 301 : 300, true, "same-cursor")));
      });
      await expect(client.activity(pr(), Date.parse(UPDATED))).rejects.toMatchObject({ code: "response" });
    }
  });
});

describe("CustodyGithub inherited security transport", () => {
  it("reuses REST ETags but never caches GraphQL POST queries by URL", async () => {
    const cache = new CiGithubCache();
    let restCalls = 0;
    const { client, calls } = fixtures((url) => {
      if (url.pathname !== "/graphql") return ++restCalls === 1 ? response([rawPull()], 200, { etag: '"rest"' }) : { status: 304, headers: {}, body: "" };
      return undefined;
    }, { cache });
    await client.pulls(REPO, "open");
    await client.pulls(REPO, "open");
    await client.activity(pr(), Date.parse(UPDATED));
    expect((calls[1]!.init?.headers as Record<string, string>)["If-None-Match"]).toBe('"rest"');
    for (const call of calls.slice(2)) {
      expect(call.init?.method).toBe("POST");
      expect(call.url.href).toBe("https://api.github.com/graphql");
      expect(call.init?.redirect).toBe("error");
      expect((call.init?.headers as Record<string, string>)["If-None-Match"]).toBeUndefined();
      expect((call.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    }
  });

  it("does not retain POST ETags or accept GraphQL 304 responses", async () => {
    const { client, calls } = fixtures((_url, init) => {
      const query = String(init?.body);
      const kind = query.includes("checkSuites(") ? "checkSuites" : query.includes("reviews(") ? "reviews" : "commits";
      return response(graphql(kind, connection(kind === "commits" ? [commit()] : [])), 200, { etag: '"post"' });
    });
    await client.activity(pr(), Date.parse(UPDATED));
    await client.activity(pr(), Date.parse(UPDATED));
    expect(calls.every((call) => !(call.init?.headers as Record<string, string>)["If-None-Match"])).toBe(true);
    const conditional = fixtures(() => ({ status: 304, body: "", headers: {} }));
    await expect(conditional.client.activity(pr(), Date.parse(UPDATED))).rejects.toMatchObject({ code: "response" });
  });

  it("redacts reflected credentials in REST and GraphQL bodies, including escaped JSON", async () => {
    for (const action of ["pulls", "activity"] as const) {
      const escaped = TOKEN.split("").map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
      const { client } = fixtures(() => ({ status: 200, headers: {}, body: `{"secret":"${escaped}"}` }));
      const error = await (action === "pulls" ? client.pulls(REPO, "open") : client.activity(pr(), Date.parse(UPDATED))).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: "response" });
      expect(String(error)).not.toContain(TOKEN);
    }
  });

  it("rejects host-followed redirects and never emits an upstream body", async () => {
    const redirect = new Response("private body", { status: 200 });
    Object.defineProperty(redirect, "redirected", { value: true });
    const { client } = fixtures(() => redirect);
    await expect(client.activity(pr(), Date.parse(UPDATED))).rejects.toMatchObject({ code: "response" });
    const rejected = fixtures(() => response({ message: TOKEN }, 302, { location: "https://evil.test" }));
    await expect(rejected.client.pulls(REPO, "open")).rejects.toMatchObject({ code: "http", status: 302 });
  });

  it("shares the request budget across REST and GraphQL and bounds bodies/pages", async () => {
    const { client } = fixtures(undefined, { maxRequests: 1 });
    await client.pulls(REPO, "open");
    await expect(client.activity(pr(), Date.parse(UPDATED))).rejects.toMatchObject({ code: "budget" });
    const bounded = fixtures(() => response([rawPull()]), { maxBodyBytes: 10 });
    await expect(bounded.client.pulls(REPO, "open")).rejects.toMatchObject({ code: "response" });
    expect(() => fixtures(undefined, { maxPages: 101 })).toThrow();
  });
});
