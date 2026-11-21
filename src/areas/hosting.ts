/** Webhosting plan and paid extras: package/billing period, additional resources, turbo, dedicated IPs; plus DKIM. */
import * as z from "zod";
import { ZoneApiError } from "../client.js";
import { READ, WRITE, asArray, defined, first, id, seg, show, slim, tool, vserver, type Deps } from "../common.js";
import * as out from "../schemas.js";

const PAID = "This costs money: the user is asked to confirm.";

export function registerHostingTools(deps: Deps): void {
  const { client } = deps;
  const v = (s: string) => `/vserver/${seg(s)}`;
  const optional = <T>(p: Promise<T>) => p.catch(() => null);

  tool(
    deps,
    "get_hosting_plan",
    {
      title: "Get webhosting plan",
      description:
        "A webhosting's package and billing period, whether it can be changed and whether turbo is allowed; the " +
        "packages it can move to with monthly/yearly prices and limits (disk, inodes, cron, MySQL, mailboxes, backup " +
        "retention) and billing periods; and the additional resources in use and on offer. 4 API requests.",
      input: z.object({ vserver }),
      output: out.parts({ plan: out.item.nullable(), plan_options: z.unknown(), resources: out.items, resource_options: z.unknown() }),
      annotations: READ,
    },
    async ({ vserver }) => {
      const [plan, opts, res, resOpts] = await Promise.all([
        client.request("GET", `${v(vserver)}/billing`),
        optional(client.request("OPTIONS", `${v(vserver)}/billing`)),
        client.request("GET", `${v(vserver)}/billing/resources`),
        optional(client.request("OPTIONS", `${v(vserver)}/billing/resources`)),
      ]);
      return { plan: first(plan), plan_options: opts?.data ?? null, resources: slim(asArray(res.data)), resource_options: resOpts?.data ?? null };
    },
  );

  tool(
    deps,
    "change_hosting_plan",
    {
      title: "Change webhosting package or billing period",
      description:
        "Move a webhosting to another package and/or billing period (values from get_hosting_plan → plan_options). " +
        "SPENDS MONEY and accepts the new fees and terms: issued invoices are credited and a new invoice is issued. " +
        "The confirmation shows the current and new package with prices.",
      input: z.object({
        vserver,
        package: z.string().optional().describe("Package code from plan_options."),
        billing_period: z.number().int().positive().optional().describe("Billing period in months."),
      }),
      output: out.objectWrite("plan"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, package: pkg, billing_period }, { confirm }) => {
      if (pkg === undefined && billing_period === undefined) throw new ZoneApiError(400, "NOTHING_TO_UPDATE", "Pass package and/or billing_period.");
      const current = first(await client.request("GET", `${v(vserver)}/billing`));
      if (current?.allow_changes === false) throw new ZoneApiError(400, "NOT_ALLOWED", `The plan of ${vserver} cannot be changed through the API.`);
      const body = { package: pkg ?? current?.package, billing_period: billing_period ?? current?.billing_period };
      const d = await confirm(
        async () => {
          const opts: any = (await optional(client.request("OPTIONS", `${v(vserver)}/billing`)))?.data;
          const packages: any[] = asArray(opts?.package ?? (Array.isArray(opts) ? opts[0]?.package : undefined));
          const price = (code: string) => {
            const p = packages.find((x) => x?.package === code);
            return p ? `${p.package_name ?? code} (${p.price_month ?? "?"}/month, ${p.price_year ?? "?"}/year)` : code;
          };
          return (
            `Change the plan of ${vserver}? This is billed: issued invoices are credited and a new invoice is issued, ` +
            "and the new fees and terms are accepted.\n" +
            `• package: ${price(current?.package)} → ${price(body.package)}\n` +
            `• billing period: ${current?.billing_period ?? "?"} → ${body.billing_period} months`
          );
        },
        { vserver },
        "the plan was not changed",
      );
      if (d !== "go") return d;
      const res = await client.request("POST", `${v(vserver)}/billing`, { body: defined(body) });
      return { status: "updated", plan: first(res) ?? body };
    },
  );

  const resourceId = id("Additional resource id from get_hosting_plan → resources.");

  tool(
    deps,
    "add_hosting_resource",
    {
      title: "Add additional resource",
      description: `Buy an additional resource package for a webhosting (\`package\` tag from get_hosting_plan → resource_options). ${PAID}`,
      input: z.object({ vserver, package: z.string().min(1), quantity: z.number().int().positive() }),
      output: out.objectWrite("resource"),
      annotations: WRITE(true, false),
    },
    async ({ vserver, package: pkg, quantity }, { confirm }) => {
      const d = await confirm(
        () => `Add ${quantity} × additional resource "${pkg}" to ${vserver}? This is billed.`,
        { vserver, package: pkg },
        "nothing was added",
      );
      if (d !== "go") return d;
      const res = await client.request("POST", `${v(vserver)}/billing/resources`, { body: { package: pkg, quantity } });
      return { status: "created", resource: first(res) };
    },
  );

  tool(
    deps,
    "update_hosting_resource",
    {
      title: "Change additional resource quantity",
      description: `Change how many of an additional resource package a webhosting has. ${PAID}`,
      input: z.object({ vserver, resource_id: resourceId, quantity: z.number().int().positive() }),
      output: out.objectWrite("resource"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, resource_id, quantity }, { confirm }) => {
      const path = `${v(vserver)}/billing/resources/${seg(resource_id)}`;
      const current = first(await client.request("GET", path));
      if (!current) throw new ZoneApiError(404, "HTTP_404", `No additional resource ${resource_id} on ${vserver}.`);
      const d = await confirm(
        () => `Change "${current.name ?? current.package}" on ${vserver} from ${current.quantity} to ${quantity}? This changes billing.`,
        { vserver, resource_id },
        "nothing was changed",
      );
      if (d !== "go") return d;
      const res = await client.request("PUT", path, { body: { quantity } });
      return { status: "updated", resource: first(res) ?? { ...current, quantity } };
    },
  );

  tool(
    deps,
    "delete_hosting_resource",
    {
      title: "Remove additional resource",
      description: "Remove an additional resource package from a webhosting. Asks the user to confirm.",
      input: z.object({ vserver, resource_id: resourceId }),
      output: out.objectWrite("resource"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, resource_id }, { confirm }) => {
      const path = `${v(vserver)}/billing/resources/${seg(resource_id)}`;
      const d = await confirm(
        async () => {
          const c = first(await client.request("GET", path)) ?? {};
          return `Remove ${c.quantity ?? ""} × "${c.name ?? c.package ?? resource_id}" from ${vserver}?`;
        },
        { vserver, resource_id },
        "nothing was removed",
      );
      if (d !== "go") return d;
      await client.request("DELETE", path);
      return { status: "deleted", resource: { identificator: resource_id } };
    },
  );

  tool(
    deps,
    "add_turbo",
    {
      title: "Add turbo",
      description:
        `Temporarily boost a webhosting's resources ("turbo") for \`ttl\` minutes, optionally from \`start\` ` +
        `(date-time). Needs turbo_allowed (get_hosting_plan). ${PAID}`,
      input: z.object({
        vserver,
        ttl: z.number().int().positive().describe("Minutes."),
        start: z.string().optional().describe("Start date-time; now when omitted."),
      }),
      output: out.objectWrite("turbo"),
      annotations: WRITE(true, false),
    },
    async ({ vserver, ttl, start }, { confirm }) => {
      const d = await confirm(
        () => `Turn on turbo for ${vserver} for ${ttl} minutes${start ? ` from ${start}` : ""}? This is billed.`,
        { vserver },
        "no turbo was added",
      );
      if (d !== "go") return d;
      const res = await client.request("POST", `${v(vserver)}/turbo`, { body: defined({ ttl, start }) });
      return { status: "created", turbo: first(res) };
    },
  );

  // ── Dedicated IPs ──

  tool(
    deps,
    "list_dedicated_ips",
    {
      title: "List dedicated IPs",
      description: "A webhosting's dedicated IPv4/IPv6 addresses and the virtual hosts on them.",
      input: z.object({ vserver }),
      output: out.list("dedicated_ips"),
      annotations: READ,
    },
    async ({ vserver }) => ({ dedicated_ips: slim(asArray((await client.request("GET", `${v(vserver)}/dedicatedip`)).data)) }),
  );

  tool(
    deps,
    "create_dedicated_ip",
    {
      title: "Order dedicated IP",
      description: `Add a dedicated IP address to a webhosting. ${PAID}`,
      input: z.object({ vserver }),
      output: out.objectWrite("dedicated_ip"),
      annotations: WRITE(true, false),
    },
    async ({ vserver }, { confirm }) => {
      const d = await confirm(() => `Order a dedicated IP for ${vserver}? This is billed.`, { vserver }, "nothing was ordered");
      if (d !== "go") return d;
      const res = await client.request("POST", `${v(vserver)}/dedicatedip`);
      return { status: "created", dedicated_ip: first(res) };
    },
  );

  tool(
    deps,
    "delete_dedicated_ip",
    {
      title: "Remove dedicated IP",
      description: "Remove a dedicated IP from a webhosting. Sites and DNS records still pointing at it stop working. Asks the user to confirm.",
      input: z.object({ vserver, ip_id: id("Dedicated IP id from list_dedicated_ips.") }),
      output: out.objectWrite("dedicated_ip"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, ip_id }, { confirm }) => {
      const path = `${v(vserver)}/dedicatedip/${seg(ip_id)}`;
      const d = await confirm(
        async () => {
          const c = first(await client.request("GET", path)) ?? {};
          return `Remove the dedicated IP ${[c.ipv4, c.ipv6].filter(Boolean).join(" / ") || ip_id} from ${vserver}? Hosts on it: ${show(c.vhosts ?? "?")}.`;
        },
        { vserver, ip_id },
        "nothing was removed",
      );
      if (d !== "go") return d;
      await client.request("DELETE", path);
      return { status: "deleted", dedicated_ip: { identificator: ip_id } };
    },
  );

  // ── DKIM ──

  tool(
    deps,
    "get_dkim",
    {
      title: "Get DKIM key",
      description:
        "The webhosting domain's DKIM signing state and public key. When the domain's DNS is not at Zone, publish the " +
        "key as a TXT record at the DNS host.",
      input: z.object({ vserver }),
      output: out.parts({ dkim: z.unknown() }),
      annotations: READ,
    },
    async ({ vserver }) => {
      const res = await client
        .request("GET", `${v(vserver)}/mail/dkim`)
        .catch((e) => (e instanceof ZoneApiError && e.status === 404 ? { data: null } : Promise.reject(e)));
      return { dkim: slim(res.data) };
    },
  );

  tool(
    deps,
    "enable_dkim",
    {
      title: "Enable DKIM signing",
      description: "Turn on DKIM signing of outgoing mail for the webhosting's domain. Asks the user to confirm.",
      input: z.object({ vserver }),
      output: out.write({ dkim: z.unknown() }),
      annotations: WRITE(false, true),
    },
    async ({ vserver }, { confirm }) => {
      const d = await confirm(() => `Turn on DKIM signing for mail sent from ${vserver}?`, { vserver }, "nothing was changed");
      if (d !== "go") return d;
      const res = await client.request("POST", `${v(vserver)}/mail/dkim`);
      return { status: "created", dkim: slim(res.data) };
    },
  );

  tool(
    deps,
    "delete_dkim",
    {
      title: "Delete DKIM key",
      description:
        "Delete the webhosting's DKIM key and stop signing. If a DMARC policy relies on DKIM, mail may start failing. " +
        "Asks the user to confirm.",
      input: z.object({ vserver }),
      output: out.write({}),
      annotations: WRITE(true, true),
    },
    async ({ vserver }, { confirm }) => {
      const d = await confirm(() => `Delete the DKIM key of ${vserver} and stop signing outgoing mail?`, { vserver }, "nothing was deleted");
      if (d !== "go") return d;
      await client.request("DELETE", `${v(vserver)}/mail/dkim`);
      return { status: "deleted" };
    },
  );
}
