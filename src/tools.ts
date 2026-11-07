import {
  isInputRequiredResult,
  type CallToolResult,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod";
import { ZoneApiError, ZoneClient, type Method, type Pager, type Query } from "./client.js";
import { canElicit, confirmWrite, notConfirmed } from "./confirm.js";
import { describeEndpoint, searchEndpoints } from "./spec.js";
import * as out from "./schemas.js";

type ToolResult = CallToolResult;

/** Same JSON as text (compact) and as `structuredContent` (typed by `outputSchema`). */
const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data as Record<string, unknown>,
});

const fail = (err: unknown): ToolResult => {
  if (err instanceof ZoneApiError) {
    const error: Record<string, unknown> = { status: err.status, code: err.code, message: err.message };
    if (err.details !== undefined) error.details = err.details;
    if (err.rateLimitRemaining) error.ratelimit_remaining = err.rateLimitRemaining;
    return { content: [{ type: "text", text: JSON.stringify({ error }) }], isError: true };
  }
  return { content: [{ type: "text", text: `Error: ${(err as Error)?.message ?? String(err)}` }], isError: true };
};

/** API errors come back as tool errors the model can read; `input_required` (a confirmation request) passes through. */
const run =
  <A>(fn: (args: A, ctx: ServerContext) => Promise<unknown>) =>
  async (args: A, ctx: ServerContext): Promise<ToolResult | InputRequiredResult> => {
    try {
      const data = await fn(args, ctx);
      return isInputRequiredResult(data) ? data : ok(data);
    } catch (err) {
      return fail(err);
    }
  };

/** Drop the hypermedia noise (`resource_url`, `_links`) the API puts on every object. */
const slim = (data: unknown): unknown => {
  if (Array.isArray(data)) return data.map(slim);
  if (!data || typeof data !== "object") return data;
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (k !== "resource_url" && k !== "_links") copy[k] = v;
  return copy;
};

const asArray = (data: unknown): unknown[] => (Array.isArray(data) ? data : data == null ? [] : [data]);

/** `{ [key]: items, pager? }` — tool results must be objects, and the API always returns arrays. */
const listResult = (key: string, data: unknown, pager?: Pager) => ({ [key]: slim(asArray(data)), ...(pager ? { pager } : {}) });

const seg = (s: string) => encodeURIComponent(s.trim());

// ───────────────────────────── Shared input fields ─────────────────────────────

const domain = z.string().min(1).describe("Domain name, e.g. 'example.com'.");
const vserver = z
  .string()
  .min(1)
  .describe("Webhosting (virtual server) name, usually its main domain, e.g. 'example.com' (see list_webhostings).");
const page = z.number().int().min(1).optional().describe("Page number (default 1).");
const limit = z.number().int().min(1).max(100).optional().describe("Items per page, 1–100 (default 10 on paginated endpoints).");

const DNS_TYPES = ["a", "aaaa", "cname", "mx", "txt", "ns", "srv", "caa", "tlsa", "sshfp", "url"] as const;
const dnsType = z
  .enum(DNS_TYPES)
  .describe("Record type: a, aaaa, cname, mx, txt, ns, srv, caa, tlsa, sshfp, or url (Zone's HTTP redirect record).");

/** Type-specific DNS fields. One flat object (not a union) so the input schema stays a plain JSON object. */
const dnsFields = {
  priority: z.number().int().min(0).optional().describe("MX, SRV: priority."),
  weight: z.number().int().min(0).optional().describe("SRV: weight."),
  port: z.number().int().min(0).max(65535).optional().describe("SRV: port."),
  flag: z.number().int().min(0).max(255).optional().describe("CAA: flag (usually 0)."),
  tag: z.enum(["issue", "issuewild", "iodef"]).optional().describe("CAA: tag."),
  certificate_usage: z.number().int().min(0).max(3).optional().describe("TLSA: certificate usage 0–3."),
  selector: z.number().int().min(0).max(1).optional().describe("TLSA: selector 0–1."),
  matching_type: z.number().int().min(0).max(2).optional().describe("TLSA: matching type 0–2."),
  algorithm: z.number().int().min(1).max(4).optional().describe("SSHFP: algorithm (1=RSA, 2=DSA, 3=ECDSA, 4=Ed25519)."),
  fingerprint_type: z.number().int().min(1).max(2).optional().describe("SSHFP: fingerprint type (1=SHA-1, 2=SHA-256)."),
  redirect_type: z.union([z.literal(301), z.literal(302)]).optional().describe("URL: HTTP redirect status, 301 (default) or 302."),
};
type DnsFields = { [K in keyof typeof dnsFields]?: z.infer<(typeof dnsFields)[K]> };

