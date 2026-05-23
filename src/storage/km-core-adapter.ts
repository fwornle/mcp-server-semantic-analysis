/**
 * km-core strangler adapter — Phase 42 Plan 01.
 *
 * Exposes the hot read/write surface that B's existing consumers
 * (`persistence-agent.ts`, `wave-controller.ts`, `content-validation-agent.ts`,
 * `tools.ts`) call on `GraphDatabaseService` / `GraphDatabaseAdapter`, but
 * routes the calls through km-core's canonical `GraphKMStore` instead.
 *
 * The `KM_CORE_PERSISTENCE` feature flag was deleted in Phase 42 Plan 07
 * Phase B1; this adapter is now the unconditional persistence backend in
 * wave-controller. GraphDatabaseService is still in tree (deferred), but
 * wave-controller no longer reads from it for the persist path.
 *
 * Surface (RESEARCH §3 — caller heat map of GraphDatabaseService methods):
 *
 *   HOT (non-zero callers in src/ — adapter must implement):
 *     - mergeAttributes(nodeId, attrs)     ← Phase 10 fix anchor (wave-controller:1373)
 *     - queryEntities(options)             ← 13 callers
 *     - storeEntity(entity, opts)          ←  6 callers
 *     - storeRelationship(from, to, type)  ←  4 callers
 *     - getEntity(name, team)              ←  4 callers
 *     - deleteEntity(name, team, opts)     ←  6 callers
 *
 *   COLD (zero callers in src/ — adapter throws NotImplementedError):
 *     - queryRelations
 *     - queryByOntologyClass
 *     - findRelated
 *
 * Entity-shape translation follows the D-54 mapping table
 * (.planning/phases/42-offline-ukb-migration-b/42-RESEARCH.md §4).
 *
 * NOTE on the Phase 39 CF-D37 ratification: `legacyId` lives on the
 * top-level Entity (NOT inside metadata). The adapter respects this.
 */

