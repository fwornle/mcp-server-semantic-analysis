#!/usr/bin/env node
/**
 * SSE-based MCP server for semantic-analysis
 *
 * This server runs as a single persistent process that multiple Claude Code sessions
 * can connect to via HTTP/SSE transport. Designed for containerized deployments.
 */

import express, { Router } from 'express';
import type { Request, Response } from 'express';
import path from 'node:path';
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createKmCoreRouter, GraphKMStore } from '@fwornle/km-core';
import { createServer } from "./server.js";
import { log, logError } from "./logging.js";
import { setServerInstance } from "./tools.js";
import { createSSEBroadcaster } from "./workflow-sse-broadcaster.js";
import { subscribe, getState } from "./workflow-state-machine.js";

const PORT = parseInt(process.env.SEMANTIC_ANALYSIS_PORT || '3848', 10);

// Express app with SSE transport
const app = express();

// CORS middleware — required by browser clients consuming the km-core /api/v1
// REST mount and the /workflow-events SSE endpoint from a different origin
// (Vite dev server at :5173, system-health-dashboard at :3032, browser direct
// access at :3848). Without these headers the browser blocks the response per
// the same-origin policy even when the request succeeds server-side.
// Pre-route placement: must run before app.use(express.json()) so OPTIONS
// preflight requests (which have no body) short-circuit without touching the
// JSON parser.
app.use((req: Request, res: Response, next: express.NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json());

// ---------------------------------------------------------------------------
// Phase 44 Plan 08: km-core /api/v1 REST mount (same-port strategy)
//
// Mount the canonical /api/v1 surface alongside the existing SSE routes
// (/health, /sse, /workflow-events, /messages). km-core ships
// `createKmCoreRouter` as the framework-agnostic factory (44-CONTEXT R-1/R-2);
// consumer constructs its own express Router and attaches it.
//
// Hydration gate (44-RESEARCH Open Q5): 503-until-ready middleware mirrors
// A's pattern (`scripts/observations-api-server.mjs:1178-1183`), so requests
// hitting /api/v1/* before the kmStore finishes opening get a typed error
// instead of crashing.
//
// Restart command: snapshot/restore returns `restartRequired: true` per
// CONTEXT S-2 (no in-process restart — SSE long-lived connections must not
// be killed by snapshot restore). Operator restarts the container via the
// documented `docker-compose restart coding-services` command.
//
// CLAUDE.md mandatory rule: km-core construction MUST pass `ontologyDir`,
// otherwise default-class resolution throws
// `opts.classes omitted but store has no ontology registry`. Paths follow
// the canonical wave-controller convention (.data/knowledge-graph/{leveldb,
// exports} + .data/ontologies inside the container at /coding/).
// ---------------------------------------------------------------------------
const REPOSITORY_PATH = process.env.REPOSITORY_PATH || '/coding';
const kmStore = new GraphKMStore({
  dbPath: path.join(REPOSITORY_PATH, '.data', 'knowledge-graph', 'leveldb'),
  exportDir: path.join(REPOSITORY_PATH, '.data', 'knowledge-graph', 'exports'),
  ontologyDir: path.join(REPOSITORY_PATH, '.data', 'ontologies'),
  domains: ['coding'],
  debounceMs: 5000,
});
let kmStoreReady = false;

const kmRouter = Router();
kmRouter.use((_req: Request, res: Response, next: express.NextFunction) => {
  // 44-RESEARCH Open Q5 + Pitfall 4: gate behind store-open + presence of
  // the in-memory graph. `kmStore.graph` is the durable indicator that
  // `open()` has finished hydrating from LevelDB/JSON; combined with the
  // local `kmStoreReady` flag flipped after `await kmStore.open()`.
  if (!kmStoreReady || !(kmStore as unknown as { graph?: unknown }).graph) {
    res.status(503).json({ error: 'Knowledge graph store not ready' });
    return;
  }
  next();
});
// km-core's RouterLike declares handler params as `never` (an over-restrictive
// contravariant shape that makes the express.Router type technically incompatible
// at the TS-checker level even though the runtime contract is identical).
// Cast through unknown to bridge the two -- functionally a no-op, declaratively
// satisfies the framework-agnostic Router contract.
createKmCoreRouter(kmStore, kmRouter as unknown as Parameters<typeof createKmCoreRouter>[1], {
  ontologyRegistry: kmStore.ontology,
  snapshotDir: path.join(REPOSITORY_PATH, '.data', 'knowledge-graph', 'exports'),
  restartCommand: 'docker-compose restart coding-services',
});
app.use('/api/v1', kmRouter);
process.stderr.write('[sse-server] km-core /api/v1 routes mounted on port ' + PORT + '\n');

// Store transports by session ID
const transports: Record<string, SSEServerTransport> = {};

// Store heartbeat intervals by session ID
const heartbeatIntervals: Record<string, NodeJS.Timeout> = {};

// Heartbeat interval in milliseconds (15 seconds)
const HEARTBEAT_INTERVAL_MS = 15000;

// Server startup time for uptime tracking
const serverStartTime = Date.now();

// Workflow state event broadcaster -- subscribes to state machine transitions
const broadcaster = createSSEBroadcaster();
subscribe(broadcaster.subscriber.bind(broadcaster));

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'semantic-analysis',
    sessions: Object.keys(transports).length,
    activeHeartbeats: Object.keys(heartbeatIntervals).length,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    uptime: Math.floor((Date.now() - serverStartTime) / 1000),
    workflowEventClients: broadcaster.clientCount,
  });
});

// Workflow state event SSE endpoint -- typed state snapshots on every transition
app.get('/workflow-events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Add client -- broadcaster sends initial-state event with current WorkflowState
  broadcaster.addClient(res, getState());

  // Heartbeat every 15s to keep connection alive
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(': heartbeat\n\n');
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    broadcaster.removeClient(res);
  });

  log('New workflow-events SSE client connected', 'info');
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

// Start server -- km-core store opens FIRST so the /api/v1 mount is
// usable as soon as `listen` accepts connections. Per CLAUDE.md mandatory
// rule: `ontologyDir` is required (set above) and `open()` hydrates the
// in-memory graph from LevelDB (or JSON fallback per Phase 37 D-22).
(async () => {
  try {
    await kmStore.open();
    kmStoreReady = true;
    log('[sse-server] km-core GraphKMStore opened (REST /api/v1 ready)', 'info');
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`[sse-server] km-core GraphKMStore open failed: ${errorMsg}`, 'error');
    // Continue serving SSE even if km-core fails -- the 503 gate keeps
    // /api/v1/* requests safe until an operator fixes the underlying issue.
  }

  app.listen(PORT, () => {
    log(`Semantic Analysis SSE Server listening on port ${PORT}`, 'info');
    log(`Health check: http://localhost:${PORT}/health`, 'info');
    log(`SSE endpoint: http://localhost:${PORT}/sse`, 'info');
    log(`Workflow events: http://localhost:${PORT}/workflow-events`, 'info');
    log(`km-core REST: http://localhost:${PORT}/api/v1/stats`, 'info');
  });
})();

// Handle shutdown
process.on('SIGINT', async () => {
  log('Shutting down server...', 'info');
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
      log(`Error closing transport for session ${sessionId}`, 'error', error);
    }
  }
  log('Server shutdown complete', 'info');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log('Received SIGTERM, shutting down...', 'info');
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
      log(`Error closing transport for session ${sessionId}`, 'error', error);
    }
  }
  process.exit(0);
});
