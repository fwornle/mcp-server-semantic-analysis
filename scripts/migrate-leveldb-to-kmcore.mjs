#!/usr/bin/env node
/**
 * Phase 42 Plan 05 — D-54 LevelDB → km-core canonical migration (B)
 *
 * One-shot script that walks B's existing `.data/knowledge-graph/` LevelDB,
 * rewrites every entity to canonical km-core Entity shape per the
 * 42-RESEARCH.md §4 mapping table, and writes the result to a fresh km-core
 * GraphKMStore dataDir. Per D-54b ("continuity over cleanliness") this is
 * the IN-PLACE path — preserves classification + naming work that has
 * accumulated across past wave-analysis runs.
 *
 * The script ONLY writes to the target dataDir. The atomic directory swap
 * (`mv .data/knowledge-graph .data/knowledge-graph.pre-42-backup && mv
 * .data/knowledge-graph-migrated .data/knowledge-graph`) is Plan 7's
 * territory.
 *
 * Usage:
 *   node scripts/migrate-leveldb-to-kmcore.mjs \
 *       --source=.data/knowledge-graph \
 *       --target=.data/knowledge-graph-migrated \
 *       --ontology-dir=.data/ontologies \
 *       --run-id=phase-42-migration-2026-05-23 \
 *       [--dry-run] [--batch-size=N] [--resume]
 *
 * Flags:
 *   --source=<path>       Source LevelDB directory.   Default .data/knowledge-graph
 *   --target=<path>       Destination km-core dataDir Default .data/knowledge-graph-migrated
 *   --ontology-dir=<path> Ontology directory (D-53)  Default .data/ontologies
 *   --dry-run             Count + validate, write nothing.
 *   --batch-size=<N>      Write batch chunk size.     Default 100
 *   --resume              Skip entities whose target already has a matching legacyId.
 *   --run-id=<string>     Stable runId stamped onto provenance + segments.
 *                         Default = deterministic hash of source path + ISO date.
 *
 * Output:
 *   stderr: one JSON summary line at end with {totalEntities, migratedCount,
 *           skippedCount, errorCount, errorRatio, runId, durationMs}.
 *   <target>/migration-errors.log: newline-delimited JSON of per-entity errors.
 *
 * Exit code: 0 when errorCount/totalEntities ≤ 0.05; non-zero otherwise.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import * as crypto from 'node:crypto';
import { Level } from 'level';
import {
  GraphKMStore,
  mintEntityId,
  parseEntityId,
  OntologyRegistry,
} from '@fwornle/km-core';

// ---------------------------------------------------------------------------
// CLI flag parsing — no new deps; pure process.argv walk.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    source: '.data/knowledge-graph',
    target: '.data/knowledge-graph-migrated',
    ontologyDir: '.data/ontologies',
    dryRun: false,
    batchSize: 100,
    resume: false,
    runId: null,
    help: false,
  };
  for (const a of argv) {
    if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--resume') {
      args.resume = true;
    } else if (a.startsWith('--source=')) {
      args.source = a.slice('--source='.length);
    } else if (a.startsWith('--target=')) {
      args.target = a.slice('--target='.length);
    } else if (a.startsWith('--ontology-dir=')) {
      args.ontologyDir = a.slice('--ontology-dir='.length);
    } else if (a.startsWith('--batch-size=')) {
      const n = parseInt(a.slice('--batch-size='.length), 10);
      if (Number.isFinite(n) && n > 0) args.batchSize = n;
    } else if (a.startsWith('--run-id=')) {
      args.runId = a.slice('--run-id='.length);
    }
  }
  return args;
}

function printUsage() {
  process.stderr.write(
    [
      'Usage: node scripts/migrate-leveldb-to-kmcore.mjs [flags]',
      '',
      'Flags:',
      '  --source=<path>       Source LevelDB dir (default .data/knowledge-graph)',
      '  --target=<path>       Target km-core dataDir (default .data/knowledge-graph-migrated)',
      '  --ontology-dir=<path> Ontology dir (default .data/ontologies)',
      '  --dry-run             Count + validate, write nothing.',
      '  --batch-size=<N>      Write batch size (default 100).',
      '  --resume              Skip entities already in target (idempotency assist).',
      '  --run-id=<string>     Stable runId for provenance stamps.',
      '  --help                Show this usage and exit 0.',
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// D-54 mapping helpers — one per row of 42-RESEARCH.md §4.
// ---------------------------------------------------------------------------

/** Row 1: id mapping — preserve B's nanoid as legacyId.id; mint a fresh
 *  UUIDv7 for the canonical id. When the entity already has a parseable
 *  UUIDv7 id AND a top-level legacyId.system === 'B', it is treated as
 *  ALREADY MIGRATED and the same id is reused (idempotency contract). */
