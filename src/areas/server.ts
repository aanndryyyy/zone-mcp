/** Webhosting server administration: cron jobs, SSL certificates, SSH keys / IP whitelist / access mode. */
import * as z from "zod";
import { ZoneApiError } from "../client.js";
import { WRITE, defined, diff, first, id, pick, seg, tool, vserver, type Deps } from "../common.js";
import * as out from "../schemas.js";

const CRON_WRITABLE = ["command", "name", "type", "active", "report", "report_email", "priority", "schedule", "timezone", "runtime_limit"] as const;

const cronFields = {
  name: z.string().optional(),
  command: z.string().min(1).describe("Command or script path (type 'system') or URL (type 'http')."),
  type: z.enum(["http", "system"]).describe("'http' fetches a URL, 'system' runs a command."),
  schedule: z.string().min(1).describe("Cron schedule, e.g. '0 3 * * *'."),
  active: z.boolean().optional(),
  report: z.enum(["never", "onerror", "onoutputorerror", "onoutput", "always"]).optional().describe("When to e-mail a report."),
  report_email: z.string().optional(),
  priority: z.enum(["low", "normal", "high"]).optional(),
  timezone: z.enum(["UTC", "Europe/Tallinn", "Europe/Amsterdam", "Europe/Helsinki"]).optional().describe("type 'system' only."),
  runtime_limit: z
    .union([z.literal(900), z.literal(1800), z.literal(3600), z.literal(10800), z.literal(86340)])
    .optional()
    .describe("Seconds; type 'system' only."),
};

/** Certificate without its private key: keys must never reach the conversation. */
const noKey = (c: any) => {
  if (!c || typeof c !== "object") return c;
  const { private_key: _k, certificate: _c, ca_certificate: _ca, ...rest } = c;
  return rest;
};

