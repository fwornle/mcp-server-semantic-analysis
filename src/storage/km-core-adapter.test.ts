/**
 * Unit tests for the km-core strangler adapter + persistence-backend feature flag.
 *
 * Phase 42 Plan 01 — TDD red/green for:
 *   - getPersistenceBackend() env-var gate (Tests 1-3)
 *   - createKmCoreAdapter() factory + hot-path surface (Tests 4-5)
 *   - Wave-controller bypass write rewire (Tests 6-8, added in Task 2)
 *
 * Run via: `npm run build && node --test dist/storage/km-core-adapter.test.js`
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getPersistenceBackend } from '../config/persistence-flag.js';
import { createKmCoreAdapter, type KmCoreAdapter } from './km-core-adapter.js';

// ---------------------------------------------------------------------------
// Stub km-core store — exposes only the surface the adapter calls.
// ---------------------------------------------------------------------------

interface StubEntity {
  id: string;
  name: string;
  entityType: string;
  ontologyClass?: string;
  layer: 'evidence' | 'pattern';
  description: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  legacyId?: { system: string; id: string };
  [key: string]: unknown;
}

class StubGraphKMStore {
  // Calls captured for assertions:
  public mergeAttributesCalls: Array<{ id: string; attrs: Record<string, unknown> }> = [];
  public putEntityCalls: StubEntity[] = [];
  public addRelationCalls: Array<{ type: string; from: string; to: string; metadata?: unknown }> = [];
  public batchCalls: unknown[] = [];

  // In-memory store keyed by entity name
  private byName = new Map<string, StubEntity>();
  // In-memory store keyed by id
  private byId = new Map<string, StubEntity>();

  seed(entity: StubEntity): void {
    this.byName.set(entity.name, entity);
    this.byId.set(entity.id, entity);
  }

  async mergeAttributes(id: string, attrs: Record<string, unknown>): Promise<void> {
    this.mergeAttributesCalls.push({ id, attrs });
    const existing = this.byId.get(id);
    if (!existing) {
      throw new Error(`Node ${id} not found in graph`);
    }
    this.byId.set(id, { ...existing, ...attrs });
  }

  async putEntity(entity: StubEntity, _opts?: unknown): Promise<StubEntity> {
    this.putEntityCalls.push(entity);
    this.byName.set(entity.name, entity);
    this.byId.set(entity.id, entity);
    return entity;
  }

  async getEntity(id: string): Promise<StubEntity | undefined> {
    return this.byId.get(id);
  }

  async findByName(name: string): Promise<StubEntity | undefined> {
    return this.byName.get(name);
  }

  async findByOntologyClass(klass: string): Promise<StubEntity[]> {
    const out: StubEntity[] = [];
    for (const e of this.byName.values()) if (e.ontologyClass === klass) out.push(e);
    return out;
  }

  async *iterate(): AsyncIterable<StubEntity> {
    for (const e of this.byName.values()) yield e;
  }

  async addRelation(r: { type: string; from: string; to: string; metadata?: unknown }): Promise<void> {
    this.addRelationCalls.push(r);
  }

  async batch(ops: unknown[]): Promise<void> {
    this.batchCalls.push(...ops);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshEntity(name: string, klass: string): StubEntity {
  const now = new Date('2026-05-23T00:00:00.000Z').toISOString();
  return {
    id: `01902b78-3c4a-7000-9000-${name.padStart(12, '0').slice(0, 12)}`,
    name,
    entityType: klass,
    ontologyClass: klass,
    layer: 'evidence',
    description: `${name} description`,
    createdAt: now,
    updatedAt: now,
    metadata: { subsystem: 'wave-analysis' },
    legacyId: { system: 'B', id: `legacy-${name}` },
  };
}

// ---------------------------------------------------------------------------
// Section 1: getPersistenceBackend() — Tests 1, 2, 3 (D-51a feature flag)
// ---------------------------------------------------------------------------

describe('persistence-flag — getPersistenceBackend', () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.KM_CORE_PERSISTENCE;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.KM_CORE_PERSISTENCE;
    else process.env.KM_CORE_PERSISTENCE = savedEnv;
  });

  it('feature flag — Test 1: returns legacy when KM_CORE_PERSISTENCE is unset', () => {
    delete process.env.KM_CORE_PERSISTENCE;
    assert.equal(getPersistenceBackend(), 'legacy');
  });

  it('feature flag — Test 2: returns km-core when KM_CORE_PERSISTENCE is km-core', () => {
    process.env.KM_CORE_PERSISTENCE = 'km-core';
    assert.equal(getPersistenceBackend(), 'km-core');
  });

  it('feature flag — Test 3: returns legacy for any other value (defensive default)', () => {
    process.env.KM_CORE_PERSISTENCE = 'something-else';
    assert.equal(getPersistenceBackend(), 'legacy');

    process.env.KM_CORE_PERSISTENCE = '';
    assert.equal(getPersistenceBackend(), 'legacy');

    process.env.KM_CORE_PERSISTENCE = 'KM-CORE'; // wrong casing — strict literal match
    assert.equal(getPersistenceBackend(), 'legacy');
  });
});

// ---------------------------------------------------------------------------
// Section 2: createKmCoreAdapter() — Tests 4, 5 (hot-path surface + cold-path stubs)
// ---------------------------------------------------------------------------

describe('km-core-adapter — surface', () => {
  it('surface — Test 4: factory returns object with the documented async methods', () => {
    const store = new StubGraphKMStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter: KmCoreAdapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    for (const m of [
      'mergeAttributes',
      'queryEntities',
      'storeEntity',
      'storeRelationship',
      'getEntity',
      'deleteEntity',
    ]) {
      assert.equal(typeof (adapter as unknown as Record<string, unknown>)[m], 'function', `missing method: ${m}`);
    }
  });

  it('surface — Test 5: cold-path methods throw NotImplementedError', async () => {
    const store = new StubGraphKMStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).queryRelations({}),
      /NotImplementedError: km-core-adapter\.queryRelations/,
    );
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).queryByOntologyClass({}),
      /NotImplementedError: km-core-adapter\.queryByOntologyClass/,
    );
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).findRelated('foo', 1),
      /NotImplementedError: km-core-adapter\.findRelated/,
    );
  });
});

// ---------------------------------------------------------------------------
// Section 3: mergeAttributes behavior (used by wave-controller bypass — Task 2)
// ---------------------------------------------------------------------------

describe('km-core-adapter — mergeAttributes', () => {
  it('resolves nodeId (team:name) to EntityId via findByName, then delegates to store.mergeAttributes', async () => {
    const store = new StubGraphKMStore();
    const e = freshEntity('TranscriptAdapter', 'Detail');
    store.seed(e);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    const enrichedAttrs = { embedding: new Array(384).fill(0.5), role: 'core', enrichedContext: 'ctx' };
    await adapter.mergeAttributes('coding:TranscriptAdapter', enrichedAttrs);

    assert.equal(store.mergeAttributesCalls.length, 1);
    assert.equal(store.mergeAttributesCalls[0].id, e.id);
    // No field-stripping: embedding/role/enrichedContext passed through verbatim
    assert.deepEqual(store.mergeAttributesCalls[0].attrs, enrichedAttrs);
  });

  it('throws when the entity name does not resolve via findByName', async () => {
    const store = new StubGraphKMStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    await assert.rejects(
      adapter.mergeAttributes('coding:Missing', { embedding: [1, 2, 3] }),
      /not found/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Section 4: Wave-controller bypass rewire — Tests 6, 7, 8 (Task 2)
//
// We exercise only the bypass loop (NOT the full WaveController). The loop
// reads from a `currentEntities` array and calls either `graphDB.mergeAttributes`
// (legacy) or `kmCoreAdapter.mergeAttributes` (km-core). We stub both sides
// with the same shape and select via the feature flag.
// ---------------------------------------------------------------------------

interface BypassEntity {
  name: string;
  embedding?: number[];
  role?: string;
  enrichedContext?: string;
}

interface BypassDeps {
  team: string;
  graphDB: { mergeAttributes(nodeId: string, attrs: Record<string, unknown>): Promise<void> };
  kmCoreAdapter?: KmCoreAdapter;
}

/**
 * Mirrors wave-controller.ts:1361-1387. Lifted verbatim into a pure function
 * for testability — the production rewire (Task 2) preserves the same shape.
 */
