/**
 * Minimal HTTP client for the ZoneID API v2 (https://api.zone.eu/v2).
 *
 * Auth is HTTP Basic with the ZoneID username and an API token. Credentials come from the environment
 * (ZONE_USERNAME / ZONE_API_TOKEN) or, on macOS, from the Keychain item `zone-ee-api` (account = username,
 * password = token), so the token never has to be written into an MCP client config file.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_BASE_URL = "https://api.zone.eu/v2";
export const DEFAULT_KEYCHAIN_SERVICE = "zone-ee-api";

export class ZoneApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly rateLimitRemaining?: string | null,
  ) {
    super(message);
    this.name = "ZoneApiError";
  }
}

export type Method = "GET" | "POST" | "PUT" | "DELETE" | "OPTIONS";
export type Query = Record<string, string | number | boolean | undefined | null>;

export interface Pager {
  page: number;
  pages: number;
  limit: number;
  items: number;
}

export interface ZoneResponse<T = unknown> {
  status: number;
  data: T;
  /** Present when the endpoint paginates (`x-pager-enabled: 1`). */
  pager?: Pager;
  /** Human-readable `X-Status-Message` (informational only). */
  message?: string;
}

export interface ZoneClientOptions {
  username?: string;
  token?: string;
  baseUrl?: string;
  keychainService?: string;
  userAgent?: string;
}

interface Credentials {
  username: string;
  token: string;
  source: "env" | "keychain";
}

/** The API sends `X-Status-Message-Base64` (Latin-1 bytes) next to a mangled plain header; prefer the base64 one. */
const statusMessage = (h: Headers): string | undefined => {
  const b64 = h.get("x-status-message-base64");
  if (b64) {
    try {
      const msg = Buffer.from(b64, "base64").toString("latin1").trim();
      if (msg) return msg;
    } catch {
      /* fall through */
    }
  }
  return h.get("x-status-message")?.trim() || undefined;
};

export class ZoneClient {
  readonly baseUrl: string;
  private readonly origin: string;
  private readonly basePath: string;
  private readonly userAgent: string;
  private readonly keychainService: string;
  private readonly envCreds?: Credentials;
  private creds?: Promise<Credentials>;

  constructor(opts: ZoneClientOptions = {}) {
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const base = new URL(this.baseUrl);
    this.origin = base.origin;
    this.basePath = base.pathname.replace(/\/+$/, "");
    this.userAgent = opts.userAgent ?? "zone-mcp";
    this.keychainService = opts.keychainService || DEFAULT_KEYCHAIN_SERVICE;
    const username = opts.username?.trim();
    const token = opts.token?.trim();
    if (username && token) this.envCreds = { username, token, source: "env" };
  }

  /** Resolve credentials once: env first, then the macOS Keychain. */
  credentials(): Promise<Credentials> {
    if (this.envCreds) return Promise.resolve(this.envCreds);
    this.creds ??= this.readKeychain().catch((err) => {
      this.creds = undefined; // let the next call retry, e.g. after the user runs setup
      throw err;
    });
    return this.creds;
  }

  private async readKeychain(): Promise<Credentials> {
    const missing = (why: string) =>
      new ZoneApiError(
        401,
        "CREDENTIALS_MISSING",
        `No zone.ee credentials (${why}). Set ZONE_USERNAME and ZONE_API_TOKEN in your MCP client config, or on macOS ` +
          `store them in the Keychain: security add-generic-password -U -s ${this.keychainService} -a <ZoneID username> -w ` +
          "(create the token at https://my.zone.eu → Settings → Security → API keys).",
      );
    if (process.platform !== "darwin") throw missing("ZONE_USERNAME / ZONE_API_TOKEN not set");
    try {
      const [{ stdout: token }, { stdout: attrs }] = await Promise.all([
        execFileAsync("security", ["find-generic-password", "-s", this.keychainService, "-w"]),
        execFileAsync("security", ["find-generic-password", "-s", this.keychainService]),
      ]);
      const username = attrs.match(/"acct"<blob>="(.*)"/)?.[1];
      if (!username || !token.trim()) throw new Error("incomplete entry");
      return { username, token: token.trim(), source: "keychain" };
    } catch {
      throw missing(`env vars not set and no '${this.keychainService}' Keychain entry`);
    }
  }