const REQUIRED_DNS_FIELDS: Partial<Record<(typeof DNS_TYPES)[number], (keyof DnsFields)[]>> = {
  mx: ["priority"],
  srv: ["priority", "weight", "port"],
  caa: ["flag", "tag"],
  tlsa: ["certificate_usage", "selector", "matching_type"],
  sshfp: ["algorithm", "fingerprint_type"],
};
const ALLOWED_DNS_FIELDS: Record<(typeof DNS_TYPES)[number], (keyof DnsFields)[]> = {
  a: [], aaaa: [], cname: [], txt: [], ns: [],
  mx: ["priority"],
  srv: ["priority", "weight", "port"],
  caa: ["flag", "tag"],
  tlsa: ["certificate_usage", "selector", "matching_type"],
  sshfp: ["algorithm", "fingerprint_type"],
  url: ["redirect_type"],
};
/** Tool field → API body field (SSHFP and URL records both call theirs `type`). */
const API_FIELD: Partial<Record<keyof DnsFields, string>> = { fingerprint_type: "type", redirect_type: "type" };

/** Build the API body from tool args, rejecting fields that don't belong to this record type. */
function dnsBody(type: (typeof DNS_TYPES)[number], args: { name?: string; destination?: string } & DnsFields, creating: boolean) {
  const allowed = ALLOWED_DNS_FIELDS[type];
  const extra = (Object.keys(dnsFields) as (keyof DnsFields)[]).filter((k) => args[k] !== undefined && !allowed.includes(k));
  if (extra.length) {
    throw new ZoneApiError(400, "INVALID_FIELDS", `${extra.join(", ")} ${extra.length > 1 ? "do" : "does"} not apply to ${type.toUpperCase()} records.`);
  }
  if (creating) {
    const missing = (REQUIRED_DNS_FIELDS[type] ?? []).filter((k) => args[k] === undefined);
    if (missing.length) throw new ZoneApiError(400, "MISSING_FIELDS", `${type.toUpperCase()} records need: ${missing.join(", ")}.`);
  }
  const body: Record<string, unknown> = {};
  if (args.name !== undefined) body.name = args.name;
  if (args.destination !== undefined) body.destination = args.destination;
  for (const k of allowed) if (args[k] !== undefined) body[API_FIELD[k] ?? k] = args[k];
  return body;
}

/** Zone wants record names as FQDNs ('www.example.com'); accept '@', bare labels and trailing dots too. */
function fqdn(name: string, zone: string): string {
  const n = name.trim().replace(/\.$/, "").toLowerCase();
  const z = zone.trim().replace(/\.$/, "").toLowerCase();
  if (n === "" || n === "@") return z;
  return n === z || n.endsWith(`.${z}`) ? n : `${n}.${z}`;
}

const describeRecord = (type: string, r: any) =>
  `${type.toUpperCase()} ${r?.name ?? "?"} → ${r?.destination ?? "?"}` + (r?.priority !== undefined ? ` (priority ${r.priority})` : "");