export function registerServerAccessTools(deps: Deps): void {
  const { client } = deps;
  const v = (s: string) => `/vserver/${seg(s)}`;

  // ── Cron ──

  const cronId = id("Cron job id from list_cron_jobs.");

  tool(
    deps,
    "create_cron_job",
    {
      title: "Create cron job",
      description: "Add a cron job to a webhosting. Valid option values: describe_endpoint('/vserver/{service_name}/crontab', 'OPTIONS') or the enums here.",
      input: z.object({ vserver, ...cronFields }),
      output: out.objectWrite("cron_job"),
      annotations: WRITE(false, false),
    },
    async ({ vserver, ...body }) => {
      const res = await client.request("POST", `${v(vserver)}/crontab`, { body: defined(body) });
      return { status: "created", cron_job: first(res) ?? body };
    },
  );

  tool(
    deps,
    "update_cron_job",
    {
      title: "Update cron job",
      description: "Change a cron job (e.g. pause it with `active: false`). Only the fields you pass change; asks the user to confirm.",
      input: z.object({
        vserver,
        cron_id: cronId,
        ...Object.fromEntries(Object.entries(cronFields).map(([k, s]) => [k, (s as z.ZodType).optional()])),
      } as { vserver: typeof vserver; cron_id: typeof cronId } & { [K in keyof typeof cronFields]: z.ZodOptional<(typeof cronFields)[K]> }),
      output: out.objectWrite("cron_job"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, cron_id, ...fields }, { confirm }) => {
      const changes = defined(fields as Record<string, unknown>);
      if (!Object.keys(changes).length) throw new ZoneApiError(400, "NOTHING_TO_UPDATE", "Pass at least one field to change.");
      const path = `${v(vserver)}/crontab/${seg(cron_id)}`;
      const current = first(await client.request("GET", path));
      if (!current) throw new ZoneApiError(404, "HTTP_404", `No cron job ${cron_id} on ${vserver}.`);
      const d = await confirm(
        () => `Change the cron job "${current.name ?? current.command}" on ${vserver}?\n${diff(current, changes)}`,
        { vserver, cron_id },
        "the cron job was not changed",
      );
      if (d !== "go") return d;
      const res = await client.request("PUT", path, { body: { ...pick(current, CRON_WRITABLE), ...changes } });
      return { status: "updated", cron_job: first(res) };
    },
  );

  tool(
    deps,
    "delete_cron_job",
    {
      title: "Delete cron job",
      description: "Delete a cron job. Asks the user to confirm.",
      input: z.object({ vserver, cron_id: cronId }),
      output: out.objectWrite("cron_job"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, cron_id }, { confirm }) => {
      const path = `${v(vserver)}/crontab/${seg(cron_id)}`;
      const d = await confirm(
        async () => {
          const c = first(await client.request("GET", path).catch(() => ({ data: null }) as any));
          return `Delete the cron job ${c ? `"${c.name ?? ""}" (${c.schedule} ${c.command})` : cron_id} on ${vserver}?`;
        },
        { vserver, cron_id },
        "nothing was deleted",
      );
      if (d !== "go") return d;
      await client.request("DELETE", path);
      return { status: "deleted", cron_job: { identificator: cron_id } };
    },
  );

  // ── SSL certificates ──

  const certId = id("Certificate id from list_ssl_certificates.");
  const pem = (what: string) => z.string().min(1).describe(`${what} (PEM).`);

  tool(
    deps,
    "upload_ssl_certificate",
    {
      title: "Upload SSL certificate",
      description:
        "Add a custom (non-Let's Encrypt) SSL certificate to a webhosting, optionally for `hosts`. Attach it to a host " +
        "with set_host_certificate. The private key is sent to Zone only and never returned.",
      input: z.object({
        vserver,
        name: z.string().min(1),
        certificate: pem("Certificate"),
        private_key: pem("Private key"),
        ca_certificate: pem("CA chain").optional(),
        hosts: z.array(z.string()).optional(),
      }),
      output: out.objectWrite("certificate"),
      annotations: WRITE(false, false),
    },
    async ({ vserver, ...body }) => {
      const res = await client.request("POST", `${v(vserver)}/ssl`, { body: defined(body) });
      return { status: "created", certificate: noKey(first(res)) };
    },
  );

  tool(
    deps,
    "update_ssl_certificate",
    {
      title: "Update SSL certificate",
      description:
        "Replace a custom certificate's contents (e.g. a renewed certificate with its key), its name, or the hosts it is " +
        "used on. Only the fields you pass change. Asks the user to confirm; key material is never shown.",
      input: z.object({
        vserver,
        certificate_id: certId,
        name: z.string().min(1).optional(),
        certificate: pem("Certificate").optional(),
        private_key: pem("Private key").optional(),
        ca_certificate: pem("CA chain").optional(),
        hosts: z.array(z.string()).optional(),
      }),
      output: out.objectWrite("certificate"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, certificate_id, ...fields }, { confirm }) => {
      const changes = defined(fields);
      if (!Object.keys(changes).length) throw new ZoneApiError(400, "NOTHING_TO_UPDATE", "Pass at least one field to change.");
      const path = `${v(vserver)}/ssl/${seg(certificate_id)}`;
      const current = first(await client.request("GET", path));
      if (!current) throw new ZoneApiError(404, "HTTP_404", `No certificate ${certificate_id} on ${vserver}.`);
      const visible = defined({ name: changes.name, hosts: changes.hosts });
      const material = ["certificate", "private_key", "ca_certificate"].filter((k) => k in changes);
      const d = await confirm(
        () =>
          `Update the certificate "${current.name}" (${current.cn ?? ""}, expires ${current.expires ?? "?"}) on ${vserver}?\n` +
          (Object.keys(visible).length ? `${diff(current, visible)}\n` : "") +
          (material.length ? `• replace: ${material.join(", ")}` : ""),
        { vserver, certificate_id },
        "the certificate was not changed",
      );
      if (d !== "go") return d;
      // PUT replaces the certificate; keep the stored PEM parts (including the key) when they are not replaced.
      const body = { ...pick(current, ["name", "certificate", "private_key", "ca_certificate", "hosts"]), ...changes };
      const res = await client.request("PUT", path, { body });
      return { status: "updated", certificate: noKey(first(res)) };
    },
  );

  tool(
    deps,
    "delete_ssl_certificate",
    {
      title: "Delete SSL certificate",
      description: "Delete an SSL certificate from a webhosting; hosts using it lose HTTPS until another one is attached. Asks the user to confirm.",
      input: z.object({ vserver, certificate_id: certId }),
      output: out.objectWrite("certificate"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, certificate_id }, { confirm }) => {
      const path = `${v(vserver)}/ssl/${seg(certificate_id)}`;
      const d = await confirm(
        async () => {
          const c = first(await client.request("GET", path).catch(() => ({ data: null }) as any));
          return `Delete the SSL certificate ${c ? `"${c.name}" (${c.cn}, used on ${[].concat(c.hosts ?? []).join(", ") || "no hosts"})` : certificate_id} on ${vserver}?`;
        },
        { vserver, certificate_id },
        "nothing was deleted",
      );
      if (d !== "go") return d;
      await client.request("DELETE", path);
      return { status: "deleted", certificate: { id: certificate_id } };
    },
  );

  // ── SSH ──

  tool(
    deps,
    "add_ssh_key",
    {
      title: "Add SSH public key",
      description:
        "Register an SSH PUBLIC key (e.g. 'ssh-ed25519 AAAA… comment') for a webhosting's SSH user; never pass a " +
        "private key. Grants shell access to whoever holds the matching private key, so the user is asked to confirm.",
      input: z.object({
        vserver,
        public_key: z
          .string()
          .regex(/^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp\d+|sk-[a-z0-9@.-]+) [A-Za-z0-9+/=]+/, "An OpenSSH public key line.")
          .describe("One OpenSSH public key line."),
        comment: z.string().optional().describe("Who or what the key is for."),
      }),
      output: out.objectWrite("key"),
      annotations: WRITE(false, false),
    },
    async ({ vserver, public_key, comment }, { confirm }) => {
      const [type, body, ...rest] = public_key.trim().split(/\s+/);
      const d = await confirm(
        () => `Allow SSH login to ${vserver} with the ${type} key …${body.slice(-12)}${rest.length ? ` (${rest.join(" ")})` : ""}${comment ? ` – ${comment}` : ""}?`,
        { vserver },
        "no key was added",
      );
      if (d !== "go") return d;
      const res = await client.request("POST", `${v(vserver)}/ssh/publickey`, { body: defined({ public_key: public_key.trim(), comment }) });
      const { public_key: _pk, ...key } = first(res) ?? {};
      return { status: "created", key };
    },
  );

  tool(
    deps,
    "delete_ssh_key",
    {
      title: "Remove SSH public key",
      description:
        "Remove a registered SSH public key (id from get_ssh_access → registered_keys). Anything logging in with it " +
        "(e.g. a CI deploy) stops working. Asks the user to confirm.",
      input: z.object({ vserver, key_id: id("Key id from get_ssh_access → registered_keys.") }),
      output: out.objectWrite("key"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, key_id }, { confirm }) => {
      const path = `${v(vserver)}/ssh/publickey/${seg(key_id)}`;
      const d = await confirm(
        async () => {
          const k = first(await client.request("GET", path).catch(() => ({ data: null }) as any));
          return `Remove the SSH key ${k ? `"${k.comment ?? ""}" ${k.type ?? ""} ${k.fingerprint ?? ""} (last used ${k.last_used ?? "never"})` : key_id} from ${vserver}?`;
        },
        { vserver, key_id },
        "nothing was removed",
      );
      if (d !== "go") return d;
      await client.request("DELETE", path);
      return { status: "deleted", key: { id: key_id } };
    },
  );

  tool(
    deps,
    "add_ssh_whitelist_ip",
    {
      title: "Whitelist an IP for SSH",
      description: "Allow SSH from an IP or CIDR range (IPv4 or IPv6) when the webhosting's SSH access mode is 'whitelist'. Asks the user to confirm.",
      input: z.object({ vserver, ip: z.string().min(2).describe("IP or CIDR, e.g. '203.0.113.7' or '203.0.113.0/24'."), comment: z.string().optional() }),
      output: out.objectWrite("whitelist_entry"),
      annotations: WRITE(false, false),
    },
    async ({ vserver, ip, comment }, { confirm }) => {
      const d = await confirm(() => `Allow SSH to ${vserver} from ${ip}${comment ? ` (${comment})` : ""}?`, { vserver, ip }, "nothing was added");
      if (d !== "go") return d;
      const res = await client.request("POST", `${v(vserver)}/ssh/whitelist`, { body: defined({ ip, comment }) });
      return { status: "created", whitelist_entry: first(res) ?? { ip, comment } };
    },
  );

  tool(
    deps,
    "delete_ssh_whitelist_ip",
    {
      title: "Remove SSH whitelist IP",
      description: "Remove an IP from a webhosting's SSH whitelist (id from get_ssh_access → whitelist). Asks the user to confirm.",
      input: z.object({ vserver, entry_id: id("Whitelist entry id.") }),
      output: out.objectWrite("whitelist_entry"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, entry_id }, { confirm }) => {
      const path = `${v(vserver)}/ssh/whitelist/${seg(entry_id)}`;
      const d = await confirm(
        async () => {
          const e = first(await client.request("GET", path).catch(() => ({ data: null }) as any));
          return `Stop allowing SSH to ${vserver} from ${e ? `${e.ip}${e.comment ? ` (${e.comment})` : ""}` : entry_id}?`;
        },
        { vserver, entry_id },
        "nothing was removed",
      );
      if (d !== "go") return d;
      await client.request("DELETE", path);
      return { status: "deleted", whitelist_entry: { identificator: entry_id } };
    },
  );

  tool(
    deps,
    "set_ssh_access",
    {
      title: "Set SSH access mode",
      description:
        "Switch a webhosting's SSH between 'public' (any IP, key required) and 'whitelist' (only whitelisted IPs). " +
        "Only on the user's request: switching to whitelist locks out keys that connect from changing IPs, such as CI " +
        "deploy keys. Asks the user to confirm.",
      input: z.object({ vserver, access: z.enum(["public", "whitelist"]) }),
      output: out.objectWrite("ssh"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, access }, { confirm }) => {
      const current = first(await client.request("GET", `${v(vserver)}/ssh`));
      const d = await confirm(
        () =>
          `Change SSH access of ${vserver} from ${current?.access ?? "?"} to ${access}?` +
          (access === "whitelist" ? " Logins from IPs not on the whitelist (e.g. CI) will be refused." : ""),
        { vserver, access },
        "the access mode was not changed",
      );
      if (d !== "go") return d;
      const res = await client.request("PUT", `${v(vserver)}/ssh`, { body: { access } });
      const { server_fingerprints: _f, ...ssh } = first(res) ?? { access };
      return { status: "updated", ssh };
    },
  );
}
