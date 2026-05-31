#!/usr/bin/env node
/**
 * Phase 42 Plan 07 — Qdrant rebuild from migrated km-core store.
 *
 * Invokes km-core's syncQdrantFromStore against
 * .data/knowledge-graph-migrated/leveldb/ and upserts every entity with a
 * non-empty embedding into the supplied Qdrant collection (default
 * 'kg_entities'). Idempotent — re-running overwrites the same point IDs.
 *
 * Usage (inside the coding-services container):
 *
 *   node /coding/integrations/mcp-server-semantic-analysis/scripts/42-07-sync-qdrant.mjs \
 *     [--collection=kg_entities] [--qdrant-url=http://coding-qdrant:6333] \
 *     [--data-dir=/coding/.data/knowledge-graph-migrated/leveldb] \
 *     [--ontology-dir=/coding/.data/ontologies] \
 *     [--batch=100]
 *
 * Emits before/after collection counts on stderr; result JSON on stdout.
 * Exit 0 on success; exit 1 if any batch failed (errors[] non-empty).
 */

import { GraphKMStore, syncQdrantFromStore } from '@fwornle/km-core';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
  }),
);

const COLLECTION = args.collection || 'kg_entities';
const QDRANT_URL = args['qdrant-url'] || process.env.QDRANT_URL || 'http://coding-qdrant:6333';
const DATA_DIR = args['data-dir'] || '/coding/.data/knowledge-graph-migrated/leveldb';
const ONTOLOGY_DIR = args['ontology-dir'] || '/coding/.data/ontologies';
const BATCH = parseInt(args.batch || '100', 10);

function diag(msg) {
  process.stderr.write(`[42-07-sync-qdrant] ${msg}\n`);
}

async function qdrantCount(collection) {
  try {
    const res = await fetch(`${QDRANT_URL}/collections/${collection}`);
    if (!res.ok) return null;
    const body = await res.json();
    return body?.result?.points_count ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const before = await qdrantCount(COLLECTION);
  diag(`baseline: ${COLLECTION} has ${before ?? 'unknown'} points`);

  const store = new GraphKMStore({
    dbPath: DATA_DIR,
    exportDir: DATA_DIR.replace(/leveldb$/, 'exports'),
    ontologyDir: ONTOLOGY_DIR,
    domains: ['coding'],
    debounceMs: 5000,
  });
  await store.open();

  // Wrap the REST API into km-core's structural QdrantClient interface.
  const qdrantClient = {
    upsert: async (collection, points) => {
      const res = await fetch(`${QDRANT_URL}/collections/${collection}/points?wait=true`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '<unreadable>');
        throw new Error(`Qdrant upsert HTTP ${res.status}: ${text.slice(0, 400)}`);
      }
    },
  };

  let result;
  try {
    result = await syncQdrantFromStore(store, {
      qdrantClient,
      collection: COLLECTION,
      batchSize: BATCH,
      log: (event) => {
        if (event.phase === 'batch') {
          diag(`batch ok: +${event.count} (cumulative=${event.cumulative})`);
        } else if (event.phase === 'error') {
          diag(`batch ERROR (${event.count}): ${event.message}`);
        }
      },
    });
  } finally {
    try {
      await store.close();
    } catch {
      /* ignore */
    }
  }

  const after = await qdrantCount(COLLECTION);
  diag(`final: ${COLLECTION} has ${after ?? 'unknown'} points`);

  process.stdout.write(
    JSON.stringify(
      {
        collection: COLLECTION,
        beforeCount: before,
        afterCount: after,
        syncedCount: result.syncedCount,
        skippedCount: result.skippedCount,
        errorCount: result.errors.length,
        errorsSample: result.errors.slice(0, 5),
        runAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );

  process.exit(result.errors.length === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(
    `[42-07-sync-qdrant] FATAL: ${err instanceof Error ? err.stack || err.message : String(err)}\n`,
  );
  process.exit(2);
});