export function registerTools(server: McpServer, client: ZoneClient): void {
  /**
   * Gate a write on user confirmation (when the client can show a form). `describe` is only called when a prompt
   * will actually be shown, so clients without elicitation don't pay for the extra lookup.
   */
  const confirmed = async (
    ctx: ServerContext,
    tool: string,
    args: unknown,
    describe: () => Promise<string> | string,
    what: Record<string, unknown>,
    nothing: string,
  ): Promise<"go" | InputRequiredResult | ReturnType<typeof notConfirmed>> => {
    if (!canElicit(server, ctx)) return "go";
    const decision = confirmWrite(server, ctx, tool, args, await describe());
    if (decision === "declined" || decision === "cancelled") return notConfirmed(decision, what, nothing);
    return decision;
  };

  const getRecord = (zone: string, type: string, id: string) =>
    // Match on id: for an unknown id the API can answer with other records instead of a 404.
    client
      .request<any[]>("GET", `/dns/${seg(zone)}/${type}/${seg(id)}`)
      .then((r) => asArray(r.data).find((rec: any) => String(rec?.id) === String(id)) as any);

  // ───────────────────────────── Domains ─────────────────────────────

  server.registerTool(
    "list_domains",
    {
      title: "List domains",
      description:
        "List the domains on the ZoneID account with expiry, DNSSEC, autorenew and delegation info. Paginated (see `pager`).",
      inputSchema: z.object({
        name: z.string().optional().describe("Only domains whose name contains this string."),
        needs_renewal: z.boolean().optional().describe("Only domains expiring within 30 days."),
        renewable: z.boolean().optional().describe("Only renewable domains."),
        order_by: z.enum(["name", "expires"]).optional(),
        order_dir: z.enum(["asc", "desc"]).optional(),
        page,
        limit,
      }),
      outputSchema: out.list("domains"),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ name, needs_renewal, renewable, order_by, order_dir, page, limit }) => {
      const res = await client.request("GET", "/domain", {
        query: { name, needs_renewal, renewable },
        page,
        limit,
        orderBy: order_by,
        orderDir: order_dir,
      });
      return listResult("domains", res.data, res.pager);
    }),
  );

  server.registerTool(
    "get_domain",
    {
      title: "Get domain",
      description: "Get one domain's registration details (expiry, DNSSEC, autorenew, delegation) together with its nameservers.",
      inputSchema: z.object({ domain }),
      outputSchema: out.getDomain,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ domain }) => {
      const [d, ns] = await Promise.all([
        client.request("GET", `/domain/${seg(domain)}`),
        client.request("GET", `/domain/${seg(domain)}/nameserver`),
      ]);
      return { domain: slim(asArray(d.data)[0] ?? null), nameservers: slim(asArray(ns.data)) };
    }),
  );

  // ───────────────────────────── Webhosting ─────────────────────────────

  server.registerTool(
    "list_webhostings",
    {
      title: "List webhostings",
      description:
        "List the webhosting packages (virtual servers) on the account: name, package, disk/memory usage and limits, " +
        "home directory, MySQL host. The `name` is the `vserver` argument for the mail, MySQL, cron and SSL tools.",
      inputSchema: z.object({ page, limit }),
      outputSchema: out.list("webhostings"),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ page, limit }) => {
      // `GET /vserver` is not in the published OpenAPI spec, but the API serves it.
      const res = await client.request("GET", "/vserver", { page, limit });
      return listResult("webhostings", res.data, res.pager);
    }),
  );

  server.registerTool(
    "get_server_info",
    {
      title: "Get webhosting server info",
      description:
        "Server details for a webhosting: IPs, temporary domain, home and document-root paths, MySQL and loopback " +
        "hostnames, system username, binary paths, phpMyAdmin URL.",
      inputSchema: z.object({ vserver }),
      outputSchema: out.object("server_info"),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ vserver }) => {
      const res = await client.request("GET", `/vserver/${seg(vserver)}/serverinfo`);
      return { server_info: slim(asArray(res.data)[0] ?? null) };
    }),
  );

  // ───────────────────────────── DNS ─────────────────────────────

  server.registerTool(
    "list_dns_records",
    {
      title: "List DNS records",
      description:
        "List DNS records in a zone. Pass `type` for one record type; omit it to fetch every type (one API request per " +
        "type, 11 in total, against a limit of 60/min). Record names are FQDNs ('www.example.com'). Each record has an " +
        "`id` (for update/delete) and `modify` / `delete` flags; records with `delete: false` are system-managed. " +
        "TTL is managed by Zone and not exposed by the API.",
      inputSchema: z.object({
        zone: domain.describe("DNS zone, e.g. 'example.com'."),
        type: dnsType.optional(),
        name: z.string().optional().describe("Only records with this name ('www', 'www.example.com' or '@' for the apex)."),
      }),
      outputSchema: out.dnsRecords,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ zone, type, name }) => {
      const types = type ? [type] : DNS_TYPES;
      const lists = await Promise.all(
        types.map(async (t) => {
          const res = await client.request("GET", `/dns/${seg(zone)}/${t}`);
          return asArray(slim(res.data)).map((r: any) => ({ type: t, ...r }));
        }),
      );
      let records = lists.flat();
      if (name) {
        const want = fqdn(name, zone);
        records = records.filter((r: any) => String(r.name).toLowerCase().replace(/\.$/, "") === want);
      }
      return { zone, records };
    }),
  );

  server.registerTool(
    "create_dns_record",
    {
      title: "Create DNS record",
      description:
        "Create a DNS record. `name` may be '@' (zone apex), a label like 'www', or the FQDN; it is sent to Zone as an " +
        "FQDN. Type-specific fields: MX priority; SRV priority, weight and port; CAA flag and tag; TLSA certificate_usage, " +
        "selector and matching_type; SSHFP algorithm and fingerprint_type; URL redirect_type. TTL can't be set through the API.",
      inputSchema: z.object({
        zone: domain.describe("DNS zone, e.g. 'example.com'."),
        type: dnsType,
        name: z.string().describe("'@', a label ('www', '_acme-challenge') or the FQDN."),
        destination: z
          .string()
          .min(1)
          .describe("The record value: IP, target host, TXT text, CAA value, fingerprint, or the redirect URL for URL records."),
        ...dnsFields,
      }),
      outputSchema: out.dnsRecord,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async ({ zone, type, name, destination, ...rest }) => {
      const body = dnsBody(type, { name: fqdn(name, zone), destination, ...rest }, true);
      const res = await client.request("POST", `/dns/${seg(zone)}/${type}`, { body });
      return { record: { type, ...(slim(asArray(res.data)[0] ?? body) as object) } };
    }),
  );

  server.registerTool(
    "update_dns_record",
    {
      title: "Update DNS record",
      description:
        "Change an existing DNS record (find its `id` with list_dns_records). Only the fields you pass are changed. When " +
        "the client supports it, the user is asked to confirm the old and new values first; if they decline, nothing " +
        "changes and the result has status 'declined' (or 'cancelled').",
      inputSchema: z.object({
        zone: domain.describe("DNS zone, e.g. 'example.com'."),
        type: dnsType,
        id: z.string().min(1).describe("Record id from list_dns_records."),
        name: z.string().optional().describe("New name: '@', a label or the FQDN."),
        destination: z.string().min(1).optional().describe("New value."),
        ...dnsFields,
      }),
      outputSchema: out.dnsRecordWrite,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async (args, ctx) => {
      const { zone, type, id, name, destination, ...rest } = args;
      const changes = dnsBody(type, { name: name === undefined ? undefined : fqdn(name, zone), destination, ...rest }, false);
      if (!Object.keys(changes).length) throw new ZoneApiError(400, "NOTHING_TO_UPDATE", "Pass at least one field to change.");
      // PUT replaces the record, so merge the changes into the current writable fields.
      const current = await getRecord(zone, type, id);
      if (!current) throw new ZoneApiError(404, "HTTP_404", `No ${type.toUpperCase()} record ${id} in ${zone}.`);
      const decision = await confirmed(
        ctx,
        "update_dns_record",
        args,
        () => `Change ${describeRecord(type, current)} in ${zone} to ${describeRecord(type, { ...current, ...changes })}?`,
        { zone, type, id },
        "the record was not changed",
      );
      if (decision !== "go") return decision;
      const writable = ["name", "destination", ...ALLOWED_DNS_FIELDS[type].map((k) => API_FIELD[k] ?? k)];
      const body: Record<string, unknown> = {};
      for (const k of writable) if (current[k] !== undefined && current[k] !== null) body[k] = current[k];
      Object.assign(body, changes);
      const res = await client.request("PUT", `/dns/${seg(zone)}/${type}/${seg(id)}`, { body });
      return { status: "updated", record: { type, ...(slim(asArray(res.data)[0] ?? body) as object) } };
    }),
  );

  server.registerTool(
    "delete_dns_record",
    {
      title: "Delete DNS record",
      description:
        "Delete a DNS record by id (from list_dns_records). When the client supports it, the user is asked to confirm " +
        "first; if they decline, nothing is deleted and the result has status 'declined' (or 'cancelled').",
      inputSchema: z.object({
        zone: domain.describe("DNS zone, e.g. 'example.com'."),
        type: dnsType,
        id: z.string().min(1).describe("Record id from list_dns_records."),
      }),
      outputSchema: out.dnsRecordWrite,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async (args, ctx) => {
      const { zone, type, id } = args;
      const decision = await confirmed(
        ctx,
        "delete_dns_record",
        args,
        async () => {
          const current = await getRecord(zone, type, id).catch(() => undefined);
          return `Delete ${current ? describeRecord(type, current) : `${type.toUpperCase()} record ${id}`} from ${zone}?`;
        },
        { zone, type, id },
        "nothing was deleted",
      );
      if (decision !== "go") return decision;
      await client.request("DELETE", `/dns/${seg(zone)}/${type}/${seg(id)}`);
      return { status: "deleted", zone, type, id };
    }),
  );

  // ───────────────────────────── Mail ─────────────────────────────

  server.registerTool(
    "list_mail_accounts",
    {
      title: "List mailboxes",
      description: "List the e-mail accounts (mailboxes) on a webhosting, with quota, spam level, forwards and 2FA state.",
      inputSchema: z.object({ vserver, address: z.string().optional().describe("Filter by address."), page, limit }),
      outputSchema: out.list("mail_accounts"),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ vserver, address, page, limit }) => {
      const res = await client.request("GET", `/vserver/${seg(vserver)}/mail/account`, { query: { address }, page, limit });
      return listResult("mail_accounts", res.data, res.pager);
    }),
  );

  server.registerTool(
    "list_mail_forwarders",
    {
      title: "List mail forwarders",
      description: "List the e-mail forwarders (aliases) on a webhosting and where each one forwards to.",
      inputSchema: z.object({ vserver, address: z.string().optional().describe("Filter by address."), page, limit }),
      outputSchema: out.list("mail_forwarders"),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ vserver, address, page, limit }) => {
      const res = await client.request("GET", `/vserver/${seg(vserver)}/mail/forwarder`, { query: { address }, page, limit });
      return listResult("mail_forwarders", res.data, res.pager);
    }),
  );

  server.registerTool(
    "create_mail_forwarder",
    {
      title: "Create mail forwarder",
      description: "Create an e-mail forwarder (alias) that forwards `address` to one or more destination addresses.",
      inputSchema: z.object({
        vserver,
        address: z.string().min(3).describe("The forwarder address, e.g. 'info@example.com'."),
        fwd_addresses: z.array(z.string().min(3)).min(1).describe("Destination addresses."),
        comment: z.string().optional(),
      }),
      outputSchema: out.object("mail_forwarder"),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async ({ vserver, address, fwd_addresses, comment }) => {
      const body = { address, fwd_addresses, ...(comment !== undefined ? { comment } : {}) };
      const res = await client.request("POST", `/vserver/${seg(vserver)}/mail/forwarder`, { body });
      return { mail_forwarder: slim(asArray(res.data)[0] ?? body) };
    }),
  );

  server.registerTool(
    "update_mail_forwarder",
    {
      title: "Update mail forwarder",
      description:
        "Replace the destination list and/or comment of an e-mail forwarder. `fwd_addresses` replaces the whole list. " +
        "When the client supports it, the user is asked to confirm first.",
      inputSchema: z.object({
        vserver,
        address: z.string().min(3).describe("The forwarder address, e.g. 'info@example.com'."),
        fwd_addresses: z.array(z.string().min(3)).min(1).optional().describe("New full list of destination addresses."),
        comment: z.string().optional(),
      }),
      outputSchema: out.objectWrite("mail_forwarder"),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async (args, ctx) => {
      const { vserver, address, fwd_addresses, comment } = args;
      if (fwd_addresses === undefined && comment === undefined)
        throw new ZoneApiError(400, "NOTHING_TO_UPDATE", "Pass fwd_addresses and/or comment.");
      const path = `/vserver/${seg(vserver)}/mail/forwarder/${seg(address)}`;
      const current: any = asArray((await client.request("GET", path)).data)[0];
      if (!current) throw new ZoneApiError(404, "HTTP_404", `No forwarder ${address} on ${vserver}.`);
      const body = {
        fwd_addresses: fwd_addresses ?? current.fwd_addresses ?? [],
        comment: comment ?? current.comment ?? "",
      };
      const decision = await confirmed(
        ctx,
        "update_mail_forwarder",
        args,
        () => `Change forwarder ${address} from [${(current.fwd_addresses ?? []).join(", ")}] to [${body.fwd_addresses.join(", ")}]?`,
        { vserver, address },
        "the forwarder was not changed",
      );
      if (decision !== "go") return decision;
      const res = await client.request("PUT", path, { body });
      return { status: "updated", mail_forwarder: slim(asArray(res.data)[0] ?? { address, ...body }) };
    }),
  );

  server.registerTool(
    "delete_mail_forwarder",
    {
      title: "Delete mail forwarder",
      description:
        "Delete an e-mail forwarder. When the client supports it, the user is asked to confirm first; if they decline, " +
        "nothing is deleted and the result has status 'declined' (or 'cancelled').",
      inputSchema: z.object({ vserver, address: z.string().min(3).describe("The forwarder address.") }),
      outputSchema: out.objectWrite("mail_forwarder"),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async (args, ctx) => {
      const { vserver, address } = args;
      const decision = await confirmed(
        ctx,
        "delete_mail_forwarder",
        args,
        () => `Delete the mail forwarder ${address} on ${vserver}?`,
        { vserver, address },
        "nothing was deleted",
      );
      if (decision !== "go") return decision;
      await client.request("DELETE", `/vserver/${seg(vserver)}/mail/forwarder/${seg(address)}`);
      return { status: "deleted", mail_forwarder: { address } };
    }),
  );

  // ───────────────────────────── MySQL, cron, SSL ─────────────────────────────

  server.registerTool(
    "list_mysql",
    {
      title: "List MySQL databases and users",
      description: "List the MySQL databases and database users (with their allowed hosts) on a webhosting.",
      inputSchema: z.object({ vserver }),
      outputSchema: out.mysql,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ vserver }) => {
      const [dbs, accounts] = await Promise.all([
        client.request("GET", `/vserver/${seg(vserver)}/database/mysql`, { limit: 100 }),
        client.request("GET", `/vserver/${seg(vserver)}/database/mysql/account`, { limit: 100 }),
      ]);
      return { databases: slim(asArray(dbs.data)), accounts: slim(asArray(accounts.data)) };
    }),
  );

  server.registerTool(
    "list_cron_jobs",
    {
      title: "List cron jobs",
      description: "List the cron jobs on a webhosting: schedule, command or URL, type (http/system), reporting and state.",
      inputSchema: z.object({ vserver }),
      outputSchema: out.list("cron_jobs"),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ vserver }) => {
      const res = await client.request("GET", `/vserver/${seg(vserver)}/crontab`, { limit: 100 });
      return listResult("cron_jobs", res.data, res.pager);
    }),
  );

  server.registerTool(
    "list_ssl_certificates",
    {
      title: "List SSL certificates",
      description:
        "List the SSL certificates on a webhosting, with their hosts and validity. The PEM certificate bodies are left " +
        "out unless `include_pem` is true; private keys are never returned.",
      inputSchema: z.object({
        vserver,
        include_pem: z.boolean().optional().describe("Include the PEM `certificate` and `ca_certificate` (default false; large)."),
      }),
      outputSchema: out.list("certificates"),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ vserver, include_pem }) => {
      const res = await client.request("GET", `/vserver/${seg(vserver)}/ssl`, { limit: 100 });
      // Never echo private keys back into the conversation.
      const certs = asArray(res.data).map((c: any) => {
        if (!c || typeof c !== "object") return c;
        const { private_key, certificate, ca_certificate, ...rest } = c;
        return include_pem ? { ...rest, certificate, ca_certificate } : rest;
      });
      return listResult("certificates", certs, res.pager);
    }),
  );

  // ───────────────────────────── Spec lookup + generic request ─────────────────────────────

  server.registerTool(
    "find_endpoints",
    {
      title: "Find API endpoints",
      description:
        "Search the ZoneID API v2 reference for endpoints whose path, tag or summary contains every word of `query` " +
        "(e.g. 'redis', 'mail autoreply', 'cloud resize'). Omit `query` to list all endpoints. Use describe_endpoint for " +
        "the parameters and body fields, then zone_api_request to call it.",
      inputSchema: z.object({ query: z.string().optional() }),
      outputSchema: out.endpoints,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run(async ({ query }) => ({ endpoints: searchEndpoints(query) })),
  );

  server.registerTool(
    "describe_endpoint",
    {
      title: "Describe API endpoint",
      description:
        "Show the parameters, request-body fields and response fields of a ZoneID API endpoint from the official " +
        "OpenAPI spec. `path` may be a template ('/vserver/{service_name}/crontab') or a concrete path " +
        "('/vserver/example.com/crontab').",
      inputSchema: z.object({
        path: z.string().min(1),
        method: z.enum(["GET", "POST", "PUT", "DELETE", "OPTIONS"]).optional().describe("Only this method (default: all)."),
      }),
      outputSchema: out.endpoint,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run(async ({ path, method }) => {
      const d = describeEndpoint(path, method);
      if (!d) throw new ZoneApiError(404, "UNKNOWN_ENDPOINT", `No endpoint matches ${path}. Try find_endpoints.`);
      return d;
    }),
  );

  server.registerTool(
    "zone_api_request",
    {
      title: "Call the ZoneID API",
      description:
        "Call any ZoneID API v2 endpoint, for everything the dedicated tools don't cover (mailbox create/update, " +
        "autoreplies, MySQL create, cron create, SSH keys, FTP users, Redis, PM2, cloud VPS, domain contacts and renewals…). " +
        "`path` is relative to https://api.zone.eu/v2, e.g. '/vserver/example.com/crontab'. Look up the body fields with " +
        "describe_endpoint first. Responses are always arrays. GET and OPTIONS run directly; for POST, PUT and DELETE " +
        "the user is asked to confirm (when the client supports it), and the prompt shows the method, path and body. " +
        "Some endpoints cost money (domain renewals, cloud orders, extra packages).",
      inputSchema: z.object({
        method: z.enum(["GET", "POST", "PUT", "DELETE", "OPTIONS"]),
        path: z.string().min(1).describe("API path, e.g. '/dns/example.com/txt'."),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Query-string parameters, e.g. {\"force\": true}."),
        body: z.unknown().optional().describe("JSON request body for POST/PUT (an object, or an array for /order/domain/renew)."),
        page,
        limit,
        order_by: z.string().optional().describe("Sort field (sent as x-order-by)."),
        order_dir: z.enum(["asc", "desc"]).optional(),
      }),
      outputSchema: out.apiResponse,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    run(async (args, ctx) => {
      const { method, path, query, body, page, limit, order_by, order_dir } = args;
      const url = client.url(path, query as Query | undefined); // validate the path before asking anything
      if (method !== "GET" && method !== "OPTIONS") {
        const decision = await confirmed(
          ctx,
          "zone_api_request",
          args,
          () => {
            const shown = body === undefined ? "" : `\n\n${JSON.stringify(body, null, 1).slice(0, 1500)}`;
            return `Send ${method} ${decodeURI(url.pathname + url.search)} to the zone.ee API?${shown}`;
          },
          { method, path },
          "no request was sent",
        );
        if (decision !== "go") return decision;
      }
      const res = await client.request(method as Method, path, {
        query: query as Query | undefined,
        body,
        page,
        limit,
        orderBy: order_by,
        orderDir: order_dir,
      });
      return {
        status: res.status,
        data: slim(res.data),
        ...(res.pager ? { pager: res.pager } : {}),
        ...(res.message ? { message: res.message } : {}),
      };
    }),
  );
}
