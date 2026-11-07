/**
 * Output schemas (`outputSchema`) for every tool.
 *
 * Zone's resources have many fields that vary by package, so items are `looseObject`: the fields a model relies on
 * are typed and everything else passes through, so a new API field never breaks a tool call. Write tools may also
 * return `{ status: "declined" | "cancelled", message }` when the user does not confirm, so those fields are optional.
 */
import * as z from "zod";

const item = z.looseObject({});

export const pager = z
  .looseObject({ page: z.number(), pages: z.number(), limit: z.number(), items: z.number() })
  .describe("Pagination from the x-pager-* headers; present only on paginated endpoints.");

/** `{ [key]: item[], pager? }` */
export const list = (key: string) => z.looseObject({ [key]: z.array(item), pager: pager.optional() });

/** `{ [key]: item | null }` */
export const object = (key: string) => z.looseObject({ [key]: item.nullable() });

const writeStatus = {
  status: z.enum(["updated", "deleted", "declined", "cancelled"]).optional(),
  message: z.string().optional().describe("Set when the user declined or dismissed the confirmation."),
};

/** Result of a confirmed write: the resource, or a declined/cancelled status. */
export const objectWrite = (key: string) => z.looseObject({ ...writeStatus, [key]: item.optional() });

export const getDomain = z.looseObject({ domain: item.nullable(), nameservers: z.array(item) });

const record = z.looseObject({
  type: z.string(),
  id: z.union([z.string(), z.number()]).optional(),
  name: z.string().optional(),
  destination: z.string().optional(),
});

export const dnsRecords = z.looseObject({ zone: z.string(), records: z.array(record) });
export const dnsRecord = z.looseObject({ record });
export const dnsRecordWrite = z.looseObject({
  ...writeStatus,
  record: record.optional(),
  zone: z.string().optional(),
  type: z.string().optional(),
  id: z.string().optional(),
});

export const mysql = z.looseObject({ databases: z.array(item), accounts: z.array(item) });

export const endpoints = z.looseObject({
  endpoints: z.array(z.looseObject({ path: z.string(), methods: z.record(z.string(), z.string()) })),
});

export const endpoint = z.looseObject({ path: z.string(), methods: z.record(z.string(), z.unknown()) });

export const apiResponse = z.looseObject({
  status: z.union([z.number(), z.enum(["declined", "cancelled"])]),
  data: z.unknown().optional(),
  pager: pager.optional(),
  message: z.string().optional(),
  method: z.string().optional(),
  path: z.string().optional(),
});
