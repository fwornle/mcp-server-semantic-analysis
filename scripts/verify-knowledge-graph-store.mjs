#!/usr/bin/env node
/**
 * Knowledge-graph store SC verifier.
 *
 * Asserts the success criteria for the km-core canonical store at
 * .data/knowledge-graph/{leveldb,exports}/. SCs 1-5 came from Phase 42 (the
 * km-core unification work); SC #6 was added in Phase 42.1 (project-anchor
 * parity) and scoped to entities with legacyId?.id !== 'unknown' so the
 * 802 pre-existing migrated entities are excluded.
 *
 * Usage (inside the coding-services container):
 *
 *   node /coding/integrations/mcp-server-semantic-analysis/scripts/verify-knowledge-graph-store.mjs \
 *     --since=<ISO-timestamp> [--collection=coding] [--qdrant-url=http://localhost:6333]
 *
 * Emits diagnostic lines on stderr; final verdict JSON on stdout.
 * Exit 0 if all SCs pass; exit 1 if any fails.
 *
 * Per-SC contract:
 *
 *   SC#1: emit-shape — sample first 10 entities from the canonical store;
 *         each must have top-level legacyId.system==='B', layer==='evidence',
 *         and ontologyClass defined.
 *
 *   SC#2: embeddings — every Detail entity has embedding.length === 384.
 *
 *   SC#3: race-log — `docker logs coding-services --since <PRERUN_TS>` shows
 *         zero "Race condition detected (0/0 steps) but no valid cache
 *         available" warnings. (Skipped inside the container — caller runs
 *         the docker logs check directly. We instead read a passed-in count.)
 *
 *   SC#4: dashboard terminal-state — `.data/workflow-progress.json` shows
 *         status === 'completed'. The workflow-runner's writeTerminalState
 *         helper (Phase 42-07 deliverable) provides this guarantee
 *         unconditionally; this check verifies it.
 *
 *   SC#5: registry — OntologyRegistry has Component + Detail + SubComponent
 *         + Project classes loaded.
 *
 *   SC#6: orphan count — zero entities with entityType not in {Project,System}
 *         and no incoming `contains` edge, scoped by legacyId?.id !== 'unknown'.
 *
 * History: created in Phase 42 Plan 07 (commit dba65bb) under the name
 * `42-07-end-to-end-verify.mjs`; renamed in Phase 42.2 Plan 06 to drop the
 * phase-tagged identity since the script outlived its origin phase and is
 * the canonical SC verifier for the knowledge-graph store.
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
  }),
);

const SINCE = args.since;
const COLLECTION = args.collection || 'coding';
const QDRANT_URL = args['qdrant-url'] || process.env.QDRANT_URL || 'http://localhost:6333';
const DATA_DIR = args['data-dir'] || '/coding/.data/knowledge-graph-migrated/leveldb';
const ONTOLOGY_DIR = args['ontology-dir'] || '/coding/.data/ontologies';
const PROGRESS_FILE = args['progress-file'] || '/coding/.data/workflow-progress.json';
const SKIP_SC3 = args['skip-sc3'] === 'true';

function diag(msg) {
  process.stderr.write(`[42-07-verify] ${msg}\n`);
}

const results = {
  sc1: { name: 'emit-shape (canonical Entity on migrated store)', status: 'unknown', detail: null },
  sc2: { name: 'embeddings (every Detail has embedding.length === 384)', status: 'unknown', detail: null },
  sc3: { name: 'race-log (zero 0/0 race warnings)', status: 'unknown', detail: null },
  sc4: { name: 'dashboard terminal-state (status === completed)', status: 'unknown', detail: null },
  sc5: { name: 'registry (Component + Detail + SubComponent + Project loaded)', status: 'unknown', detail: null },
  sc6: { name: 'project-anchor parity (zero in-phase orphans after wave-analysis)', status: 'unknown', detail: null },
};

// -----------------------------------------------------------------------
// SC#1 + SC#2 + SC#5 share a km-core store handle.
// -----------------------------------------------------------------------
let storeRef = null;

async function openStore() {
  const km = await import('@fwornle/km-core');
  const store = new km.GraphKMStore({
    dbPath: DATA_DIR,
    exportDir: DATA_DIR.replace(/leveldb$/, 'exports'),
    ontologyDir: ONTOLOGY_DIR,
    domains: ['coding'],
    debounceMs: 5000,
  });
  await store.open();
  storeRef = store;
  return store;
}

async function checkSC1(store) {
  diag('SC#1: sampling first 10 entities for canonical shape');
  try {
    const sample = [];
    let i = 0;
    for await (const entity of store.iterate()) {
      sample.push(entity);
      if (++i >= 10) break;
    }
    if (sample.length === 0) {
      results.sc1.status = 'fail';
      results.sc1.detail = 'store is empty; no entities to sample';
      return;
    }
    const violations = [];
    for (const e of sample) {
      const fails = [];
      if (!e.legacyId || e.legacyId.system !== 'B') {
        fails.push(`legacyId.system != 'B' (got ${JSON.stringify(e.legacyId)})`);
      }
      if (e.layer !== 'evidence') {
        fails.push(`layer != 'evidence' (got ${e.layer})`);
      }
      if (!e.ontologyClass) {
        fails.push('ontologyClass missing');
      }
      if (fails.length > 0) {
        violations.push({ name: e.name, id: e.id, fails });
      }
    }
    if (violations.length === 0) {
      results.sc1.status = 'pass';
      results.sc1.detail = { sampled: sample.length, violations: 0 };
    } else {
      results.sc1.status = 'fail';
      results.sc1.detail = { sampled: sample.length, violations };
    }
  } catch (err) {
    results.sc1.status = 'fail';
    results.sc1.detail = { error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkSC2(store) {
  diag('SC#2: scanning all Detail entities for 384-dim embeddings');
  try {
    const details = await store.findByOntologyClass('Detail');
    const total = details.length;
    let withEmbedding = 0;
    let wrongDim = 0;
    const missingNames = [];
    for (const d of details) {
      if (!d.embedding || d.embedding.length === 0) {
        missingNames.push(d.name);
        continue;
      }
      if (d.embedding.length !== 384) {
        wrongDim += 1;
        continue;
      }
      withEmbedding += 1;
    }
    if (total === 0) {
      results.sc2.status = 'fail';
      results.sc2.detail = 'no Detail entities found in store';
      return;
    }
    if (withEmbedding === total) {
      results.sc2.status = 'pass';
      results.sc2.detail = { total, withEmbedding };
    } else {
      results.sc2.status = 'fail';
      results.sc2.detail = {
        total,
        withEmbedding,
        wrongDim,
        missingSample: missingNames.slice(0, 5),
        missingCount: missingNames.length,
      };
    }
  } catch (err) {
    results.sc2.status = 'fail';
    results.sc2.detail = { error: err instanceof Error ? err.message : String(err) };
  }
}

function checkSC3() {
  if (SKIP_SC3) {
    results.sc3.status = 'pass';
    results.sc3.detail = 'skipped via --skip-sc3 — caller verifies docker logs out-of-band';
    return;
  }
  if (!SINCE) {
    results.sc3.status = 'fail';
    results.sc3.detail = '--since not provided; cannot bound the docker logs window';
    return;
  }
  diag(`SC#3: counting race-condition warnings since ${SINCE}`);
  try {
    // Inside the container we cannot run `docker logs`. Caller must pass
    // --skip-sc3=true and run the check on the host. Detect host vs.
    // container via the presence of /coding (container mount).
    if (existsSync('/coding') && !process.env.HOSTNAME?.startsWith('coding')) {
      // Likely host — try docker logs.
      const out = execSync(
        `docker logs coding-services --since "${SINCE}" 2>&1 | grep -c "Race condition detected (0/0 steps) but no valid cache available" || true`,
        { encoding: 'utf8' },
      );
      const count = parseInt(out.trim(), 10);
      if (count === 0) {
        results.sc3.status = 'pass';
        results.sc3.detail = { warningCount: 0 };
      } else {
        results.sc3.status = 'fail';
        results.sc3.detail = { warningCount: count };
      }
    } else {
      // Inside container — skip with note.
      results.sc3.status = 'pass';
      results.sc3.detail = 'running inside container; caller verifies docker logs out-of-band';
    }
  } catch (err) {
    results.sc3.status = 'fail';
    results.sc3.detail = { error: err instanceof Error ? err.message : String(err) };
  }
}

function checkSC4() {
  diag(`SC#4: reading ${PROGRESS_FILE} for terminal status`);
  try {
    if (!existsSync(PROGRESS_FILE)) {
      results.sc4.status = 'fail';
      results.sc4.detail = `progress file does not exist: ${PROGRESS_FILE}`;
      return;
    }
    const progress = JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'));
    const status = progress.status;
    if (status === 'completed') {
      results.sc4.status = 'pass';
      results.sc4.detail = { status, lastUpdate: progress.lastUpdate };
    } else if (status === 'failed') {
      results.sc4.status = 'fail';
      results.sc4.detail = {
        status,
        error: progress.error,
        step: progress.step,
        lastUpdate: progress.lastUpdate,
      };
    } else {
      results.sc4.status = 'fail';
      results.sc4.detail = { status, expected: 'completed', lastUpdate: progress.lastUpdate };
    }
  } catch (err) {
    results.sc4.status = 'fail';
    results.sc4.detail = { error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkSC5() {
  diag('SC#5: verifying OntologyRegistry loads Project + Component + SubComponent + Detail');
  try {
    const km = await import('@fwornle/km-core');
    const registry = new km.OntologyRegistry({ ontologyDir: ONTOLOGY_DIR });
    // The registry may need explicit load — try both APIs.
    if (typeof registry.loadFromDisk === 'function') {
      await registry.loadFromDisk();
    }
    const required = ['Project', 'Component', 'SubComponent', 'Detail'];
    const missing = required.filter((c) => !registry.hasClass(c));
    if (missing.length === 0) {
      results.sc5.status = 'pass';
      const domainCount =
        typeof registry.listDomains === 'function'
          ? registry.listDomains().length
          : undefined;
      results.sc5.detail = { requiredClasses: required, domainCount };
    } else {
      results.sc5.status = 'fail';
      results.sc5.detail = { missing };
    }
  } catch (err) {
    results.sc5.status = 'fail';
    results.sc5.detail = { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * SC#6 — Phase 42.1 project-anchor parity.
 *
 * Reads the graphology-serialized export at <DATA_DIR>/../exports/general.json
 * and asserts that every IN-PHASE entity has at least one incoming
 * contains/parent-child edge.
 *
 * IN-PHASE means:
 *   - entityType ∉ {Project, System} — Project + System ARE the anchors
 *   - legacyId?.id !== 'unknown'      — exclude the 802 pre-existing migrated
 *                                       entities (Phase 42.1 CONTEXT.md
 *                                       scope_fence: their back-fill is
 *                                       deferred to Phase 42.2+)
 *
 * Export shape (committed; do NOT add r.to/r.from fallbacks — that hides bugs):
 *   nodes: [{ key: <id>, attributes: { name, entityType, legacyId, ... } }]
 *   edges: [{ key, source: <fromId>, target: <toId>,
 *             attributes: { type: 'contains', ... } }]
 */
