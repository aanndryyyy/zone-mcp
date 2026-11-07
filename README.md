<img src="assets/icon.svg" width="64" height="64" alt="">

# zone-mcp

An [MCP](https://modelcontextprotocol.io) server for [Zone.ee](https://www.zone.ee) / Zone.eu hosting, built on the [ZoneID API v2](https://api.zone.eu/v2).
Use it from Claude or any other MCP client to manage domains, DNS records, mail forwarders and webhosting. A generic, spec-aware request tool covers the rest of the API: mailboxes, MySQL, cron, SSH, FTP, Redis, PM2 and cloud VPS.

- Built on the **MCP TypeScript SDK v2** (`@modelcontextprotocol/server`). It serves the **2026-07-28** protocol revision and still works with clients on the 2025 revisions.
- Uses the stdio transport. It needs Node.js 20 or newer.

## Tools

| Tool | What it does |
| --- | --- |
| `list_domains` / `get_domain` | Domains on the account (filters, sorting, paging), or one domain with its nameservers |
| `list_webhostings` / `get_server_info` | Webhosting packages and their usage, or a server's IPs, paths and hostnames |
| `list_dns_records` | Records of one type, or of every type, optionally filtered by name |
| `create_dns_record` / `update_dns_record` / `delete_dns_record` | Manage A, AAAA, CNAME, MX, TXT, NS, SRV, CAA, TLSA, SSHFP and URL records |
| `list_mail_accounts` / `list_mail_forwarders` | Mailboxes and forwarders on a webhosting |
| `create_mail_forwarder` / `update_mail_forwarder` / `delete_mail_forwarder` | Manage forwarders (aliases) |
| `list_mysql` | MySQL databases and database users |
| `list_cron_jobs` / `list_ssl_certificates` | Cron jobs and SSL certificates. Private keys are never returned |
| `find_endpoints` / `describe_endpoint` | Search the bundled OpenAPI spec, and show an endpoint's parameters and body fields |
| `zone_api_request` | Call any ZoneID API endpoint. POST, PUT and DELETE ask you to confirm first |

## Setup

1. Create an API token at [my.zone.eu](https://my.zone.eu) → Settings → Security → API keys. It is shown only once.
2. Give the server your ZoneID username and token. Use **either** option below.

**Option A: macOS Keychain (recommended on a Mac).** The token never appears in a config file.

```bash
security add-generic-password -U -s zone-ee-api -a <your ZoneID username> -w
# paste the token at the prompt
claude mcp add -s user zone -- npx -y github:aanndryyyy/zone-mcp
```

**Option B: environment variables.**

```bash
claude mcp add -s user zone -e ZONE_USERNAME=<username> -e ZONE_API_TOKEN=<token> -- npx -y github:aanndryyyy/zone-mcp
```

**Claude Desktop, Cursor, and other clients using `mcpServers` JSON**

```json
{
  "mcpServers": {
    "zone": {
      "command": "npx",
      "args": ["-y", "github:aanndryyyy/zone-mcp"],
      "env": { "ZONE_USERNAME": "<username>", "ZONE_API_TOKEN": "<token>" }
    }
  }
}
```

If you stored the credentials in the Keychain, leave out the `env` block.

**From a local clone**

```bash
git clone https://github.com/aanndryyyy/zone-mcp.git
cd zone-mcp && npm install   # builds dist/ automatically
claude mcp add -s user zone -- node "$PWD/dist/index.js"
```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ZONE_USERNAME` | – | ZoneID username |
| `ZONE_API_TOKEN` | – | ZoneID API token |
| `ZONE_KEYCHAIN_SERVICE` | `zone-ee-api` | macOS Keychain service the server reads when the two variables above are not set |
| `ZONE_API_URL` | `https://api.zone.eu/v2` | Override the API base URL |

## Example prompts

- "Which of my domains expire in the next 30 days?"
- "Show the MX and TXT records for example.com."
- "Add a TXT record `_acme-challenge.example.com` with value `abc123`."
- "Point www.example.com at 192.0.2.10."
- "Forward info@example.com to me@example.org."
- "Create a daily 03:00 cron job on example.com that runs `php artisan schedule:run`." (This one uses `describe_endpoint`, then `zone_api_request`.)

## Notes

- **Confirmation before writes.** If your client supports form elicitation, the server asks you to confirm before it runs `update_*`, `delete_*`, or a POST, PUT or DELETE through `zone_api_request`. The prompt shows the old and new values, or the method, path and body. If you decline, nothing is sent and the tool returns `status: "declined"` (or `"cancelled"` if you dismissed the prompt). The confirmation is bound to the exact arguments with a signed `requestState`, so a client cannot answer it in advance or reuse it for other arguments. Clients without form elicitation skip this step and rely on their own tool-approval prompt. Create tools rely on the client's own tool approval.
- **DNS names are FQDNs.** Zone stores record names as `www.example.com`. The DNS tools accept `@`, a bare label (`www`), or the FQDN, and convert it. `update_dns_record` changes only the fields you pass.
- **Not available through the API:** DNS TTLs (Zone manages them) and DNSSEC activation. Use [my.zone.eu](https://my.zone.eu) for these.
- **Rate limit.** The API allows 60 requests/min per IP. `list_dns_records` without `type` uses 11 requests, one per record type. A `429` comes back as a tool error.
- **Paid operations.** Some endpoints reachable through `zone_api_request` cost money, for example `/order/domain/renew`, `/order/cloud` and billing resources.
- **Structured output.** Every tool declares an `outputSchema` and returns `structuredContent`, with the same JSON as text. The API always returns arrays, so list tools return objects such as `{ domains, pager }`. `resource_url` and `_links` are removed to save tokens.
- **Path safety.** `zone_api_request` accepts only paths under `https://api.zone.eu/v2` and does not follow redirects, so your credentials are never sent to another host.
- The OpenAPI spec in `spec/openapi.json` is Zone's public [API reference](https://api.zone.eu/v2), bundled so the server can work offline.

## Development

```bash
npm install
npm run build
npx @modelcontextprotocol/inspector node dist/index.js   # interactive testing

# End-to-end smoke test against your live account. It's read-only: the only write is a DELETE of a record id that
# doesn't exist. It uses about 30 requests, so wait a minute between runs.
npm test                    # 2026-07-28 protocol
PROTOCOL=legacy npm test    # 2025-era protocol
```

## License

MIT. Not affiliated with Zone Media OÜ.
