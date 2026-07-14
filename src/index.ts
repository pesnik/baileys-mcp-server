#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BaileysClient } from "./baileys-client.js";
import { registerTools } from "./tools.js";

const AUTH_DIR = process.env.WA_AUTH_DIR || "./wa-auth";
const client = new BaileysClient(AUTH_DIR);

client.on("connected", (data) => {
  console.error(`WhatsApp connected: ${(data as any).phone}`);
});

client.on("disconnected", () => {
  console.error("WhatsApp disconnected");
});

const server = new McpServer({
  name: "baileys-mcp-server",
  version: "1.0.0",
});

registerTools(server, client);

async function main() {
  client.connect().catch((err) => {
    console.error("Failed to connect Baileys:", err);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Baileys MCP server running via stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
