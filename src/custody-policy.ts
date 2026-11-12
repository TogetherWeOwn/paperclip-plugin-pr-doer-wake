import { UUID } from "./ci-config.js";
import type { CustodyCard } from "./custody-reader.js";
import type { CustodyPull } from "./custody-github.js";

export const DAY = 86_400_000;
export const CUSTODY_ORIGIN = "plugin:togetherweown.pr-doer-wake:pr-custody" as const;
export interface CustodyRegistration {
  companyId: string; issueId: string; repo: string; prNumber: number;
  /**
   * Binding proof recorded by ci-wake: true only when the workspace branch
   * (before and after the GitHub read) equals the live PR head branch.
   * Missing/false (including legacy waits without the field) is repo-only
   * evidence and is skipped below — never trusted at the registration tier.
   */
  branchVerified?: boolean;
}
export interface Mapping { card: CustodyCard | null; source: "registration" | "workspace" | "work_product" | "url" | "identifier" | "unmapped"; candidates: string[] }
export interface Disposition { at: number; action: string; revisit: number | null }
export interface Trigger { key: string; kind: "idle" | "terminal" | "closed"; epoch: string; at: number }

function escape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
export function prReference(pr: Pick<CustodyPull, "repo" | "number">): string { return `${pr.repo}#${pr.number}`; }
/**
 * Canonical key for the bounded prToCards index. GitHub repo names are
 * case-insensitive, so the index lowercases the repo to make event-written
 * and tick-written keys agree regardless of which side spelled the URL.
 */
export function prIndexRef(pr: Pick<CustodyPull, "repo" | "number">): string { return `${pr.repo.toLowerCase()}#${pr.number}`; }
/**
 * Extract the index ref from a work-product URL, or null. Anchored to the
 * full URL (allowing only a query/fragment tail) so a PR URL embedded in
 * another host's query, or a longer PR number, can never produce a ref —
 * the extraction counterpart of containsPrUrl's token discipline.
 */
export function prRefFromUrl(url: string): string | null {
  const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[?#].*)?$/i.exec(url);
  return match ? `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}#${Number(match[3])}` : null;
}
export function prUrl(pr: Pick<CustodyPull, "repo" | "number">): string { return `https://github.com/${pr.repo}/pull/${pr.number}`; }

/** Tokens only; never accept a URL embedded in another host's query or a longer PR number. */
export function containsPrUrl(body: string, pr: Pick<CustodyPull, "repo" | "number">): boolean {
  return new RegExp(`(^|\\s|<|\\]\\()${escape(prUrl(pr))}(?=$|[\\s<>),;#?\\]])`, "i").test(body);
}
function isSourceReference(body: string, pr: Pick<CustodyPull, "repo" | "number">): boolean {
  const url = escape(prUrl(pr));
  return new RegExp(`^(?:${escape(prReference(pr))}|${url}|<${url}>|\\[[^\\]#:/]*\\]\\(${url}\\))$`, "i").test(body);
}

/** The first nonempty tier wins; multiple matches at that tier are UNMAPPED, never a primary-owner guess.
 * Only branch-verified registrations are trusted at the registration tier:
 * a repo-only registration (checkout ownership of the caller's own card plus
 * public PR number/SHA) does not link the checkout to the PR, so unverified
 * or legacy registrations are skipped entirely and cannot poison or suppress
 * the workspace/URL/identifier tiers. */
export function mapCustodyCard(pr: CustodyPull, cards: CustodyCard[], registrations: CustodyRegistration[], projectRepos: Map<string, Set<string>>, companyId: string): Mapping {
  const eligible = cards.filter((c) => c.companyId === companyId);
  const pick = (source: Mapping["source"], matches: CustodyCard[]): Mapping | null => {
    const unique = [...new Map(matches.map((c) => [c.id, c])).values()];
    return unique.length ? { source, card: unique.length === 1 ? unique[0]! : null, candidates: unique.map((c) => c.id).sort() } : null;
  };
  const registered = new Set(registrations.filter((r) => r.branchVerified === true && r.companyId === companyId && r.repo === pr.repo && r.prNumber === pr.number).map((r) => r.issueId));
  const explicit = pick("registration", eligible.filter((c) => registered.has(c.id)));
  if (explicit) return explicit;
  const sameRepo = pr.headRepo === pr.repo;
  const projectMatches = (c: CustodyCard) => c.projectId !== null && projectRepos.get(c.projectId)?.has(pr.repo) === true;
  const branchId = /^work\/([0-9a-f-]{36})$/i.exec(pr.headBranch)?.[1];
  const workspace = sameRepo && branchId && UUID.test(branchId) ? pick("workspace", eligible.filter((c) => c.id.toLowerCase() === branchId.toLowerCase() && projectMatches(c))) : null;
  if (workspace) return workspace;
  // Explicit native work-product PR bindings (host-supplied issue_work_products
  // via Issue.workProducts). Revalidated exactly: a binding matches only when
  // its URL is a token-exact match for this PR, or when metadata carries
  // BOTH repo and number, both equal to this PR. Partial metadata (empty
  // object, repo-only, number-only) with no matching URL never matches, so
  // one malformed binding cannot claim an unrelated PR. A URL naming a
  // different PR, or metadata whose present fields disagree, is ignored at
  // this tier, never trusted. externalId/status are lifecycle annotations
  // retained on the binding; they play no role in identity matching.
  const workProduct = pick("work_product", eligible.filter((c) => (c.workProducts ?? []).some((w) => {
    if (w.type !== "pull_request" || w.provider !== "github") return false;
    const urlOk = w.url !== null && containsPrUrl(w.url, pr);
    if (w.url !== null && !urlOk) return false;
    const meta = w.metadata;
    const metaRepo = meta && typeof meta.repo === "string" ? meta.repo : null;
    const metaNumber = meta && typeof meta.number === "number" ? meta.number : null;
    if (metaRepo !== null && metaRepo.toLowerCase() !== pr.repo.toLowerCase()) return false;
    if (metaNumber !== null && metaNumber !== pr.number) return false;
    return urlOk || (metaRepo !== null && metaNumber !== null);
  })));
  if (workProduct) return workProduct;
  // URL tier is title/description only. Comment/document URL claims would
  // require the full-company history scan (TWO-5928) to prove unique/absent;
  // comments/documents are read only for already-mapped cards (dispositions
  // and closure rationale), never as an ownership discovery tier.
  const url = pick("url", eligible.filter((c) => c.texts.some((t) => t.ownership && (t.id === "title" || t.id === "description") && containsPrUrl(t.body, pr))));
  if (url) return url;
  const identifier = /^([A-Z][A-Z0-9]*-\d+)(?:[-/]|$)/i.exec(pr.headBranch)?.[1]?.toLowerCase();
  const tracker = sameRepo && identifier ? pick("identifier", eligible.filter((c) => c.identifier?.toLowerCase() === identifier && projectMatches(c))) : null;
  return tracker ?? { card: null, source: "unmapped", candidates: [] };
}

/** Only unquoted lines outside fences and HTML comments can be directive evidence. */
export function directiveLines(body: string): string[] {
  const result: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  let comment = false;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && /^\s*$/.test(marker[2]!)) fence = null;
      continue;
    }
    if (!comment && marker && (marker[1]![0] !== "`" || !marker[2]!.includes("`"))) {
      fence = { marker: marker[1]![0]!, length: marker[1]!.length };
      continue;
    }
    let touchedComment = comment;
    let position = 0;
    while (position < line.length) {
      const boundary = line.indexOf(comment ? "-->" : "<!--", position);
      if (boundary < 0) break;
      touchedComment = true;
      position = boundary + (comment ? 3 : 4);
      comment = !comment;
    }
    if (!touchedComment) result.push(line);
  }
  return result;
}

