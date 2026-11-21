/**
 * Shared plumbing for the tool modules: result shaping, error mapping, the confirmation gate, common input fields
 * and a `tool()` helper that registers a tool with all of the above wired in.
 */
import {
  isInputRequiredResult,
  type CallToolResult,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod";
import { ZoneApiError, type Pager, type ZoneClient, type ZoneResponse } from "./client.js";
import { canElicit, confirmWrite, notConfirmed } from "./confirm.js";

export type ToolResult = CallToolResult;

/** Same JSON as text (compact) and as `structuredContent` (typed by `outputSchema`). */
export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data as Record<string, unknown>,
});

export const fail = (err: unknown): ToolResult => {
  if (err instanceof ZoneApiError) {
    const error: Record<string, unknown> = { status: err.status, code: err.code, message: err.message };
    if (err.details !== undefined) error.details = err.details;
    if (err.rateLimitRemaining) error.ratelimit_remaining = err.rateLimitRemaining;
    return { content: [{ type: "text", text: JSON.stringify({ error }) }], isError: true };
  }
  return { content: [{ type: "text", text: `Error: ${(err as Error)?.message ?? String(err)}` }], isError: true };
};

/** API errors come back as tool errors the model can read; `input_required` (a confirmation request) passes through. */
export const run =
  <A>(fn: (args: A, ctx: ServerContext) => Promise<unknown>) =>
  async (args: A, ctx: ServerContext): Promise<ToolResult | InputRequiredResult> => {
    try {
      const data = await fn(args, ctx);
      return isInputRequiredResult(data) ? data : ok(data);
    } catch (err) {
      return fail(err);
    }
  };

/** Drop the hypermedia noise (`resource_url`, `_links`) the API puts on every object, nested ones included. */
export const slim = (data: unknown): unknown => {
  if (Array.isArray(data)) return data.map(slim);
  if (!data || typeof data !== "object") return data;
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (k !== "resource_url" && k !== "_links") copy[k] = slim(v);
  return copy;
};

export const asArray = (data: unknown): unknown[] => (Array.isArray(data) ? data : data == null ? [] : [data]);

/** The first object of a response (the API wraps single resources in an array), slimmed. */
export const first = (res: ZoneResponse): any => slim(asArray(res.data)[0] ?? null);

/** `{ [key]: items, pager? }` — tool results must be objects, and the API always returns arrays. */
export const listResult = (key: string, data: unknown, pager?: Pager) => ({ [key]: slim(asArray(data)), ...(pager ? { pager } : {}) });

export const seg = (s: string | number) => encodeURIComponent(String(s).trim());

export const bad = (msg: string) => new ZoneApiError(400, "INVALID_ARGUMENTS", msg);

/** Drop `undefined` values so a body only carries the fields the caller set. */
export const defined = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Copy only `keys` from `src` (skipping null/undefined): the writable part of a fetched resource, for a merge-PUT. */
export const pick = (src: any, keys: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (src?.[k] !== undefined && src?.[k] !== null) out[k] = src[k];
  return out;
};

/** Short, readable rendering of a value for a confirmation prompt. */
export const show = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/** `field: old → new` lines for the fields that change. */
export const diff = (current: Record<string, unknown>, next: Record<string, unknown>): string => {
  const lines = Object.keys(next)
    .filter((k) => JSON.stringify(current?.[k]) !== JSON.stringify(next[k]))
    .map((k) => `• ${k}: ${current?.[k] === undefined ? "(unset)" : show(current[k])} → ${show(next[k])}`);
  return lines.length ? lines.join("\n") : "• (no visible change)";
};

// ───────────────────────────── Shared input fields ─────────────────────────────

export const domain = z.string().min(1).describe("Domain name, e.g. 'example.com'.");
export const vserver = z
  .string()
  .min(1)
  .describe("Webhosting (virtual server) name, usually its main domain, e.g. 'example.com' (see list_webhostings).");
export const page = z.number().int().min(1).optional().describe("Page number (default 1).");
export const limit = z.number().int().min(1).max(100).optional().describe("Items per page, 1–100 (default 10 on paginated endpoints).");
export const hostname = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/, "A host name like 'www.example.com'.");
export const id = (what: string) => z.union([z.string().min(1), z.number().int()]).describe(what);

// ───────────────────────────── Annotations ─────────────────────────────

export const READ = { readOnlyHint: true, openWorldHint: true } as const;
/** A write: `destructive` when it overwrites or removes something, `idempotent` when repeating it changes nothing more. */
export const WRITE = (destructive: boolean, idempotent: boolean) =>
  ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: true }) as const;

// ───────────────────────────── Tool registration ─────────────────────────────

type Decision = "go" | InputRequiredResult | ReturnType<typeof notConfirmed>;

export interface Helpers {
  ctx: ServerContext;
  /**
   * Gate a write on user confirmation (when the client can show a form). `describe` runs only when a prompt is
   * actually shown. Returns "go", or the result to return as-is (a prompt, or a declined/cancelled status).
   */
  confirm: (describe: () => Promise<string> | string, what: Record<string, unknown>, nothing: string) => Promise<Decision>;
}

export interface Deps {
  server: McpServer;
  client: ZoneClient;
}

/** Register a tool: input/output schemas, error mapping, and a `confirm` bound to this tool's name and arguments. */
export function tool<I extends z.ZodObject<any>>(
  { server }: Deps,
  name: string,
  cfg: {
    title: string;
    description: string;
    input: I;
    output: z.ZodType;
    annotations: Record<string, boolean>;
  },
  fn: (args: z.infer<I>, h: Helpers) => Promise<unknown>,
): void {
  server.registerTool(
    name,
    {
      title: cfg.title,
      description: cfg.description,
      inputSchema: cfg.input,
      outputSchema: cfg.output as any,
      annotations: cfg.annotations,
    },
    run(async (args: z.infer<I>, ctx: ServerContext) =>
      fn(args, {
        ctx,
        confirm: async (describe, what, nothing) => {
          if (!canElicit(server, ctx)) return "go";
          const decision = confirmWrite(server, ctx, name, args, await describe());
          if (decision === "declined" || decision === "cancelled") return notConfirmed(decision, what, nothing);
          return decision;
        },
      }),
    ) as any,
  );
}