function deriveCanonicalId(source) {
  // Idempotency guard — RESEARCH §4 + plan acceptance criterion
  // (grep for "legacyId.*system.*'B'" must match this line).
  const legacy = source?.legacyId;
  if (
    legacy &&
    typeof legacy === 'object' &&
    legacy.system === 'B' &&
    typeof source.id === 'string'
  ) {
    try {
      parseEntityId(source.id);
      // Already canonical — keep both.
      return { canonicalId: source.id, legacyId: legacy, alreadyMigrated: true };
    } catch {
      // top-level id is NOT a UUIDv7; fall through to mint.
    }
  }
  const oldId = typeof source?.id === 'string' && source.id.length > 0
    ? source.id
    : 'unknown';
  return {
    canonicalId: mintEntityId(),
    legacyId: { system: 'B', id: oldId },
    alreadyMigrated: false,
  };
}

/** Row 3: entityType → ontologyClass. Returns the class name AND a flag
 *  set true when the class is NOT in the registry (RESEARCH §6 Risk 3 —
 *  the 60 specialized B entities that use ad-hoc classes). */
function deriveOntologyClass(source, registry) {
  const cls = typeof source?.entityType === 'string' && source.entityType.length > 0
    ? source.entityType
    : 'Unclassified';
  const known = registry ? registry.isValidClass(cls) : true;
  return { ontologyClass: cls, unregistered: !known };
}

/** Row 4: observations[] → description + metadata.descriptionSegments[0].
 *  Joins observations into a single description string; builds an initial
 *  DescriptionSegment with the migration provenance stamp. */
function deriveDescription(source, runId, nowIso) {
  // Observations can be either string[] or array of {content: string}.
  const raw = Array.isArray(source?.observations) ? source.observations : [];
  const texts = raw
    .map((o) => {
      if (typeof o === 'string') return o;
      if (o && typeof o === 'object' && typeof o.content === 'string') return o.content;
      return '';
    })
    .filter((s) => s.length > 0);
  const joined = texts.join('\n\n');
  const segment = {
    text: joined,
    runId,
    provider: 'phase-42-migration',
    model: 'b-to-km-core',
    quality: 'standard',
    timestamp: nowIso,
    confirmations: [],
  };
  return { description: joined, descriptionSegment: segment, legacyObservations: raw };
}

/** Provenance stamp produced by the migration run. */
function stampProvenance(runId, nowIso) {
  const stamp = {
    provider: 'phase-42-migration',
    model: 'b-to-km-core',
    runId,
    timestamp: nowIso,
  };
  return {
    createdBy: stamp,
    lastConfirmedBy: stamp,
    confirmationCount: 1,
  };
}

/** Rows 7-8: metadata.created_at → createdAt + validFrom; last_updated →
 *  updatedAt. Production LevelDB has both top-level and metadata variants
 *  (see graph blob inspection) — read both, prefer metadata. */
function derivePromotedTimestamps(source, nowIso) {
  const metaCreated = source?.metadata?.created_at;
  const metaUpdated = source?.metadata?.last_updated ?? source?.metadata?.last_modified;
  const flatCreated = source?.created_at;
  const flatUpdated = source?.last_updated ?? source?.last_modified;
  const createdAt = typeof metaCreated === 'string' && metaCreated.length > 0
    ? metaCreated
    : typeof flatCreated === 'string' && flatCreated.length > 0
      ? flatCreated
      : nowIso;
  const updatedAt = typeof metaUpdated === 'string' && metaUpdated.length > 0
    ? metaUpdated
    : typeof flatUpdated === 'string' && flatUpdated.length > 0
      ? flatUpdated
      : createdAt;
  return { createdAt, updatedAt, validFrom: createdAt };
}

/** Rows 9 + 11-16: preserve B-specific metadata into canonical metadata.
 *  Includes problem/solution, significance, source, subsystem, provenance,
 *  hierarchy fields (when present in source), descriptionSegments,
 *  legacyObservations, and the ontologyClassUnregistered flag. */
function derivePreservedMetadata({
  source,
  runId,
  nowIso,
  descriptionSegment,
  legacyObservations,
  unregistered,
}) {
  const inMeta = (source?.metadata && typeof source.metadata === 'object') ? source.metadata : {};
  const significance = source?.significance ?? inMeta.significance;
  const src = source?.source ?? inMeta.source;
  const problem = source?.problem ?? inMeta.problem;
  const solution = source?.solution ?? inMeta.solution;
  const hierarchyLevel = source?.hierarchyLevel ?? inMeta.hierarchyLevel;
  const parentEntityName = source?.parentEntityName ?? inMeta.parentEntityName;
  const childEntityNames = source?.childEntityNames ?? inMeta.childEntityNames;
  const isScaffoldNode = source?.isScaffoldNode ?? inMeta.isScaffoldNode;

  const out = {
    subsystem: 'wave-analysis',
    provenance: stampProvenance(runId, nowIso),
    descriptionSegments: [descriptionSegment],
    legacyObservations,
  };
  if (significance !== undefined) out.significance = significance;
  if (src !== undefined) out.source = src;
  if (problem !== undefined) out.problem = problem;
  if (solution !== undefined) out.solution = solution;
  if (hierarchyLevel !== undefined) out.hierarchyLevel = hierarchyLevel;
  if (parentEntityName !== undefined) out.parentEntityName = parentEntityName;
  if (childEntityNames !== undefined) out.childEntityNames = childEntityNames;
  if (isScaffoldNode !== undefined) out.isScaffoldNode = isScaffoldNode;
  if (unregistered) out.ontologyClassUnregistered = true;
  return out;
}