  /**
   * Build the request URL from an API path (e.g. `/dns/example.com/a`). The path is appended to the base URL by
   * string concatenation and checked to stay on the API origin, so credentials can never be sent to another host.
   */
  url(path: string, query?: Query): URL {
    let p = path.trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("//")) {
      throw new ZoneApiError(400, "INVALID_PATH", "Pass an API path like '/domain', not a full URL.");
    }
    if (!p.startsWith("/")) p = `/${p}`;
    if (p.startsWith(`${this.basePath}/`)) p = p.slice(this.basePath.length); // tolerate a pasted '/v2/...' prefix
    if (p.split(/[/?#]/).some((seg) => seg === ".." || seg === ".") || /[\\#\s]/.test(p) || /%2e|%2f|%5c/i.test(p)) {
      throw new ZoneApiError(400, "INVALID_PATH", `Invalid API path: ${path}`);
    }
    const url = new URL(this.baseUrl + p);
    if (url.origin !== this.origin || !url.pathname.startsWith(`${this.basePath}/`)) {
      throw new ZoneApiError(400, "INVALID_PATH", `Path escapes the API base URL: ${path}`);
    }
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    return url;
  }

  async request<T = unknown>(
    method: Method,
    path: string,
    {
      query,
      body,
      page,
      limit,
      orderBy,
      orderDir,
    }: { query?: Query; body?: unknown; page?: number; limit?: number; orderBy?: string; orderDir?: "asc" | "desc" } = {},
  ): Promise<ZoneResponse<T>> {
    const url = this.url(path, query);
    const { username, token } = await this.credentials();

    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
      "User-Agent": this.userAgent,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (page !== undefined) headers["x-pager-page"] = String(page);
    if (limit !== undefined) headers["x-pager-limit"] = String(limit);
    if (orderBy) headers["x-order-by"] = orderBy;
    if (orderDir) headers["x-order-dir"] = orderDir;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error", // never follow a redirect with the Authorization header attached
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ZoneApiError(0, "NETWORK_ERROR", `Could not reach ${url.origin}: ${(err as Error).message}`);
    }

    const text = await res.text();
    let json: any = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    const message = statusMessage(res.headers);

    if (!res.ok) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      let msg: string =
        (typeof json?.message === "string" && json.message) || message || text.slice(0, 500) || res.statusText || "Request failed";
      if (res.status === 401) msg += " (check the ZoneID username and API token)";
      if (res.status === 402) msg += " (package upgrade required)";
      if (res.status === 409) msg += " (conflict: another operation is probably running; retry shortly)";
      if (res.status === 429) msg += " (rate limited: 60 requests/min per IP; wait a minute and retry)";
      // 422 bodies mirror the resource with an error code per field, e.g. {"destination":"is_required"}.
      const details = json && typeof json === "object" && !(json.result === "error" && Object.keys(json).length <= 2) ? json : undefined;
      if (res.status === 422 && details) msg = `Validation failed: ${JSON.stringify(details)}`;
      throw new ZoneApiError(res.status, `HTTP_${res.status}`, msg, details, remaining);
    }

    let pager: Pager | undefined;
    if (res.headers.get("x-pager-enabled") === "1") {
      const n = (h: string) => Number(res.headers.get(h) ?? 0);
      pager = { page: n("x-pager-page"), pages: n("x-pager-pages"), limit: n("x-pager-limit"), items: n("x-pager-items") };
    }

    return { status: res.status, data: (json ?? null) as T, pager, message };
  }
}
