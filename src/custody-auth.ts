import { createPrivateKey, sign } from "node:crypto";
import { APP_PERMISSIONS, AUTH_CYCLE_MS } from "./ci-auth.js";
import { CiGithubError, type CiTokenExchange, type CiTokenSource } from "./ci-github.js";

const MARGIN_MS = 60_000;
const ORG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
interface CustodyAppAuthOptions {
  appId: string;
  installationId: string;
  org: string;
  resolvePrivateKey: () => Promise<string>;
  now?: () => number;
}

/**
 * Installation-wide custody credential. CiAppAuth narrows to one repository,
 * but custody inventories a whole org (org listing, per-repo pulls, GraphQL
 * activity), so this source mints without a repository selection from the
 * same dedicated read-only App. Permissions are validated just as strictly:
 * every granted level must be "read" within the fixed APP_PERMISSIONS
 * ceiling. Without a key, a spent token, or a deadline, no request proceeds.
 * Operation-local only: key material, JWTs and tokens are never retained on
 * the source beyond the cached token, and never logged.
 */
export class CustodyAppAuth implements CiTokenSource {
  #options: CustodyAppAuthOptions;
  #deadline: number;
  #token: { value: string; expiresAt: number } | null = null;
  #pending: Promise<string> | null = null;
  #failed = false;
  #now: () => number;

  constructor(options: CustodyAppAuthOptions) {
    if (![options.appId, options.installationId].every((v) => /^[1-9][0-9]{0,15}$/.test(v) && Number.isSafeInteger(Number(v)))
        || !ORG.test(options.org) || options.org !== options.org.toLowerCase()) throw new CiGithubError("input");
    this.#options = { ...options };
    this.#now = options.now ?? Date.now;
    this.#deadline = this.#now() + AUTH_CYCLE_MS;
  }

  invalidate(): void { this.#token = null; this.#failed = true; }

  async token(path: string, exchange: CiTokenExchange): Promise<string> {
    const { org } = this.#options;
    if (path !== "/graphql" && !path.startsWith(`/repos/${org}/`) && !path.startsWith(`/orgs/${org}/`)) throw new CiGithubError("input");
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
    // No repository selection: the installation token covers every repository
    // the dedicated read-only App is installed on, which custody inventories.
    const raw = await exchange(this.#options.installationId, jwt, { permissions: APP_PERMISSIONS });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CiGithubError("auth");
    const data = raw as Record<string, unknown>;
    const expiresAt = typeof data.expires_at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(data.expires_at) ? Date.parse(data.expires_at) : NaN;
    if (typeof data.token !== "string" || data.token.length < 16 || data.token.length > 4096 || !/^[A-Za-z0-9_.-]+$/.test(data.token)
        || !Number.isFinite(expiresAt) || expiresAt <= this.#now() + MARGIN_MS || expiresAt > now + 3_660_000 || this.#now() >= this.#deadline) throw new CiGithubError("auth");
    const permissions = data.permissions;
    if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) throw new CiGithubError("auth");
    const granted = permissions as Record<string, unknown>;
    if (Object.keys(APP_PERMISSIONS).some((name) => granted[name] !== "read")
        || Object.entries(granted).some(([name, level]) => level !== "read" || !Object.hasOwn(APP_PERMISSIONS, name))) throw new CiGithubError("auth");
    if (data.repository_selection !== undefined && data.repository_selection !== "selected" && data.repository_selection !== "all") throw new CiGithubError("auth");
    const repos = data.repositories;
    if (repos !== undefined) {
      if (!Array.isArray(repos) || repos.length > 500) throw new CiGithubError("auth");
      for (const entry of repos) {
        const fullName = entry && typeof entry === "object" ? (entry as Record<string, unknown>).full_name : undefined;
        if (typeof fullName !== "string" || !fullName.toLowerCase().startsWith(`${this.#options.org}/`)) throw new CiGithubError("auth");
      }
    }
    if (this.#failed) throw new CiGithubError("auth");
    this.#token = { value: data.token, expiresAt };
    return data.token;
  }
}
