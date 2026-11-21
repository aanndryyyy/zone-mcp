/** Long-running processes on a webhosting: PM2 applications (Node.js, Python, …) and Redis. */
import * as z from "zod";
import { ZoneApiError } from "../client.js";
import { READ, WRITE, asArray, defined, diff, first, id, pick, seg, slim, tool, vserver, type Deps } from "../common.js";
import * as out from "../schemas.js";

const PM2_WRITABLE = ["name", "scriptname", "memory_limit"] as const;
const processId = id("PM2 process id from list_pm2_processes.");
const redisId = id("Redis id from list_redis.");

export function registerProcessTools(deps: Deps): void {
  const { client } = deps;
  const pm2 = (v: string, p?: string | number) => `/vserver/${seg(v)}/process/pm2${p !== undefined ? `/${seg(p)}` : ""}`;
  const redis = (v: string, r?: string | number) => `/vserver/${seg(v)}/database/redis${r !== undefined ? `/${seg(r)}` : ""}`;
  const getPm2 = async (v: string, p: string | number) => {
    const c = first(await client.request("GET", pm2(v, p)));
    if (!c) throw new ZoneApiError(404, "HTTP_404", `No PM2 process ${p} on ${v}.`);
    return c;
  };

  tool(
    deps,
    "list_pm2_processes",
    {
      title: "List PM2 processes",
      description:
        "The PM2-managed applications on a webhosting (Node.js, Python, shell…): id, name, script, memory limit and " +
        "available memory, status, enabled. Serve one on a host with update_host_config(proxy_backend_port); its logs " +
        "are in read_logs(log: 'pm2').",
      input: z.object({ vserver }),
      output: out.list("processes"),
      annotations: READ,
    },
    async ({ vserver }) => ({ processes: slim(asArray((await client.request("GET", pm2(vserver))).data)) }),
  );

  tool(
    deps,
    "create_pm2_process",
    {
      title: "Create PM2 process",
      description: "Register a new PM2 application on a webhosting: a name, the script to run (path relative to the home dir), and optionally a memory limit (MB).",
      input: z.object({
        vserver,
        name: z.string().min(1),
        scriptname: z.string().min(1).describe("Script path, e.g. 'app/server.js'."),
        memory_limit: z.number().int().positive().optional().describe("Max memory in MB."),
      }),
      output: out.objectWrite("process"),
      annotations: WRITE(false, false),
    },
    async ({ vserver, ...body }) => {
      const res = await client.request("POST", pm2(vserver), { body: defined(body) });
      return { status: "created", process: first(res) ?? body };
    },
  );

  tool(
    deps,
    "update_pm2_process",
    {
      title: "Update PM2 process",
      description: "Change a PM2 application's name, script or memory limit. Only the fields you pass change; asks the user to confirm.",
      input: z.object({
        vserver,
        process_id: processId,
        name: z.string().min(1).optional(),
        scriptname: z.string().min(1).optional(),
        memory_limit: z.number().int().positive().optional(),
      }),
      output: out.objectWrite("process"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, process_id, ...fields }, { confirm }) => {
      const changes = defined(fields);
      if (!Object.keys(changes).length) throw new ZoneApiError(400, "NOTHING_TO_UPDATE", "Pass at least one field to change.");
      const current = await getPm2(vserver, process_id);
      const d = await confirm(
        () => `Change the PM2 process "${current.name}" on ${vserver}?\n${diff(current, changes)}`,
        { vserver, process_id },
        "the process was not changed",
      );
      if (d !== "go") return d;
      const res = await client.request("PUT", pm2(vserver, process_id), { body: { ...pick(current, PM2_WRITABLE), ...changes } });
      return { status: "updated", process: first(res) };
    },
  );

  tool(
    deps,
    "delete_pm2_process",
    {
      title: "Delete PM2 process",
      description: "Stop and remove a PM2 application (its files stay). Any host proxied to it stops working. Asks the user to confirm.",
      input: z.object({ vserver, process_id: processId }),
      output: out.objectWrite("process"),
      annotations: WRITE(true, true),
    },
    async ({ vserver, process_id }, { confirm }) => {
      const current = await getPm2(vserver, process_id);
      const d = await confirm(
        () => `Delete the PM2 process "${current.name}" (${current.scriptname}) on ${vserver}?`,
        { vserver, process_id },
        "nothing was deleted",
      );
      if (d !== "go") return d;
      await client.request("DELETE", pm2(vserver, process_id));
      return { status: "deleted", process: { id: process_id, name: current.name } };
    },
  );

  tool(
    deps,
    "control_pm2_process",
    {
      title: "Start, stop or restart PM2 process",
      description: "Start, stop or restart a PM2 application. Stop and restart interrupt the app, so they ask the user to confirm.",
      input: z.object({ vserver, process_id: processId, action: z.enum(["start", "stop", "restart"]) }),
      output: out.objectWrite("process"),
      annotations: WRITE(true, false),
    },
    async ({ vserver, process_id, action }, { confirm }) => {
      if (action !== "start") {
        const d = await confirm(
          async () => `${action === "stop" ? "Stop" : "Restart"} the PM2 process "${(await getPm2(vserver, process_id)).name}" on ${vserver}?`,
          { vserver, process_id, action },
          `the process was not ${action === "stop" ? "stopped" : "restarted"}`,
        );
        if (d !== "go") return d;
      }
      const res = await client.request("POST", `${pm2(vserver, process_id)}/${action}`);
      return { status: { start: "started", stop: "stopped", restart: "restarted" }[action], process: first(res) };
    },
  );

  // ── Redis ──

  tool(
    deps,
    "list_redis",
    {
      title: "List Redis",
      description: "The Redis instance(s) of a webhosting: id, host/IP and port, status, and the auth password (needed to configure apps; don't repeat it needlessly).",
      input: z.object({ vserver }),
      output: out.list("redis"),
      annotations: READ,
    },
    async ({ vserver }) => ({ redis: slim(asArray((await client.request("GET", redis(vserver))).data)) }),
  );

  tool(
    deps,
    "enable_redis",
    {
      title: "Activate Redis",
      description: "Activate a Redis database on a webhosting (if the package allows it). Asks the user to confirm.",
      input: z.object({ vserver }),
      output: out.objectWrite("redis"),
      annotations: WRITE(false, true),
    },
    async ({ vserver }, { confirm }) => {
      const d = await confirm(() => `Activate Redis on ${vserver}?`, { vserver }, "nothing was activated");
      if (d !== "go") return d;
      const res = await client.request("POST", redis(vserver));
      return { status: "created", redis: first(res) };
    },
  );

  tool(
    deps,
    "control_redis",
    {
      title: "Start, stop, restart Redis or rotate its password",
      description:
        "Start, stop or restart a webhosting's Redis, or `regenerate_auth` to issue a new password (apps using the old " +
        "one lose access until reconfigured). Everything except start asks the user to confirm.",
      input: z.object({ vserver, redis_id: redisId, action: z.enum(["start", "stop", "restart", "regenerate_auth"]) }),
      output: out.objectWrite("redis"),
      annotations: WRITE(true, false),
    },
    async ({ vserver, redis_id, action }, { confirm }) => {
      if (action !== "start") {
        const what = { stop: "Stop", restart: "Restart", regenerate_auth: "Generate a new password for" }[action];
        const d = await confirm(
          () => `${what} Redis on ${vserver}?${action === "regenerate_auth" ? " Apps using the old password lose access." : ""}`,
          { vserver, redis_id, action },
          "nothing was changed",
        );
        if (d !== "go") return d;
      }
      const res = await client.request("POST", `${redis(vserver, redis_id)}/${action === "regenerate_auth" ? "regenerateauth" : action}`);
      const status = { start: "started", stop: "stopped", restart: "restarted", regenerate_auth: "updated" }[action];
      return { status, redis: first(res) };
    },
  );
}
