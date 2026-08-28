/**
 * Integration smoke for `WaveController.ensureProjectAnchor(runId)`
 * (Phase 42.1.2 Plan 03 — Task 1).
 *
 * Verification-Boundary contract (LOCKED in 42.1.2-CONTEXT.md
 * `<decisions>` § "Verification Boundary (LOCKED)" bullet 2):
 *
 *   1. Cold path — no pre-existing Project entity:
 *      `storeEntity` MUST be called exactly once with
 *      `{ name: 'Coding', entityType: 'Project', ontologyClass: 'Project' }`
 *      and the `{ team: 'coding' }` options object.
 *
 *   2. Warm path — `{ name: 'Coding', entityType: 'Project' }` already
 *      returned by `queryEntities`: `storeEntity` MUST NOT be called.
 *
 *   3. Idempotency — two back-to-back invocations produce exactly one
 *      `storeEntity` call across both calls (cold-then-warm sequence).
 *
 * Phase 42.1.2 Plan 02 covers the unit-level smoke (registry reports
 * `Project` as a valid class). This file covers the integration-level
 * smoke (the actual caller that motivated the phase — `ensureProjectAnchor`
 * at `src/agents/wave-controller.ts:2262` — no longer breaks, and its
 * idempotency invariant is preserved).
 *
 * Hard prohibitions (per Plan 03 `<action>`):
 *   - DOES NOT modify `src/agents/wave-controller.ts`. The private method is
 *     reached via a TypeScript `as unknown as { ... }` cast — purely a
 *     compile-time visibility hatch.
 *   - DOES NOT import the real `KmCoreAdapter` implementation or touch any
 *     real km-core registry / LevelDB. The fake adapter is a hand-rolled
 *     in-memory stub with `queryEntities` / `storeEntity` spies.
 *   - DOES NOT use any console.* methods. All forensic output goes through
 *     `process.stderr.write` (CLAUDE.md `no-console-log` constraint).
 *   - DOES NOT use vitest / jest / mocha. Built-in `node:test` only.
 *
 * Run via:
 *   cd integrations/semantic-analysis && npm run build && \
 *     node --test dist/agents/wave-controller-ensure-project-anchor.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';

import { WaveController } from './wave-controller.js';

// ---------------------------------------------------------------------------
// Local minimal types for the in-memory fake adapter. We deliberately do NOT
// import `KmCoreAdapter` from `../storage/km-core-adapter.js` — that pulls
// `@fwornle/km-core` into the test surface. Structural typing keeps the test
// self-contained and lets the `as unknown as { ensureProjectAnchor }` cast
// inject the fake without any real km-core dependency.
// ---------------------------------------------------------------------------

interface QueryFilter {
  entityType?: string;
  ontologyClass?: string;
  team?: string;
  [k: string]: unknown;
}

interface StoredEntity {
  name: string;
  entityType: string;
  [k: string]: unknown;
}

interface StoreEntityCall {
  entity: Record<string, unknown>;
  opts: { team: string };
}

interface QueryEntitiesCall {
  filter: QueryFilter;
}

/**
 * Constructs a fresh WaveController + spied fake adapter pair per test
 * (no state shared across tests). `queryReturn` is a getter so the
 * idempotency test can flip the stub's return value between back-to-back
 * invocations.
 *
 * The `repositoryPath` is a per-test os.tmpdir() subpath so that
 * `WorkflowReportAgent`'s constructor-side `mkdirSync('.data/workflow-reports')`
 * lands harmlessly under /tmp instead of polluting the real repo. The
 * `progressFile` points at a non-existent path under the same tmpdir —
 * `touchProgress()` is fail-soft so a missing file is a no-op.
 */
