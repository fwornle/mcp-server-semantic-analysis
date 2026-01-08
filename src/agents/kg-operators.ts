/**
 * KG Operators - Tree-KG Inspired Operators for Knowledge Graph Expansion
 *
 * Implements six operators from the Tree-KG framework for incremental
 * knowledge graph construction during batch processing:
 *
 * 1. conv (Context Convolution) - Enrich entity descriptions with temporal context
 * 2. aggr (Entity Aggregation) - Assign core/non-core roles based on significance
 * 3. embed (Node Embedding) - Generate/update vector embeddings
 * 4. dedup (Deduplication) - Merge equivalent entities with role consistency
 * 5. pred (Edge Prediction) - Discover relations using score = α·cos + β·AA + γ·CA
 * 6. merge (Structure Fusion) - Integrate batch results into accumulated KG
 *
 * Based on: "Building Smarter Knowledge Graphs with Tree-KG"
 */

import { log } from '../logging.js';
import { SemanticAnalyzer } from './semantic-analyzer.js';
import type { OperatorResults } from './batch-scheduler.js';

// Edge prediction weights from environment or defaults
const EDGE_WEIGHTS = {
  alpha: parseFloat(process.env.EDGE_WEIGHT_ALPHA || '0.6'),  // Semantic similarity (cosine)
  beta: parseFloat(process.env.EDGE_WEIGHT_BETA || '0.2'),    // Adamic-Adar index
  gamma: parseFloat(process.env.EDGE_WEIGHT_GAMMA || '0.2')   // Common ancestors
};

// Minimum score threshold for edge prediction
const EDGE_PREDICTION_THRESHOLD = parseFloat(process.env.EDGE_PREDICTION_THRESHOLD || '0.5');

export interface KGEntity {
  id: string;
  name: string;
  type: string;
  observations: string[];
  significance: number;
  embedding?: number[];
  role?: 'core' | 'non-core';
  batchId?: string;
  timestamp?: string;
  references?: string[];
  enrichedContext?: string;
}

export interface KGRelation {
  from: string;
  to: string;
  type: string;
  weight: number;
  source: 'explicit' | 'predicted';
  batchId?: string;
}

export interface BatchContext {
  batchId: string;
  startDate: Date;
  endDate: Date;
  commits: Array<{ hash: string; message: string; date: Date }>;
  sessions: Array<{ filename: string; timestamp: Date }>;
}

export interface OperatorConfig {
  semanticAnalyzer: SemanticAnalyzer;
  edgeWeights?: { alpha: number; beta: number; gamma: number };
  edgeThreshold?: number;
  coreThreshold?: number;
}

export interface AggregatedEntities {
  core: KGEntity[];
  nonCore: KGEntity[];
}

export interface DeduplicatedResult {
  entities: KGEntity[];
  merged: number;
  mergeLog: Array<{ kept: string; merged: string[] }>;
}

export interface PredictedEdges {
  edges: KGRelation[];
  scores: Array<{ from: string; to: string; score: number; components: { cos: number; aa: number; ca: number } }>;
}

export interface MergeResult {
  entities: KGEntity[];
  relations: KGRelation[];
  added: { entities: number; relations: number };
  updated: { entities: number; relations: number };
}

export class KGOperators {
  private semanticAnalyzer: SemanticAnalyzer;
  private edgeWeights: { alpha: number; beta: number; gamma: number };
  private edgeThreshold: number;
  private coreThreshold: number;

  constructor(config: OperatorConfig) {
    this.semanticAnalyzer = config.semanticAnalyzer;
    this.edgeWeights = config.edgeWeights || EDGE_WEIGHTS;
    this.edgeThreshold = config.edgeThreshold || EDGE_PREDICTION_THRESHOLD;
    this.coreThreshold = config.coreThreshold || 0.6; // 60% of max significance
  }

