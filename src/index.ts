#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ZoneClient } from "./client.js";
import { registerTools } from "./tools.js";

const { version, description } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  description: string;
};

// Inlined as a data: URI so it works over stdio, where the client cannot fetch a relative path.
const icon = {
  src: `data:image/svg+xml;base64,${readFileSync(new URL("../assets/icon.svg", import.meta.url)).toString("base64")}`,
  mimeType: "image/svg+xml",
  sizes: ["any"],
};

const HOUR = 3_600_000;

const client = new ZoneClient({
  username: process.env.ZONE_USERNAME,
  token: process.env.ZONE_API_TOKEN,
  baseUrl: process.env.ZONE_API_URL,
  keychainService: process.env.ZONE_KEYCHAIN_SERVICE,
  userAgent: `zone-mcp/${version}`,
});

const handle = serveStdio(
  () => {
    const server = new McpServer(
      {
        name: "zone",
        title: "Zone.ee",
        version,
        description,
        websiteUrl: "https://github.com/aanndryyyy/zone-mcp",
        icons: [icon],
      },
      {
        capabilities: { tools: {} },
        // The tool list is static for the life of the process and holds no per-user data.
        cacheHints: {
          "tools/list": { ttlMs: HOUR, cacheScope: "public" },
          "server/discover": { ttlMs: HOUR, cacheScope: "public" },
        },
        instructions:
          "Tools for a Zone.ee (zone.eu) hosting account via the ZoneID API v2. Start with list_domains or " +
          "list_webhostings; a webhosting's `name` is the `vserver` argument for the mail/MySQL/cron/SSL tools. " +
          "DNS record names are FQDNs; get a record's `id` from list_dns_records before updating or deleting it. " +
          "For anything without a dedicated tool: find_endpoints → describe_endpoint → zone_api_request. " +
          "The API allows 60 requests/min per IP, so don't poll. DNSSEC activation and DNS TTLs can't be changed " +
          "through the API (use https://my.zone.eu).",
      },
    );
    registerTools(server, client);
    return server;
  },
  { onerror: (err) => console.error("[zone-mcp]", err) },
);

client.credentials().then(
  ({ source }) => console.error(`[zone-mcp] using credentials from ${source}`),
  (err) => console.error(`[zone-mcp] ${(err as Error).message}`),
);

const shutdown = () => {
  void handle.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
