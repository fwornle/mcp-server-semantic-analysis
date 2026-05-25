/**
 * Phase 42.2 Plan 04 — extracted types from the retired persistence trio.
 *
 * `SharedMemoryEntity`, `EntityRelationship`, `ObservationObject`, and
 * `EntityMetadata` were originally defined in `src/agents/persistence-agent.ts`.
 * `GraphEntity` was originally defined in `src/storage/graph-database-adapter.ts`.
 * Both files were deleted in Phase 42.2 Plan 04; consumers (wave-controller.ts
 * primarily, plus the wave-controller-canonical-emit.test.ts regression
 * guard) still reference these shapes for in-memory bookkeeping, so the
 * type definitions live here as a shared, dependency-free module.
 *
 * Identifier shapes match the legacy definitions byte-for-byte; downstream
 * call sites needed zero adjustment beyond the import path.
 */

export interface ObservationObject {
  type: string;
  content: string;
  date: string;
  metadata?: Record<string, unknown>;
}

export interface EntityRelationship {
  from: string;
  to: string;
  relationType: string;
}

export interface EntityMetadata {
  created_at?: string;
  last_updated?: string;
  created_by?: string;
  version?: string;
  team?: string;
  source?: string;
  context?: string;
  tags?: string[];
  validated_file_path?: string;
  has_insight_document?: boolean;
  invalidating_commits?: string[];
  staleness_score?: number;
  staleness_check_at?: string;
  staleness_method?: string;
  renamedFrom?: string;
  renamedAt?: string;
  mixed_topics?: boolean;
  mixed_topics_pairs?: Array<{ a: number; b: number; similarity: number }>;
  ontology?: {
    ontologyName?: string;
    ontologyClass: string;
    ontologyVersion: string;
    confidence?: number;
    classificationConfidence: number;
    classificationMethod: string;
    ontologySource: 'upper' | 'lower';
    properties?: Record<string, unknown>;
    classifiedAt: string;
  };
  hierarchyClassifiedAt?: string;
  hierarchyClassificationMethod?: string;
  // Pass-through for arbitrary metadata that legacy code attached.
  [key: string]: unknown;
}

export interface SharedMemoryEntity {
  id?: string;
  name: string;
  entityType: string;
  significance: number;
  observations: Array<string | ObservationObject>;
  relationships: EntityRelationship[];
  metadata: EntityMetadata;
  quick_reference?: {
    trigger: string;
    action: string;
    avoid: string;
    check: string;
  };
  // Hierarchy fields
  hierarchyLevel?: number;
  parentEntityName?: string;
  childEntityNames?: string[];
  isScaffoldNode?: boolean;
  // Operator-enriched fields from KG operators (Phase 10)
  embedding?: number[];
  role?: string;
  enrichedContext?: string;
}

/**
 * Loose shape returned by the legacy GraphDatabaseAdapter.queryEntities(...).
 * Retained as a permissive interface for the wave-controller
 * loadExistingEntities() mapping path which already used `as any` casts.
 */
export interface GraphEntity {
  name: string;
  entityType?: string;
  observations?: unknown[];
  confidence?: number;
  source?: string;
  significance?: number;
  relationships?: Array<{
    from: string;
    to: string;
    relationType: string;
  }>;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}
