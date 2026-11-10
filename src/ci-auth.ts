import { createPrivateKey, sign } from "node:crypto";
import { REPO } from "./ci-config.js";
import { CiGithubError, type CiTokenExchange, type CiTokenSource } from "./ci-github.js";

/** GitHub's permission key is statuses, not commit_statuses. Metadata read is implicit. */
export const APP_PERMISSIONS = Object.freeze({ pull_requests: "read", checks: "read", statuses: "read", actions: "read", administration: "read" } as const);
export const AUTH_CYCLE_MS = 180_000;
const MARGIN_MS = 60_000;
interface AppAuthOptions {
  appId: string;
  installationId: string;
  repo: string;
  resolvePrivateKey: () => Promise<string>;
  now?: () => number;
}

/** Operation-local only. Private fields prevent accidental JSON serialization of credentials. */
export class CiAppAuth implements CiTokenSource {
  #options: AppAuthOptions;
  #deadline: number;
  #token: { value: string; expiresAt: number } | null = null;
  #pending: Promise<string> | null = null;
  #failed = false;
  #now: () => number;

  constructor(options: AppAuthOptions) {
    if (![options.appId, options.installationId].every((v) => /^[1-9][0-9]{0,15}$/.test(v) && Number.isSafeInteger(Number(v)))
        || !REPO.test(options.repo) || options.repo !== options.repo.toLowerCase() || [".", ".."].includes(options.repo.split("/")[1]!)) throw new CiGithubError("input");
    this.#options = { ...options };
    this.#now = options.now ?? Date.now;
    this.#deadline = this.#now() + AUTH_CYCLE_MS;
  }

  invalidate(): void { this.#token = null; this.#failed = true; }

  async token(path: string, exchange: CiTokenExchange): Promise<string> {
    if (!path.startsWith(`/repos/${this.#options.repo}/`)) throw new CiGithubError("input");
    if (this.#now() >= this.#deadline) { this.invalidate(); throw new CiGithubError("timeout"); }
    if (this.#failed) throw new CiGithubError("auth");
    if (this.#token && this.#token.expiresAt > this.#now() + MARGIN_MS) return this.#token.value;
    if (this.#pending) return this.#pending;
    // Every joining caller receives the sanitized promise, never raw key/host failures.
    this.#pending = this.mint(exchange).catch((error: unknown) => {
      this.invalidate();
      if (error instanceof CiGithubError) throw error;
      throw new CiGithubError("auth");
    }).finally(() => { this.#pending = null; });
    return this.#pending;
  }

  private async mint(exchange: CiTokenExchange): Promise<string> {
    // Do not retain key material, KeyObjects or JWTs on the source or the runtime.
    const pem = await this.#options.resolvePrivateKey();
    // A client deadline can invalidate us while the secret RPC is still running.
    if (this.#failed) throw new CiGithubError("auth");
    if (typeof pem !== "string" || pem.length > 32_768 || !/^-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(pem)) throw new CiGithubError("auth");
    const key = createPrivateKey(pem);
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (key.asymmetricKeyType !== "rsa" || bits < 2048 || bits > 8192) throw new CiGithubError("auth");
    const now = this.#now();
    if (now >= this.#deadline) throw new CiGithubError("timeout");
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: this.#options.appId, iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 300 })}`;
    const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
    if (this.#failed || this.#now() >= this.#deadline) throw new CiGithubError("auth");
    const raw = await exchange(this.#options.installationId, jwt, { repositories: [this.#options.repo.split("/")[1]!], permissions: APP_PERMISSIONS });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CiGithubError("auth");
    const data = raw as Record<string, unknown>;
    const expiresAt = typeof data.expires_at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(data.expires_at) ? Date.parse(data.expires_at) : NaN;
    if (typeof data.token !== "string" || data.token.length < 16 || data.token.length > 4096 || !/^[A-Za-z0-9_.-]+$/.test(data.token)
        || !Number.isFinite(expiresAt) || expiresAt <= this.#now() + MARGIN_MS || expiresAt > now + 3_660_000 || this.#now() >= this.#deadline) throw new CiGithubError("auth");
    const permissions = data.permissions;
    if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) throw new CiGithubError("auth");
    const granted = permissions as Record<string, unknown>;
    if (Object.keys(APP_PERMISSIONS).some((name) => granted[name] !== "read")
        || Object.entries(granted).some(([name, level]) => level !== "read" || name !== "metadata" && !Object.hasOwn(APP_PERMISSIONS, name))) throw new CiGithubError("auth");
    const repos = data.repositories;
    if (!Array.isArray(repos) || repos.length !== 1 || !repos[0] || typeof repos[0] !== "object"
        || typeof repos[0].full_name !== "string" || repos[0].full_name.toLowerCase() !== this.#options.repo
        || data.repository_selection !== undefined && data.repository_selection !== "selected") throw new CiGithubError("auth");
    if (this.#failed) throw new CiGithubError("auth");
    this.#token = { value: data.token, expiresAt };
    return data.token;
  }
}