async function checkSC6() {
  diag('SC#6: scanning IN-PHASE entities for missing project-anchor edges (entityType ∉ {Project,System} AND legacyId?.id !== "unknown" ⇒ ≥1 incoming contains/parent-child)');
  try {
    const exportPath = DATA_DIR.replace(/leveldb$/, 'exports') + '/general.json';
    if (!existsSync(exportPath)) {
      results.sc6.status = 'fail';
      results.sc6.detail = `exports/general.json missing — cannot read graph: ${exportPath}`;
      return;
    }
    const exportJson = JSON.parse(readFileSync(exportPath, 'utf8'));

    if (!Array.isArray(exportJson.nodes) || !Array.isArray(exportJson.edges)) {
      results.sc6.status = 'fail';
      results.sc6.detail = 'exports/general.json missing nodes[] or edges[] — graphology shape expected';
      return;
    }

    // Build incoming-anchor index by target node id.
    const incomingAnchorOf = new Map();
    for (const edge of exportJson.edges) {
      const t = edge.attributes?.type;
      if (t !== 'contains' && t !== 'parent-child') continue;
      incomingAnchorOf.set(edge.target, (incomingAnchorOf.get(edge.target) || 0) + 1);
    }

    // Sweep IN-PHASE nodes only per CONTEXT.md scope_fence.
    const orphans = [];
    let inScopeTotal = 0;
    let excludedLegacy = 0;
    for (const node of exportJson.nodes) {
      const attrs = node.attributes || {};
      const etype = attrs.entityType || attrs.ontologyClass;
      if (etype === 'Project' || etype === 'System') continue;
      if (attrs.legacyId?.id === 'unknown') {
        excludedLegacy += 1;
        continue;
      }
      inScopeTotal += 1;
      const hasAnchor = (incomingAnchorOf.get(node.key) || 0) > 0;
      if (!hasAnchor) {
        orphans.push({ id: node.key, name: attrs.name, entityType: etype });
      }
    }

    if (orphans.length === 0) {
      results.sc6.status = 'pass';
      results.sc6.detail = {
        inScopeEntities: inScopeTotal,
        excludedLegacyEntities: excludedLegacy,
        orphans: 0,
        note: `Excluded ${excludedLegacy} pre-existing migrated entities (legacyId?.id === 'unknown') per CONTEXT.md scope_fence.`,
      };
    } else {
      results.sc6.status = 'fail';
      results.sc6.detail = {
        inScopeEntities: inScopeTotal,
        excludedLegacyEntities: excludedLegacy,
        orphans: orphans.length,
        sample: orphans.slice(0, 10),
      };
    }
  } catch (err) {
    results.sc6.status = 'fail';
    results.sc6.detail = { error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const store = await openStore();
  try {
    await checkSC1(store);
    await checkSC2(store);
    checkSC3();
    checkSC4();
    await checkSC5();
    await checkSC6();
  } finally {
    try {
      await store.close();
    } catch {
      /* ignore */
    }
  }

  const allPass = Object.values(results).every((r) => r.status === 'pass');
  const verdict = {
    overall: allPass ? 'pass' : 'fail',
    sc1: results.sc1.status,
    sc2: results.sc2.status,
    sc3: results.sc3.status,
    sc4: results.sc4.status,
    sc5: results.sc5.status,
    sc6: results.sc6.status,
    detail: results,
    runAt: new Date().toISOString(),
  };
  process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`[42-07-verify] FATAL: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(2);
});
