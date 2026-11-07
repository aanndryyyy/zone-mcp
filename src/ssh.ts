/**
 * SSH access to Zone webhostings (shared and Privaatserver), for what the ZoneID API cannot do: reading logs.
 *
 * - The connection target (system user, server IP) and the server's host-key fingerprints come from the API
 *   (`GET /vserver/{name}/ssh`, over authenticated HTTPS). `ssh-keyscan` fetches the host keys, only keys whose
 *   SHA256 fingerprint matches the API are written to a known_hosts file this process owns, and ssh runs with
 *   `StrictHostKeyChecking=yes` against that file. The user's `~/.ssh/known_hosts` is never read or written.
 * - Authentication is the user's own: ssh-agent, `~/.ssh/config`, default keys, or `ZONE_SSH_KEY`.
 * - The remote side always runs `sh -s` with a script built here from fixed text. User input reaches the script only
 *   as base64 literals that the script decodes into variables, so it is never parsed as shell.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ZoneApiError, type ZoneClient } from "./client.js";

const execFileAsync = promisify(execFile);
const seg = (s: string) => encodeURIComponent(s.trim());

// ───────────────────────────── Fingerprints ─────────────────────────────

/** OpenSSH-style `SHA256:<base64, no padding>` of a base64 key blob. */
export const sha256Fingerprint = (blobB64: string): string =>
  `SHA256:${createHash("sha256").update(Buffer.from(blobB64, "base64")).digest("base64").replace(/=+$/, "")}`;

/**
 * Every `SHA256:...` fingerprint in the API's `server_fingerprints`. The spec says `string[]`, but the API returns
 * `{ RSA: "RSA:3072:MD5:…\nRSA:3072:SHA256:…\n…", ECDSA: …, ED25519: … }`, so walk whatever comes back.
 */
export const apiHostFingerprints = (value: unknown): Set<string> => {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") for (const m of v.matchAll(/SHA256:([A-Za-z0-9+/]+)/g)) found.add(`SHA256:${m[1]}`);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return found;
};

/** `type base64 [comment]` lines → parsed keys (skips anything that does not look like a public key). */
const parsePublicKeys = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim().match(/^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+)\s+([A-Za-z0-9+/]+=*)(?:\s+(.*))?$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({ type: m[1], blob: m[2], comment: m[3]?.trim() || undefined, fingerprint: sha256Fingerprint(m[2]) }));

// ───────────────────────────── Target (cached per process) ─────────────────────────────

export interface SshTarget {
  vserver: string;
  username: string;
  ipv4: string | null;
  ipv6: string | null;
  access: string;
  webhosts: string[];
  hostFingerprints: string[];
}

const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]+)$/i;
const USER_RE = /^[a-z_][a-z0-9_.-]{0,63}$/i;

export class SshRunner {
  private targets = new Map<string, Promise<SshTarget>>();
  private hostMaps = new Map<string, Promise<{ hosts: string[]; aliases: Map<string, string> }>>();
  private knownHosts = new Map<string, Promise<string>>();
  private dir?: string;

  constructor(
    private readonly client: ZoneClient,
    private readonly identityFile = process.env.ZONE_SSH_KEY?.trim() || undefined,
  ) {}

  /** SSH settings from the API, once per vserver for the life of the process (60 requests/min limit). */
  target(vserver: string): Promise<SshTarget> {
    const key = vserver.trim().toLowerCase();
    let p = this.targets.get(key);
    if (!p) {
      p = this.fetchTarget(vserver).catch((err) => {
        this.targets.delete(key);
        throw err;
      });
      this.targets.set(key, p);
    }
    return p;
  }