  /**
   * Apply all operators in sequence for a batch
   */
  async applyAll(
    entities: KGEntity[],
    relations: KGRelation[],
    batchContext: BatchContext,
    accumulatedKG: { entities: KGEntity[]; relations: KGRelation[] }
  ): Promise<{
    entities: KGEntity[];
    relations: KGRelation[];
    operatorResults: OperatorResults;
  }> {
    const results: OperatorResults = {
      conv: { processed: 0, duration: 0 },
      aggr: { core: 0, nonCore: 0, duration: 0 },
      embed: { embedded: 0, duration: 0 },
      dedup: { merged: 0, duration: 0 },
      pred: { edgesAdded: 0, duration: 0 },
      merge: { entitiesAdded: 0, duration: 0 }
    };

    let currentEntities = [...entities];
    let currentRelations = [...relations];

    // 1. Context Convolution
    const convStart = Date.now();
    currentEntities = await this.contextConvolution(currentEntities, batchContext);
    results.conv.processed = currentEntities.length;
    results.conv.duration = Date.now() - convStart;

    // 2. Entity Aggregation
    const aggrStart = Date.now();
    const aggregated = await this.entityAggregation(currentEntities);
    results.aggr.core = aggregated.core.length;
    results.aggr.nonCore = aggregated.nonCore.length;
    results.aggr.duration = Date.now() - aggrStart;
    currentEntities = [...aggregated.core, ...aggregated.nonCore];

    // 3. Node Embedding
    const embedStart = Date.now();
    currentEntities = await this.nodeEmbedding(currentEntities);
    results.embed.embedded = currentEntities.filter(e => e.embedding).length;
    results.embed.duration = Date.now() - embedStart;

    // 4. Deduplication (with accumulated KG)
    const dedupStart = Date.now();
    const deduped = await this.deduplication(currentEntities, accumulatedKG);
    results.dedup.merged = deduped.merged;
    results.dedup.duration = Date.now() - dedupStart;
    currentEntities = deduped.entities;

    // 5. Edge Prediction
    const predStart = Date.now();
    const predicted = await this.edgePrediction(currentEntities, accumulatedKG);
    currentRelations = [...currentRelations, ...predicted.edges];
    results.pred.edgesAdded = predicted.edges.length;
    results.pred.duration = Date.now() - predStart;

    // 6. Structure Merge
    const mergeStart = Date.now();
    const merged = await this.structureMerge(
      { entities: currentEntities, relations: currentRelations },
      accumulatedKG
    );
    results.merge.entitiesAdded = merged.added.entities;
    results.merge.duration = Date.now() - mergeStart;

    return {
      entities: merged.entities,
      relations: merged.relations,
      operatorResults: results
    };
  }

  /**
   * CONV: Context Convolution
   * Enrich entity descriptions with temporal and batch context
   */
  async contextConvolution(
    entities: KGEntity[],
    batchContext: BatchContext
  ): Promise<KGEntity[]> {
    const enriched: KGEntity[] = [];

    for (const entity of entities) {
      // Build context from batch information
      const contextParts: string[] = [];

      // Add temporal context
      const dateRange = `${batchContext.startDate.toISOString().split('T')[0]} to ${batchContext.endDate.toISOString().split('T')[0]}`;
      contextParts.push(`Time period: ${dateRange}`);

      // Find related commits
      const relatedCommits = batchContext.commits.filter(c =>
        entity.observations.some(obs =>
          obs.toLowerCase().includes(c.message.toLowerCase().substring(0, 20))
        )
      );
      if (relatedCommits.length > 0) {
        contextParts.push(`Related commits: ${relatedCommits.map(c => c.hash.substring(0, 7)).join(', ')}`);
      }

      // Find related sessions
      const relatedSessions = batchContext.sessions.filter(s => {
        const sessionDate = s.timestamp.toISOString().split('T')[0];
        const batchStartDate = batchContext.startDate.toISOString().split('T')[0];
        const batchEndDate = batchContext.endDate.toISOString().split('T')[0];
        return sessionDate >= batchStartDate && sessionDate <= batchEndDate;
      });
      if (relatedSessions.length > 0) {
        contextParts.push(`Related sessions: ${relatedSessions.length}`);
      }

      enriched.push({
        ...entity,
        batchId: batchContext.batchId,
        enrichedContext: contextParts.join(' | ')
      });
    }

    log('Context convolution completed', 'info', {
      entityCount: enriched.length,
      batchId: batchContext.batchId
    });

    return enriched;
  }

