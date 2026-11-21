/** The ZoneID account: profile, balance, invoices and payment, services, delegations, identity verification. */
import * as z from "zod";
import { ZoneApiError } from "../client.js";
import { READ, WRITE, asArray, bad, defined, diff, first, id, limit, listResult, page, pick, seg, slim, tool, type Deps } from "../common.js";
import * as out from "../schemas.js";

const RENEWAL_FIELDS = ["allow_domain_renewals", "allow_domain_renewals_limit", "domain_renewals_singleorder", "domain_renewals_autopay"] as const;
const serviceId = id("Numeric service id: list_services → identificator.");
const zoneid = z.string().min(1).describe("The ZoneID username of the person the service is shared with.");

export function registerAccountTools(deps: Deps): void {
  const { client } = deps;

  tool(
    deps,
    "get_account",
    {
      title: "Get account",
      description:
        "The ZoneID account: profile (contact details, VAT, invoice e-mail), the domain auto-renewal settings, and the " +
        "prepaid credit `balance` that pay_invoices spends.",
      input: z.object({}),
      output: out.parts({ profile: out.item.nullable(), balance: z.unknown() }),
      annotations: READ,
    },
    async () => {
      const [me, billing] = await Promise.all([client.request("GET", "/me"), client.request("GET", "/me/billing")]);
      return { profile: first(me), balance: first(billing)?.balance ?? null };
    },
  );

  tool(
    deps,
    "update_domain_renewal_settings",
    {
      title: "Update domain auto-renewal settings",
      description:
        "Account-wide domain renewal automation: `allow_domain_renewals` creates renewal orders and invoices when " +
        "domains near expiry, `allow_domain_renewals_limit` caps how many at once, `domain_renewals_singleorder` " +
        "groups them into one order, and `domain_renewals_autopay` pays them from credit automatically (spends money). " +
        "These are the only account fields the API can change. Asks the user to confirm.",
      input: z.object({
        allow_domain_renewals: z.boolean().optional(),
        allow_domain_renewals_limit: z.number().int().min(0).optional(),
        domain_renewals_singleorder: z.boolean().optional(),
        domain_renewals_autopay: z.boolean().optional(),
      }),
      output: out.objectWrite("settings"),
      annotations: WRITE(true, true),
    },
    async (args, { confirm }) => {
      const changes = defined(args);
      if (!Object.keys(changes).length) throw new ZoneApiError(400, "NOTHING_TO_UPDATE", "Pass at least one setting.");
      const current = first(await client.request("GET", "/me")) ?? {};
      const d = await confirm(
        () => `Change the account's domain renewal settings?\n${diff(current, changes)}`,
        {},
        "the settings were not changed",
      );
      if (d !== "go") return d;
      const res = await client.request("PUT", "/me", { body: { ...pick(current, RENEWAL_FIELDS), ...changes } });
      return { status: "updated", settings: pick(first(res) ?? { ...current, ...changes }, RENEWAL_FIELDS) };
    },
  );

  tool(
    deps,
    "get_notification",
    {
      title: "Get account notification",
      description: "Show a notification Zone sent to the account (subject, date, message), by its id (e.g. from an e-mail link).",
      input: z.object({ notification_id: id("Notification id.") }),
      output: out.object("notification"),
      annotations: READ,
    },
    async ({ notification_id }) => ({ notification: first(await client.request("GET", `/me/notification/${seg(notification_id)}`)) }),
  );

  // ── Invoices ──

  tool(
    deps,
    "list_invoices",
    {
      title: "List invoices",
      description:
        "The account's invoices with due date, totals with and without VAT, unpaid sum (`total_due_sum`), paid flag, and " +
        "`pay_url` / `download_url` (PDF). Filter with `paid: false` for what is owed; `search` matches the invoice " +
        "number. Pass `invoice_id` (identificator, not the number) for one. Sums are strings.",
      input: z.object({
        paid: z.boolean().optional(),
        search: z.string().optional().describe("Invoice number (or part of it)."),
        invoice_id: id("Invoice identificator.").optional(),
        order_dir: z.enum(["asc", "desc"]).optional(),
        page,
        limit,
      }),
      output: out.list("invoices"),
      annotations: READ,
    },
    async ({ paid, search, invoice_id, order_dir, page, limit }) => {
      if (invoice_id !== undefined) return listResult("invoices", (await client.request("GET", `/me/invoice/${seg(invoice_id)}`)).data);
      const res = await client.request("GET", "/me/invoice", { query: { paid, search }, page, limit, orderDir: order_dir });
      return listResult("invoices", res.data, res.pager);
    },
  );

  tool(
    deps,
    "pay_invoices",
    {
      title: "Pay invoices from credit",
      description:
        "Pay invoices from the account's prepaid credit (the only method the API supports). SPENDS MONEY. Pass the " +
        "invoice NUMBERS (`invoice_number`, not ids). Already paid invoices and credit notes are skipped silently and " +
        "nothing is returned, so the result re-reads the invoices to show what is now paid. The confirmation lists " +
        "each invoice with its unpaid sum, the total and the current balance.",
      input: z.object({ invoices: z.array(z.number().int().positive()).min(1).max(50).describe("Invoice numbers.") }),
      output: out.write({ invoices: out.items, still_unpaid: z.array(z.number()), balance: z.unknown() }),
      annotations: WRITE(true, true),
    },
    async ({ invoices }, { confirm }) => {
      // One request for all unpaid invoices (not one per number): the confirmation runs twice and the limit is 60/min.
      const unpaid = async () =>
        new Map(
          asArray((await client.request("GET", "/me/invoice", { query: { paid: false }, limit: 100 })).data).map(
            (i: any) => [Number(i?.invoice_number), i] as const,
          ),
        );
      const d = await confirm(
        async () => {
          const [open, billing] = await Promise.all([unpaid(), client.request("GET", "/me/billing")]);
          let total = 0;
          const lines = invoices.map((n) => {
            const inv: any = open.get(n);
            if (!inv) return `• ${n}: not an unpaid invoice (will be skipped)`;
            total += Number(inv.total_due_sum) || 0;
            return `• ${n}: ${inv.total_due_sum} due ${inv.due ?? "?"} – ${inv.description ?? ""}`.trim();
          });
          return `Pay these invoices from prepaid credit?\n${lines.join("\n")}\nTotal: ${total.toFixed(2)} · Current balance: ${first(billing)?.balance ?? "?"}`;
        },
        { invoices },
        "nothing was paid",
      );
      if (d !== "go") return d;
      const before = await unpaid();
      await client.request("POST", "/me/billing/payment", { body: { method: "prepayment", invoices } });
      const [after, billing] = await Promise.all([unpaid(), client.request("GET", "/me/billing")]);
      return {
        status: "requested",
        invoices: slim(invoices.map((n) => before.get(n)).filter(Boolean)),
        still_unpaid: invoices.filter((n) => after.has(n)),
        balance: first(billing)?.balance ?? null,
        message: "`still_unpaid` lists invoices the payment did not cover (insufficient credit, or still processing).",
      };
    },
  );

  // ── Services and delegations ──

  tool(
    deps,
    "list_services",
    {
      title: "List services",
      description:
        "Every service the account owns or has been given access to (domains, webhostings, cloud servers…): type, " +
        "owner, whether it is shared with you (`delegation`), suspended, package. The numeric `identificator` is the " +
        "`service_id` for the delegation tools. Pass `service` (id or name) for one.",
      input: z.object({
        service: id("Service identificator or name.").optional(),
        type: z.enum(["webhosting", "dserver", "domain", "sslcertificate", "vps", "vpn"]).optional().describe("Only this service type."),
        description: z.string().optional().describe("Only services whose description matches."),
      }),
      output: out.list("services"),
      annotations: READ,
    },
    async ({ service, type, description }) => {
      const res = service !== undefined
        ? await client.request("GET", `/me/service/${seg(service)}`)
        : await client.request("GET", "/me/service", { query: { type, description } });
      return listResult("services", res.data, res.pager);
    },
  );

  const delegationPath = (s: string | number, u?: string) => `/me/service/${seg(s)}/delegation${u ? `/${seg(u)}` : ""}`;

  tool(
    deps,
    "list_delegations",
    {
      title: "List service delegations",
      description:
        "Who else has access to a service (ZoneID username, permissions, mailing lists, days until it expires), plus " +
        "`permission_options`: the permissions that can be granted for this service type. Only for services you own " +
        "(`delegation: false` in list_services); others return 404.",
      input: z.object({ service_id: serviceId }),
      output: out.parts({ delegations: out.items, permission_options: z.unknown() }),
      annotations: READ,
    },
    async ({ service_id }) => {
      const [list, opts] = await Promise.all([
        client.request("GET", delegationPath(service_id)),
        client.request("OPTIONS", delegationPath(service_id)).catch(() => null),
      ]);
      return { delegations: slim(asArray(list.data)), permission_options: opts?.data ?? null };
    },
  );

  tool(
    deps,
    "set_delegation",
    {
      title: "Share a service (delegate)",
      description:
        "Give another ZoneID user access to a service, or change what an existing delegate may do. `permissions` " +
        "REPLACES their permission list ('all' grants everything; see list_delegations → permission_options). Grants " +
        "third-party access, so the user is asked to confirm the exact permissions.",
      input: z.object({
        service_id: serviceId,
        zoneid,
        permissions: z.array(z.string().min(1)).min(1),
        mailinglists: z.array(z.string()).optional().describe("Mailing lists, with the webhosting 'mailinglist' permission."),
      }),
      output: out.objectWrite("delegation"),
      annotations: WRITE(true, true),
    },
    async ({ service_id, zoneid, permissions, mailinglists }, { confirm }) => {
      const path = delegationPath(service_id, zoneid);
      const existing = await client
        .request("GET", path)
        .then((r) => first(r))
        .catch((e) => (e instanceof ZoneApiError && e.status === 404 ? null : Promise.reject(e)));
      const body = defined({ permissions, mailinglists });
      const d = await confirm(
        () =>
          existing
            ? `Change ${zoneid}'s access to service ${existing.service ?? service_id}?\n${diff(existing, body)}`
            : `Give ZoneID user ${zoneid} access to service ${service_id} with permissions: ${permissions.join(", ")}` +
              (mailinglists?.length ? `; mailing lists: ${mailinglists.join(", ")}` : "") + "?",
        { service_id, zoneid },
        "no access was changed",
      );
      if (d !== "go") return d;
      const res = await client.request(existing ? "PUT" : "POST", path, { body });
      return { status: existing ? "updated" : "created", delegation: first(res) ?? { username: zoneid, ...body } };
    },
  );

  tool(
    deps,
    "delete_delegation",
    {
      title: "Revoke a delegation",
      description: "Remove another ZoneID user's access to a service. Asks the user to confirm.",
      input: z.object({ service_id: serviceId, zoneid }),
      output: out.objectWrite("delegation"),
      annotations: WRITE(true, true),
    },
    async ({ service_id, zoneid }, { confirm }) => {
      const d = await confirm(
        () => `Revoke ZoneID user ${zoneid}'s access to service ${service_id}?`,
        { service_id, zoneid },
        "no access was changed",
      );
      if (d !== "go") return d;
      await client.request("DELETE", delegationPath(service_id, zoneid));
      return { status: "deleted", delegation: { username: zoneid, service_id } };
    },
  );

  // ── Identity verification ──

  const objectType = z.string().min(1).describe("Type of the object to verify (as Zone names it, e.g. from an order that requires authentication).");
  const objectId = z.number().int().describe("Id of that object.");

  tool(
    deps,
    "get_identity_verifications",
    {
      title: "Get identity verifications",
      description:
        "Active identity verifications for an object (for example a domain order with `authorization_required`). " +
        "The API does not document the object types; they come from the order or service that asks for verification.",
      input: z.object({ object_type: objectType, object_id: objectId }),
      output: out.list("verifications"),
      annotations: READ,
    },
    async ({ object_type, object_id }) =>
      listResult("verifications", (await client.request("GET", `/identityverifier/${seg(object_type)}/${seg(object_id)}`)).data),
  );

  tool(
    deps,
    "create_identity_verification",
    {
      title: "Start identity verification",
      description:
        "Create an identity-verification URL for an object (e.g. a domain order that needs the registrant verified). " +
        "Give the returned URL only to the person who must verify. Asks the user to confirm.",
      input: z.object({ object_type: objectType, object_id: objectId }),
      output: out.write({ verification: z.unknown() }),
      annotations: WRITE(false, false),
    },
    async ({ object_type, object_id }, { confirm }) => {
      if (!object_type.trim()) throw bad("object_type is required.");
      const d = await confirm(
        () => `Start an identity verification for ${object_type} ${object_id}?`,
        { object_type, object_id },
        "no verification was started",
      );
      if (d !== "go") return d;
      const res = await client.request("POST", "/identityverifier", { body: [{ object_type, object_id }] });
      return { status: "created", verification: slim(res.data) };
    },
  );
}
