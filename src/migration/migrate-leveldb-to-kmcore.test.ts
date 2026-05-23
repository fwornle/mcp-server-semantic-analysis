/**
 * Integration tests for the D-54 LevelDB → km-core canonical-shape
 * migration script (Phase 42 Plan 05).
 *
 * The script under test is a .mjs ESM file at:
 *   integrations/mcp-server-semantic-analysis/scripts/migrate-leveldb-to-kmcore.mjs
 *
 * Tests use `child_process.spawn` to drive the real script against per-test
 * fixture LevelDB directories. Each test seeds a fresh tmpdir LevelDB with a
 * known-shape entity set, runs the script, then asserts both the on-disk
 * target km-core store AND the exit code / stderr summary line.
 *
 * Run via:
 *   cd integrations/mcp-server-semantic-analysis
 *   npm run build
 *   node --test --test-timeout=60000 dist/migration/migrate-leveldb-to-kmcore.test.js
 *
 * Test inventory (10 cases — see 42-05-PLAN.md §<behavior>):
 *   Test 1: happy path — 10 entities migrate to canonical km-core shape with
 *           layer='evidence', legacyId.system='B', validFrom set,
 *           validUntil=null.
 *   Test 2: idempotency — second run reports 0 migrations.
 *   Test 3: ontologyClass — Detail keeps "Detail"; Config (specialized class
 *           absent from coding-ontology.json) gets
 *           metadata.ontologyClassUnregistered=true.
 *   Test 4: descriptionSegments — observations[] are joined into description
 *           AND placed into metadata.descriptionSegments[0] with the
 *           migration provenance stamp.
 *   Test 5: embedding — a fixture entity carrying a 12-element embedding has
 *           the array copied verbatim. Without embedding, the field is
 *           undefined on the output.
 *   Test 6: provenance stamping — all migrated entities carry
 *           metadata.provenance.createdBy.provider === 'phase-42-migration',
 *           model === 'b-to-km-core', confirmationCount === 1.
 *   Test 7: legacyId preservation — top-level legacyId === { system: 'B',
 *           id: <original 13-char nanoid> }; the new id is a parseable
 *           UUIDv7 per km-core's parseEntityId contract.
 *   Test 8: --dry-run — script reports the count it WOULD migrate but writes
 *           NOTHING to the target dataDir.
 *   Test 9a: error budget OK — 1/20 malformed (5% exactly) exits 0.
 *   Test 9b: error budget exceeded — 2/20 malformed (10%) exits non-zero.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Level } from 'level';

// ---------------------------------------------------------------------------
// Constants — resolve the script and the km-core ontology dir
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
// dist/migration/migrate-leveldb-to-kmcore.test.js → up 3 levels to submodule root
const SUBMODULE_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const SCRIPT_PATH = path.join(SUBMODULE_ROOT, 'scripts', 'migrate-leveldb-to-kmcore.mjs');
// Coding repo root: submodule is at integrations/mcp-server-semantic-analysis
const CODING_ROOT = path.resolve(SUBMODULE_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(CODING_ROOT, '.data', 'ontologies');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface FixtureEntity {
  // Legacy B shape — the data the migration reads.
  name: string;
  entityType: string;
  observations: string[];
  significance?: number;
  source?: string;
  problem?: Record<string, unknown>;
  solution?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  id?: string;
  embedding?: number[];
  hierarchyLevel?: number;
  parentEntityName?: string | null;
  childEntityNames?: string[];
  team?: string;
  // Direct top-level fields seen in production LevelDB
  created_at?: string;
  last_modified?: string;
}

/** Build the LevelDB blob shape `GraphDatabaseService._persistGraphToLevel`
 *  produces: a single `graph` key holding `{ nodes, edges, metadata }`. */