  /**
   * AGGR: Entity Aggregation
   * Assign core/non-core roles based on significance
   */
  async entityAggregation(entities: KGEntity[]): Promise<AggregatedEntities> {
    if (entities.length === 0) {
      return { core: [], nonCore: [] };
    }

    // Calculate significance threshold
    const significances = entities.map(e => e.significance || 0);
    const maxSignificance = Math.max(...significances);
    const threshold = maxSignificance * this.coreThreshold;

    const core: KGEntity[] = [];
    const nonCore: KGEntity[] = [];

    for (const entity of entities) {
      const significance = entity.significance || 0;

      // Additional factors for core determination
      const hasMultipleObservations = entity.observations.length >= 3;
      const hasReferences = (entity.references?.length || 0) >= 2;
      const isWellDocumented = entity.observations.some(obs => obs.length > 100);

      // Score-based classification
      let coreScore = 0;
      if (significance >= threshold) coreScore += 2;
      if (hasMultipleObservations) coreScore += 1;
      if (hasReferences) coreScore += 1;
      if (isWellDocumented) coreScore += 1;

      const role: 'core' | 'non-core' = coreScore >= 2 ? 'core' : 'non-core';

      const classifiedEntity = { ...entity, role };

      if (role === 'core') {
        core.push(classifiedEntity);
      } else {
        nonCore.push(classifiedEntity);
      }
    }

    log('Entity aggregation completed', 'info', {
      total: entities.length,
      core: core.length,
      nonCore: nonCore.length,
      threshold
    });

    return { core, nonCore };
  }

  /**
   * EMBED: Node Embedding
   * Generate vector embeddings for entities
   */
  async nodeEmbedding(entities: KGEntity[]): Promise<KGEntity[]> {
    const embedded: KGEntity[] = [];

    for (const entity of entities) {
      // Skip if already has embedding
      if (entity.embedding && entity.embedding.length > 0) {
        embedded.push(entity);
        continue;
      }

      try {
        // Build text representation for embedding
        const textParts = [
          entity.name,
          entity.type,
          ...entity.observations.slice(0, 3) // Limit observations for embedding
        ];
        const text = textParts.join(' ').substring(0, 8000); // Limit length

        // Use semantic analyzer's embedding generation
        const embedding = await this.semanticAnalyzer.generateEmbedding(text);

        embedded.push({
          ...entity,
          embedding
        });
      } catch (error) {
        log('Failed to generate embedding for entity', 'warning', {
          entityId: entity.id,
          error
        });
        embedded.push(entity); // Keep entity without embedding
      }
    }

    log('Node embedding completed', 'info', {
      total: entities.length,
      embedded: embedded.filter(e => e.embedding).length
    });

    return embedded;
  }

  /**
   * DEDUP: Deduplication
   * Merge equivalent entities with role consistency
   */
  async deduplication(
    entities: KGEntity[],
    accumulatedKG: { entities: KGEntity[]; relations: KGRelation[] }
  ): Promise<DeduplicatedResult> {
    const mergeLog: Array<{ kept: string; merged: string[] }> = [];
    const seen = new Map<string, KGEntity>();
    const merged: string[] = [];

    // Track input count without creating a copy (OOM fix: avoid spread operator)
    const inputCount = entities.length + accumulatedKG.entities.length;

    // First, add accumulated entities (already deduped from previous batches)
    for (const entity of accumulatedKG.entities) {
      const normalizedName = entity.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      seen.set(normalizedName, entity);
    }

    // Then process new batch entities, merging with existing
    for (const entity of entities) {
      const normalizedName = entity.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const existing = seen.get(normalizedName);

      if (existing) {
        // Merge into existing
        const mergedEntity = this.mergeEntities(existing, entity);
        seen.set(normalizedName, mergedEntity);
        merged.push(entity.id);

        // Update merge log
        const logEntry = mergeLog.find(l => l.kept === existing.id);
        if (logEntry) {
          logEntry.merged.push(entity.id);
        } else {
          mergeLog.push({ kept: existing.id, merged: [entity.id] });
        }
      } else {
        seen.set(normalizedName, entity);
      }
    }

    const dedupedEntities = Array.from(seen.values());

    log('Deduplication completed', 'info', {
      input: inputCount,
      output: dedupedEntities.length,
      merged: merged.length
    });

    return {
      entities: dedupedEntities,
      merged: merged.length,
      mergeLog
    };
  }

