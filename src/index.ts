#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { setupLogging, log, logError } from "./logging.js";

// Setup logging FIRST - before anything else
setupLogging();

// Global error handlers - CRITICAL for stability
// These prevent unhandled errors from crashing the process
process.on('uncaughtException', (error: Error) => {
  logError(error, 'UNCAUGHT EXCEPTION - Server will attempt to continue');
  // Don't exit - try to keep server running
  // The MCP connection may recover
});

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logError(error, 'UNHANDLED PROMISE REJECTION - Server will continue');
  // Don't exit - try to keep server running
});

// Handle termination signals gracefully
process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down gracefully', 'info');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT, shutting down gracefully', 'info');
  process.exit(0);
});

// Log startup info
log(`Semantic Analysis MCP Server starting...`, 'info', {
  nodeVersion: process.version,
  platform: process.platform,
  pid: process.pid,
  cwd: process.cwd(),
});

// Run the server
async function runServer() {
  try {
    log("Initializing MCP server...", "info");

    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);

    server.sendLoggingMessage({
      level: "info",
      data: "Semantic Analysis MCP server is ready to accept requests",
    });

    log("Server connected and ready", "info");
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    log(`Failed to start server: ${errorMsg}`, "error", { stack });
    console.error(errorMsg);
    process.exit(1);
  }
}

runServer().catch((error) => {
  const errorMsg = error instanceof Error ? error.message : String(error);
  logError(error instanceof Error ? error : new Error(errorMsg), 'Server startup failed');
  console.error(errorMsg);
  process.exit(1);
});