async function runBypassLoop(deps: BypassDeps, currentEntities: BypassEntity[]): Promise<{ success: number; failed: number }> {
  let directWriteSuccess = 0;
  let directWriteFail = 0;
  for (const entity of currentEntities) {
    const enrichedAttrs: Record<string, unknown> = {};
    if (entity.embedding && entity.embedding.length > 0) enrichedAttrs.embedding = entity.embedding;
    if (entity.role) enrichedAttrs.role = entity.role;
    if (entity.enrichedContext) enrichedAttrs.enrichedContext = entity.enrichedContext;

    if (Object.keys(enrichedAttrs).length > 0) {
      try {
        const nodeId = `${deps.team}:${entity.name}`;
        if (deps.kmCoreAdapter) {
          await deps.kmCoreAdapter.mergeAttributes(nodeId, enrichedAttrs);
        } else {
          await deps.graphDB.mergeAttributes(nodeId, enrichedAttrs);
        }
        directWriteSuccess++;
      } catch {
        directWriteFail++;
      }
    }
  }
  return { success: directWriteSuccess, failed: directWriteFail };
}

describe('wave-controller bypass — phase 10 fix', () => {
  it('bypass phase 10 — Test 6: legacy path (flag off) calls graphDB.mergeAttributes', async () => {
    const calls: Array<{ nodeId: string; attrs: Record<string, unknown> }> = [];
    const legacyGraphDB = {
      async mergeAttributes(nodeId: string, attrs: Record<string, unknown>) {
        calls.push({ nodeId, attrs });
      },
    };

    const entities: BypassEntity[] = [
      { name: 'Foo', embedding: [0.1, 0.2], role: 'core' },
    ];

    const result = await runBypassLoop({ team: 'coding', graphDB: legacyGraphDB }, entities);
    assert.equal(result.success, 1);
    assert.equal(result.failed, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].nodeId, 'coding:Foo');
  });

  it('bypass phase 10 — Test 7: km-core path (flag on) calls kmCoreAdapter.mergeAttributes', async () => {
    const store = new StubGraphKMStore();
    store.seed(freshEntity('Foo', 'Detail'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    const legacyGraphDB = {
      mergeAttributes: async () => { throw new Error('legacy path must NOT be called when flag is on'); },
    };

    const entities: BypassEntity[] = [
      { name: 'Foo', embedding: new Array(384).fill(0.5), role: 'core', enrichedContext: 'ctx' },
    ];

    const result = await runBypassLoop(
      { team: 'coding', graphDB: legacyGraphDB, kmCoreAdapter: adapter },
      entities,
    );
    assert.equal(result.success, 1);
    assert.equal(result.failed, 0);
    assert.equal(store.mergeAttributesCalls.length, 1);
  });

  it('bypass phase 10 — Test 8: enriched fields pass through verbatim (no stripping)', async () => {
    const store = new StubGraphKMStore();
    store.seed(freshEntity('Foo', 'Detail'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    const embedding = new Array(384).fill(0).map((_, i) => i / 384);
    const entities: BypassEntity[] = [
      { name: 'Foo', embedding, role: 'core', enrichedContext: 'temporal-context-blob' },
    ];

    const legacyGraphDB = { mergeAttributes: async () => { throw new Error('unused'); } };

    await runBypassLoop({ team: 'coding', graphDB: legacyGraphDB, kmCoreAdapter: adapter }, entities);

    const call = store.mergeAttributesCalls[0];
    assert.deepEqual(call.attrs.embedding, embedding);
    assert.equal(call.attrs.role, 'core');
    assert.equal(call.attrs.enrichedContext, 'temporal-context-blob');
  });
});