function makeLevelBlob(entities: FixtureEntity[]): {
  nodes: Array<{ key: string; attributes: FixtureEntity }>;
  edges: Array<{ source: string; target: string; attributes: Record<string, unknown> }>;
  metadata: { lastSaved: string; nodeCount: number; edgeCount: number };
} {
  const nodes = entities.map((e) => ({
    key: `${e.team ?? 'coding'}:${e.name}`,
    attributes: e,
  }));
  return {
    nodes,
    edges: [],
    metadata: {
      lastSaved: new Date().toISOString(),
      nodeCount: nodes.length,
      edgeCount: 0,
    },
  };
}

async function seedLevelDb(dir: string, entities: FixtureEntity[]): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Level<string, unknown>(dir, { valueEncoding: 'json' });
  await db.open();
  await db.put('graph', makeLevelBlob(entities));
  await db.close();
}

/** Seed a fixture where the 'graph' blob holds a MALFORMED node attribute —
 *  the script must capture this in errors[] and account for error budget. */
async function seedLevelDbWithMalformed(
  dir: string,
  goodEntities: FixtureEntity[],
  malformedCount: number,
): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Level<string, unknown>(dir, { valueEncoding: 'json' });
  await db.open();
  const blob = makeLevelBlob(goodEntities);
  // Append malformed nodes — attributes is null which the mapper cannot handle.
  for (let i = 0; i < malformedCount; i += 1) {
    blob.nodes.push({
      key: `coding:Malformed${i}`,
      // attributes deliberately null to force a mapping error
      attributes: null as unknown as FixtureEntity,
    });
  }
  blob.metadata.nodeCount = blob.nodes.length;
  await db.put('graph', blob);
  await db.close();
}

/** Read the migrated km-core graph back from disk. The migration script
 *  flushes a per-domain JSON export under `<target>/<domain>.json`. We read
 *  the coding domain since fixtures use team='coding' by default. */
function readMigratedEntities(targetDataDir: string): Array<Record<string, unknown>> {
  // GraphKMStore exporter writes per-domain JSON under exportDir; the script
  // configures exportDir = <target>/exports. Default domain is 'coding' for
  // these fixtures.
  const exportDir = path.join(targetDataDir, 'exports');
  if (!fs.existsSync(exportDir)) return [];
  const files = fs.readdirSync(exportDir).filter((f) => f.endsWith('.json'));
  const entities: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const blob = JSON.parse(fs.readFileSync(path.join(exportDir, file), 'utf-8'));
    if (Array.isArray(blob?.nodes)) {
      for (const n of blob.nodes) entities.push(n.attributes);
    }
  }
  return entities;
}

interface ScriptOutcome {
  status: number;
  summary?: {
    totalEntities: number;
    migratedCount: number;
    skippedCount: number;
    errorCount: number;
    errorRatio: number;
    runId: string;
    durationMs: number;
  };
  stderr: string;
  stdout: string;
}

function runScript(args: string[]): ScriptOutcome {
  const result = spawnSync('node', [SCRIPT_PATH, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  const status = result.status ?? 1;
  const stderr = result.stderr ?? '';
  const stdout = result.stdout ?? '';
  // The final JSON line on stderr is the summary
  let summary: ScriptOutcome['summary'] | undefined;
  const lines = stderr.trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.totalEntities === 'number') {
          summary = parsed;
          break;
        }
      } catch {
        // not JSON, keep scanning
      }
    }
  }
  return { status, summary, stderr, stdout };
}