/** A directive belongs to this PR, not to every PR mentioned elsewhere in the same card. */
export function latestDisposition(card: CustodyCard, pr: CustodyPull): Disposition | null {
  const found: Disposition[] = [];
  for (const text of card.texts) for (const line of directiveLines(text.body)) {
    const match = new RegExp(`^PR disposition:\\s+${escape(prReference(pr))}\\s+(finish|rework|defer|close);\\s*next actor\\s+[^;]*[^;\\s][^;]*;\\s*revisit\\s+(.+?)\\s*$`, "i").exec(line);
    if (!match) continue;
    const revisitText = match[2]!;
    const revisit = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?$/.test(revisitText) ? Date.parse(revisitText) : NaN;
    const canonical = revisitText.length === 10 ? `${revisitText}T00:00:00Z` : revisitText;
    const valid = Number.isFinite(revisit) && new Date(revisit).toISOString().replace(".000Z", "Z") === canonical;
    found.push({ at: text.at, action: match[1]!.toLowerCase(), revisit: valid ? revisit : null });
  }
  return found.sort((a, b) => b.at - a.at)[0] ?? null;
}
export function hasCardClosure(card: CustodyCard, pr: CustodyPull): boolean {
  return card.texts.some((t) => directiveLines(t.body).some((line) => {
    if (!/^Closed unmerged:\s+[^;\s]/i.test(line)) return false;
    const sources = line.split(";").slice(1).map((field) => field.trim()).filter((field) => /^source\b/i.test(field));
    if (sources.length !== 1) return false;
    const source = /^source\s+(.+)$/i.exec(sources[0]!);
    return source !== null && isSourceReference(source[1]!, pr);
  }));
}
export function hasPrClosure(texts: string[]): boolean {
  return texts.some((body) => directiveLines(body).some((line) => /^Closed unmerged:\s+(?:duplicate of|superseded by|need lost|mismatch|burden)\b/i.test(line)));
}
export function custodyTriggers(pr: CustodyPull, card: CustodyCard, activityAt: number | null, closureTexts: string[] | null, now: number): Trigger[] {
  const result: Trigger[] = [];
  const add = (kind: Trigger["kind"], epoch: string, at: number) => result.push({ key: `${prReference(pr)}|${kind}|${epoch}`, kind, epoch, at });
  const disposition = latestDisposition(card, pr);
  if (pr.state === "open") {
    if (["done", "cancelled", "backlog"].includes(card.status)) {
      // statusVersion changes only on status transitions, unlike updatedAt/document writes.
      add("terminal", `${card.id}:${card.status}:${card.statusVersion}`, now);
    }
    if (activityAt !== null) {
      const epoch = Math.max(pr.createdAt, activityAt, disposition?.at ?? 0);
      if (now - epoch >= 7 * DAY && !(disposition?.action === "defer" && disposition.revisit !== null && disposition.revisit > now)) add("idle", String(epoch), epoch);
    }
  } else if (!pr.merged && pr.closedAt !== null && closureTexts !== null && (!hasCardClosure(card, pr) || !hasPrClosure(closureTexts))) {
    add("closed", String(pr.closedAt), pr.closedAt);
  }
  return result;
}