  private async fetchTarget(vserver: string): Promise<SshTarget> {
    let res;
    try {
      res = await this.client.request("GET", `/vserver/${seg(vserver)}/ssh`);
    } catch (err) {
      if (err instanceof ZoneApiError && err.status === 404) {
        throw new ZoneApiError(404, "NOT_A_WEBHOSTING", `No SSH settings for '${vserver}'. SSH tools work on webhostings (see list_webhostings), not cloud VPS.`);
      }
      throw err;
    }
    const s: any = (Array.isArray(res.data) ? res.data[0] : res.data) ?? {};
    const username = String(s.username ?? "");
    const ipv4 = typeof s.ipv4 === "string" && IP_RE.test(s.ipv4) ? s.ipv4 : null;
    const ipv6 = typeof s.ipv6 === "string" && IP_RE.test(s.ipv6) ? s.ipv6 : null;
    if (!USER_RE.test(username) || (!ipv4 && !ipv6)) {
      throw new ZoneApiError(502, "SSH_SETTINGS_INCOMPLETE", `The API returned no usable SSH username/IP for '${vserver}'.`);
    }
    return {
      vserver,
      username,
      ipv4,
      ipv6,
      access: String(s.access ?? "unknown"),
      webhosts: Array.isArray(s.webhosts) ? s.webhosts.map(String) : [],
      hostFingerprints: [...apiHostFingerprints(s.server_fingerprints)],
    };
  }

  /** The webhosting's hosts and aliases (alias → host), once per vserver. */
  private hostMap(vserver: string) {
    const key = vserver.trim().toLowerCase();
    let p = this.hostMaps.get(key);
    if (!p) {
      p = this.client.request("GET", `/vserver/${seg(vserver)}`).then((res) => {
        const v: any = (Array.isArray(res.data) ? res.data[0] : res.data) ?? {};
        const hosts = (Array.isArray(v.hosts) ? v.hosts : []).map((h: any) => String(h?.name ?? "").toLowerCase()).filter(Boolean);
        const aliases = new Map<string, string>();
        for (const a of Array.isArray(v.aliases) ? v.aliases : []) {
          if (a?.alias_name && typeof a.host === "string" && a.host) aliases.set(String(a.alias_name).toLowerCase(), a.host.toLowerCase());
        }
        return { hosts, aliases };
      });
      p.catch(() => this.hostMaps.delete(key));
      this.hostMaps.set(key, p);
    }
    return p;
  }

  /**
   * Map a name to the vhost the logs record: Apache logs every request under the host's canonical name (field 1 of
   * access lines, `[vhost: …]` in error lines), also for aliases and `www.` names. Unknown names are an error, so a
   * typo never reads as "no log lines".
   */
  async resolveHost(vserver: string, name: string): Promise<{ host: string; via?: string }> {
    const { hosts, aliases } = await this.hostMap(vserver);
    const n = name.trim().replace(/\.$/, "").toLowerCase();
    for (const cand of n.startsWith("www.") ? [n, n.slice(4)] : [n]) {
      if (hosts.includes(cand)) return cand === n ? { host: cand } : { host: cand, via: n };
      const h = aliases.get(cand);
      if (h) return { host: h, via: n };
    }
    throw new ZoneApiError(
      400,
      "UNKNOWN_HOST",
      `'${name}' is not a host or alias of ${vserver}. Hosts: ${hosts.join(", ") || "(none)"}${aliases.size ? `; aliases: ${[...aliases.keys()].join(", ")}` : ""}.`,
    );
  }

  /** Host keys of `host`, keeping only those whose fingerprint the API vouches for; returns the known_hosts path. */
  private hostKeyFile(t: SshTarget, host: string): Promise<string> {
    let p = this.knownHosts.get(host);
    if (!p) {
      p = this.scanHostKeys(t, host).catch((err) => {
        this.knownHosts.delete(host);
        throw err;
      });
      this.knownHosts.set(host, p);
    }
    return p;
  }

