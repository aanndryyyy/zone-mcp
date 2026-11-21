/** Zone+ managed applications (WordPress and others): catalogue, installs, staging copies/sync, upgrades, backups. */
import * as z from "zod";
import { ZoneApiError } from "../client.js";
import { READ, WRITE, bad, defined, diff, first, id, limit, listResult, page, pick, seg, slim, tool, vserver, type Deps } from "../common.js";
import * as out from "../schemas.js";

const installId = id("Zone+ install id (list_app_installs → identificator).");
const INSTALL_WRITABLE = [
  "settings_autoupdates_plugins",
  "settings_autoupdates_themes",
  "settings_notifications",
  "access_ips",
  "email",
] as const;

const label = (i: any) => `${i?.application?.name ?? "app"} ${i?.version?.name ?? ""} at ${i?.location ?? "?"}`.replace(/\s+/g, " ");

export function registerZonePlusTools(deps: Deps): void {
  const { client } = deps;
  const base = (v: string) => `/vserver/${seg(v)}/zoneplus`;
  const inst = (v: string, i: string | number) => `${base(v)}/install/${seg(i)}`;
  const getInstall = async (v: string, i: string | number) => {
    const found = first(await client.request("GET", inst(v, i)));
    if (!found) throw new ZoneApiError(404, "HTTP_404", `No Zone+ install ${i} on ${v}.`);
    return found;
  };
  const optional = <T>(p: Promise<T>) => p.catch(() => null);

  tool(
    deps,
    "list_zoneplus_apps",
    {
      title: "List Zone+ applications",
      description:
        "The Zone+ application catalogue for a webhosting (WordPress, Brizy, …) with prices and trial periods. Pass " +
        "`app_id` for one application with its versions (price, languages), the hosts it can be installed on, " +
        "auto-update presets and terms-of-service URL: what create_app_install needs.",
      input: z.object({
        vserver,
        app_id: z.string().optional().describe("Application id, e.g. 'wordpress'."),
        roles: z.string().optional().describe("Comma-separated roles to list: web, addon, proxy, wp."),
      }),
      output: out.parts({ applications: out.items.optional(), application: out.item.nullable().optional(), versions: out.items.optional(), options: z.unknown().optional() }),
      annotations: READ,
    },
    async ({ vserver, app_id, roles }) => {
      if (!app_id) {
        const res = await client.request("GET", `${base(vserver)}/application`, { query: { roles } });
        return { applications: slim(res.data) };
      }
      const p = `${base(vserver)}/application/${seg(app_id)}`;
      const [app, versions, opts] = await Promise.all([
        client.request("GET", p),
        client.request("GET", `${p}/version`),
        optional(client.request("OPTIONS", p)),
      ]);
      return { application: first(app), versions: slim(versions.data), options: opts?.data ?? null };
    },
  );

  tool(
    deps,
    "list_app_installs",
    {
      title: "List Zone+ installs",
      description:
        "List the Zone+ application installs (e.g. WordPress sites) on a webhosting: location, application and version, " +
        "available upgrade versions, auto-update settings, staging/production flags and sync destinations.",
      input: z.object({
        vserver,
        staging: z.boolean().optional().describe("Only staging (true) or only non-staging (false) installs."),
        url_or_app: z.string().optional().describe("Filter by URL or application name."),
        page,
        limit,
      }),
      output: out.list("installs"),
      annotations: READ,
    },
    async ({ vserver, staging, url_or_app, page, limit }) => {
      const res = await client.request("GET", `${base(vserver)}/install`, { query: { staging, url_or_app }, page, limit });
      return listResult("installs", res.data, res.pager);
    },
  );

  tool(
    deps,
    "get_app_install",
    {
      title: "Get Zone+ install",
      description:
        "One Zone+ install with its upgrade options, available add-ons and, when it supports staging sync, the files " +
        "and database tables that sync_app_install can copy. Up to 4 API requests.",
      input: z.object({ vserver, install_id: installId }),
      output: out.parts({ install: out.item, options: z.unknown(), addons: z.unknown(), sync_options: z.unknown() }),
      annotations: READ,
    },
    async ({ vserver, install_id }) => {
      const p = inst(vserver, install_id);
      const [install, opts, addons] = await Promise.all([
        getInstall(vserver, install_id),
        optional(client.request("OPTIONS", p)),
        optional(client.request("GET", `${p}/addons`)),
      ]);
      const sync = install.support_sync ? await optional(client.request("OPTIONS", `${p}/sync`)) : null;
      return { install, options: opts?.data ?? null, addons: addons ? first(addons) : null, sync_options: sync?.data ?? null };
    },
  );

  tool(
    deps,
    "create_app_install",
    {
      title: "Install a Zone+ application",
      description:
        "Install a Zone+ application (e.g. WordPress) on a host. Look up valid `version`, `location`, languages and " +
        "auto-update presets with list_zoneplus_apps(app_id) first. Some applications or versions are PAID: the user is " +
        "asked to confirm with the price and terms shown.",
      input: z.object({
        vserver,
        application: z.string().min(1).describe("Application slug, e.g. 'wordpress'."),
        version: z.string().min(1).describe("Version name from list_zoneplus_apps(app_id)."),
        location: z.string().min(1).describe("Host name or full URL, depending on the application."),
        settings_language: z.string().optional(),
        settings_autoupdates: z.enum(["any", "minor", "manual"]).optional(),
        settings_autoupdates_plugins: z.boolean().optional(),
        settings_autoupdates_themes: z.boolean().optional(),
        settings_notifications: z.boolean().optional(),
        email: z.string().optional().describe("Site contact e-mail (required by most brands)."),
        plugins: z.array(z.string()).optional().describe("WordPress: plugins to install."),
        themes: z.array(z.string()).optional().describe("WordPress: themes to install."),
        template: z.string().optional().describe("WordPress: starter template."),
      }),
      output: out.objectWrite("install"),
      annotations: WRITE(true, false),
    },
    async (args, { confirm }) => {
      const { vserver, ...body } = args;
      const d = await confirm(
        async () => {
          const opts: any = (await optional(client.request("OPTIONS", `${base(vserver)}/application/${seg(body.application)}`)))?.data;
          const v = (Array.isArray(opts?.version) ? opts.version : []).find((x: any) => x?.name === body.version || x?.identificator === body.version);
          const price = v
            ? `Price: ${v.price || "0"}${v.price_first_year ? ` (first year ${v.price_first_year})` : ""}${v.trial_period ? `, ${v.trial_period}-day trial` : ""}.`
            : "Price: unknown (version not found in the options); check my.zone.eu.";
          return `Install ${body.application} ${body.version} at ${body.location} on ${vserver}?\n${price}` +
            (opts?.terms_of_service_url ? `\nTerms: ${opts.terms_of_service_url}` : "");
        },
        { vserver, application: body.application, location: body.location },
        "nothing was installed",
      );
      if (d !== "go") return d;
      const res = await client.request("POST", `${base(vserver)}/install`, { body: defined(body) });
      return { status: "created", install: first(res), message: "Installation runs in the background; check list_app_installs in a few minutes." };
    },
  );

  tool(
    deps,
    "update_app_install",
    {
      title: "Update Zone+ install settings",
      description:
        "Change a Zone+ install's plugin/theme auto-updates, update e-mail notifications, contact e-mail, or `access_ips` " +
        "(IP allow-list for staging sites; [] makes it public). Only the fields you pass change; asks the user to confirm.",
      input: z.object({
        vserver,
        install_id: installId,
        settings_autoupdates_plugins: z.boolean().optional(),
        settings_autoupdates_themes: z.boolean().optional(),
        settings_notifications: z.boolean().optional(),
        access_ips: z.array(z.string()).optional(),
        email: z.string().optional(),
      }),
      output: out.objectWrite("install"),
      annotations: WRITE(true, true),
    },
    async (args, { confirm }) => {
      const { vserver, install_id, ...fields } = args;
      const changes = defined(fields);
      if (!Object.keys(changes).length) throw new ZoneApiError(400, "NOTHING_TO_UPDATE", "Pass at least one field to change.");
      const current = await getInstall(vserver, install_id);
      const d = await confirm(
        () => `Change ${label(current)}?\n${diff(current, changes)}`,
        { vserver, install_id },
        "the install was not changed",
      );
      if (d !== "go") return d;
      const res = await client.request("PUT", inst(vserver, install_id), { body: { ...pick(current, INSTALL_WRITABLE), ...changes } });
      return { status: "updated", install: first(res) };
    },
  );

  tool(
    deps,
    "delete_app_install",
    {
      title: "Delete Zone+ install",
      description:
        "Uninstall a Zone+ application (e.g. a WordPress site). IRREVERSIBLE: make a backup first if anything might be " +
        "needed. The user is asked to confirm.",
      input: z.object({ vserver, install_id: installId }),
      output: out.objectWrite("install"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, install_id }, { confirm }) => {
      const current = await getInstall(vserver, install_id);
      const d = await confirm(
        () => `PERMANENTLY delete ${label(current)} on ${vserver}? This cannot be undone.`,
        { vserver, install_id },
        "nothing was deleted",
      );
      if (d !== "go") return d;
      await client.request("DELETE", inst(vserver, install_id));
      return { status: "deleted", install: { identificator: install_id, location: current.location } };
    },
  );

  tool(
    deps,
    "copy_app_install",
    {
      title: "Copy Zone+ install",
      description:
        "Copy a Zone+ install (files and database) to another host, e.g. to make a staging site. Check `support_clones` " +
        "with get_app_install; the target host must exist (create_host). `staging: true` links the copy to the original " +
        "for sync_app_install. Asks the user to confirm.",
      input: z.object({
        vserver,
        install_id: installId,
        location: z.string().min(1).describe("Target host name."),
        path: z.string().optional().describe("Path under the host; the host root when omitted."),
        staging: z.boolean().optional().describe("Make the copy a staging site of the original."),
      }),
      output: out.write({ copy: out.item }),
      annotations: WRITE(false, false),
    },
    async ({ vserver, install_id, location, path, staging }, { confirm }) => {
      const current = await getInstall(vserver, install_id);
      if (current.support_clones === false) throw bad(`${label(current)} does not support copies.`);
      const target = `${location}${path ? `/${path.replace(/^\/+/, "")}` : ""}`;
      const d = await confirm(
        () => `Copy ${label(current)} to ${target}${staging ? " as a staging site" : ""}? Anything already at ${target} may be overwritten.`,
        { vserver, install_id },
        "nothing was copied",
      );
      if (d !== "go") return d;
      const res = await client.request("POST", `${inst(vserver, install_id)}/copy`, { body: defined({ location, path, staging }) });
      return { status: "created", copy: slim(Array.isArray(res.data) ? res.data[0] : res.data) };
    },
  );

  tool(
    deps,
    "sync_app_install",
    {
      title: "Sync WordPress staging ↔ production",
      description:
        "Copy a WordPress install over another one: staging → production to publish, or production → staging to " +
        "refresh. OVERWRITES the destination. `destination_id` must be in the source's `sync_destinations`. Omit " +
        "`files` / `tables` to sync everything, or list the ones to sync (get_app_install → sync_options). `backup` " +
        "(default true) backs up the destination first. Asks the user to confirm.",
      input: z.object({
        vserver,
        source_id: installId.describe("Install to copy from."),
        destination_id: installId.describe("Install to overwrite."),
        backup: z.boolean().optional().describe("Back up the destination first (default true)."),
        files: z.array(z.string().min(1)).min(1).optional().describe("Only these files/directories (default: all)."),
        tables: z.array(z.string().min(1)).min(1).optional().describe("Only these database tables (default: all)."),
      }),
      output: out.write({ source_id: z.unknown(), destination_id: z.unknown() }),
      annotations: WRITE(true, false),
    },
    async ({ vserver, source_id, destination_id, backup, files, tables }, { confirm }) => {
      const [src, dst] = await Promise.all([getInstall(vserver, source_id), getInstall(vserver, destination_id)]);
      if (!src.support_sync) throw bad(`${label(src)} does not support staging sync.`);
      const dests = (src.sync_destinations ?? []).map(String);
      if (!dests.includes(String(destination_id))) {
        throw bad(
          dests.length
            ? `${destination_id} is not a sync destination of ${source_id} (allowed: ${dests.join(", ")}).`
            : `${label(src)} has no linked staging/production site; make one with copy_app_install(staging: true).`,
        );
      }
      const doBackup = backup ?? true;
      const d = await confirm(
        () =>
          `Overwrite ${label(dst)} with ${label(src)}?\n` +
          `• files: ${files ? files.join(", ") : "all"}\n• database tables: ${tables ? tables.join(", ") : "all"}\n` +
          `• backup of the destination first: ${doBackup ? "yes" : "NO"}`,
        { vserver, source_id, destination_id },
        "nothing was synced",
      );
      if (d !== "go") return d;
      await client.request("POST", `${inst(vserver, source_id)}/sync/${seg(destination_id)}`, {
        query: { backup: doBackup, files, tables },
      });
      return { status: "started", source_id, destination_id, message: "Sync runs in the background; check the site shortly." };
    },
  );

  tool(
    deps,
    "upgrade_app_install",
    {
      title: "Upgrade Zone+ install",
      description:
        "Upgrade a Zone+ install to `version` (one of get_app_install → options / available_versions), optionally " +
        "with its WordPress plugins and themes. By default a backup is made first (`backup_first`), so " +
        "restore_app_backup can roll back. Asks the user to confirm.",
      input: z.object({
        vserver,
        install_id: installId,
        version: z.string().min(1),
        plugins: z.boolean().optional().describe("WordPress: also upgrade plugins."),
        themes: z.boolean().optional().describe("WordPress: also upgrade themes."),
        backup_first: z.boolean().optional().describe("Back up before upgrading (default true)."),
      }),
      output: out.write({ backup: out.item }),
      annotations: WRITE(true, false),
    },
    async ({ vserver, install_id, version, plugins, themes, backup_first }, { confirm }) => {
      const current = await getInstall(vserver, install_id);
      const doBackup = backup_first ?? true;
      if (doBackup && current.support_snapshots === false) {
        throw bad(`${label(current)} does not support backups; pass backup_first: false to upgrade without one.`);
      }
      const extras = [plugins && "plugins", themes && "themes"].filter(Boolean).join(" and ");
      const d = await confirm(
        () =>
          `Upgrade ${label(current)} to ${version}${extras ? `, including ${extras}` : ""}?\n` +
          `Backup first: ${doBackup ? "yes" : "NO"}.`,
        { vserver, install_id },
        "nothing was upgraded",
      );
      if (d !== "go") return d;
      let backup: unknown;
      if (doBackup) {
        backup = first(
          await client.request("POST", `${inst(vserver, install_id)}/backup`, { body: { label: `Before upgrade to ${version}` } }),
        );
      }
      await client.request("POST", `${inst(vserver, install_id)}/upgrade`, { body: defined({ version, plugins, themes }) });
      return { status: "started", ...(backup ? { backup } : {}), message: "The upgrade runs in the background; check list_app_installs shortly." };
    },
  );

  tool(
    deps,
    "get_app_login_url",
    {
      title: "Get WordPress login link",
      description:
        "Generate a one-click admin login URL for a WordPress/Brizy install. The URL logs anyone who opens it in as " +
        "admin: give it only to the user, never paste it anywhere else. Asks the user to confirm.",
      input: z.object({ vserver, install_id: installId }),
      output: out.write({ url: z.string().nullable() }),
      annotations: WRITE(false, false),
    },
    async ({ vserver, install_id }, { confirm }) => {
      const d = await confirm(
        async () => `Generate a one-click admin login link for ${label(await getInstall(vserver, install_id))}? Anyone who has the link can log in as admin.`,
        { vserver, install_id },
        "no login link was generated",
      );
      if (d !== "go") return d;
      const res = await client.request<any>("GET", `${inst(vserver, install_id)}/login`);
      const data = Array.isArray(res.data) ? res.data[0] : res.data;
      return { status: "created", url: data?.url ?? null };
    },
  );

  tool(
    deps,
    "import_wordpress",
    {
      title: "Import a WordPress site",
      description:
        "Import an existing WordPress site from another host into Zone+ on this webhosting. `source` + `ftu` (an " +
        "FTP/SSH URL with credentials, e.g. 'sftp://user:pass@host/path') let Zone fetch the files. The credentials " +
        "are sent to Zone only and never shown in the confirmation. Asks the user to confirm.",
      input: z.object({
        vserver,
        url: z.string().min(1).describe("URL of the existing WordPress site."),
        source: z.string().optional().describe("Source URL."),
        source_ip: z.string().optional().describe("Source server IP."),
        ftu: z.string().optional().describe("FTP/SSH URL (with credentials) or app:// URI; required with `source`."),
      }),
      output: out.objectWrite("install"),
      annotations: WRITE(false, false),
    },
    async ({ vserver, url, source, source_ip, ftu }, { confirm }) => {
      if (source && !ftu) throw bad("`ftu` is required when `source` is set.");
      const d = await confirm(
        () => `Import the WordPress site ${url} into ${vserver}${source ? ` from ${source}` : ""}${ftu ? " (using the FTP/SSH credentials you gave)" : ""}?`,
        { vserver, url },
        "nothing was imported",
      );
      if (d !== "go") return d;
      const res = await client.request("POST", `${base(vserver)}/install/import`, { body: defined({ url, source, source_ip, ftu }) });
      return { status: "started", install: first(res) };
    },
  );

  // ── Backups ──

  tool(
    deps,
    "list_app_backups",
    {
      title: "List Zone+ install backups",
      description: "List the backups (snapshots) of a Zone+ install: id, created time, label, backed-up version, size.",
      input: z.object({ vserver, install_id: installId }),
      output: out.list("backups"),
      annotations: READ,
    },
    async ({ vserver, install_id }) => {
      const res = await client.request("GET", `${inst(vserver, install_id)}/backup`);
      return listResult("backups", res.data, res.pager);
    },
  );

  tool(
    deps,
    "create_app_backup",
    {
      title: "Back up a Zone+ install",
      description: "Make a backup (snapshot) of a Zone+ install's files and database. Uses disk quota.",
      input: z.object({ vserver, install_id: installId, label: z.string().max(100).optional().describe("Short description.") }),
      output: out.objectWrite("backup"),
      annotations: WRITE(false, false),
    },
    async ({ vserver, install_id, label }) => {
      const res = await client.request("POST", `${inst(vserver, install_id)}/backup`, { body: defined({ label }) });
      return { status: "created", backup: first(res) };
    },
  );

  const getBackup = async (v: string, i: string | number, b: string | number) =>
    first(await client.request("GET", `${inst(v, i)}/backup/${seg(b)}`));

  tool(
    deps,
    "restore_app_backup",
    {
      title: "Restore Zone+ install from backup",
      description:
        "Restore a Zone+ install from one of its backups. OVERWRITES the live site's files and database with the " +
        "backup; changes since then are lost (make a fresh backup first if unsure). Asks the user to confirm.",
      input: z.object({ vserver, install_id: installId, backup_id: id("Backup id from list_app_backups.") }),
      output: out.write({ backup: out.item }),
      annotations: WRITE(true, false),
    },
    async ({ vserver, install_id, backup_id }, { confirm }) => {
      const [current, backup] = await Promise.all([getInstall(vserver, install_id), getBackup(vserver, install_id, backup_id)]);
      if (!backup) throw new ZoneApiError(404, "HTTP_404", `No backup ${backup_id} for install ${install_id}.`);
      const d = await confirm(
        () =>
          `Restore ${label(current)} to the backup "${backup.label ?? backup_id}" from ${backup.created ?? "?"} (version ${backup.version ?? "?"})? ` +
          "Everything changed since then is overwritten.",
        { vserver, install_id, backup_id },
        "nothing was restored",
      );
      if (d !== "go") return d;
      await client.request("POST", `${inst(vserver, install_id)}/backup/${seg(backup_id)}`);
      return { status: "started", backup, message: "The restore runs in the background." };
    },
  );

  tool(
    deps,
    "delete_app_backup",
    {
      title: "Delete Zone+ install backup",
      description: "Delete one backup of a Zone+ install. IRREVERSIBLE. Asks the user to confirm.",
      input: z.object({ vserver, install_id: installId, backup_id: id("Backup id from list_app_backups.") }),
      output: out.write({ backup: out.item }),
      annotations: WRITE(true, true),
    },
    async ({ vserver, install_id, backup_id }, { confirm }) => {
      const d = await confirm(
        async () => {
          const b = await getBackup(vserver, install_id, backup_id).catch(() => null);
          return `Permanently delete the backup "${b?.label ?? backup_id}"${b?.created ? ` from ${b.created}` : ""}${b?.size_human ? ` (${b.size_human})` : ""} of install ${install_id}?`;
        },
        { vserver, install_id, backup_id },
        "nothing was deleted",
      );
      if (d !== "go") return d;
      await client.request("DELETE", `${inst(vserver, install_id)}/backup/${seg(backup_id)}`);
      return { status: "deleted", backup: { identificator: backup_id } };
    },
  );
}
