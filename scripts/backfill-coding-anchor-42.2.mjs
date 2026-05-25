#!/usr/bin/env node
/**
 * Phase 42.2 Plan 06 — one-shot Coding-anchor backfill.
 *
 * Purpose: retroactively run the Phase 42.1 anchor sweep over the entities
 * accumulated in the canonical store before the
 * `km-core-adapter.findEntityByName` fix landed (submodule commit 0822dfe).
 * That fix unblocked the live anchor pass's `storeRelationship('Coding', …)`
 * call, but every wave-analysis run prior to it produced Components and
 * SubComponents with no incoming `contains` edge from the Coding Project
 * (validUntil: null + default isActive filter → findEntityByName('Coding')
 * returned undefined → storeRelationship threw → anchor pass try/catch
 * swallowed it). SC#6 verifier reports 18 orphans on the cancelled
 * 2026-05-25 11:36 run alone.
 *
 * Behaviour (mirrors Plan 02 augment-team-field-42.2.mjs):
 *   1. Open the km-core GraphKMStore at --source-dir with
 *      `includeSuperseded: true` so the migrated cohort is visible.
 *   2. Resolve the Coding Project entity (must exist; fail-loud if absent).
 *   3. Iterate every entity. For each entity that is:
 *      - in-scope (legacyId?.id !== 'unknown')
 *      - NOT a Project/System (anchor classes are not anchored to anything)
 *      - has NO incoming 'contains' or 'parent-child' edge
 *      ... add a 'contains' edge from Coding (idempotent via km-core
 *      addRelation upsert semantics).
 *   4. Fail-loud at >5% error budget.
 *   5. Per CLAUDE.md "km-core scripts" — constructs GraphKMStore WITH
 *      `ontologyDir` (Phase 41 lesson).
 *
 * Usage:
 *   node scripts/backfill-coding-anchor-42.2.mjs                # live
 *   node scripts/backfill-coding-anchor-42.2.mjs --dry-run      # scan only
 *
 * Defaults:
 *   --source-dir   /Users/Q284340/Agentic/coding/.data/knowledge-graph
 *   --ontology-dir /Users/Q284340/Agentic/coding/.data/ontologies
 *
 * Output: stderr per-batch progress + final JSON summary.
 * Exit 0 when errorRatio <= 0.05; non-zero otherwise.
 *
 * @module scripts/backfill-coding-anchor-42.2
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import { GraphKMStore } from '@fwornle/km-core';

const PROJECT_ANCHOR_NAME = 'Coding';
const PROJECT_ANCHOR_TYPE = 'Project';
const ANCHOR_EDGE_TYPES = new Set(['contains', 'parent-child']);
const ANCHOR_CLASSES_SKIP = new Set(['Project', 'System']);
const ERROR_BUDGET = 0.05;

function parseArgs(argv) {
  const args = {
    sourceDir: '/Users/Q284340/Agentic/coding/.data/knowledge-graph',
    ontologyDir: '/Users/Q284340/Agentic/coding/.data/ontologies',
    dryRun: false,
    help: false,
  };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--source-dir=')) args.sourceDir = a.slice('--source-dir='.length);
    else if (a.startsWith('--ontology-dir=')) args.ontologyDir = a.slice('--ontology-dir='.length);
  }
  return args;
}

function diag(s) {
  process.stderr.write(`[backfill-anchor] ${s}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stderr.write(
      [
        'Phase 42.2 Plan 06 — Coding-anchor backfill',
        '',
        'Usage:',
        '  node scripts/backfill-coding-anchor-42.2.mjs [--dry-run] [--source-dir=PATH] [--ontology-dir=PATH]',
      ].join('\n') + '\n',
    );
    process.exit(0);
  }

  const dbPath = path.join(args.sourceDir, 'leveldb');
  const exportDir = path.join(args.sourceDir, 'exports');
  if (!fs.existsSync(dbPath)) {
    diag(`FATAL: dbPath ${dbPath} does not exist`);
    process.exit(2);
  }

  const store = new GraphKMStore({
    dbPath,
    exportDir,
    ontologyDir: args.ontologyDir,
    ontologyStrict: false,
    debounceMs: 0,
  });
  await store.open();

  // 1. Resolve the Coding Project entity (must use includeSuperseded to see
  //    the migrated cohort).
  let codingEntity = null;
  for await (const e of store.iterate(undefined, { includeSuperseded: true })) {
    if (e.name === PROJECT_ANCHOR_NAME && e.entityType === PROJECT_ANCHOR_TYPE) {
      codingEntity = e;
      break;
    }
  }
  if (!codingEntity) {
    diag(`FATAL: Coding Project entity not found in store at ${args.sourceDir}`);
    await store.close();
    process.exit(3);
  }
  diag(`Resolved Coding Project: id=${codingEntity.id.slice(0, 12)}…  validUntil=${codingEntity.validUntil ?? 'undef'}`);

  // 2. Walk the store, find orphan candidates.
  let scanned = 0;
  let inScopeCandidates = 0;
  let alreadyAnchored = 0;
  let backfilled = 0;
  let skippedAnchorClass = 0;
  let skippedLegacy = 0;
  let errors = 0;
  const errorSamples = [];
  const backfilledSamples = [];

  for await (const e of store.iterate(undefined, { includeSuperseded: true })) {
    scanned += 1;

    // Skip legacy cohort (Phase 42-05 migrated, scope_fence).
    if (e?.legacyId?.id === 'unknown') {
      skippedLegacy += 1;
      continue;
    }
    // Skip Project/System anchors (they are NOT anchored TO anything).
    if (ANCHOR_CLASSES_SKIP.has(e.entityType)) {
      skippedAnchorClass += 1;
      continue;
    }
    inScopeCandidates += 1;

    try {
      const incoming = await store.findRelations({ to: e.id });
      const hasAnchor = incoming.some((r) => ANCHOR_EDGE_TYPES.has(r.type));
      if (hasAnchor) {
        alreadyAnchored += 1;
        continue;
      }

      if (args.dryRun) {
        backfilled += 1; // count as "would-backfill"
        if (backfilledSamples.length < 5) {
          backfilledSamples.push({ id: e.id.slice(0, 16), name: e.name, entityType: e.entityType });
        }
        continue;
      }

      // Add the contains edge — km-core addRelation is upsert-by-(from,to,type)
      // so re-runs are safe.
      await store.addRelation({
        type: 'contains',
        from: codingEntity.id,
        to: e.id,
        metadata: {
          source: 'backfill-coding-anchor-42.2',
          runAt: new Date().toISOString(),
        },
      });
      backfilled += 1;
      if (backfilledSamples.length < 5) {
        backfilledSamples.push({ id: e.id.slice(0, 16), name: e.name, entityType: e.entityType });
      }
    } catch (err) {
      errors += 1;
      if (errorSamples.length < 5) {
        errorSamples.push({
          id: e.id?.slice(0, 16),
          name: e.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (scanned % 100 === 0) {
      diag(
        `progress: scanned=${scanned} inScope=${inScopeCandidates} backfilled=${backfilled} alreadyAnchored=${alreadyAnchored} errors=${errors}`,
      );
    }
  }

  await store.close();

  const errorRatio = inScopeCandidates > 0 ? errors / inScopeCandidates : 0;
  const result = {
    sourceDir: args.sourceDir,
    dryRun: args.dryRun,
    codingProjectId: codingEntity.id,
    scanned,
    skippedLegacy,
    skippedAnchorClass,
    inScopeCandidates,
    alreadyAnchored,
    backfilled,
    errors,
    errorRatio,
    errorBudgetExceeded: errorRatio > ERROR_BUDGET,
    backfilledSamples,
    errorSamples,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (result.errorBudgetExceeded) {
    diag(`FAIL: errorRatio ${errorRatio.toFixed(3)} > budget ${ERROR_BUDGET}`);
    process.exit(1);
  }
  diag(
    `OK: backfilled ${backfilled} contains edges (errorRatio=${errorRatio.toFixed(3)}, alreadyAnchored=${alreadyAnchored})`,
  );
  process.exit(0);
}

main().catch((err) => {
  diag(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(2);
});