function buildHarness(opts: {
  queryReturn: () => StoredEntity[];
}): {
  controller: WaveController;
  ensureProjectAnchor: (runId: string) => Promise<void>;
  storeEntityCalls: StoreEntityCall[];
  queryEntitiesCalls: QueryEntitiesCall[];
  getPersistedNames: () => Set<string>;
} {
  const storeEntityCalls: StoreEntityCall[] = [];
  const queryEntitiesCalls: QueryEntitiesCall[] = [];

  const fakeAdapter = {
    async queryEntities(filter: QueryFilter = {}): Promise<StoredEntity[]> {
      queryEntitiesCalls.push({ filter });
      return opts.queryReturn();
    },
    async storeEntity(
      entity: Record<string, unknown>,
      options: { team: string },
    ): Promise<{ id: string }> {
      storeEntityCalls.push({ entity, opts: options });
      return { id: `fake-id-${storeEntityCalls.length}` };
    },
    // The other KmCoreAdapter methods are NOT exercised by ensureProjectAnchor.
    // ensureProjectAnchor's body (wave-controller.ts:2262-2305) only touches
    // queryEntities + storeEntity, so the structural cast below only requires
    // those two methods.
  };

  // Per-test sandbox under os.tmpdir(); WorkflowReportAgent will mkdir
  // `${repositoryPath}/.data/workflow-reports` from this root, which is
  // harmless and self-cleaning under tmpdir.
  const tmpRepo = path.join(
    os.tmpdir(),
    `wave-controller-ensure-project-anchor-test-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}`,
  );

  const controller = new WaveController({
    repositoryPath: tmpRepo,
    team: 'coding',
    progressFile: path.join(tmpRepo, 'workflow-progress.json'),
    maxAgentsPerWave: 1,
    failFast: false,
  });

  // Inject the fake adapter onto the private field. `as unknown as { ... }`
  // is a compile-time visibility hatch — the runtime field assignment is
  // exactly what the constructor would do on the production path when
  // KM_CORE_PERSISTENCE=km-core (see wave-controller.ts:95 + bootstrap site).
  const controllerInternals = controller as unknown as {
    kmCoreAdapter: typeof fakeAdapter;
    persistedEntityNames: Set<string>;
    ensureProjectAnchor: (runId: string) => Promise<void>;
  };
  controllerInternals.kmCoreAdapter = fakeAdapter;

  return {
    controller,
    ensureProjectAnchor: (runId: string): Promise<void> =>
      controllerInternals.ensureProjectAnchor(runId),
    storeEntityCalls,
    queryEntitiesCalls,
    getPersistedNames: (): Set<string> => controllerInternals.persistedEntityNames,
  };
}

