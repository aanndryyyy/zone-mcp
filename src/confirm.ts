/**
 * Ask the user to confirm a write before it happens (multi-round-trip elicitation, protocol 2026-07-28; the SDK's
 * legacy shim turns it into `elicitation/create` for 2025-era clients). Same mechanism as hertwill-mcp.
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as z from "zod";

/**
 * A single-option choice rather than a yes/no tick-box: hosts that answer with plain Approve/Decline buttons
 * (T3 Code, for one) fill in an "approve" option themselves, but they cannot fill a required boolean, so they
 * decline the request without ever showing it. Form-rendering clients show it as a one-item picker.
 */
const confirmationSchema = z.object({
  confirm: z.enum(["approve"]).meta({ title: "Approve this change" }).describe("Choose 'approve' to go ahead."),
});

/**
 * True when this request's client can show a form elicitation (2026-07-28 envelope, else the 2025 handshake).
 * `elicitation: {}` means form support (the 2025-06-18 shape); a client that declares only `url` cannot show our form.
 */
export const canElicit = (server: McpServer, ctx: ServerContext): boolean => {
  const envelope = ctx.mcpReq.envelope as Record<string, any> | undefined;
  const el = (envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? server.server.getClientCapabilities())?.elicitation;
  if (!el || typeof el !== "object") return false;
  return Boolean(el.form) || Object.keys(el).length === 0;
};

// The confirmation answer comes back from the client, so on its own it proves nothing: a client could send
// `inputResponses: { confirm: … }` on the first call, or confirm one set of arguments and retry with another.
// So the server mints a `requestState` that binds the prompt to the exact tool + arguments (HMAC with a
// per-process key, 10-minute expiry) and only honours an answer that arrives with a valid state for those args.
const STATE_KEY = randomBytes(32);
const STATE_TTL_MS = 10 * 60_000;

/** JSON with sorted object keys, so the same arguments always hash the same way. */
const stableJson = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stableJson).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .filter((k) => (v as any)[k] !== undefined)
          .map((k) => `${JSON.stringify(k)}:${stableJson((v as any)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);

const argsDigest = (tool: string, args: unknown) =>
  createHash("sha256").update(`${tool}\n${stableJson(args)}`).digest("base64url");
const sign = (payload: string) => createHmac("sha256", STATE_KEY).update(payload).digest("base64url");

const mintState = (tool: string, args: unknown): string => {
  const payload = Buffer.from(JSON.stringify({ d: argsDigest(tool, args), exp: Date.now() + STATE_TTL_MS })).toString(
    "base64url",
  );
  return `${payload}.${sign(payload)}`;
};

const stateMatches = (state: unknown, tool: string, args: unknown): boolean => {
  if (typeof state !== "string") return false;
  const [payload, mac] = state.split(".");
  if (!payload || !mac) return false;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  try {
    const { d, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof exp === "number" && exp > Date.now() && d === argsDigest(tool, args);
  } catch {
    return false;
  }
};

/**
 * Ask the user to confirm a write before it happens, using a multi-round-trip elicitation (protocol 2026-07-28;
 * the SDK's legacy shim turns it into a server→client `elicitation/create` for 2025-era clients).
 *
 * Returns `"go"` when the user confirmed these exact arguments (or the client cannot show a form, in which case
 * the host's own tool approval is the gate), `"declined"` / `"cancelled"` when the user said no or dismissed the
 * prompt, or the `input_required` result to send back.
 */
export const confirmWrite = (
  server: McpServer,
  ctx: ServerContext,
  tool: string,
  args: unknown,
  message: string,
): "go" | "declined" | "cancelled" | InputRequiredResult => {
  if (!canElicit(server, ctx)) return "go";
  const answer = inputResponse(ctx.mcpReq.inputResponses, "confirm");
  // No answer yet, or an answer not bound to a prompt we issued for these args: (re-)ask.
  if (answer.kind !== "elicit" || !stateMatches(ctx.mcpReq.requestState(), tool, args)) {
    return inputRequired({
      inputRequests: { confirm: inputRequired.elicit({ message, requestedSchema: confirmationSchema }) },
      requestState: mintState(tool, args),
    });
  }
  if (answer.action === "cancel") return "cancelled";
  const parsed = confirmationSchema.safeParse(answer.content ?? {});
  return answer.action === "accept" && parsed.success && parsed.data.confirm === "approve" ? "go" : "declined";
};

/** The tool result when the user did not confirm. */
export const notConfirmed = (decision: "declined" | "cancelled", what: Record<string, unknown>, nothing: string) => ({
  status: decision,
  ...what,
  message:
    decision === "declined"
      ? `The user declined; ${nothing}. Do not retry unless the user asks.`
      : `The user dismissed the confirmation without answering; ${nothing}.`,
});