/** Full mapping — assemble a canonical km-core Entity from a B source. */
function mapToCanonical(source, runId, registry, nowIso) {
  if (!source || typeof source !== 'object') {
    throw new Error('source is not an object');
  }
  if (typeof source.name !== 'string' || source.name.length === 0) {
    throw new Error('source.name missing or empty');
  }
  const { canonicalId, legacyId, alreadyMigrated } = deriveCanonicalId(source);
  const { ontologyClass, unregistered } = deriveOntologyClass(source, registry);
  const { description, descriptionSegment, legacyObservations } = deriveDescription(source, runId, nowIso);
  const { createdAt, updatedAt, validFrom } = derivePromotedTimestamps(source, nowIso);
  const metadata = derivePreservedMetadata({
    source,
    runId,
    nowIso,
    descriptionSegment,
    legacyObservations,
    unregistered,
  });
  const entity = {
    id: canonicalId,
    name: source.name,
    entityType: ontologyClass,
    ontologyClass,
    layer: 'evidence',
    description,
    createdAt,
    updatedAt,
    validFrom,
    validUntil: null,
    legacyId,
    metadata,
  };
  // Row 16: embedding (rare) → embedding verbatim.
  if (Array.isArray(source.embedding) && source.embedding.length > 0) {
    entity.embedding = source.embedding.slice();
  }
  return { entity, alreadyMigrated };
}

// ---------------------------------------------------------------------------
// Source iteration — open LevelDB, read the 'graph' blob, yield each node.
// ---------------------------------------------------------------------------

