/** Domain renewals and orders, and per-domain renewal reminders. */
import * as z from "zod";
import { READ, WRITE, asArray, domain, first, id, listResult, page, limit, seg, tool, type Deps } from "../common.js";
import * as out from "../schemas.js";

export function registerDomainOrderTools(deps: Deps): void {
  const { client } = deps;
  const renewalOptions = async (d: string) => (await client.request<any>("OPTIONS", `/domain/${seg(d)}`)).data?.renewal_options ?? null;

  tool(
    deps,
    "get_domain_renewal_options",
    {
      title: "Get domain renewal options",
      description:
        "How a domain can be renewed now (`action`: renew, or reactivate from grace/redemption) with each period's new " +
        "expiry date and price incl. VAT, and whether renewal reminder e-mails are on.",
      input: z.object({ domain }),
      output: out.parts({ renewal_options: z.unknown(), preferences: out.item.nullable() }),
      annotations: READ,
    },
    async ({ domain }) => {
      const [opts, prefs] = await Promise.all([renewalOptions(domain), client.request("GET", `/domain/${seg(domain)}/preferences`)]);
      return { renewal_options: opts, preferences: first(prefs) };
    },
  );

  tool(
    deps,
    "renew_domain",
    {
      title: "Renew a domain",
      description:
        "Order a renewal (or reactivation, for an expired domain) for `period` years from get_domain_renewal_options. " +
        "SPENDS MONEY: it creates an order and invoice. The confirmation shows the price and new expiry date. Track it " +
        "with list_domain_orders; pay with pay_invoices.",
      input: z.object({ domain, period: z.number().int().positive().describe("Period from get_domain_renewal_options.") }),
      output: out.write({ order: z.unknown() }),
      annotations: WRITE(true, false),
    },
    async ({ domain, period }, { confirm }) => {
      const d = await confirm(
        async () => {
          const opts: any = await renewalOptions(domain).catch(() => null);
          const p = asArray(opts?.action_periods).find((x: any) => Number(x?.period) === period) as any;
          const what = opts?.action && opts.action !== "renew" ? `Reactivate (${opts.action})` : "Renew";
          return `${what} ${domain} for ${period} ${period === 1 ? "year" : "years"}?` +
            (p ? ` Price ${p.total_price_with_tax} incl. VAT; new expiry ${p.expire_new ?? "?"}.` : " Price unknown: this period is not in the renewal options.");
        },
        { domain, period },
        "nothing was ordered",
      );
      if (d !== "go") return d;
      const res = await client.request("POST", "/order/domain/renew", { body: [{ domain, period }] });
      return { status: "created", order: res.data };
    },
  );

  tool(
    deps,
    "list_domain_orders",
    {
      title: "List domain orders",
      description:
        "Domain orders (registrations, renewals, transfers): status, errors, price, invoice number and whether it is " +
        "paid, and whether identity authorization is required. Pass `order_id` for one.",
      input: z.object({
        order_id: id("Order identificator.").optional(),
        in_progress: z.boolean().optional().describe("Only orders still in progress."),
        page,
        limit,
      }),
      output: out.list("orders"),
      annotations: READ,
    },
    async ({ order_id, in_progress, page, limit }) => {
      const res = await client.request("GET", order_id !== undefined ? `/order/domain/${seg(order_id)}` : "/order/domain", {
        query: { in_progress },
        page,
        limit,
      });
      return listResult("orders", res.data, res.pager);
    },
  );

  tool(
    deps,
    "cancel_domain_order",
    {
      title: "Cancel domain order",
      description: "Cancel a domain order that has not been completed. Asks the user to confirm.",
      input: z.object({ order_id: id("Order identificator from list_domain_orders.") }),
      output: out.write({ order: z.unknown() }),
      annotations: WRITE(true, true),
    },
    async ({ order_id }, { confirm }) => {
      const d = await confirm(
        async () => {
          const o = first(await client.request("GET", `/order/domain/${seg(order_id)}`).catch(() => ({ data: null }) as any));
          return `Cancel domain order ${order_id}${o ? ` (${o.status}, ${o.total_price_with_tax ?? "?"} incl. VAT, ${o.paid ? "PAID" : "unpaid"})` : ""}?`;
        },
        { order_id },
        "the order was not cancelled",
      );
      if (d !== "go") return d;
      await client.request("DELETE", `/order/domain/${seg(order_id)}`);
      return { status: "deleted", order: { identificator: order_id } };
    },
  );

  tool(
    deps,
    "set_domain_renewal_reminders",
    {
      title: "Turn domain renewal reminders on or off",
      description: "Turn renewal reminder e-mails for one domain on or off.",
      input: z.object({ domain, renewal_notifications: z.boolean() }),
      output: out.objectWrite("preferences"),
      annotations: WRITE(false, true),
    },
    async ({ domain, renewal_notifications }) => {
      const res = await client.request("PUT", `/domain/${seg(domain)}/preferences`, { body: { renewal_notifications } });
      return { status: "updated", preferences: first(res) ?? { renewal_notifications } };
    },
  );
}
