/** MySQL databases, accounts and per-database permissions (list_mysql in tools.ts lists both). */
import * as z from "zod";
import { ZoneApiError } from "../client.js";
import { READ, WRITE, asArray, defined, diff, first, seg, slim, tool, vserver, type Deps } from "../common.js";
import * as out from "../schemas.js";

const dbName = z.string().min(1).describe("Database name as listed by list_mysql (with the webhosting prefix).");
const dbUser = z.string().min(1).describe("MySQL username as listed by list_mysql (with the webhosting prefix).");
const password = z.string().min(10).max(64).describe("10–64 characters. Never shown back.");
const hosts = z
  .array(z.string().min(1))
  .describe("IPs allowed to connect; also 'ws' (the webserver) and 'pma' (phpMyAdmin).");

/** MySQL account without its password (the API may echo it). */
const noPassword = (a: any) => {
  if (!a || typeof a !== "object") return a;
  const { password: _p, ...rest } = a;
  return rest;
};

export function registerDatabaseTools(deps: Deps): void {
  const { client } = deps;
  const my = (v: string) => `/vserver/${seg(v)}/database/mysql`;
  const acct = (v: string, u: string) => `${my(v)}/account/${seg(u)}`;

  tool(
    deps,
    "create_mysql_database",
    {
      title: "Create MySQL database",
      description:
        "Create a MySQL database. `name` is used as a suffix of the webhosting's prefix (a name that already has the " +
        "prefix is kept). Collation defaults to utf8mb4_unicode_ci. Grant access with set_mysql_permissions.",
      input: z.object({ vserver, name: z.string().min(1), comment: z.string().optional(), collation: z.string().optional() }),
      output: out.objectWrite("database"),
      annotations: WRITE(false, false),
    },
    async ({ vserver, ...body }) => {
      const res = await client.request("POST", my(vserver), { body: defined(body) });
      return { status: "created", database: first(res) ?? body };
    },
  );

  tool(
    deps,
    "delete_mysql_database",
    {
      title: "Delete MySQL database",
      description: "Delete a MySQL database and ALL its data. IRREVERSIBLE. Asks the user to confirm.",
      input: z.object({ vserver, database: dbName }),
      output: out.objectWrite("database"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, database }, { confirm }) => {
      const d = await confirm(
        async () => {
          const db = first(await client.request("GET", `${my(vserver)}/${seg(database)}`).catch(() => ({ data: null }) as any));
          return `Permanently delete the MySQL database ${database}${db?.disk_usage_human ? ` (${db.disk_usage_human})` : ""} on ${vserver} and all its data?`;
        },
        { vserver, database },
        "nothing was deleted",
      );
      if (d !== "go") return d;
      await client.request("DELETE", `${my(vserver)}/${seg(database)}`);
      return { status: "deleted", database: { name: database } };
    },
  );

  tool(
    deps,
    "create_mysql_account",
    {
      title: "Create MySQL user",
      description:
        "Create a MySQL user. `username` is used as a suffix of the webhosting's prefix. Grant it databases with " +
        "set_mysql_permissions. The password is never echoed back.",
      input: z.object({
        vserver,
        username: z.string().min(1),
        password,
        hosts: hosts.optional(),
        require_ssl: z.boolean().optional(),
        comment: z.string().optional(),
      }),
      output: out.objectWrite("account"),
      annotations: WRITE(false, false),
    },
    async ({ vserver, ...body }) => {
      const res = await client.request("POST", `${my(vserver)}/account`, { body: defined(body) });
      return { status: "created", account: noPassword(first(res) ?? body) };
    },
  );

  tool(
    deps,
    "update_mysql_account",
    {
      title: "Update MySQL user",
      description:
        "Change a MySQL user's password, allowed hosts (replaces the list) or comment. Only the fields you pass change; " +
        "asks the user to confirm (the password itself is not shown).",
      input: z.object({ vserver, username: dbUser, password: password.optional(), hosts: hosts.optional(), comment: z.string().optional() }),
      output: out.objectWrite("account"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, username, password, hosts, comment }, { confirm }) => {
      const visible = defined({ hosts, comment });
      if (!Object.keys(visible).length && password === undefined) throw new ZoneApiError(400, "NOTHING_TO_UPDATE", "Pass password, hosts and/or comment.");
      const current = first(await client.request("GET", acct(vserver, username)));
      if (!current) throw new ZoneApiError(404, "HTTP_404", `No MySQL user ${username} on ${vserver}.`);
      const d = await confirm(
        () =>
          `Change the MySQL user ${username} on ${vserver}?\n` +
          (Object.keys(visible).length ? diff(current, visible) : "") +
          (password !== undefined ? "\n• password: (new password)" : ""),
        { vserver, username },
        "the user was not changed",
      );
      if (d !== "go") return d;
      const body = defined({ comment: comment ?? current.comment, hosts: hosts ?? current.hosts, password });
      const res = await client.request("PUT", acct(vserver, username), { body });
      return { status: "updated", account: noPassword(first(res) ?? { username, ...body }) };
    },
  );

  tool(
    deps,
    "delete_mysql_account",
    {
      title: "Delete MySQL user",
      description: "Delete a MySQL user; apps connecting as it stop working. The databases stay. Asks the user to confirm.",
      input: z.object({ vserver, username: dbUser }),
      output: out.objectWrite("account"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, username }, { confirm }) => {
      const d = await confirm(() => `Delete the MySQL user ${username} on ${vserver}?`, { vserver, username }, "nothing was deleted");
      if (d !== "go") return d;
      await client.request("DELETE", acct(vserver, username));
      return { status: "deleted", account: { username } };
    },
  );

  tool(
    deps,
    "get_mysql_permissions",
    {
      title: "Get MySQL user permissions",
      description: "Which databases a MySQL user can access and with which privileges, plus the privileges that can be granted (`available`).",
      input: z.object({ vserver, username: dbUser }),
      output: out.parts({ permissions: out.items, available: z.unknown() }),
      annotations: READ,
    },
    async ({ vserver, username }) => {
      const [perms, opts] = await Promise.all([
        client.request("GET", `${acct(vserver, username)}/permission`),
        client.request("OPTIONS", `${acct(vserver, username)}/permission`).catch(() => null),
      ]);
      return { permissions: slim(asArray(perms.data)), available: opts?.data ?? null };
    },
  );

  tool(
    deps,
    "set_mysql_permissions",
    {
      title: "Set MySQL user permissions",
      description:
        "Grant a MySQL user privileges on one database, replacing what it had there (e.g. ['SELECT','INSERT','UPDATE'," +
        "'DELETE'] or every privilege from get_mysql_permissions → available). Asks the user to confirm.",
      input: z.object({ vserver, username: dbUser, database: dbName, permissions: z.array(z.string().min(1)).min(1) }),
      output: out.objectWrite("permission"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, username, database, permissions }, { confirm }) => {
      const path = `${acct(vserver, username)}/permission/${seg(database)}`;
      const d = await confirm(
        async () => {
          const cur = first(await client.request("GET", path).catch(() => ({ data: null }) as any));
          return `Set ${username}'s privileges on ${database} to: ${permissions.join(", ")}?` +
            (cur?.permissions ? `\n(currently: ${[].concat(cur.permissions).join(", ") || "none"})` : "");
        },
        { vserver, username, database },
        "the privileges were not changed",
      );
      if (d !== "go") return d;
      const res = await client.request("PUT", path, { body: { permissions } });
      return { status: "updated", permission: first(res) ?? { username, database, permissions } };
    },
  );

  tool(
    deps,
    "revoke_mysql_permissions",
    {
      title: "Revoke MySQL user permissions",
      description: "Remove all of a MySQL user's privileges on one database. Asks the user to confirm.",
      input: z.object({ vserver, username: dbUser, database: dbName }),
      output: out.objectWrite("permission"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, username, database }, { confirm }) => {
      const d = await confirm(
        () => `Revoke all of ${username}'s privileges on ${database} (${vserver})?`,
        { vserver, username, database },
        "nothing was revoked",
      );
      if (d !== "go") return d;
      await client.request("DELETE", `${acct(vserver, username)}/permission/${seg(database)}`);
      return { status: "deleted", permission: { username, database } };
    },
  );
}