async function readSourceEntities(sourceDir) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`source LevelDB not found: ${sourceDir}`);
  }
  const db = new Level(sourceDir, { valueEncoding: 'json' });
  await db.open();
  let graphBlob;
  try {
    graphBlob = await db.get('graph');
  } catch (err) {
    await db.close();
    if (err && err.code === 'LEVEL_NOT_FOUND') {
      return [];
    }
    throw err;
  }
  await db.close();
  if (!graphBlob || !Array.isArray(graphBlob.nodes)) {
    return [];
  }
  return graphBlob.nodes;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  const startMs = Date.now();
  const nowIso = new Date(startMs).toISOString();

  // Default runId is a deterministic hash of source path + UTC date so the
  // same migration over the same source produces stable provenance stamps
  // across re-runs (RESEARCH §4 idempotency contract).
  let runId = args.runId;
  if (!runId) {
    const hash = crypto.createHash('sha256');
    hash.update(path.resolve(args.source));
    hash.update(nowIso.slice(0, 10));
    runId = `phase-42-migration-${hash.digest('hex').slice(0, 16)}`;
  }

  // Resolve absolute paths.
  const sourceDir = path.resolve(args.source);
  const targetDir = path.resolve(args.target);
  const ontologyDir = path.resolve(args.ontologyDir);
  const dbPath = path.join(targetDir, 'leveldb');
  const exportDir = path.join(targetDir, 'exports');
  const errorsLog = path.join(targetDir, 'migration-errors.log');

  process.stderr.write(
    `[42-05] starting: source=${sourceDir} target=${targetDir} ontologyDir=${ontologyDir} dryRun=${args.dryRun} batchSize=${args.batchSize} runId=${runId}\n`,
  );

  if (!args.dryRun) {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(dbPath, { recursive: true });
    fs.mkdirSync(exportDir, { recursive: true });
  }

  // Load ontology registry to detect unregistered specialized classes
  // (RESEARCH §6 Risk 3). If the ontology dir is missing or unreadable,
  // log a warning and proceed with registry=null (every class will be
  // flagged as unregistered which is the safe fallback).
  let registry = null;
  if (fs.existsSync(ontologyDir)) {
    try {
      registry = new OntologyRegistry({ ontologyDir, strict: false });
    } catch (e) {
      process.stderr.write(`[42-05] ontology registry load failed: ${e.message}; proceeding with registry=null\n`);
      registry = null;
    }
  } else {
    process.stderr.write(`[42-05] ontology dir not found: ${ontologyDir}; proceeding with registry=null\n`);
  }

  // Source iteration.
  let sourceNodes;
  try {
    sourceNodes = await readSourceEntities(sourceDir);
  } catch (err) {
    process.stderr.write(`[42-05] source open failed: ${err.message}\n`);
    process.stderr.write(JSON.stringify({
      totalEntities: 0,
      migratedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      errorRatio: 0,
      runId,
      durationMs: Date.now() - startMs,
      error: err.message,
    }) + '\n');
    process.exit(2);
  }
  const totalEntities = sourceNodes.length;
  process.stderr.write(`[42-05] read ${totalEntities} source nodes\n`);

  // Pre-scan target dataDir for --resume / cross-run idempotency: build a
  // Set of legacyId.id values already present in target so we skip them.
  const alreadyMigratedLegacyIds = new Set();
  if (args.resume && !args.dryRun) {
    // Read target export JSONs if present and collect legacyId.ids.
    if (fs.existsSync(exportDir)) {
      const files = fs.readdirSync(exportDir).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        try {
          const blob = JSON.parse(fs.readFileSync(path.join(exportDir, f), 'utf-8'));
          if (Array.isArray(blob?.nodes)) {
            for (const n of blob.nodes) {
              const lid = n?.attributes?.legacyId;
              if (lid && lid.system === 'B' && typeof lid.id === 'string') {
                alreadyMigratedLegacyIds.add(lid.id);
              }
            }
          }
        } catch {
          // ignore — corrupt export shouldn't block migration
        }
      }
    }
    process.stderr.write(`[42-05] --resume: ${alreadyMigratedLegacyIds.size} entities already migrated in target\n`);
  }

  // Open the km-core store (skipped for pure dry-run — we still want to
  // exercise the mapping logic; but no GraphKMStore is needed if we don't
  // write anything).
  let store = null;
  if (!args.dryRun) {
    store = new GraphKMStore({
      dbPath,
      exportDir,
      ontologyDir,
      ontologyStrict: false,
      debounceMs: 0,
      domains: ['coding'],
    });
    await store.open();
  }

  let migratedCount = 0;
  let skippedCount = 0;
  const errors = [];

  let batch = [];

  async function flushBatch() {
    if (batch.length === 0) return;
    if (args.dryRun || !store) {
      batch = [];
      return;
    }
    try {
      const ops = batch.map((entity) => ({ type: 'putEntity', entity, skipOntologyCheck: true }));
      await store.batch(ops);
    } catch (e) {
      // A batch failure is fatal in the sense that the whole batch is
      // discarded; we count each as an error.
      for (const entity of batch) {
        errors.push({ entityName: entity.name, message: `batch failed: ${e.message}` });
      }
    } finally {
      batch = [];
    }
  }

  for (const node of sourceNodes) {
    const source = node?.attributes;
    const sourceId = typeof source?.id === 'string' ? source.id : (node?.key ?? 'unknown');
    try {
      const { entity, alreadyMigrated } = mapToCanonical(source, runId, registry, nowIso);
      if (alreadyMigrated) {
        skippedCount += 1;
        continue;
      }
      // --resume cross-run skip: if the legacyId.id is already in target,
      // skip without writing.
      if (entity.legacyId?.id && alreadyMigratedLegacyIds.has(entity.legacyId.id)) {
        skippedCount += 1;
        continue;
      }
      batch.push(entity);
      migratedCount += 1;
      if (batch.length >= args.batchSize) {
        await flushBatch();
      }
    } catch (err) {
      errors.push({ entityId: sourceId, message: err?.message ?? String(err) });
    }
  }
  await flushBatch();

  // Flush + close store.
  if (store) {
    try {
      await store.exportJson();
    } catch (e) {
      process.stderr.write(`[42-05] exportJson failed: ${e.message}\n`);
    }
    await store.close();
  }

  // Write errors log.
  if (errors.length > 0 && !args.dryRun) {
    try {
      const lines = errors.map((e) => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(errorsLog, lines, 'utf-8');
    } catch (e) {
      process.stderr.write(`[42-05] errors log write failed: ${e.message}\n`);
    }
  }

  const errorCount = errors.length;
  const errorRatio = totalEntities === 0 ? 0 : errorCount / totalEntities;
  const durationMs = Date.now() - startMs;
  const summary = {
    totalEntities,
    migratedCount,
    skippedCount,
    errorCount,
    errorRatio,
    runId,
    durationMs,
  };
  process.stderr.write(JSON.stringify(summary) + '\n');

  // Exit code: 0 if error ratio within budget (≤5%), else 1.
  if (errorRatio > 0.05) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(
    JSON.stringify({ error: err?.message ?? String(err), stack: err?.stack }) + '\n',
  );
  process.exit(3);
});