function tmpDirSuffix(label: string): string {
  return path.join(os.tmpdir(), `42-05-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function tenEntityFixture(): FixtureEntity[] {
  const base: Array<{ name: string; entityType: string; id: string }> = [
    { name: 'CodingProject', entityType: 'Project', id: 'fixtureproj0001' },
    { name: 'AltProject', entityType: 'Project', id: 'fixtureproj0002' },
    { name: 'ResiProject', entityType: 'Project', id: 'fixtureproj0003' },
    { name: 'LSL', entityType: 'Component', id: 'fixturecomp0001' },
    { name: 'LLMProxy', entityType: 'Component', id: 'fixturecomp0002' },
    { name: 'Trajectory', entityType: 'Component', id: 'fixturecomp0003' },
    { name: 'TranscriptAdapter', entityType: 'SubComponent', id: 'fixturesub00001' },
    { name: 'ProxyClient', entityType: 'SubComponent', id: 'fixturesub00002' },
    { name: 'MetricsCollector', entityType: 'Detail', id: 'fixturedet00001' },
    { name: 'EventBus', entityType: 'Detail', id: 'fixturedet00002' },
  ];
  return base.map((b, i) => ({
    name: b.name,
    entityType: b.entityType,
    id: b.id,
    observations: [
      `${b.name} observation A from fixture row ${i}`,
      `${b.name} observation B from fixture row ${i}`,
    ],
    significance: 0.5,
    source: 'manual',
    problem: {},
    solution: {},
    metadata: {
      created_at: '2026-03-07T12:38:24.946Z',
      last_updated: '2026-03-21T06:36:53.211Z',
    },
    team: 'coding',
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const cleanupDirs: string[] = [];

after(() => {
  for (const dir of cleanupDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore — tmp cleanup is best-effort
    }
  }
});

describe('migrate-leveldb-to-kmcore (Phase 42 Plan 05)', () => {
  it('Test 1: happy path — 10 entities migrate to canonical km-core shape', async () => {
    const source = tmpDirSuffix('t1-src');
    const target = tmpDirSuffix('t1-tgt');
    cleanupDirs.push(source, target);

    await seedLevelDb(source, tenEntityFixture());
    const outcome = runScript([
      `--source=${source}`,
      `--target=${target}`,
      `--ontology-dir=${ONTOLOGY_DIR}`,
      '--run-id=test1-run',
    ]);
    assert.equal(outcome.status, 0, `script exited ${outcome.status}; stderr=\n${outcome.stderr}`);
    assert.ok(outcome.summary, 'summary JSON line missing on stderr');
    assert.equal(outcome.summary!.totalEntities, 10);
    assert.equal(outcome.summary!.migratedCount, 10);
    assert.equal(outcome.summary!.errorCount, 0);

    const entities = readMigratedEntities(target);
    assert.equal(entities.length, 10, `expected 10 migrated; got ${entities.length}`);
    for (const e of entities) {
      const legacy = e.legacyId as { system: string; id: string } | undefined;
      assert.ok(legacy, `entity ${String(e.name)} missing legacyId`);
      assert.equal(legacy!.system, 'B');
      assert.equal(e.layer, 'evidence');
      assert.ok(typeof e.validFrom === 'string' && e.validFrom!.length > 0);
      // validUntil should be null OR absent — both encode "still in-force"
      assert.ok(e.validUntil === null || e.validUntil === undefined);
      const meta = e.metadata as Record<string, unknown>;
      assert.equal(meta.subsystem, 'wave-analysis');
    }
  });

  it('Test 2: idempotency — second run skips already-migrated entities', async () => {
    const source = tmpDirSuffix('t2-src');
    const target = tmpDirSuffix('t2-tgt');
    cleanupDirs.push(source, target);

    await seedLevelDb(source, tenEntityFixture());

    const first = runScript([
      `--source=${source}`,
      `--target=${target}`,
      `--ontology-dir=${ONTOLOGY_DIR}`,
      '--run-id=test2-run',
    ]);
    assert.equal(first.status, 0);
    assert.equal(first.summary!.migratedCount, 10);

    // Re-seed source with the SAME 10 entities (LevelDB has been closed); now
    // also seed the source with the ALREADY-migrated shape so the script detects
    // they have been migrated — for idempotency, we run the script AGAINST THE
    // TARGET as its own source.
    const second = runScript([
      `--source=${source}`,
      `--target=${target}`,
      `--ontology-dir=${ONTOLOGY_DIR}`,
      '--run-id=test2-run',
      '--resume',
    ]);
    assert.equal(second.status, 0);
    // Idempotency: total entity count unchanged after second run.
    const entities = readMigratedEntities(target);
    assert.equal(entities.length, 10, `idempotency violated: ${entities.length} != 10`);
    // The second run should report skippedCount === 10 (idempotency contract).
    assert.equal(second.summary!.skippedCount, 10);
    assert.equal(second.summary!.migratedCount, 0);
  });

  it('Test 3: ontologyClass — Detail registered; Config unregistered fallback flag', async () => {
    const source = tmpDirSuffix('t3-src');
    const target = tmpDirSuffix('t3-tgt');
    cleanupDirs.push(source, target);

    await seedLevelDb(source, [
      {
        name: 'KnownDetail',
        entityType: 'Detail',
        id: 'fixturedet00099',
        observations: ['known-class entity'],
        team: 'coding',
        metadata: { created_at: '2026-03-07T12:38:24.946Z', last_updated: '2026-03-21T06:36:53.211Z' },
      },
      {
        name: 'WeirdConfig',
        entityType: 'Config',
        id: 'fixturecfg00099',
        observations: ['specialized-class entity'],
        team: 'coding',
        metadata: { created_at: '2026-03-07T12:38:24.946Z', last_updated: '2026-03-21T06:36:53.211Z' },
      },
    ]);
    const outcome = runScript([
      `--source=${source}`,
      `--target=${target}`,
      `--ontology-dir=${ONTOLOGY_DIR}`,
      '--run-id=test3-run',
    ]);
    assert.equal(outcome.status, 0, `exit non-zero; stderr=\n${outcome.stderr}`);

    const entities = readMigratedEntities(target);
    const detail = entities.find((e) => e.name === 'KnownDetail');
    const config = entities.find((e) => e.name === 'WeirdConfig');
    assert.ok(detail);
    assert.ok(config);
    assert.equal(detail!.ontologyClass, 'Detail');
    assert.equal(config!.ontologyClass, 'Config');
    const detailMeta = detail!.metadata as Record<string, unknown>;
    const configMeta = config!.metadata as Record<string, unknown>;
    // Detail is in the ontology — should NOT carry the unregistered flag (or flag === false).
    assert.notEqual(detailMeta.ontologyClassUnregistered, true);
    // Config is NOT in the ontology — must carry the flag === true.
    assert.equal(configMeta.ontologyClassUnregistered, true);
  });

  it('Test 4: descriptionSegments — joined description + migration provenance', async () => {
    const source = tmpDirSuffix('t4-src');
    const target = tmpDirSuffix('t4-tgt');
    cleanupDirs.push(source, target);

    await seedLevelDb(source, [
      {
        name: 'SegEntity',
        entityType: 'Detail',
        id: 'fixtureseg00001',
        observations: ['observation alpha', 'observation beta', 'observation gamma'],
        team: 'coding',
        metadata: { created_at: '2026-03-07T12:38:24.946Z', last_updated: '2026-03-21T06:36:53.211Z' },
      },
    ]);
    const outcome = runScript([
      `--source=${source}`,
      `--target=${target}`,
      `--ontology-dir=${ONTOLOGY_DIR}`,
      '--run-id=test4-segments-run',
    ]);
    assert.equal(outcome.status, 0);

    const entities = readMigratedEntities(target);
    const e = entities.find((x) => x.name === 'SegEntity');
    assert.ok(e);
    assert.ok(typeof e!.description === 'string');
    assert.ok((e!.description as string).includes('observation alpha'));
    assert.ok((e!.description as string).includes('observation beta'));
    const meta = e!.metadata as Record<string, unknown>;
    const segs = meta.descriptionSegments as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(segs));
    assert.equal(segs.length, 1);
    assert.equal(segs[0].runId, 'test4-segments-run');
    assert.equal(segs[0].provider, 'phase-42-migration');
    assert.equal(segs[0].model, 'b-to-km-core');
  });

  it('Test 5: embedding — copied verbatim when present; undefined when absent', async () => {
    const source = tmpDirSuffix('t5-src');
    const target = tmpDirSuffix('t5-tgt');
    cleanupDirs.push(source, target);

    const fixtureEmbedding = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2];
    await seedLevelDb(source, [
      {
        name: 'WithEmbedding',
        entityType: 'Detail',
        id: 'fixtureemb00001',
        observations: ['has embedding'],
        team: 'coding',
        embedding: fixtureEmbedding,
        metadata: { created_at: '2026-03-07T12:38:24.946Z', last_updated: '2026-03-21T06:36:53.211Z' },
      },
      {
        name: 'NoEmbedding',
        entityType: 'Detail',
        id: 'fixtureemb00002',
        observations: ['no embedding'],
        team: 'coding',
        metadata: { created_at: '2026-03-07T12:38:24.946Z', last_updated: '2026-03-21T06:36:53.211Z' },
      },
    ]);
    const outcome = runScript([
      `--source=${source}`,
      `--target=${target}`,
      `--ontology-dir=${ONTOLOGY_DIR}`,
      '--run-id=test5-run',
    ]);
    assert.equal(outcome.status, 0);

    const entities = readMigratedEntities(target);
    const withEmb = entities.find((e) => e.name === 'WithEmbedding');
    const noEmb = entities.find((e) => e.name === 'NoEmbedding');
    assert.ok(withEmb);
    assert.ok(noEmb);
    assert.deepEqual(withEmb!.embedding, fixtureEmbedding);
    // Output JSON serialization drops `undefined`; assert it is absent or undefined.
    assert.ok(noEmb!.embedding === undefined || noEmb!.embedding === null);
  });

  it('Test 6: provenance stamping — every entity carries migration stamp', async () => {
    const source = tmpDirSuffix('t6-src');
    const target = tmpDirSuffix('t6-tgt');
    cleanupDirs.push(source, target);

    await seedLevelDb(source, tenEntityFixture());
    const outcome = runScript([
      `--source=${source}`,
      `--target=${target}`,
      `--ontology-dir=${ONTOLOGY_DIR}`,
      '--run-id=test6-prov-run',
    ]);
    assert.equal(outcome.status, 0);

    const entities = readMigratedEntities(target);
    assert.ok(entities.length > 0);
    for (const e of entities) {
      const meta = e.metadata as Record<string, unknown>;
      const prov = meta.provenance as {
        createdBy: { provider: string; model: string; runId: string };
        lastConfirmedBy: { provider: string; model: string; runId: string };
        confirmationCount: number;
      };
      assert.ok(prov, `entity ${String(e.name)} missing metadata.provenance`);
      assert.equal(prov.createdBy.provider, 'phase-42-migration');
      assert.equal(prov.createdBy.model, 'b-to-km-core');
      assert.equal(prov.createdBy.runId, 'test6-prov-run');
      assert.equal(prov.confirmationCount, 1);
    }
  });

  it('Test 7: legacyId preservation + new id is parseable UUIDv7', async () => {
    const source = tmpDirSuffix('t7-src');
    const target = tmpDirSuffix('t7-tgt');
    cleanupDirs.push(source, target);

    await seedLevelDb(source, [
      {
        name: 'TranscriptAdapter',
        entityType: 'Detail',
        id: 'mc4flkglue8o7',
        observations: ['legacy nanoid id'],
        team: 'coding',
        metadata: { created_at: '2026-03-07T12:38:24.946Z', last_updated: '2026-03-21T06:36:53.211Z' },
      },
    ]);
    const outcome = runScript([
      `--source=${source}`,
      `--target=${target}`,
      `--ontology-dir=${ONTOLOGY_DIR}`,
      '--run-id=test7-run',
    ]);
    assert.equal(outcome.status, 0);

    const entities = readMigratedEntities(target);
    const e = entities.find((x) => x.name === 'TranscriptAdapter');
    assert.ok(e);
    const legacy = e!.legacyId as { system: string; id: string };
    assert.deepEqual(legacy, { system: 'B', id: 'mc4flkglue8o7' });
    // The new top-level id must be a parseable UUIDv7.
    const { parseEntityId } = await import('@fwornle/km-core');
    assert.doesNotThrow(() => parseEntityId(e!.id as string));
  });

  it('Test 8: --dry-run reports count but writes nothing', async () => {
    const source = tmpDirSuffix('t8-src');
    const target = tmpDirSuffix('t8-tgt');
    cleanupDirs.push(source, target);

    await seedLevelDb(source, tenEntityFixture());
    const outcome = runScript([
      `--source=${source}`,
      `--target=${target}`,
      `--ontology-dir=${ONTOLOGY_DIR}`,
      '--run-id=test8-dry-run',
      '--dry-run',
    ]);
    assert.equal(outcome.status, 0);
    assert.ok(outcome.summary);
    assert.equal(outcome.summary!.totalEntities, 10);
    // Target dataDir should NOT have been written to.
    const exportDir = path.join(target, 'exports');
    if (fs.existsSync(exportDir)) {
      const files = fs.readdirSync(exportDir).filter((f) => f.endsWith('.json'));
      // A fresh GraphKMStore.open() may create an empty export file with
      // `nodes: []` even in dry-run if the store was instantiated — assert
      // no entities landed regardless of file presence.
      let total = 0;
      for (const f of files) {
        const blob = JSON.parse(fs.readFileSync(path.join(exportDir, f), 'utf-8'));
        if (Array.isArray(blob?.nodes)) total += blob.nodes.length;
      }
      assert.equal(total, 0, 'dry-run wrote entities to target');
    }
  });

  it('Test 9a: error budget OK — 1/20 malformed (5%) exits 0', async () => {
    const source = tmpDirSuffix('t9a-src');
    const target = tmpDirSuffix('t9a-tgt');
    cleanupDirs.push(source, target);

    // 19 good + 1 malformed = 20 total; 1/20 = 5% (within budget)
    const good = tenEntityFixture().concat(
      tenEntityFixture().map((e, i) => ({
        ...e,
        name: `${e.name}_dup${i}`,
        id: `dup${i.toString().padStart(13, '0')}`,
      })),
    );
    // remove last good to leave 19
    good.pop();
    await seedLevelDbWithMalformed(source, good, 1);

    const outcome = runScript([
      `--source=${source}`,
      `--target=${target}`,
      `--ontology-dir=${ONTOLOGY_DIR}`,
      '--run-id=test9a-run',
    ]);
    assert.equal(outcome.status, 0, `expected exit 0 for 5% error budget; got ${outcome.status}; stderr=\n${outcome.stderr}`);
    assert.ok(outcome.summary);
    assert.equal(outcome.summary!.errorCount, 1);
    assert.equal(outcome.summary!.totalEntities, 20);
  });

  it('Test 9b: error budget exceeded — 2/20 malformed (10%) exits non-zero', async () => {
    const source = tmpDirSuffix('t9b-src');
    const target = tmpDirSuffix('t9b-tgt');
    cleanupDirs.push(source, target);

    const good = tenEntityFixture().concat(
      tenEntityFixture().map((e, i) => ({
        ...e,
        name: `${e.name}_dup${i}`,
        id: `dup${i.toString().padStart(13, '0')}`,
      })),
    );
    // remove last 2 good to leave 18
    good.pop();
    good.pop();
    await seedLevelDbWithMalformed(source, good, 2);

    const outcome = runScript([
      `--source=${source}`,
      `--target=${target}`,
      `--ontology-dir=${ONTOLOGY_DIR}`,
      '--run-id=test9b-run',
    ]);
    assert.notEqual(outcome.status, 0, 'expected non-zero exit for 10% error budget');
    assert.ok(outcome.summary);
    assert.equal(outcome.summary!.errorCount, 2);
    assert.equal(outcome.summary!.totalEntities, 20);
  });
});
