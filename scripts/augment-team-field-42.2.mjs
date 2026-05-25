#!/usr/bin/env node
/**
 * Phase 42.2 Plan 02 Gap 3 — one-shot `metadata.team` augmentation for the
 * 908 entities already in `.data/knowledge-graph-migrated/`.
 *
 * Forensics report `report-42.2-00-canonical-emit.md` §3.3 verdict:
 * RE-MIGRATION REQUIRED — 0/10 sampled entities carried `team` (`migrate-leveldb-
 * to-kmcore.mjs` had ZERO references to team). Without this backfill,
 * `kmCoreAdapter.queryEntities({ team: 'coding' })` won't match the migrated
 * cohort, breaking the multi-tenant attribution model that Phase 42.1's
 * `ensureProjectAnchor` assumes.
 *
 * Behaviour (per forensics §3.4 recipe):
 *   1. Open the km-core GraphKMStore at `--source-dir` (canonical migrated dir).
 *   2. Iterate every entity via `store.iterate()`.
 *   3. For each entity where `legacyId?.system === 'B'` AND `metadata?.team`
 *      is missing/empty, stamp `metadata.team = 'coding'` via
 *      `store.mergeAttributes(id, { metadata: { ...existing, team: 'coding' } })`.
 *   4. Idempotent — entities that already carry `metadata.team` are skipped.
 *   5. Fail-loud at >5% error budget (matches `migrate-leveldb-to-kmcore.mjs`
 *      convention; Phase 42-05 SUMMARY).
 *   6. Per CLAUDE.md "km-core scripts" — constructs `GraphKMStore` WITH an
 *      `ontologyDir` option (Phase 41 lesson, commits `87bc2f567` /
 *      `fd35c5350`). Missing this throws
 *      `opts.classes omitted but store has no ontology registry`.
 *
 * Usage:
 *   node scripts/augment-team-field-42.2.mjs                         # live, defaults
 *   node scripts/augment-team-field-42.2.mjs --dry-run               # scan only
 *   node scripts/augment-team-field-42.2.mjs --team=coding           # override team
 *   node scripts/augment-team-field-42.2.mjs --source-dir=<path>     # override store dir
 *
 * Defaults:
 *   --source-dir   /Users/Q284340/Agentic/coding/.data/knowledge-graph-migrated
 *   --ontology-dir /Users/Q284340/Agentic/coding/.data/ontologies
 *   --team         coding
 *
 * Output:
 *   stderr: per-batch progress + final JSON summary line.
 *   Exit 0 when errorRatio ≤ 0.05; non-zero otherwise.
 *
 * Run AFTER Wave 2 Plan 05 dir-swap, not before — the migrated dir becomes
 * canonical only post-swap. This script targets
 * `.data/knowledge-graph-migrated/` directly so it works pre-swap (Plan 02 is
 * Wave 1; Plan 05 dir-swap is Wave 2). Idempotency means re-running post-swap
 * against `.data/knowledge-graph/` is a no-op once team is stamped.
 *
 * @module scripts/augment-team-field-42.2
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import { GraphKMStore } from '@fwornle/km-core';

// ---------------------------------------------------------------------------
// CLI flag parsing — pure process.argv walk, no new deps.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    sourceDir: '/Users/Q284340/Agentic/coding/.data/knowledge-graph-migrated',
    ontologyDir: '/Users/Q284340/Agentic/coding/.data/ontologies',
    team: 'coding',
    dryRun: false,
    help: false,
  };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--source-dir=')) args.sourceDir = a.slice('--source-dir='.length);
    else if (a.startsWith('--ontology-dir=')) args.ontologyDir = a.slice('--ontology-dir='.length);
    else if (a.startsWith('--team=')) args.team = a.slice('--team='.length);
  }
  return args;
}

function printUsage() {
  process.stderr.write(
    [
      'Usage: node scripts/augment-team-field-42.2.mjs [flags]',
      '',
      'Backfill metadata.team on the 908 already-migrated B entities.',
      '',
      'Flags:',
      '  --source-dir=<path>   km-core dataDir (default .data/knowledge-graph-migrated)',
      '  --ontology-dir=<path> Ontology dir (default .data/ontologies) — MANDATORY per CLAUDE.md',
      '  --team=<id>           Team to stamp (default "coding")',
      '  --dry-run             Scan + report counts, no writes',
      '  --help                Show this usage and exit 0',
      '',
    ].join('\n'),
  );
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
  const sourceDir = path.resolve(args.sourceDir);
  const ontologyDir = path.resolve(args.ontologyDir);
  const dbPath = path.join(sourceDir, 'leveldb');
  const exportDir = path.join(sourceDir, 'exports');

  process.stderr.write(
    `[42.2-augment] start: sourceDir=${sourceDir} ontologyDir=${ontologyDir} team=${args.team} dryRun=${args.dryRun}\n`,
  );

  // Pre-flight: required paths exist
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(`[42.2-augment] FATAL: dbPath does not exist: ${dbPath}\n`);
    process.exit(2);
  }
  if (!fs.existsSync(ontologyDir)) {
    process.stderr.write(`[42.2-augment] FATAL: ontologyDir does not exist: ${ontologyDir}\n`);
    process.exit(2);
  }

  // Open the km-core store. CLAUDE.md mandates `ontologyDir` — without it
  // GraphKMStore throws `opts.classes omitted but store has no ontology registry`
  // (Phase 41 lesson; commits 87bc2f567 / fd35c5350).
  //
  // Domains: the migrated dir's exports/ has both `coding.json` (empty) and
  // `general.json` (the 908 entities — see forensics §3.1: "every migrated
  // entity lives in general.json"). Default domain is 'general' per
  // GraphKMStore.d.ts:23. Include both to hydrate the full graph.
  const store = new GraphKMStore({
    dbPath,
    exportDir,
    ontologyDir,
    ontologyStrict: false,
    debounceMs: 0,
    domains: ['general', 'coding'],
  });
  await store.open();

  let scanned = 0;
  let augmented = 0;
  let skipped = 0;
  let errored = 0;
  const errors = [];
  const PROGRESS_EVERY = 100;

  try {
    // Rule 1 deviation: the 42-05 migration script (commit `1eaaa5e`, line 291)
    // set `validUntil: null` on every entity. km-core's `isActive` helper at
    // GraphKMStore.js:454-458 returns FALSE for `validUntil !== undefined`, so
    // by default `iterate()` filters out the entire migrated cohort
    // (`new Date(null).getTime() === 0` is < now). Pass
    // `includeSuperseded: true` so we see every node regardless. The
    // mergeAttributes path below leaves `validUntil` untouched — we are NOT
    // fixing the `null` bug here, just bypassing its filter. Plan 02 surfaces
    // this as a Rule 1 deviation; Plan 05 dir-swap is the natural place to
    // also clean up `validUntil: null` → `undefined` if the team chooses.
    for await (const entity of store.iterate(undefined, { includeSuperseded: true })) {
      scanned += 1;
      try {
        const legacy = entity?.legacyId;
        const existingMeta = (entity?.metadata && typeof entity.metadata === 'object')
          ? entity.metadata
          : {};
        const existingTeam = existingMeta.team;
        const isBEntity = legacy && typeof legacy === 'object' && legacy.system === 'B';
        const alreadyHasTeam = typeof existingTeam === 'string' && existingTeam.length > 0;

        if (!isBEntity) {
          // Out of scope — only the 908 B-system entities are targeted.
          skipped += 1;
          continue;
        }
        if (alreadyHasTeam) {
          // Idempotency: re-runs are no-ops once team is stamped.
          skipped += 1;
          continue;
        }

        if (args.dryRun) {
          augmented += 1;
        } else {
          // mergeAttributes merges into Graphology's nodeAttributes via the
          // store's canonical merge pathway (km-core GraphKMStore.ts:314 +
          // 854). Passing `metadata: { ...existing, team }` preserves the
          // rest of the metadata bag.
          await store.mergeAttributes(entity.id, {
            metadata: { ...existingMeta, team: args.team },
          });
          augmented += 1;
        }

        if (augmented > 0 && augmented % PROGRESS_EVERY === 0) {
          process.stderr.write(
            `[42.2-augment] progress: scanned=${scanned} augmented=${augmented} skipped=${skipped} errored=${errored}\n`,
          );
        }
      } catch (e) {
        errored += 1;
        errors.push({
          entityId: entity?.id ?? '<unknown>',
          name: entity?.name ?? '<unknown>',
          message: e?.message ?? String(e),
        });
      }
    }

    // Flush exports so the augmented metadata.team is visible to downstream
    // JSON consumers (VKB, integration tests, verifier).
    if (!args.dryRun) {
      try {
        await store.exportJson();
      } catch (e) {
        process.stderr.write(`[42.2-augment] exportJson failed: ${e.message}\n`);
      }
    }
  } finally {
    await store.close();
  }

  const durationMs = Date.now() - startMs;
  const errorRatio = scanned === 0 ? 0 : errored / scanned;
  const summary = {
    scanned,
    augmented,
    skipped,
    errored,
    errorRatio,
    durationMs,
    dryRun: args.dryRun,
    team: args.team,
  };
  process.stderr.write(JSON.stringify(summary) + '\n');

  if (errors.length > 0) {
    process.stderr.write(`[42.2-augment] first-3 errors: ${JSON.stringify(errors.slice(0, 3))}\n`);
  }

  // Fail-loud at >5% error budget (mirrors migrate-leveldb-to-kmcore.mjs).
  if (errorRatio > 0.05) {
    process.stderr.write(`[42.2-augment] FATAL: errorRatio ${errorRatio} exceeds 5% budget\n`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(
    JSON.stringify({ fatal: err?.message ?? String(err), stack: err?.stack }) + '\n',
  );
  process.exit(3);
});