  /**
   * Merge two entities, preserving role consistency
   */
  private mergeEntities(existing: KGEntity, incoming: KGEntity): KGEntity {
    // Limits to prevent unbounded growth across many batches
    const MAX_OBSERVATIONS = 50;
    const MAX_REFERENCES = 100;

    // Merge observations (deduplicate, limit size)
    const allObservations = [...existing.observations, ...incoming.observations];
    let uniqueObservations = [...new Set(allObservations)];
    if (uniqueObservations.length > MAX_OBSERVATIONS) {
      // Keep most recent observations (incoming takes precedence)
      uniqueObservations = uniqueObservations.slice(-MAX_OBSERVATIONS);
    }

    // Merge references (deduplicate, limit size)
    const allReferences = [...(existing.references || []), ...(incoming.references || [])];
    let uniqueReferences = [...new Set(allReferences)];
    if (uniqueReferences.length > MAX_REFERENCES) {
      uniqueReferences = uniqueReferences.slice(-MAX_REFERENCES);
    }

    // Role consistency: core takes precedence
    const role = existing.role === 'core' || incoming.role === 'core' ? 'core' : 'non-core';

    // Higher significance wins
    const significance = Math.max(existing.significance || 0, incoming.significance || 0);

    // Prefer existing embedding, but update if incoming is newer
    const embedding = incoming.embedding || existing.embedding;

    // Combine context (limit size to prevent string length overflow on large workflows)
    const MAX_CONTEXT_LENGTH = 10000; // ~10KB max per entity
    let enrichedContext = [existing.enrichedContext, incoming.enrichedContext]
      .filter(Boolean)
      .join(' | ');

    // Truncate if too long, keeping the most recent context (incoming) prioritized
    if (enrichedContext.length > MAX_CONTEXT_LENGTH) {
      // Keep last MAX_CONTEXT_LENGTH characters (most recent context)
      enrichedContext = '...' + enrichedContext.slice(-MAX_CONTEXT_LENGTH + 3);
    }

    return {
      ...existing,
      observations: uniqueObservations,
      references: uniqueReferences,
      role,
      significance,
      embedding,
      enrichedContext: enrichedContext || undefined,
      timestamp: incoming.timestamp || existing.timestamp
    };
  }

  /**
   * PRED: Edge Prediction
   * Predict relations using weighted scoring: score = α·cos + β·AA + γ·CA
   */
  async edgePrediction(
    entities: KGEntity[],
    accumulatedKG: { entities: KGEntity[]; relations: KGRelation[] }
  ): Promise<PredictedEdges> {
    const edges: KGRelation[] = [];
    const scores: PredictedEdges['scores'] = [];

    // OOM fix: removed unused allEntities and entityMap (dead code that wasted memory)

    // Build neighbor map for Adamic-Adar
    const neighbors = new Map<string, Set<string>>();
    for (const relation of accumulatedKG.relations) {
      if (!neighbors.has(relation.from)) neighbors.set(relation.from, new Set());
      if (!neighbors.has(relation.to)) neighbors.set(relation.to, new Set());
      neighbors.get(relation.from)!.add(relation.to);
      neighbors.get(relation.to)!.add(relation.from);
    }

    // Compare each pair of new entities with accumulated entities
    for (const newEntity of entities) {
      for (const accEntity of accumulatedKG.entities) {
        if (newEntity.id === accEntity.id) continue;

        // Calculate cosine similarity
        const cos = this.cosineSimilarity(newEntity.embedding, accEntity.embedding);

        // Calculate Adamic-Adar index
        const aa = this.adamicAdar(newEntity.id, accEntity.id, neighbors);

        // Calculate common ancestors
        const ca = this.commonAncestors(newEntity.id, accEntity.id, accumulatedKG.relations);

        // Combined score
        const score =
          this.edgeWeights.alpha * cos +
          this.edgeWeights.beta * aa +
          this.edgeWeights.gamma * ca;

        if (score >= this.edgeThreshold) {
          edges.push({
            from: newEntity.id,
            to: accEntity.id,
            type: 'related_to',
            weight: score,
            source: 'predicted',
            batchId: newEntity.batchId
          });

          scores.push({
            from: newEntity.id,
            to: accEntity.id,
            score,
            components: { cos, aa, ca }
          });
        }
      }
    }

    log('Edge prediction completed', 'info', {
      entitiesCompared: entities.length * accumulatedKG.entities.length,
      edgesPredicted: edges.length,
      threshold: this.edgeThreshold
    });

    return { edges, scores };
  }