  private async scanHostKeys(t: SshTarget, host: string): Promise<string> {
    if (!t.hostFingerprints.length) {
      throw new ZoneApiError(502, "NO_HOST_FINGERPRINTS", "The API returned no SSH host-key fingerprints, so the server cannot be verified.");
    }
    let stdout = "";
    try {
      ({ stdout } = await execFileAsync("ssh-keyscan", ["-T", "10", "-t", "ed25519,ecdsa,rsa", host], { timeout: 20_000 }));
    } catch (err: any) {
      stdout = err?.stdout ?? "";
      if (!stdout) throw new ZoneApiError(0, "SSH_KEYSCAN_FAILED", `ssh-keyscan ${host} failed: ${err?.message ?? err}`);
    }
    const trusted = new Set(t.hostFingerprints);
    const lines = stdout
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((f) => f.length >= 3 && !f[0].startsWith("#") && trusted.has(sha256Fingerprint(f[2])))
      .map((f) => `${host} ${f[1]} ${f[2]}`);
    if (!lines.length) {
      throw new ZoneApiError(
        502,
        "HOST_KEY_MISMATCH",
        `None of the host keys ${host} presented match the fingerprints the zone.ee API reports for ${t.vserver}. Not connecting.`,
      );
    }
    this.dir ??= mkdtempSync(join(tmpdir(), "zone-mcp-ssh-"));
    const file = join(this.dir, `known_hosts_${host.replace(/[^0-9a-z.]/gi, "_")}`);
    writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
    return file;
  }

  /** Remove the temporary known_hosts files. */
  cleanup() {
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }

