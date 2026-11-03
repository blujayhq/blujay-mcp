#!/usr/bin/env node
// blujay-mcp: run Blujay as an MCP server over stdio.
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BlujayClient } from "blujay";

import { createBlujayMcpServer, VERSION } from "./server.js";

const HELP = `blujay-mcp ${VERSION}: Blujay for Claude, Cursor and other MCP clients.

Usage: npx -y blujay-mcp [options]

Environment:
  BLUJAY_API_KEY              Your API key, from API in the Blujay sidebar (required)

Options:
  --read-only                 Only reading tools: nothing can be sent, changed or deleted
  --allow-send-to <numbers>   Only text, react to or otherwise reach these numbers
                              (comma-separated), for safe testing
  --enable-invoke-api         Add invoke_api, which can call any Blujay endpoint
  --help, --version
`;

function main(): void {
    let parsed;
    try {
        parsed = parseArgs({
        options: {
            "read-only": { type: "boolean", default: false },
            "allow-send-to": { type: "string" },
            "enable-invoke-api": { type: "boolean", default: false },
            help: { type: "boolean", default: false },
            version: { type: "boolean", default: false },
        },
        strict: true,
        });
    } catch (error) {
        process.stderr.write(`blujay-mcp: ${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
        process.exit(1);
    }
    const { values } = parsed;
    if (values.help) {
        process.stdout.write(HELP);
        return;
    }
    if (values.version) {
        process.stdout.write(`${VERSION}\n`);
        return;
    }
    const apiKey = process.env.BLUJAY_API_KEY;
    if (!apiKey) {
        process.stderr.write("blujay-mcp: set BLUJAY_API_KEY to your API key, from API in the Blujay sidebar.\n");
        process.exit(1);
    }

    const allowSendTo = values["allow-send-to"]
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    if (allowSendTo && allowSendTo.length === 0) {
        // An empty value (often an unset variable) must never turn the limit off.
        process.stderr.write("blujay-mcp: --allow-send-to is empty. List at least one number, or remove the option.\n");
        process.exit(1);
    }
    const server = createBlujayMcpServer({
        client: new BlujayClient({
            apiKey,
            ...(process.env.BLUJAY_BASE_URL ? { baseUrl: process.env.BLUJAY_BASE_URL } : {}),
        }),
        readOnly: values["read-only"],
        allowSendTo: allowSendTo ?? null,
        enableInvokeApi: values["enable-invoke-api"],
    });
    // stdout carries the MCP protocol; anything else goes to stderr.
    server.connect(new StdioServerTransport()).catch((error: unknown) => {
        process.stderr.write(`blujay-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    });
}

main();