  /**
   * Calculate cosine similarity between two embeddings
   */
  private cosineSimilarity(a?: number[], b?: number[]): number {
    if (!a || !b || a.length !== b.length || a.length === 0) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Calculate Adamic-Adar index (shared neighbors weighted by degree)
   */
  private adamicAdar(
    entityA: string,
    entityB: string,
    neighbors: Map<string, Set<string>>
  ): number {
    const neighborsA = neighbors.get(entityA) || new Set();
    const neighborsB = neighbors.get(entityB) || new Set();

    if (neighborsA.size === 0 || neighborsB.size === 0) {
      return 0;
    }

    let score = 0;
    for (const common of neighborsA) {
      if (neighborsB.has(common)) {
        const degree = neighbors.get(common)?.size || 1;
        score += 1 / Math.log(degree + 1);
      }
    }

    // Normalize to 0-1 range
    const maxPossible = Math.min(neighborsA.size, neighborsB.size);
    return maxPossible > 0 ? score / maxPossible : 0;
  }

  /**
   * Calculate common ancestors score
   */
  private commonAncestors(
    entityA: string,
    entityB: string,
    relations: KGRelation[]
  ): number {
    // Find entities that both A and B relate to
    const ancestorsA = new Set<string>();
    const ancestorsB = new Set<string>();

    for (const rel of relations) {
      if (rel.from === entityA) ancestorsA.add(rel.to);
      if (rel.to === entityA) ancestorsA.add(rel.from);
      if (rel.from === entityB) ancestorsB.add(rel.to);
      if (rel.to === entityB) ancestorsB.add(rel.from);
    }

    // Count common ancestors
    let common = 0;
    for (const ancestor of ancestorsA) {
      if (ancestorsB.has(ancestor)) common++;
    }

    // Normalize by union size
    const unionSize = ancestorsA.size + ancestorsB.size - common;
    return unionSize > 0 ? common / unionSize : 0;
  }

  /**
   * MERGE: Structure Fusion
   * Integrate batch results into accumulated KG
   */
  async structureMerge(
    batchResults: { entities: KGEntity[]; relations: KGRelation[] },
    accumulatedKG: { entities: KGEntity[]; relations: KGRelation[] }
  ): Promise<MergeResult> {
    const entityMap = new Map<string, KGEntity>();
    const relationSet = new Set<string>();

    let entitiesAdded = 0;
    let entitiesUpdated = 0;
    let relationsAdded = 0;
    let relationsUpdated = 0;

    // First, add all accumulated entities
    for (const entity of accumulatedKG.entities) {
      entityMap.set(entity.id, entity);
    }

    // Merge in batch entities
    for (const entity of batchResults.entities) {
      const existing = entityMap.get(entity.id);
      if (existing) {
        entityMap.set(entity.id, this.mergeEntities(existing, entity));
        entitiesUpdated++;
      } else {
        entityMap.set(entity.id, entity);
        entitiesAdded++;
      }
    }

    // Add accumulated relations
    const allRelations: KGRelation[] = [];
    for (const relation of accumulatedKG.relations) {
      const key = `${relation.from}|${relation.to}|${relation.type}`;
      if (!relationSet.has(key)) {
        relationSet.add(key);
        allRelations.push(relation);
      }
    }

    // Merge in batch relations
    for (const relation of batchResults.relations) {
      const key = `${relation.from}|${relation.to}|${relation.type}`;
      if (!relationSet.has(key)) {
        relationSet.add(key);
        allRelations.push(relation);
        relationsAdded++;
      } else {
        // Could update weight here if needed
        relationsUpdated++;
      }
    }

    log('Structure merge completed', 'info', {
      entitiesAdded,
      entitiesUpdated,
      relationsAdded,
      relationsUpdated,
      totalEntities: entityMap.size,
      totalRelations: allRelations.length
    });

    return {
      entities: Array.from(entityMap.values()),
      relations: allRelations,
      added: { entities: entitiesAdded, relations: relationsAdded },
      updated: { entities: entitiesUpdated, relations: relationsUpdated }
    };
  }
}

// Factory function
export function createKGOperators(semanticAnalyzer: SemanticAnalyzer): KGOperators {
  return new KGOperators({ semanticAnalyzer });
}
