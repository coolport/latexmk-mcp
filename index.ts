#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "latexmk-mcp", version: "1.0.0" },
  { 
    capabilities: { tools: {} },
    instructions: "Compile and manage LaTeX documents." 
  }
);

// Start with an empty tool list
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: []
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return {
    content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
    isError: true,
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("latexmk MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