describe('Phase 42.1.2 Plan 03 — WaveController.ensureProjectAnchor integration smoke', () => {
  // -------------------------------------------------------------------------
  // Test 1: COLD path — no pre-existing Project entity. ensureProjectAnchor
  // must mint exactly one Coding/Project entity through storeEntity with the
  // locked spy contract:
  //   entity.name           === 'Coding'
  //   entity.entityType     === 'Project'
  //   entity.ontologyClass  === 'Project'
  //   opts.team             === 'coding'
  // and add 'Coding' to the internal persistedEntityNames set.
  // -------------------------------------------------------------------------
  it('cold path: storeEntity called once with the locked Coding/Project contract', async () => {
    const harness = buildHarness({ queryReturn: () => [] });

    await harness.ensureProjectAnchor('test-run-id-cold');

    // queryEntities probed once with entityType: 'Project'
    assert.equal(
      harness.queryEntitiesCalls.length,
      1,
      'cold path: queryEntities called exactly once before deciding cold-vs-warm',
    );
    assert.equal(
      harness.queryEntitiesCalls[0].filter.entityType,
      'Project',
      "cold path: queryEntities filter.entityType === 'Project'",
    );

    // storeEntity called exactly once with the locked contract
    assert.equal(
      harness.storeEntityCalls.length,
      1,
      'cold path: storeEntity called exactly once (mint)',
    );
    const call = harness.storeEntityCalls[0];
    assert.equal(call.entity.name, 'Coding', "cold path: entity.name === 'Coding'");
    assert.equal(
      call.entity.entityType,
      'Project',
      "cold path: entity.entityType === 'Project'",
    );
    assert.equal(
      call.entity.ontologyClass,
      'Project',
      "cold path: entity.ontologyClass === 'Project' (km-core registry pin)",
    );
    assert.equal(call.opts.team, 'coding', "cold path: opts.team === 'coding'");

    // Defence-in-depth: the production code adds 'Coding' to persistedEntityNames
    // after a successful storeEntity (wave-controller.ts:2291). If a regression
    // moved that add() above the storeEntity call (or removed it), the relation
    // sweep would skip Coding-targeted edges as "unknown target".
    assert.ok(
      harness.getPersistedNames().has('Coding'),
      "cold path: persistedEntityNames must contain 'Coding' after successful mint",
    );

    process.stderr.write(
      "[wave-controller-ensure-project-anchor] cold path: storeEntity called once with { name: Coding, entityType: Project, ontologyClass: Project, team: coding }\n",
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: WARM path — Project/Coding already exists. ensureProjectAnchor
  // must return early (no storeEntity call). The pre-existing entity is
  // shaped as { name: 'Coding', entityType: 'Project' } — the minimum shape
  // ensureProjectAnchor inspects (see wave-controller.ts:2269
  // `existing.some((e) => e.name === 'Coding')`).
  // -------------------------------------------------------------------------
  it('warm path: storeEntity NOT called when Coding/Project already returned by queryEntities', async () => {
    const harness = buildHarness({
      queryReturn: () => [{ name: 'Coding', entityType: 'Project' }],
    });

    await harness.ensureProjectAnchor('test-run-id-warm');

    assert.equal(
      harness.queryEntitiesCalls.length,
      1,
      'warm path: queryEntities called exactly once',
    );
    assert.equal(
      harness.storeEntityCalls.length,
      0,
      'warm path: storeEntity NOT called (idempotent early return)',
    );

    process.stderr.write(
      '[wave-controller-ensure-project-anchor] warm path: storeEntity NOT called (early return on existing Coding/Project)\n',
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: IDEMPOTENCY — two back-to-back invocations must produce exactly
  // one storeEntity call across both calls. The fake adapter starts cold
  // (queryEntities returns []), then flips to warm (queryEntities returns
  // the just-minted Coding/Project) after the first storeEntity lands. This
  // simulates the entity being persisted between calls — the second call
  // takes the warm path and is a no-op for storeEntity.
  // -------------------------------------------------------------------------
  it('idempotency: two back-to-back calls produce exactly one storeEntity invocation', async () => {
    // Mutable "Coding minted?" flag flipped by the storeEntity spy.
    let codingMinted = false;
    const queryReturn = (): StoredEntity[] =>
      codingMinted ? [{ name: 'Coding', entityType: 'Project' }] : [];

    const harness = buildHarness({ queryReturn });

    // Wrap the spy so the second queryEntities call sees the post-mint state.
    // We can't easily flip from inside buildHarness's storeEntity stub without
    // re-architecting the harness, so we observe via the side-effect of the
    // first call landing in storeEntityCalls.
    const originalLength = harness.storeEntityCalls.length;
    await harness.ensureProjectAnchor('run-1');
    if (harness.storeEntityCalls.length > originalLength) {
      codingMinted = true;
    }
    await harness.ensureProjectAnchor('run-2');

    assert.equal(
      harness.storeEntityCalls.length,
      1,
      'idempotency: storeEntity called exactly once across two ensureProjectAnchor invocations',
    );
    assert.equal(
      harness.queryEntitiesCalls.length,
      2,
      'idempotency: queryEntities called exactly twice (once per ensureProjectAnchor invocation)',
    );

    // Spy contract on the single mint call still holds — locked contract
    // applies to the SOLE storeEntity call regardless of which invocation
    // produced it.
    const call = harness.storeEntityCalls[0];
    assert.equal(call.entity.name, 'Coding', "idempotency: the one mint had entity.name === 'Coding'");
    assert.equal(
      call.entity.entityType,
      'Project',
      "idempotency: the one mint had entity.entityType === 'Project'",
    );
    assert.equal(
      call.entity.ontologyClass,
      'Project',
      "idempotency: the one mint had entity.ontologyClass === 'Project'",
    );
    assert.equal(call.opts.team, 'coding', "idempotency: the one mint had opts.team === 'coding'");

    process.stderr.write(
      '[wave-controller-ensure-project-anchor] idempotency: two calls = one mint (locked contract preserved on the sole storeEntity invocation)\n',
    );
  });
});