  /**
   * Run `script` on the server with `sh -s` (the script goes over stdin). Resolves with stdout; rejects with an
   * explained error when ssh itself fails (exit 255).
   */
  async run(
    vserver: string,
    script: string,
    { timeoutMs = 60_000, maxBytes = 4 * 1024 * 1024 } = {},
  ): Promise<{ stdout: string; truncated: boolean }> {
    const t = await this.target(vserver);
    const host = (t.ipv4 ?? t.ipv6)!;
    const knownHosts = await this.hostKeyFile(t, host);
    const args = [
      "-T",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${knownHosts}`,
      "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      ...(this.identityFile ? ["-i", this.identityFile, "-o", "IdentitiesOnly=yes"] : []),
      "-l", t.username,
      host,
      "sh -s",
    ];
    return new Promise((resolve, reject) => {
      const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      let outBytes = 0;
      let err = "";
      let truncated = false;
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.stdout.on("data", (b: Buffer) => {
        if (outBytes + b.length > maxBytes) {
          truncated = true;
          child.kill("SIGTERM");
          return;
        }
        out.push(b);
        outBytes += b.length;
      });
      child.stderr.on("data", (b: Buffer) => {
        if (err.length < 8000) err += b.toString("utf8");
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new ZoneApiError(0, "SSH_NOT_AVAILABLE", `Could not run ssh: ${e.message}`));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(out).toString("utf8");
        if (truncated) return resolve({ stdout, truncated });
        if (signal) return reject(new ZoneApiError(0, "SSH_TIMEOUT", `ssh to ${t.username}@${host} timed out after ${timeoutMs / 1000}s.`));
        if (code === 255) return reject(explainSshError(t, host, err, this.identityFile));
        if (code !== 0 && !stdout) return reject(new ZoneApiError(0, "REMOTE_COMMAND_FAILED", `Remote command exited ${code}: ${err.trim().slice(0, 500)}`));
        resolve({ stdout, truncated });
      });
      child.stdin.end(script);
    });
  }

  /** Public keys this machine can offer: ZONE_SSH_KEY, ssh-agent, and ~/.ssh/*.pub. */
  async localPublicKeys(): Promise<{ source: string; type: string; comment?: string; fingerprint: string; public_key: string }[]> {
    const keys: { source: string; type: string; comment?: string; fingerprint: string; public_key: string }[] = [];
    const add = (source: string, text: string) => {
      for (const k of parsePublicKeys(text)) {
        if (!keys.some((x) => x.fingerprint === k.fingerprint)) keys.push({
            source,
            type: k.type,
            comment: k.comment,
            fingerprint: k.fingerprint,
            public_key: `${k.type} ${k.blob}${k.comment ? ` ${k.comment}` : ""}`,
          });
      }
    };
    if (this.identityFile) {
      try {
        add("ZONE_SSH_KEY", readFileSync(`${this.identityFile}.pub`, "utf8"));
      } catch {
        /* no .pub next to it */
      }
    }
    try {
      const { stdout } = await execFileAsync("ssh-add", ["-L"], { timeout: 5_000 });
      add("ssh-agent", stdout);
    } catch {
      /* no agent, or no keys in it */
    }
    const dir = join(homedir(), ".ssh");
    try {
      for (const f of readdirSync(dir).filter((f) => f.endsWith(".pub")).sort()) {
        try {
          add(`~/.ssh/${f}`, readFileSync(join(dir, f), "utf8"));
        } catch {
          /* unreadable */
        }
      }
    } catch {
      /* no ~/.ssh */
    }
    return keys;
  }
}

function explainSshError(t: SshTarget, host: string, stderr: string, identityFile?: string): ZoneApiError {
  const msg = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
  const where = `${t.username}@${host}`;
  if (/Permission denied|Too many authentication failures/i.test(stderr)) {
    const hint = /Too many authentication failures/i.test(stderr)
      ? " Your agent offered too many keys; set ZONE_SSH_KEY to the key registered on this webhosting."
      : identityFile
        ? ` ZONE_SSH_KEY (${identityFile}) is not accepted.`
        : " The server accepted none of the keys ssh offered (agent, ~/.ssh/config, default key files).";
    const wl = t.access === "whitelist" ? " SSH here also accepts only whitelisted IPs, so this machine's IP may simply not be listed." : "";
    return new ZoneApiError(401, "SSH_AUTH_FAILED", `SSH login to ${where} was refused.${hint}${wl} Run get_ssh_access to compare your keys with the registered ones. (${msg})`);
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(stderr)) {
    return new ZoneApiError(502, "HOST_KEY_MISMATCH", `The host key of ${host} did not match the fingerprints from the zone.ee API. Not connecting. (${msg})`);
  }
  if (/timed out|Connection refused|Connection closed|No route/i.test(stderr)) {
    const hint = t.access === "whitelist" ? " SSH on this webhosting only accepts whitelisted IPs; check get_ssh_access." : "";
    return new ZoneApiError(0, "SSH_UNREACHABLE", `Could not connect to ${where}.${hint} (${msg})`);
  }
  return new ZoneApiError(0, "SSH_FAILED", `ssh to ${where} failed: ${msg}`);
}

// ───────────────────────────── Remote script helpers ─────────────────────────────

/** `NAME="$(decoded value)"`: the value travels as base64, which is safe inside single quotes. */
export const shVar = (name: string, value: string) =>
  `${name}="$(printf '%s' '${Buffer.from(value, "utf8").toString("base64")}' | base64 -d)"`;

// ───────────────────────────── Logs ─────────────────────────────

export const LOG_KINDS = ["access", "error", "php", "pm2"] as const;
export type LogKind = (typeof LOG_KINDS)[number];

export interface LogQuery {
  log: LogKind;
  https: boolean;
  host?: string;
  status?: string;
  contains?: string;
  pm2_process?: string;
  pm2_stream: "out" | "error";
  days: number;
  lines: number;
}

export const MAX_LINE_CHARS = 2000;
const BEGIN = "__ZONE_MCP_BEGIN__";

/**
 * Build the remote script for a log query. Every user-supplied string goes through `shVar`; numbers are validated
 * integers; everything else is fixed text chosen here.
 *
 * Zone layout: `~/domeenid/www.<main domain>/logs/` holds `apache[.ssl].{access,error}.log` and `php.log` for the
 * main host and every child host (`alamdomeenid/`); each is rotated daily to `<name>.YYYY-MM-DD.gz` (5 kept).
 * Access lines start with the vhost name; error lines carry `[vhost: name]`. PM2 logs are in `~/.pm2/logs/` as
 * `<process>-out.log` / `<process>-error.log`, rotated (by pm2-logrotate) to `<base>__<date>.log[.gz]`.
 */
const PM2_LIST = [
  `printf 'NOPROC\\n'`,
  `ls -1 "$HOME/.pm2/logs" 2>/dev/null | sed -n 's/-\\(out\\|error\\)\\.log$//p' | sort -u | sed 's/^/P /'`,
  `exit 0`,
];

export function logScript(q: LogQuery): string {
  if (q.log === "pm2" && !q.pm2_process) return [...PM2_LIST, ""].join("\n");
  const apacheBase = (kind: "access" | "error") => `apache.${q.https ? "ssl." : ""}${kind}.log`;
  const base =
    q.log === "access" || q.log === "error" ? apacheBase(q.log) : q.log === "php" ? "php.log" : `${q.pm2_process}-${q.pm2_stream}`;
  // What may follow the base name in a rotated file (fixed text, not user input).
  const rotatedRe = q.log === "pm2" ? "^__[0-9_-]+\\.log(\\.gz)?$" : "^\\.[0-9]{4}-[0-9]{2}-[0-9]{2}\\.gz$";
  const current = q.log === "pm2" ? `${base}.log` : base;
  const dirs = q.log === "pm2" ? `"$HOME/.pm2/logs"` : `"$HOME"/domeenid/*/logs`;

  const filters: string[] = [];
  if (q.host) {
    filters.push(q.log === "access" ? `awk -v h="$HOST" 'tolower($1) == h'` : `grep -F -i -- "[vhost: $HOST]"`);
  }
  if (q.status) {
    // The first `" NNN ` is the status right after the quoted request line.
    filters.push(`awk -v re="$STATUS_RE" 'match($0, /" [0-9][0-9][0-9] /) { if (substr($0, RSTART + 2, 3) ~ re) print }'`);
  }
  if (q.contains) filters.push(`grep -F -i -- "$PAT"`);
  const pipeline = [`emit`, ...filters, `tail -n ${q.lines}`, `cut -c1-${MAX_LINE_CHARS}`].join(" | ");

  return [
    "set -u",
    "LC_ALL=C; export LC_ALL",
    shVar("BASE", base),
    shVar("CURRENT", current),
    shVar("HOST", (q.host ?? "").toLowerCase()),
    shVar("PAT", q.contains ?? ""),
    shVar("STATUS_RE", q.status ? `^${q.status.replace(/x/g, "[0-9]")}$` : ""),
    `FILES=""`,
    `for d in ${dirs}; do`,
    `  [ -d "$d" ] || continue`,
    ...(q.days > 0
      ? [
          `  for f in $(ls -1 "$d" 2>/dev/null | awk -v p="$BASE" 'index($0, p) == 1 && substr($0, length(p) + 1) ~ /${rotatedRe}/' | sort | tail -n ${q.days}); do`,
          `    FILES="$FILES $d/$f"`,
          `  done`,
        ]
      : []),
    `  [ -f "$d/$CURRENT" ] && FILES="$FILES $d/$CURRENT"`,
    `done`,
    ...(q.log === "pm2" ? [`if [ -z "$FILES" ]; then`, ...PM2_LIST.map((l) => `  ${l}`), `fi`] : []),
    `for f in $FILES; do printf 'F %s\\n' "\${f#$HOME/}"; done`,
    `printf '%s\\n' '${BEGIN}'`,
    `emit() { for f in $FILES; do case "$f" in *.gz) gzip -dc -- "$f" 2>/dev/null ;; *) cat -- "$f" 2>/dev/null ;; esac; done; }`,
    pipeline,
    `exit 0`,
    "",
  ].join("\n");
}

export interface LogResult {
  files: string[];
  lines: string[];
  pm2_processes?: string[];
}

export function parseLogOutput(stdout: string): LogResult {
  const lines = stdout.split("\n");
  if (lines[0] === "NOPROC") {
    return { files: [], lines: [], pm2_processes: lines.filter((l) => l.startsWith("P ")).map((l) => l.slice(2)) };
  }
  const at = lines.indexOf(BEGIN);
  const head = at < 0 ? lines : lines.slice(0, at);
  const body = at < 0 ? [] : lines.slice(at + 1);
  if (body.length && body[body.length - 1] === "") body.pop();
  return { files: head.filter((l) => l.startsWith("F ")).map((l) => l.slice(2)), lines: body };
}
