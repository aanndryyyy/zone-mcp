/**
 * Lookups in the bundled ZoneID API OpenAPI 3.0 spec (spec/openapi.json, as published at https://api.zone.eu/v2).
 * Lets the model find the right path and the exact request-body fields before calling zone_api_request.
 */
import { readFileSync } from "node:fs";

type Json = any;

let cached: Json | undefined;
const spec = (): Json => (cached ??= JSON.parse(readFileSync(new URL("../spec/openapi.json", import.meta.url), "utf8")));

const METHODS = ["get", "post", "put", "delete", "options"] as const;

const resolveRef = (ref: string): Json => {
  let node: Json = spec();
  for (const part of ref.replace(/^#\//, "").split("/")) node = node?.[part];
  return node;
};

/** A compact field map: `{ field: "type (ro) – description" }`, with $ref and allOf flattened. */
function fields(schema: Json, depth = 0): Record<string, unknown> | string {
  if (!schema || depth > 4) return {};
  if (schema.$ref) return fields(resolveRef(schema.$ref), depth + 1);
  if (schema.type === "array") {
    const inner = fields(schema.items, depth + 1);
    return typeof inner === "string" ? `${inner}[]` : { "[]": inner };
  }
  const out: Record<string, unknown> = {};
  for (const part of schema.allOf ?? []) {
    const f = fields(part, depth + 1);
    if (typeof f === "object") Object.assign(out, f);
  }
  for (const [name, raw] of Object.entries<Json>(schema.properties ?? {})) {
    const prop = raw.$ref ? resolveRef(raw.$ref) : raw;
    if (prop.type === "object" || prop.properties || (prop.type === "array" && (prop.items?.properties || prop.items?.$ref))) {
      out[name] = fields(prop, depth + 1);
      continue;
    }
    let type: string = prop.type ?? "any";
    if (prop.type === "array") type = `${prop.items?.type ?? "any"}[]`;
    const bits = [type];
    if (prop.enum) bits.push(`one of ${prop.enum.join("|")}`);
    if (prop.readOnly) bits.push("read-only");
    if (prop.default !== undefined) bits.push(`default ${JSON.stringify(prop.default)}`);
    const desc = prop.description?.replace(/\*+/g, "").replace(/\s+/g, " ").trim();
    out[name] = desc ? `${bits.join(", ")} – ${desc}` : bits.join(", ");
  }
  if (!Object.keys(out).length && schema.type && schema.type !== "object") return String(schema.type);
  return out;
}

const params = (list: Json[] = []) =>
  list.map((p) => (p.$ref ? resolveRef(p.$ref) : p)).map((p) => ({
    name: p.name,
    in: p.in,
    required: Boolean(p.required),
    ...(p.description ? { description: String(p.description).replace(/\s+/g, " ").trim() } : {}),
    ...(p.schema?.enum ? { enum: p.schema.enum } : {}),
  }));

const templateRegex = (template: string) =>
  new RegExp(`^${template.replace(/\/+$/, "").replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+")}/?$`);

/** Find the spec path template for a concrete path (`/dns/example.com/a/1`) or a template. Literal segments win. */
export function matchPath(path: string): string | undefined {
  let p = path.trim().split("?")[0]!.replace(/^\/?(v2\/)?/, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  const paths = Object.keys(spec().paths);
  if (paths.includes(p)) return p;
  if (paths.includes(`${p}/`)) return `${p}/`;
  const literals = (t: string) => t.split("/").filter((s) => s && !s.startsWith("{")).length;
  return paths
    .filter((t) => templateRegex(t).test(p))
    .sort((a, b) => literals(b) - literals(a))[0];
}

/** Paths (with methods and summaries) whose path, tag or summary contains every word of `query`. */
export function searchEndpoints(query?: string) {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const out: { path: string; methods: Record<string, string> }[] = [];
  for (const [path, item] of Object.entries<Json>(spec().paths)) {
    const methods: Record<string, string> = {};
    for (const m of METHODS) if (item[m]) methods[m.toUpperCase()] = item[m].summary ?? "";
    const hay = `${path} ${Object.values(methods).join(" ")} ${METHODS.flatMap((m) => item[m]?.tags ?? []).join(" ")}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) out.push({ path, methods });
  }
  return out;
}

/** Full description of one endpoint: parameters, request body fields and response fields per method. */
export function describeEndpoint(path: string, method?: string) {
  const template = matchPath(path);
  if (!template) return undefined;
  const item = spec().paths[template];
  const wanted = method ? [method.toLowerCase()] : METHODS.filter((m) => item[m]);
  const methods: Record<string, unknown> = {};
  for (const m of wanted) {
    const op = item[m];
    if (!op) continue;
    const body = op.requestBody?.content?.["application/json"]?.schema;
    const okResp = Object.entries<Json>(op.responses ?? {}).find(([code]) => code.startsWith("2"));
    const respSchema = okResp?.[1]?.content?.["application/json"]?.schema;
    methods[m.toUpperCase()] = {
      summary: op.summary,
      ...(op.description ? { description: String(op.description).replace(/\s+/g, " ").trim() } : {}),
      parameters: params([...(item.parameters ?? []), ...(op.parameters ?? [])]),
      ...(body ? { request_body: fields(body) } : {}),
      ...(respSchema ? { response: fields(respSchema) } : {}),
      status_codes: Object.fromEntries(Object.entries<Json>(op.responses ?? {}).map(([c, r]) => [c, r.description ?? ""])),
    };
  }
  return { path: template, methods };
}
