<img src="assets/icon.svg" width="64" height="64" alt="">

# zone-mcp

An [MCP](https://modelcontextprotocol.io) server for [Zone.ee](https://www.zone.ee) / Zone.eu hosting, built on the [ZoneID API v2](https://api.zone.eu/v2).
Use it from Claude or any other MCP client to manage domains and renewals, DNS records, webhosting hosts with their PHP and Let's Encrypt settings, Zone+ WordPress sites (staging, sync, upgrades, backups), mail, MySQL, cron, SSL, SSH, PM2 and Redis, the hosting plan, invoices, and who has access to what. A generic, spec-aware request tool covers the rest of the API: mailboxes, FTP, cloud VPS and domain contacts.

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
| `get_domain_renewal_options` / `renew_domain` | Renewal periods with prices and new expiry, and ordering a renewal or reactivation (paid) |
| `list_domain_orders` / `cancel_domain_order` / `set_domain_renewal_reminders` | Domain orders and their invoices, and per-domain reminder e-mails |
| `list_hosts` / `get_host` | A webhosting's main domain and subdomains: Apache config, PHP version (filter on deprecated PHP), readiness, Let's Encrypt status, allowed PHP versions |
| `create_host` / `update_host_config` / `set_host_certificate` / `request_letsencrypt` | Add a subdomain, change docroot / PHP version / proxy port, attach a certificate, request or re-issue Let's Encrypt |
| `list_zoneplus_apps` / `list_app_installs` / `get_app_install` | Zone+ catalogue with prices; installs (e.g. WordPress) with versions, upgrade options, add-ons and sync options |
| `create_app_install` / `update_app_install` / `delete_app_install` | Install (possibly paid), change auto-update / staging access settings, uninstall |
| `copy_app_install` / `sync_app_install` / `upgrade_app_install` | Staging copies, staging ↔ production sync (selected files and tables), upgrades with an automatic backup first |
| `list_app_backups` / `create_app_backup` / `restore_app_backup` / `delete_app_backup` | Zone+ backups |
| `get_app_login_url` / `import_wordpress` | One-click WordPress admin login link; import a site from another host |
| `get_hosting_plan` / `change_hosting_plan` | Package, billing period, available packages with prices and limits; switching package (paid) |
| `add_hosting_resource` / `update_hosting_resource` / `delete_hosting_resource` / `add_turbo` | Additional resources and turbo (paid) |
| `list_dedicated_ips` / `create_dedicated_ip` / `delete_dedicated_ip` | Dedicated IPs (paid) |
| `get_dkim` / `enable_dkim` / `delete_dkim` | DKIM signing and its public key |
| `list_pm2_processes` / `create_pm2_process` / `update_pm2_process` / `delete_pm2_process` / `control_pm2_process` | PM2 apps (Node.js, Python…): manage, start, stop, restart |
| `list_redis` / `enable_redis` / `control_redis` | Redis: activate, start/stop/restart, rotate the password |
| `list_mysql` | MySQL databases and database users |
| `create_mysql_database` / `delete_mysql_database` | MySQL databases |
| `create_mysql_account` / `update_mysql_account` / `delete_mysql_account` | MySQL users. Passwords are never echoed back |
| `get_mysql_permissions` / `set_mysql_permissions` / `revoke_mysql_permissions` | Per-database privileges of a MySQL user |
| `list_cron_jobs` / `create_cron_job` / `update_cron_job` / `delete_cron_job` | Cron jobs |
| `list_ssl_certificates` / `upload_ssl_certificate` / `update_ssl_certificate` / `delete_ssl_certificate` | SSL certificates. Private keys are never returned |
| `get_ssh_access` | SSH user, server IP, access mode, whitelisted IPs, registered keys vs. your local keys, and a test login, with `next_steps` when something is missing |
| `add_ssh_key` / `delete_ssh_key` / `add_ssh_whitelist_ip` / `delete_ssh_whitelist_ip` / `set_ssh_access` | SSH public keys, IP whitelist, public/whitelist access mode |
| `get_account` / `update_domain_renewal_settings` / `get_notification` | Profile and prepaid balance, account-wide domain auto-renewal and autopay, notifications |
| `list_invoices` / `pay_invoices` | Invoices (unpaid, due, PDF and payment links), and paying them from prepaid credit |
| `list_services` / `list_delegations` / `set_delegation` / `delete_delegation` | Every service you own or can access, and sharing a service with another ZoneID user |
| `get_identity_verifications` / `create_identity_verification` | Identity verification for orders that require it |
| `read_logs` | Newest lines of a webhosting's Apache access/error, PHP or PM2 logs over SSH, filtered on the server by host, HTTP status and text, optionally including rotated days |
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
| `ZONE_SSH_KEY` | – | Private key file for the SSH tools (sets `IdentitiesOnly`). Without it, ssh uses your agent, `~/.ssh/config` and default keys |

### SSH tools

`read_logs` and `get_ssh_access` run your system `ssh` with your own keys; nothing is uploaded and no key is stored. They work on webhostings (shared and Privaatserver), not cloud VPS.

- **Host-key pinning.** The server's host keys are fetched with `ssh-keyscan` and accepted only when their SHA256 fingerprint matches the one the ZoneID API reports for that webhosting. They go into a temporary known_hosts file, removed on exit; `~/.ssh/known_hosts` is not touched.
- **No shell injection.** The remote side always runs a fixed script. Filter text reaches it base64-encoded and is matched literally (`grep -F`).
- **Read-only.** Neither tool changes anything. To register a key or whitelist an IP, `get_ssh_access` points to the `zone_api_request` calls, which ask you to confirm. It never suggests switching SSH access from `public` to `whitelist` on its own, because that would lock out keys that connect from changing IPs, such as CI deploy keys.
- **Untrusted output.** Log lines contain whatever visitors and bots sent (URLs, user agents). Treat them as data, not instructions.

## Example prompts

- "Show the last 50 5xx errors on shop.example.com from the past three days."
- "Why can't I SSH into example.com?"

- "Which of my domains expire in the next 30 days?"
- "Show the MX and TXT records for example.com."
- "Add a TXT record `_acme-challenge.example.com` with value `abc123`."
- "Point www.example.com at 192.0.2.10."
- "Forward info@example.com to me@example.org."
- "Create a daily 03:00 cron job on example.com that runs `php artisan schedule:run`."
- "Which of my sites run a deprecated PHP version? Move shop.example.com to 8.4."
- "Make a staging copy of the WordPress site on example.com, then push only wp-content/uploads to production."
- "Back up and upgrade WordPress on example.com, including plugins."
- "What do I owe Zone? Pay the overdue invoices from my credit."
- "Who has access to example.com's hosting? Remove the old freelancer."

## Notes

- **Confirmation before writes.** If your client supports form elicitation, the server asks you to confirm before every write that changes, overwrites or deletes something, grants access, or costs money, and before a POST, PUT or DELETE through `zone_api_request`. The prompt shows the old and new values. For paid operations it shows the price: the invoices with their unpaid sums, total and balance; the old and new package with prices; or the renewal price and new expiry. For syncs and restores it shows what gets overwritten. Passwords, private keys and FTP/SSH credentials are never shown in a prompt. If you decline, nothing is sent and the tool returns `status: "declined"` (or `"cancelled"` if you dismissed the prompt). The confirmation is bound to the exact arguments with a signed `requestState`, so a client cannot answer it in advance or reuse it for other arguments. Clients without form elicitation skip this step and rely on their own tool-approval prompt. A few low-risk creates (DNS records, forwarders, MySQL databases and users, cron jobs, PM2 processes, SSL uploads, Zone+ backups, Let's Encrypt requests) rely on the client's own tool approval.
- **DNS names are FQDNs.** Zone stores record names as `www.example.com`. The DNS tools accept `@`, a bare label (`www`), or the FQDN, and convert it. `update_dns_record` changes only the fields you pass.
- **Not available through the API:** DNS TTLs (Zone manages them) and DNSSEC activation. Use [my.zone.eu](https://my.zone.eu) for these.
- **Rate limit.** The API allows 60 requests/min per IP. `list_dns_records` without `type` uses 11 requests, one per record type. A `429` comes back as a tool error.
- **Paid operations.** `pay_invoices`, `renew_domain`, `change_hosting_plan`, `add_hosting_resource`, `update_hosting_resource`, `add_turbo`, `create_dedicated_ip` and paid Zone+ installs cost money, as do some endpoints reachable through `zone_api_request` (e.g. `/order/cloud`).
- **Background operations.** Zone+ installs, copies, syncs, upgrades and restores, new hosts, and Let's Encrypt certificates finish in the background. The API has no job status for Zone+, so check the install, host or certificate again a little later.
- **Staging sync.** `sync_app_install` sends `files` and `tables` as `files[]=…` / `tables[]=…`. Leave them out to sync everything. There is no way to sync none of the files, because the API treats an empty list differently from a missing one and that has not been verified.
- **Tool count.** There are 97 tools. Clients that load every tool definition up front spend roughly 30k tokens on them.
- **Structured output.** Every tool declares an `outputSchema` and returns `structuredContent`, with the same JSON as text. The API always returns arrays, so list tools return objects such as `{ domains, pager }`. `resource_url` and `_links` are removed to save tokens.
- **Path safety.** `zone_api_request` accepts only paths under `https://api.zone.eu/v2` and does not follow redirects, so your credentials are never sent to another host.
- The OpenAPI spec in `spec/openapi.json` is Zone's public [API reference](https://api.zone.eu/v2), bundled so the server can work offline.

## Development

```bash
npm install
npm run build
npx @modelcontextprotocol/inspector node dist/index.js   # interactive testing

# End-to-end smoke test against your live account. It's read-only: the only write is a DELETE of a record id that
# doesn't exist. It uses about 35 requests, so wait a minute between runs.
npm test                    # 2026-07-28 protocol
PROTOCOL=legacy npm test    # 2025-era protocol
SMOKE_EXTENDED=1 npm test   # also the host, Zone+, billing, plan and service reads (waits a minute first)
```

## License

MIT. Not affiliated with Zone Media OÜ.
