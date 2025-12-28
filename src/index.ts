#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { setupLogging, log, logError } from "./logging.js";
import { setServerInstance } from "./tools.js";

// Setup logging FIRST - before anything else
setupLogging();

// Track server state for graceful shutdown
let isShuttingDown = false;
let server: ReturnType<typeof createServer> | null = null;
let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
const serverStartTime = Date.now();

// Keepalive interval in ms - sends periodic messages to prevent connection timeout
// Claude Code may close idle connections; this keeps the connection active
const KEEPALIVE_INTERVAL_MS = 30000; // 30 seconds

// Graceful shutdown handler
async function gracefulShutdown(reason: string) {
  if (isShuttingDown) {
    log(`Shutdown already in progress, ignoring: ${reason}`, 'info');
    return;
  }
  isShuttingDown = true;
  log(`Initiating graceful shutdown: ${reason}`, 'info');

  // Clear keepalive interval
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }

  // Give pending operations a moment to complete
  await new Promise(resolve => setTimeout(resolve, 100));

  log('Shutdown complete', 'info');
  process.exit(0);
}

// Global error handlers - CRITICAL for stability
// These prevent unhandled errors from crashing the process
process.on('uncaughtException', (error: Error) => {
  logError(error, 'UNCAUGHT EXCEPTION - Server will attempt to continue');
  // Don't exit - try to keep server running
  // The MCP connection may recover
});

process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logError(error, 'UNHANDLED PROMISE REJECTION - Server will continue');
  // Don't exit - try to keep server running
});

// Handle termination signals gracefully
process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM received');
});

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT received');
});

// CRITICAL: Handle stdin close/end events
// The MCP SDK's StdioServerTransport doesn't handle these, causing silent disconnections
process.stdin.on('end', () => {
  log('stdin ended (parent process closed pipe)', 'info');
  gracefulShutdown('stdin end');
});

process.stdin.on('close', () => {
  log('stdin closed', 'info');
  gracefulShutdown('stdin close');
});

// Handle stdout errors (e.g., broken pipe)
process.stdout.on('error', (error) => {
  log(`stdout error: ${error.message}`, 'error');
  gracefulShutdown('stdout error');
});

// Handle process 'beforeExit' to log unexpected exits
process.on('beforeExit', (code) => {
  log(`Process beforeExit with code: ${code}`, 'info');
});

// Handle process 'exit' to ensure final logging
process.on('exit', (code) => {
  // Note: only synchronous operations work here
  console.error(`[${new Date().toISOString()}] Process exiting with code: ${code}`);
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

    server = createServer();
    const transport = new StdioServerTransport();

    // Set up transport close handler
    // Note: This is called when the MCP protocol layer detects a close
    const originalOnclose = transport.onclose;
    transport.onclose = () => {
      log('Transport onclose called - MCP connection closed', 'info');
      if (originalOnclose) originalOnclose();
      gracefulShutdown('transport close');
    };

    // Set up transport error handler
    const originalOnerror = transport.onerror;
    transport.onerror = (error) => {
      log(`Transport error: ${error.message}`, 'error');
      if (originalOnerror) originalOnerror(error);
    };

    await server.connect(transport);

    // Set the server instance for tools to send progress updates
    setServerInstance(server);

    // Set up server-level close and error handlers
    server.onclose = () => {
      log('Server onclose called - connection closed by protocol layer', 'info');
      gracefulShutdown('server close');
    };

    server.onerror = (error) => {
      logError(error, 'Server protocol error');
      // Don't shutdown on protocol errors - let the MCP SDK handle recovery
    };

    server.sendLoggingMessage({
      level: "info",
      data: "Semantic Analysis MCP server is ready to accept requests",
    });

    log("Server connected and ready", "info");

    // Start keepalive interval to prevent connection timeout during idle periods
    // This sends periodic logging messages to keep the stdio connection active
    keepAliveInterval = setInterval(() => {
      if (server && !isShuttingDown) {
        try {
          server.sendLoggingMessage({
            level: "debug",
            data: `💗 keepalive (uptime: ${Math.floor((Date.now() - serverStartTime) / 1000)}s)`,
          });
        } catch (error) {
          // If we can't send, the connection is probably dead
          log(`Keepalive failed: ${error instanceof Error ? error.message : String(error)}`, 'warning');
        }
      }
    }, KEEPALIVE_INTERVAL_MS);

    log(`Keepalive started (interval: ${KEEPALIVE_INTERVAL_MS}ms)`, "info");

    // Keep the process alive - the event loop will handle incoming messages
    // We rely on stdin/stdout events to detect disconnection

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