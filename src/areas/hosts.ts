/** Hosts (main domain and subdomains of a webhosting), their Apache/PHP config, and Let's Encrypt certificates. */
import * as z from "zod";
import { ZoneApiError } from "../client.js";
import { READ, WRITE, diff, first, hostname, limit, listResult, page, pick, seg, slim, tool, vserver, type Deps } from "../common.js";
import * as out from "../schemas.js";

const APACHE_WRITABLE = ["docroot", "proxy_backend_port", "php_version", "php_upgrade_strategy"] as const;

export function registerHostTools(deps: Deps): void {
  const { client } = deps;
  const hostPath = (v: string, h: string) => `/vserver/${seg(v)}/host/${seg(h)}`;
  const orNull = <T>(p: Promise<T>) => p.catch((e) => (e instanceof ZoneApiError && e.status === 404 ? null : Promise.reject(e)));

  tool(
    deps,
    "list_hosts",
    {
      title: "List hosts",
      description:
        "List a webhosting's hosts (main domain and subdomains): scheme, Let's Encrypt status, attached SSL certificate id. " +
        "`deprecated_php: true` returns only hosts on a deprecated PHP version; `apache: true` adds each host's Apache " +
        "settings (docroot, PHP version, proxy port).",
      input: z.object({
        vserver,
        hostname: z.string().optional().describe("Only hosts whose name contains this string."),
        apache: z.boolean().optional().describe("Include Apache settings per host."),
        deprecated_php: z.boolean().optional().describe("Only hosts that use a deprecated PHP version."),
        page,
        limit,
      }),
      output: out.list("hosts"),
      annotations: READ,
    },
    async ({ vserver, hostname, apache, deprecated_php, page, limit }) => {
      const res = await client.request("GET", `/vserver/${seg(vserver)}/host`, {
        query: {
          hostname,
          apache: apache || deprecated_php ? true : undefined,
          "apache[php_version_deprecated]": deprecated_php,
        },
        page,
        limit,
      });
      return listResult("hosts", res.data, res.pager);
    },
  );

  tool(
    deps,
    "get_host",
    {
      title: "Get host",
      description:
        "One host with everything about it: whether it is deployed (`ready`), its Apache config per scheme (docroot, " +
        "PHP version and whether it is deprecated, proxy port), Let's Encrypt status with failed hostnames, and the " +
        "allowed PHP versions and upgrade strategies (`apache_options`) for update_host_config. 4 API requests.",
      input: z.object({ vserver, hostname }),
      output: out.parts({ host: out.item.nullable(), apache: out.items, letsencrypt: out.item.nullable(), apache_options: z.unknown() }),
      annotations: READ,
    },
    async ({ vserver, hostname }) => {
      const p = hostPath(vserver, hostname);
      const [host, apache, le, opts] = await Promise.all([
        client.request("GET", p, { query: { check_ready: true } }),
        client.request("GET", `${p}/apache`),
        orNull(client.request("GET", `${p}/letsencrypt`)),
        orNull(client.request("OPTIONS", `${p}/apache`)),
      ]);
      return {
        host: first(host),
        apache: slim(Array.isArray(apache.data) ? apache.data : [apache.data]),
        letsencrypt: le ? first(le) : null,
        apache_options: opts?.data ?? null,
      };
    },
  );

  tool(
    deps,
    "create_host",
    {
      title: "Create subdomain host",
      description:
        "Add an https subdomain host (e.g. 'staging.example.com') to a webhosting. It must be a subdomain of the " +
        "webhosting's main domain. The API has no way to delete a host afterwards (use my.zone.eu), so the user is " +
        "asked to confirm. Deployment is asynchronous: check `ready` with get_host before installing anything, then " +
        "request_letsencrypt for a certificate.",
      input: z.object({ vserver, name: hostname.describe("The new subdomain, e.g. 'staging.example.com'.") }),
      output: out.objectWrite("host"),
      annotations: WRITE(false, false),
    },
    async ({ vserver, name }, { confirm }) => {
      const d = await confirm(
        () => `Create the host ${name} on ${vserver}? It cannot be removed through the API later.`,
        { vserver, name },
        "no host was created",
      );
      if (d !== "go") return d;
      const res = await client.request("POST", `/vserver/${seg(vserver)}/host`, { body: { name } });
      return { status: "created", host: first(res) ?? { name } };
    },
  );

  tool(
    deps,
    "update_host_config",
    {
      title: "Update host Apache/PHP config",
      description:
        "Change a host's docroot (relative to the home dir, e.g. 'domeenid/www.example.com/public'), PHP version, PHP " +
        "auto-upgrade strategy, or proxy port (serve a PM2/Node app on 127.0.0.1:<port> instead of PHP; '' to turn it " +
        "off). Valid PHP versions and strategies: get_host → apache_options. Only the fields you pass change. When a " +
        "host has both http and https configs, pass `scheme`. A wrong value can take the site down, so the user is " +
        "asked to confirm the old → new values.",
      input: z.object({
        vserver,
        hostname,
        scheme: z.enum(["https", "http"]).optional().describe("Which config to change when the host has both."),
        docroot: z.string().optional(),
        php_version: z.string().optional().describe("e.g. '8.4'."),
        php_upgrade_strategy: z.string().optional(),
        proxy_backend_port: z.union([z.string(), z.number().int().min(1).max(65535)]).optional(),
      }),
      output: out.objectWrite("apache"),
      annotations: WRITE(true, true),
    },
    async (args, { confirm }) => {
      const { vserver, hostname, scheme, ...fields } = args;
      const changes = Object.fromEntries(
        Object.entries(fields)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, typeof v === "number" ? String(v) : v]),
      );
      if (!Object.keys(changes).length) throw new ZoneApiError(400, "NOTHING_TO_UPDATE", "Pass at least one field to change.");
      const path = `${hostPath(vserver, hostname)}/apache`;
      const configs = ((await client.request<any[]>("GET", path)).data ?? []) as any[];
      const list = Array.isArray(configs) ? configs : [configs];
      const current = scheme ? list.find((c) => c?.scheme === scheme) : list.length === 1 ? list[0] : undefined;
      if (!current) {
        throw new ZoneApiError(
          400,
          "SCHEME_REQUIRED",
          scheme
            ? `${hostname} has no ${scheme} config (it has: ${list.map((c) => c?.scheme).join(", ")}).`
            : `${hostname} has ${list.length} configs (${list.map((c) => c?.scheme).join(", ")}); pass \`scheme\`.`,
        );
      }
      const body = { ...pick(current, APACHE_WRITABLE), ...changes, ...(list.length > 1 ? { scheme: current.scheme } : {}) };
      const d = await confirm(
        () =>
          `Change the ${current.scheme ?? ""} Apache config of ${hostname} on ${vserver}?\n${diff(current, changes)}` +
          (current.is_php_version_owner === false && changes.php_version !== undefined
            ? "\nNote: is_php_version_owner is false, so the PHP version change may have no effect on this host."
            : ""),
        { vserver, hostname },
        "the config was not changed",
      );
      if (d !== "go") return d;
      const res = await client.request("PUT", path, { body });
      return { status: "updated", apache: first(res) ?? body };
    },
  );

  tool(
    deps,
    "set_host_certificate",
    {
      title: "Attach SSL certificate to host",
      description:
        "Attach an SSL certificate (id from list_ssl_certificates) to a host, or detach it with `certificate: null`. " +
        "This is the only writable field of a host. Asks the user to confirm.",
      input: z.object({
        vserver,
        hostname,
        certificate: z.number().int().nullable().describe("Certificate id, or null to detach."),
      }),
      output: out.objectWrite("host"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, hostname, certificate }, { confirm }) => {
      const path = hostPath(vserver, hostname);
      const current = first(await client.request("GET", path));
      if (!current) throw new ZoneApiError(404, "HTTP_404", `No host ${hostname} on ${vserver}.`);
      const d = await confirm(
        () => `Change the SSL certificate of ${hostname} from ${current.certificate ?? "none"} to ${certificate ?? "none"}?`,
        { vserver, hostname },
        "the certificate was not changed",
      );
      if (d !== "go") return d;
      const res = await client.request("PUT", path, { body: { certificate } });
      return { status: "updated", host: first(res) ?? { name: hostname, certificate } };
    },
  );

  tool(
    deps,
    "request_letsencrypt",
    {
      title: "Request Let's Encrypt certificate",
      description:
        "Request a free Let's Encrypt certificate for a host, or with `regenerate: true` re-issue an existing one (e.g. " +
        "after it failed). Issuing is asynchronous: check the status later with get_host (waiting → alive or failed; " +
        "`info.last_failed_hostnames` lists names that failed validation, usually because DNS or a CAA record does not " +
        "point at Zone). Let's Encrypt rate limits apply, so don't retry in a loop.",
      input: z.object({ vserver, hostname, regenerate: z.boolean().optional().describe("Re-issue an existing certificate.") }),
      output: out.objectWrite("letsencrypt"),
      annotations: WRITE(false, false),
    },
    async ({ vserver, hostname, regenerate }) => {
      const path = `${hostPath(vserver, hostname)}/letsencrypt`;
      const res = regenerate
        ? await client.request("PUT", path, { body: { status: "waiting" } })
        : await client.request("POST", path);
      return { status: "requested", letsencrypt: first(res) ?? { status: "waiting" } };
    },
  );
}