import type {
  Entity,
  Relation,
  GraphKMStore,
  BatchOp,
  ProvenanceStamp,
} from '@fwornle/km-core';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface KmCoreAdapter {
  /**
   * Operator-enriched bulk write — phase 10 anchor.
   *
   * `nodeId` follows B's existing `${team}:${entityName}` convention. The
   * adapter looks the entity up via `store.findByName(name)` to resolve the
   * EntityId, then delegates to `store.mergeAttributes(id, attrs)` (which
   * itself calls Graphology's `mergeNodeAttributes` — see km-core
   * GraphKMStore.ts:854).
   *
   * Throws if the entity is not found in the store (matches km-core's
   * existing `Node ${id} not found in graph` contract).
   */
  mergeAttributes(nodeId: string, attrs: Record<string, unknown>): Promise<void>;

  /**
   * Filtered list of entities. Iterates the store and applies filters.
   * When only `ontologyClass` is set, the adapter takes the fast path via
   * `store.findByOntologyClass`.
   */
  queryEntities(options?: QueryEntitiesOptions): Promise<Entity[]>;

  /**
   * Write a new entity (or upsert by id when caller supplies one). Translates
   * B's SharedMemoryEntity-ish shape into the canonical km-core Entity per
   * D-54. Returns `{ id }` matching B's existing return contract.
   */
  storeEntity(
    entity: Record<string, unknown>,
    options: { team: string },
  ): Promise<{ id: string }>;

  /**
   * Add a relation by entity-name (B's convention). Resolves both names to
   * EntityIds via `store.findByName` then calls `store.addRelation`.
   */
  storeRelationship(
    fromName: string,
    toName: string,
    type: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Read one entity by name. The `team` argument is currently ignored —
   * km-core is single-tenant per store instance and Plan 5 migrates the
   * team-tagging into `metadata.team`.
   */
  getEntity(name: string, team: string): Promise<Entity | undefined>;

  /**
   * Delete one entity by name. If the entity is not found, returns silently
   * (matches B's no-op behavior at GraphDatabaseService.js:513-597).
   */
  deleteEntity(name: string, team: string, options?: Record<string, unknown>): Promise<void>;

  // Cold-path stubs — throw NotImplementedError. Fill in when a caller appears.
  queryRelations(options?: Record<string, unknown>): Promise<never>;
  queryByOntologyClass(options?: Record<string, unknown>): Promise<never>;
  findRelated(entityName: string, depth?: number, filter?: unknown): Promise<never>;
}

export interface QueryEntitiesOptions {
  team?: string;
  searchTerm?: string;
  ontologyClass?: string;
  entityType?: string;
  limit?: number;
  offset?: number;
}

export interface CreateKmCoreAdapterOptions {
  store: GraphKMStore;
  team: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a `KmCoreAdapter` bound to a `GraphKMStore` instance.
 *
 * The `team` argument is captured for storeEntity / mergeAttributes
 * provenance stamping and for the legacy `${team}:${name}` nodeId
 * convention. km-core's store is single-tenant per instance — Plan 5
 * migrates team-tagging into `metadata.team`.
 */
export function createKmCoreAdapter(opts: CreateKmCoreAdapterOptions): KmCoreAdapter {
  const { store, team } = opts;

  /** Migration provenance stamp for storeEntity writes. */
  const provenance = (): ProvenanceStamp => ({
    provider: 'phase-42-strangler-adapter',
    model: 'b-to-km-core',
    runId: `wave-analysis-${team}`,
    timestamp: new Date().toISOString(),
  });

  /**
   * Resolve entity by name via async iteration (km-core's GraphKMStore does
   * not expose a `findByName` — iterate(filter) is the documented lookup
   * path per D-18; this scans linearly and is fine for B's small graphs).
   *
   * Plan 5+ can add a name → id index in km-core if profiling shows this
   * is a hot path. For Plan 1 the wave-controller bypass loop runs
   * <1000x per `ukb full` (one merge per entity), so O(n) per call is OK.
   */
  async function findEntityByName(name: string): Promise<Entity | undefined> {
    for await (const e of store.iterate()) {
      if (e.name === name) return e;
    }
    return undefined;
  }

  /** Resolve `${team}:${name}` → Entity by stripping the team prefix. */
  async function resolveByNodeId(nodeId: string): Promise<Entity | undefined> {
    const name = nodeId.includes(':') ? nodeId.split(':').slice(1).join(':') : nodeId;
    return findEntityByName(name);
  }

  // -------------------------------------------------------------------------
  // mergeAttributes — phase 10 anchor
  // -------------------------------------------------------------------------

  async function mergeAttributes(nodeId: string, attrs: Record<string, unknown>): Promise<void> {
    const entity = await resolveByNodeId(nodeId);
    if (!entity) {
      throw new Error(`km-core-adapter.mergeAttributes: entity not found for nodeId='${nodeId}'`);
    }
    await store.mergeAttributes(entity.id, attrs as Partial<Entity>);
  }

  // -------------------------------------------------------------------------
  // queryEntities — fast path via findByOntologyClass when applicable
  // -------------------------------------------------------------------------

  async function queryEntities(options: QueryEntitiesOptions = {}): Promise<Entity[]> {
    const { searchTerm, ontologyClass, entityType, limit, offset } = options;

    // Fast path: a class filter alone — defer to km-core's class index
    const classFilter = ontologyClass ?? entityType;
    let candidates: Entity[];
    if (classFilter && !searchTerm) {
      candidates = await store.findByOntologyClass(classFilter);
    } else {
      candidates = [];
      for await (const e of store.iterate()) candidates.push(e);
    }

    // Apply remaining filters
    const filtered = candidates.filter((e) => {
      if (classFilter && e.ontologyClass !== classFilter && e.entityType !== classFilter) return false;
      if (searchTerm) {
        const needle = searchTerm.toLowerCase();
        const hay = `${e.name} ${e.description ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });

    const start = offset ?? 0;
    const end = typeof limit === 'number' ? start + limit : undefined;
    return filtered.slice(start, end);
  }

  // -------------------------------------------------------------------------
  // storeEntity — SharedMemoryEntity → canonical Entity per D-54
  // -------------------------------------------------------------------------

  async function storeEntity(
    source: Record<string, unknown>,
    _options: { team: string },
  ): Promise<{ id: string }> {
    const name = String(source.name ?? '');
    if (!name) throw new Error('km-core-adapter.storeEntity: entity.name is required');

    const entityType = String(source.entityType ?? source.type ?? 'Unclassified');
    const ontologyClass = String(source.ontologyClass ?? entityType);

    // ID handling: existing legacy id → top-level legacyId.id. The canonical
    // EntityId is minted by km-core's putEntity (D-10) and returned from
    // the call. Per Phase 39 CF-D37, legacyId lives at the top level.
    const incomingId = source.id ? String(source.id) : undefined;
    const legacyId = incomingId ? ({ system: 'B' as const, id: incomingId }) : undefined;

    // Description: prefer explicit description; else join observations.
    let description = '';
    if (typeof source.description === 'string') {
      description = source.description;
    } else if (Array.isArray(source.observations)) {
      description = (source.observations as unknown[])
        .map((o) => (typeof o === 'string' ? o : (o as { content?: unknown })?.content ?? ''))
        .filter(Boolean)
        .join('\n\n');
    }

    const now = new Date().toISOString();
    const sourceMetadata = (typeof source.metadata === 'object' && source.metadata !== null)
      ? (source.metadata as Record<string, unknown>)
      : {};

    // Build the putEntity payload (id is minted by the store; createdAt /
    // updatedAt are stamped by the store on the strict path per D-31/D-32).
    const entity: Partial<Entity> & { name: string; entityType: string } = {
      name,
      entityType,
      ontologyClass,
      layer: 'evidence',
      description,
      metadata: {
        ...sourceMetadata,
        subsystem: 'wave-analysis',
        ...(typeof source.significance !== 'undefined' ? { significance: source.significance } : {}),
        ...(typeof source.source !== 'undefined' ? { source: source.source } : {}),
        // Operator-enriched fields ride along on metadata until Plan 5
        // teaches consumers to read them from top-level Entity:
        ...(typeof (source as { embedding?: unknown }).embedding !== 'undefined'
          ? { embedding: (source as { embedding?: unknown }).embedding }
          : {}),
        ...(typeof (source as { role?: unknown }).role !== 'undefined'
          ? { role: (source as { role?: unknown }).role }
          : {}),
        ...(typeof (source as { enrichedContext?: unknown }).enrichedContext !== 'undefined'
          ? { enrichedContext: (source as { enrichedContext?: unknown }).enrichedContext }
          : {}),
      },
      validFrom: now,
      ...(legacyId ? { legacyId } : {}),
    };

    const mintedId = await store.putEntity(entity, { provenance: provenance() });
    return { id: String(mintedId) };
  }

  // -------------------------------------------------------------------------
  // storeRelationship — name-to-name → id-to-id
  // -------------------------------------------------------------------------

  async function storeRelationship(
    fromName: string,
    toName: string,
    type: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const [from, to] = await Promise.all([
      findEntityByName(fromName),
      findEntityByName(toName),
    ]);
    if (!from) {
      throw new Error(`km-core-adapter.storeRelationship: from-entity '${fromName}' not found`);
    }
    if (!to) {
      throw new Error(`km-core-adapter.storeRelationship: to-entity '${toName}' not found`);
    }
    const relation: Relation = {
      type,
      from: from.id,
      to: to.id,
      metadata,
    } as Relation;
    await store.addRelation(relation);
  }

  // -------------------------------------------------------------------------
  // getEntity / deleteEntity
  // -------------------------------------------------------------------------

  async function getEntity(name: string, _team: string): Promise<Entity | undefined> {
    return findEntityByName(name);
  }

  async function deleteEntity(
    name: string,
    _team: string,
    _options: Record<string, unknown> = {},
  ): Promise<void> {
    const entity = await findEntityByName(name);
    if (!entity) {
      // Mirrors B's no-op behavior at GraphDatabaseService.js:513-597
      return;
    }
    const ops: BatchOp[] = [{ type: 'deleteEntity', id: entity.id }];
    await store.batch(ops);
  }

  // -------------------------------------------------------------------------
  // Cold-path stubs — RESEARCH §3 closing recommendation
  // -------------------------------------------------------------------------

  async function queryRelations(_options?: Record<string, unknown>): Promise<never> {
    throw new Error(
      'NotImplementedError: km-core-adapter.queryRelations — no callers in src/, fill in when needed',
    );
  }
  async function queryByOntologyClass(_options?: Record<string, unknown>): Promise<never> {
    throw new Error(
      'NotImplementedError: km-core-adapter.queryByOntologyClass — no callers in src/, fill in when needed',
    );
  }
  async function findRelated(_entityName: string, _depth?: number, _filter?: unknown): Promise<never> {
    throw new Error(
      'NotImplementedError: km-core-adapter.findRelated — no callers in src/, fill in when needed',
    );
  }

  return {
    mergeAttributes,
    queryEntities,
    storeEntity,
    storeRelationship,
    getEntity,
    deleteEntity,
    queryRelations,
    queryByOntologyClass,
    findRelated,
  };
}
