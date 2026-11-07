// End-to-end smoke test: spawns the built server over stdio with the official MCP client and calls the read-only
// tools against the live ZoneID API, using the first domain and webhosting found on the account.
// Nothing on the account is modified: the only writes are a declined confirmation (never sent) and an accepted
// DELETE of a record id that does not exist (expected 404).
// Set SMOKE_SSH_VSERVER to also read logs over SSH from that webhosting.
// Uses ~35 requests (limit 60/min per IP): wait a minute between runs.
// Credentials: ZONE_USERNAME + ZONE_API_TOKEN, or the macOS Keychain item `zone-ee-api`.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const modern = process.env.PROTOCOL !== "legacy"; // PROTOCOL=legacy for a 2025-era initialize
const connect = async (name, { elicit } = {}) => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: { ...process.env }, stderr: "inherit" });
  const client = new Client(
    { name, version: "0.0.0" },
    {
      ...(modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}),
      ...(elicit ? { capabilities: { elicitation: { form: {} } } } : {}),
    },
  );
  if (elicit) client.setRequestHandler("elicitation/create", elicit);
  await client.connect(transport);
  return client;
};

let failures = 0;
const check = (good, label) => {
  if (!good) failures++;
  console.log(`${good ? "PASS" : "FAIL"} ${label}`);
};
const caller = (client) => async (name, args = {}, { expectError = false } = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  check(expectError ? res.isError : !res.isError, `${name} ${JSON.stringify(args).slice(0, 80)} -> ${text.replace(/\s+/g, " ").slice(0, 140)}`);
  return text;
};

const client = await connect("zone-smoke");
const call = caller(client);
console.log("protocol:", client.getNegotiatedProtocolVersion(), "server:", JSON.stringify(client.getServerVersion()));
const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(", "));

const { domains } = JSON.parse(await call("list_domains", { limit: 3, order_by: "expires", order_dir: "asc" }));
const zone = domains[0]?.name;
if (zone) {
  await call("get_domain", { domain: zone });
  const all = JSON.parse(await call("list_dns_records", { zone }));
  check(all.records.every((r) => r.type && r.id !== undefined && !("resource_url" in r)), "list_dns_records: every record has type and id, no resource_url");
  await call("list_dns_records", { zone, type: "a", name: "@" });
  // Validation runs before any API call.
  await call("create_dns_record", { zone, type: "mx", name: "@", destination: "mx.invalid" }, { expectError: true });
  await call("create_dns_record", { zone, type: "a", name: "x", destination: "192.0.2.1", priority: 1 }, { expectError: true });
}

const { webhostings } = JSON.parse(await call("list_webhostings", { limit: 2 }));
const vserver = webhostings[0]?.name;
if (vserver) {
  await call("get_server_info", { vserver });
  await call("list_mail_accounts", { vserver, limit: 2 });
  await call("list_mail_forwarders", { vserver, limit: 2 });
  await call("list_mysql", { vserver });
  await call("list_cron_jobs", { vserver });
  const ssl = await call("list_ssl_certificates", { vserver });
  check(!ssl.includes("private_key"), "list_ssl_certificates never returns private keys");
  const acc = JSON.parse(await call("get_ssh_access", { vserver, test: false }));
  check(acc.host_fingerprints.length > 0 && acc.registered_keys.every((k) => !("public_key" in k)), "get_ssh_access: host fingerprints, no key bodies");
  // Argument checks run before any SSH connection.
  await call("read_logs", { vserver, log: "php", host: "www.example.com" }, { expectError: true });
  await call("read_logs", { vserver, log: "access", host: "a;b" }, { expectError: true });
}

// Over SSH, only when asked: SMOKE_SSH_VSERVER=<webhosting this machine can SSH into>.
const sshVserver = process.env.SMOKE_SSH_VSERVER;
if (sshVserver) {
  const logs = JSON.parse(await call("read_logs", { vserver: sshVserver, log: "access", lines: 3 }));
  check(Array.isArray(logs.lines) && logs.lines.length <= 3, "read_logs returns at most `lines` lines");
  const inj = JSON.parse(await call("read_logs", { vserver: sshVserver, log: "access", contains: "'; echo INJECTED #$(id)", lines: 5 }));
  check(!inj.lines.some((l) => l.includes("INJECTED") || l.includes("uid=")), "read_logs: filter text is matched literally, not run");
  await call("read_logs", { vserver: sshVserver, log: "pm2" });
}

await call("find_endpoints", { query: "redis" });
const desc = JSON.parse(await call("describe_endpoint", { path: "/dns/example.com/srv", method: "POST" }));
check(desc.path === "/dns/{service_name}/srv" && "port" in (desc.methods.POST.request_body ?? {}), "describe_endpoint resolves a concrete path and allOf body");
await call("describe_endpoint", { path: "/nope" }, { expectError: true });
await call("zone_api_request", { method: "GET", path: "/domain", limit: 1 });
await call("zone_api_request", { method: "GET", path: "/../evil" }, { expectError: true });
await call("zone_api_request", { method: "GET", path: "https://example.com/domain" }, { expectError: true });
await call("zone_api_request", { method: "GET", path: "/dns/%2e%2e/a" }, { expectError: true });
await client.close();

// Confirmation flow with a client that can show forms.
if (zone) {
  let prompts = 0;
  const decliner = await connect("zone-smoke-decline", {
    elicit: async () => (prompts++, { action: "decline" }),
  });
  const r1 = JSON.parse(await caller(decliner)("zone_api_request", { method: "DELETE", path: `/dns/${zone}/txt/0` }));
  check(prompts === 1 && r1.status === "declined", "declined confirmation: status 'declined', request not sent");
  const r2 = JSON.parse(await caller(decliner)("delete_dns_record", { zone, type: "txt", id: "0" }));
  check(prompts === 2 && r2.status === "declined", "delete_dns_record declined");
  await decliner.close();

  let lastPrompt = "";
  const accepter = await connect("zone-smoke-accept", {
    elicit: async (req) => {
      lastPrompt = req.params.message;
      console.log("  prompt:", lastPrompt.replace(/\s+/g, " "));
      return { action: "accept", content: { confirm: true } };
    },
  });
  // Accepted, so it reaches the API: record id 0 does not exist, so this must be a 404 and nothing is deleted.
  const r3 = await caller(accepter)("delete_dns_record", { zone, type: "txt", id: "0" }, { expectError: true });
  check(r3.includes("404"), "accepted confirmation reaches the API (404 for a nonexistent record)");
  check(lastPrompt.includes("record 0"), "confirmation for an unknown id names the id, not some other record");
  await accepter.close();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
