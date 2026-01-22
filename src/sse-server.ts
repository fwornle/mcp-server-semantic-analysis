#!/usr/bin/env node
/**
 * SSE-based MCP server for semantic-analysis
 *
 * This server runs as a single persistent process that multiple Claude Code sessions
 * can connect to via HTTP/SSE transport. Designed for containerized deployments.
 */

import express from 'express';
import type { Request, Response } from 'express';
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer } from "./server.js";
import { log, logError } from "./logging.js";
import { setServerInstance } from "./tools.js";

const PORT = parseInt(process.env.SEMANTIC_ANALYSIS_PORT || '3848', 10);

// Express app with SSE transport
const app = express();
app.use(express.json());

// Store transports by session ID
const transports: Record<string, SSEServerTransport> = {};

// Store heartbeat intervals by session ID
const heartbeatIntervals: Record<string, NodeJS.Timeout> = {};

// Heartbeat interval in milliseconds (15 seconds)
const HEARTBEAT_INTERVAL_MS = 15000;

// Server startup time for uptime tracking
const serverStartTime = Date.now();

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'semantic-analysis',
    sessions: Object.keys(transports).length,
    activeHeartbeats: Object.keys(heartbeatIntervals).length,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    uptime: Math.floor((Date.now() - serverStartTime) / 1000),
  });
});

// SSE endpoint for establishing the stream
app.get('/sse', async (_req: Request, res: Response) => {
  log(`New SSE connection request`, "info");
  try {
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    transports[sessionId] = transport;

    // Set up heartbeat to keep SSE connection alive
    const heartbeatInterval = setInterval(() => {
      try {
        // Check if response is still writable before sending heartbeat
        if (!res.writableEnded && !res.destroyed) {
          res.write(`:heartbeat ${Date.now()}\n\n`);
        } else {
          // Connection is closed, clean up
          clearInterval(heartbeatInterval);
          delete heartbeatIntervals[sessionId];
        }
      } catch (error) {
        // Connection likely closed, clean up
        clearInterval(heartbeatInterval);
        delete heartbeatIntervals[sessionId];
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatIntervals[sessionId] = heartbeatInterval;

    transport.onclose = () => {
      log(`SSE transport closed for session ${sessionId}`, "info");
      // Clean up heartbeat interval
      if (heartbeatIntervals[sessionId]) {
        clearInterval(heartbeatIntervals[sessionId]);
        delete heartbeatIntervals[sessionId];
      }
      delete transports[sessionId];
    };

    // Also clean up on response close (handles client disconnect)
    res.on('close', () => {
      if (heartbeatIntervals[sessionId]) {
        clearInterval(heartbeatIntervals[sessionId]);
        delete heartbeatIntervals[sessionId];
      }
    });

    const server = createServer();
    await server.connect(transport);

    // Set the server instance for tools to send progress updates
    setServerInstance(server);

    log(`Established SSE stream with session ID: ${sessionId}`, "info");
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Error establishing SSE stream: ${errorMsg}`, "error");
    if (!res.headersSent) {
      res.status(500).send('Error establishing SSE stream');
    }
  }
});

// Messages endpoint for receiving client JSON-RPC requests
app.post('/messages', async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) {
    res.status(400).send('Missing sessionId parameter');
    return;
  }

  const transport = transports[sessionId];
  if (!transport) {
    log(`No active transport found for session ID: ${sessionId}`, "error");
    res.status(404).send('Session not found');
    return;
  }

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Error handling request: ${errorMsg}`, "error");
    if (!res.headersSent) {
      res.status(500).send('Error handling request');
    }
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Semantic Analysis SSE Server listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
});

// Handle shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  // Clean up all heartbeat intervals
  for (const sessionId in heartbeatIntervals) {
    clearInterval(heartbeatIntervals[sessionId]);
    delete heartbeatIntervals[sessionId];
  }
  // Close all transports
  for (const sessionId in transports) {
    try {
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (error) {
      console.error(`Error closing transport for session ${sessionId}:`, error);
    }
  }
  console.log('Server shutdown complete');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down...');
  // Clean up all heartbeat intervals
  for (const sessionId in heartbeatIntervals) {
    clearInterval(heartbeatIntervals[sessionId]);
    delete heartbeatIntervals[sessionId];
  }
  // Close all transports
  for (const sessionId in transports) {
    try {
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (error) {
      console.error(`Error closing transport for session ${sessionId}:`, error);
    }
  }
  process.exit(0);
});
