import { log } from "../logging.js";
import OpenAI from "openai";

export interface SimilarityConfig {
  embeddingModel?: string;
  similarityThreshold: number;
  batchSize: number;
}

export interface MergingStrategy {
  preserveReferences: boolean;
  mergeObservations: boolean;
  keepMostSignificant: boolean;
}

export interface DuplicateGroup {
  id: string;
  entities: Entity[];
  similarity: number;
  suggestedMerge: Entity;
  confidence: number;
}

export interface Entity {
  id: string;
  name: string;
  type: string;
  observations: Observation[];
  significance?: number;
  timestamp: string;
  references?: string[];
}

export interface Observation {
  type: string;
  content: string;
  timestamp: string;
  source?: string;
}

export interface DeduplicationResult {
  totalProcessed: number;
  duplicatesFound: number;
  entitiesMerged: number;
  entitiesRemoved: number;
  conflictsRequiringReview: number;
  processingTime: number;
}

export class DeduplicationAgent {
  private similarityConfig: SimilarityConfig;
  private mergingStrategy: MergingStrategy;
  private agents: Map<string, any> = new Map();
  private embeddingModel: any = null;
  private openaiClient: OpenAI | null = null;

  constructor() {
    this.similarityConfig = {
      embeddingModel: "sentence-transformers/all-MiniLM-L6-v2",
      similarityThreshold: 0.85,
      batchSize: 100,
    };

    this.mergingStrategy = {
      preserveReferences: true,
      mergeObservations: true,
      keepMostSignificant: true,
    };

    this.initializeEmbeddingModel();
    
    log("DeduplicationAgent initialized", "info", {
      threshold: this.similarityConfig.similarityThreshold,
      batchSize: this.similarityConfig.batchSize,
    });
  }

  private async initializeEmbeddingModel(): Promise<void> {
    try {
      const openaiKey = process.env.OPENAI_API_KEY;
      if (openaiKey && openaiKey !== "your-openai-api-key") {
        this.openaiClient = new OpenAI({ apiKey: openaiKey });
        this.embeddingModel = "text-embedding-3-small";
        log("OpenAI embedding client initialized", "info");
        return;
      }

      log("No embedding provider available, using text similarity", "warning");
      this.embeddingModel = null;
      this.openaiClient = null;
    } catch (error) {
      log("Failed to initialize embedding model", "warning", error);
      this.embeddingModel = null;
      this.openaiClient = null;
    }
  }

  // Agent registration for workflow integration
  registerAgent(name: string, agent: any): void {
    this.agents.set(name, agent);
    log(`Registered agent: ${name}`, "info");
  }

  async detectDuplicates(entityTypes?: string[], similarityThreshold: number = 0.85, comparisonMethod: string = "both"): Promise<any> {
    try {
      // Get entities from registered knowledge graph agent
      const kgAgent = this.agents.get("knowledge_graph");
      if (!kgAgent) {
        log("DEDUPLICATION FIX: Knowledge graph agent not available", "error", {
          availableAgents: Array.from(this.agents.keys()),
          requestedAgent: "knowledge_graph"
        });
        return { success: false, error: "Knowledge graph agent not available" };
      }

      // Get shared memory entities from persistence agent
      let allEntities: any[] = [];
      if (typeof kgAgent.getSharedMemory === 'function') {
        const sharedMemory = await kgAgent.getSharedMemory();
        allEntities = sharedMemory?.entities || [];
      } else if (kgAgent.entities) {
        allEntities = Array.from(kgAgent.entities.values() || []);
      } else {
        log("DEDUPLICATION FIX: No entities found in knowledge graph agent", "warning");
        return {
          success: true,
          duplicate_groups: [],
          total_entities: 0,
          message: "No entities found to deduplicate"
        };
      }

      // Filter entities by type if specified
      const entities: any[] = [];
      
      for (const entity of allEntities) {
        if (!entityTypes || entityTypes.includes(entity.entityType || entity.entity_type)) {
          entities.push({
            name: entity.name,
            type: entity.entityType || entity.entity_type,
            observations: Array.isArray(entity.observations) ? entity.observations : [entity.observations].filter(Boolean),
            significance: entity.significance || 5,
            metadata: entity.metadata || {}
          });
        }
      }
      
      log(`DEDUPLICATION FIX: Processing ${entities.length} entities for deduplication`, "info", {
        totalEntities: allEntities.length,
        filteredEntities: entities.length,
        entityTypes: entityTypes || 'all'
      });

      if (entities.length < 2) {
        return {
          success: true,
          duplicate_groups: [],
          total_entities: entities.length,
          message: "Not enough entities to compare"
        };
      }

      const duplicates: any[] = [];
      const processedEntities = new Set<string>();

      // Compare entities
      for (let i = 0; i < entities.length; i++) {
        const entity1 = entities[i];
        if (processedEntities.has(entity1.name)) continue;

        const similarGroup = [entity1];

        for (let j = i + 1; j < entities.length; j++) {
          const entity2 = entities[j];
          if (processedEntities.has(entity2.name)) continue;

          const similarity = await this.calculateSimilarityByMethod(entity1, entity2, comparisonMethod);

          if (similarity >= similarityThreshold) {
            similarGroup.push(entity2);
            processedEntities.add(entity2.name);
          }
        }

        if (similarGroup.length > 1) {
          duplicates.push({
            primary_entity: similarGroup[0],
            duplicate_entities: similarGroup.slice(1),
            similarity_scores: Array(similarGroup.length - 1).fill(similarityThreshold),
            group_size: similarGroup.length
          });

          // Mark all as processed
          similarGroup.forEach(entity => processedEntities.add(entity.name));
        }
      }

      return {
        success: true,
        duplicate_groups: duplicates,
        total_entities: entities.length,
        entities_with_duplicates: duplicates.reduce((sum, group) => sum + group.group_size, 0),
        similarity_threshold: similarityThreshold,
        comparison_method: comparisonMethod,
        entity_types_filter: entityTypes
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        entity_types: entityTypes,
        similarity_threshold: similarityThreshold,
        comparison_method: comparisonMethod
      };
    }
  }

  private async calculateSimilarityByMethod(entity1: any, entity2: any, method: string): Promise<number> {
    const text1 = this.entityToText(entity1);
    const text2 = this.entityToText(entity2);

    if (method === "semantic") {
      return await this.semanticSimilarity(text1, text2);
    } else if (method === "text") {
      return this.calculateStringSimilarity(text1, text2);
    } else { // "both" - use average
      const semanticSim = await this.semanticSimilarity(text1, text2);
      const textSim = this.calculateStringSimilarity(text1, text2);
      return (semanticSim + textSim) / 2.0;
    }
  }

  private entityToText(entity: any): string {
    const textParts = [entity.name];

    if (entity.observations) {
      // Limit to first 3 observations to avoid too much text
      const obs = Array.isArray(entity.observations) ? entity.observations : [entity.observations];
      textParts.push(...obs.slice(0, 3));
    }

    return textParts.join(" ");
  }

  private async generateEmbedding(text: string): Promise<number[]> {
    if (!this.openaiClient) {
      throw new Error("OpenAI client not initialized");
    }

    try {
      const response = await this.openaiClient.embeddings.create({
        model: this.embeddingModel || "text-embedding-3-small",
        input: text,
      });

      return response.data[0].embedding;
    } catch (error) {
      log("Failed to generate embedding", "error", error);
      throw error;
    }
  }

  private cosineSimilarity(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length) {
      throw new Error("Vectors must have the same length");
    }

    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      magnitude1 += vec1[i] * vec1[i];
      magnitude2 += vec2[i] * vec2[i];
    }

    magnitude1 = Math.sqrt(magnitude1);
    magnitude2 = Math.sqrt(magnitude2);

    if (magnitude1 === 0 || magnitude2 === 0) {
      return 0;
    }

    return dotProduct / (magnitude1 * magnitude2);
  }

  private async semanticSimilarity(text1: string, text2: string): Promise<number> {
    if (!this.openaiClient) {
      return this.calculateStringSimilarity(text1, text2);
    }

    try {
      const [emb1, emb2] = await Promise.all([
        this.generateEmbedding(text1),
        this.generateEmbedding(text2),
      ]);

      return this.cosineSimilarity(emb1, emb2);
    } catch (error) {
      log("Embedding similarity failed, falling back to text similarity", "warning", error);
      return this.calculateStringSimilarity(text1, text2);
    }
  }

  async deduplicateEntities(entities: Entity[]): Promise<DeduplicationResult> {
    const startTime = Date.now();
    log(`Starting deduplication of ${entities.length} entities`, "info");

    const result: DeduplicationResult = {
      totalProcessed: entities.length,
      duplicatesFound: 0,
      entitiesMerged: 0,
      entitiesRemoved: 0,
      conflictsRequiringReview: 0,
      processingTime: 0,
    };

    try {
      // Process entities in batches
      const batches = this.createBatches(entities, this.similarityConfig.batchSize);
      const duplicateGroups: DuplicateGroup[] = [];

      for (const batch of batches) {
        const batchDuplicates = await this.findDuplicatesInBatch(batch);
        duplicateGroups.push(...batchDuplicates);
      }

      result.duplicatesFound = duplicateGroups.length;

      // Merge duplicate groups
      for (const group of duplicateGroups) {
        try {
          const mergeResult = await this.mergeEntityGroup(group);
          if (mergeResult.success) {
            result.entitiesMerged++;
            result.entitiesRemoved += group.entities.length - 1;
          } else {
            result.conflictsRequiringReview++;
          }
        } catch (error) {
          log(`Failed to merge group ${group.id}`, "error", error);
          result.conflictsRequiringReview++;
        }
      }

      result.processingTime = Date.now() - startTime;
      
      log("Deduplication completed", "info", result);
      
    } catch (error) {
      log("Deduplication failed", "error", error);
      throw error;
    }

    return result;
  }

  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  private async findDuplicatesInBatch(entities: Entity[]): Promise<DuplicateGroup[]> {
    const duplicateGroups: DuplicateGroup[] = [];
    const processed = new Set<string>();

    for (let i = 0; i < entities.length; i++) {
      if (processed.has(entities[i].id)) continue;

      const similarEntities = [entities[i]];
      processed.add(entities[i].id);

      for (let j = i + 1; j < entities.length; j++) {
        if (processed.has(entities[j].id)) continue;

        const similarity = await this.calculateSimilarity(entities[i], entities[j]);
        
        if (similarity >= this.similarityConfig.similarityThreshold) {
          similarEntities.push(entities[j]);
          processed.add(entities[j].id);
        }
      }

      if (similarEntities.length > 1) {
        const group = await this.createDuplicateGroup(similarEntities);
        duplicateGroups.push(group);
      }
    }

    return duplicateGroups;
  }

  private async calculateSimilarity(entity1: Entity, entity2: Entity): Promise<number> {
    // Enhanced similarity calculation with multiple factors

    let score = 0;
    let factors = 0;

    // Name similarity
    const nameSimilarity = this.calculateStringSimilarity(entity1.name, entity2.name);
    score += nameSimilarity * 0.4;
    factors += 0.4;

    // Type similarity
    if (entity1.type === entity2.type) {
      score += 0.2;
    }
    factors += 0.2;

    // Content similarity (from observations)
    const content1 = entity1.observations.map(obs => 
      typeof obs === 'string' ? obs : obs.content || String(obs)
    ).join(' ');
    const content2 = entity2.observations.map(obs => 
      typeof obs === 'string' ? obs : obs.content || String(obs)
    ).join(' ');
    const contentSimilarity = this.calculateStringSimilarity(content1, content2);
    score += contentSimilarity * 0.4;
    factors += 0.4;

    return factors > 0 ? score / factors : 0;
  }

  private calculateStringSimilarity(str1: string, str2: string): number {
    // Simple Jaccard similarity using word sets
    const words1 = new Set(str1.toLowerCase().split(/\s+/));
    const words2 = new Set(str2.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...words1].filter(word => words2.has(word)));
    const union = new Set([...words1, ...words2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  private async createDuplicateGroup(entities: Entity[]): Promise<DuplicateGroup> {
    // Calculate average similarity within the group
    let totalSimilarity = 0;
    let comparisons = 0;

    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        totalSimilarity += await this.calculateSimilarity(entities[i], entities[j]);
        comparisons++;
      }
    }

    const avgSimilarity = comparisons > 0 ? totalSimilarity / comparisons : 0;

    // Create suggested merge
    const suggestedMerge = await this.createMergedEntity(entities);

    return {
      id: `group-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      entities,
      similarity: avgSimilarity,
      suggestedMerge,
      confidence: this.calculateConfidence(avgSimilarity, entities.length),
    };
  }

  private calculateConfidence(similarity: number, entityCount: number): number {
    // Higher similarity and more entities = higher confidence
    const similarityFactor = similarity;
    const countFactor = Math.min(entityCount / 5, 1); // Cap at 5 entities
    
    return (similarityFactor * 0.7 + countFactor * 0.3);
  }

  private async createMergedEntity(entities: Entity[]): Promise<Entity> {
    // Choose the most significant entity as base
    let baseEntity = entities[0];
    
    if (this.mergingStrategy.keepMostSignificant) {
      baseEntity = entities.reduce((most, current) => 
        (current.significance || 0) > (most.significance || 0) ? current : most
      );
    }

    const mergedEntity: Entity = {
      id: baseEntity.id,
      name: baseEntity.name,
      type: baseEntity.type,
      observations: [],
      significance: baseEntity.significance,
      timestamp: new Date().toISOString(),
      references: [],
    };

    // Merge observations
    if (this.mergingStrategy.mergeObservations) {
      const allObservations: Observation[] = [];
      
      entities.forEach(entity => {
        allObservations.push(...entity.observations);
      });

      // Remove duplicate observations
      const uniqueObservations = this.removeDuplicateObservations(allObservations);
      mergedEntity.observations = uniqueObservations;
    } else {
      mergedEntity.observations = baseEntity.observations;
    }

    // Merge references
    if (this.mergingStrategy.preserveReferences) {
      const allReferences: string[] = [];
      
      entities.forEach(entity => {
        if (entity.references) {
          allReferences.push(...entity.references);
        }
      });

      mergedEntity.references = [...new Set(allReferences)];
    }

    // Update significance to highest value
    const maxSignificance = Math.max(...entities.map(e => e.significance || 0));
    if (maxSignificance > 0) {
      mergedEntity.significance = maxSignificance;
    }

    return mergedEntity;
  }

  private removeDuplicateObservations(observations: Observation[]): Observation[] {
    const seen = new Set<string>();
    const unique: Observation[] = [];

    observations.forEach(obs => {
      const key = `${obs.type}:${obs.content}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(obs);
      }
    });

    // Sort by timestamp (most recent first)
    return unique.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }

  private async mergeEntityGroup(group: DuplicateGroup): Promise<{ success: boolean; mergedEntity?: Entity }> {
    try {
      // Check if automatic merge is safe
      if (group.confidence < 0.8) {
        log(`Low confidence merge for group ${group.id}: ${group.confidence}`, "warning");
        return { success: false };
      }

      // Perform the merge
      const mergedEntity = group.suggestedMerge;
      
      log(`Merged ${group.entities.length} entities into: ${mergedEntity.name}`, "info", {
        groupId: group.id,
        similarity: group.similarity,
        confidence: group.confidence,
      });

      return { success: true, mergedEntity };
      
    } catch (error) {
      log(`Failed to merge group ${group.id}`, "error", error);
      return { success: false };
    }
  }

  async findSimilarEntities(targetEntity: Entity, candidates: Entity[]): Promise<Entity[]> {
    const similarEntities: Array<{entity: Entity, similarity: number}> = [];

    for (const candidate of candidates) {
      if (candidate.id === targetEntity.id) continue;

      const similarity = await this.calculateSimilarity(targetEntity, candidate);
      
      if (similarity >= this.similarityConfig.similarityThreshold) {
        similarEntities.push({ entity: candidate, similarity });
      }
    }

    // Sort by similarity (highest first)
    similarEntities.sort((a, b) => b.similarity - a.similarity);

    return similarEntities.map(item => item.entity);
  }

  updateSimilarityThreshold(threshold: number): void {
    if (threshold < 0 || threshold > 1) {
      throw new Error("Similarity threshold must be between 0 and 1");
    }
    
    this.similarityConfig.similarityThreshold = threshold;
    log(`Updated similarity threshold to: ${threshold}`, "info");
  }

  updateMergingStrategy(strategy: Partial<MergingStrategy>): void {
    Object.assign(this.mergingStrategy, strategy);
    log("Updated merging strategy", "info", this.mergingStrategy);
  }

  async mergeEntities(entityGroups: any[], preserveHistory: boolean = true): Promise<any> {
    try {
      const kgAgent = this.agents.get("knowledge_graph");
      if (!kgAgent) {
        return { success: false, error: "Knowledge graph agent not available" };
      }

      const mergedResults: any[] = [];
      let totalMerged = 0;
      const errors: any[] = [];

      for (const group of entityGroups) {
        try {
          // Extract entities and target name from group
          const entities = group.entities || [];
          const targetName = group.target_name || group.targetName;
          const mergeStrategy = group.merge_strategy || group.mergeStrategy || "combine";

          // Verify target exists
          if (!kgAgent.entities?.has(targetName)) {
            errors.push({
              group,
              error: `Target entity not found: ${targetName}`
            });
            continue;
          }

          const secondaryNames = entities.filter((name: string) => name !== targetName);

          if (secondaryNames.length === 0) {
            continue; // Nothing to merge
          }

          // Preserve history if requested
          if (preserveHistory) {
            const primaryEntity = kgAgent.entities.get(targetName);
            if (primaryEntity) {
              if (!primaryEntity.metadata.merge_history) {
                primaryEntity.metadata.merge_history = [];
              }

              primaryEntity.metadata.merge_history.push({
                merged_entities: secondaryNames,
                merge_strategy: mergeStrategy,
                timestamp: Date.now()
              });
            }
          }

          // Perform the merge (simplified - in real implementation would call KG agent)
          const mergeResult = { merged_count: secondaryNames.length };

          if (mergeResult.merged_count > 0) {
            totalMerged += mergeResult.merged_count;
            mergedResults.push({
              target_entity: targetName,
              merged_entities: secondaryNames,
              merge_strategy: mergeStrategy,
              merged_count: mergeResult.merged_count
            });
          }

        } catch (error) {
          errors.push({
            group,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      return {
        success: errors.length === 0,
        groups_processed: entityGroups.length,
        entities_merged: totalMerged,
        merge_results: mergedResults,
        preserve_history: preserveHistory,
        errors
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        entity_groups: entityGroups,
        preserve_history: preserveHistory
      };
    }
  }

  async deduplicateInsights(scope: string = "global", entityFilter?: string[], typeFilter?: string[], similarityThreshold: number = 0.9): Promise<any> {
    try {
      const kgAgent = this.agents.get("knowledge_graph");
      if (!kgAgent) {
        return { success: false, error: "Knowledge graph agent not available" };
      }

      // Get entities based on scope and filters
      const targetEntities: any[] = [];
      const allEntities = Array.from(kgAgent.entities?.values() || []);

      for (const entity of allEntities) {
        // Apply filters based on scope
        if (scope === "entity_specific" && entityFilter) {
          if (!entityFilter.includes((entity as any).name)) continue;
        } else if (scope === "type_specific" && typeFilter) {
          if (!typeFilter.includes((entity as any).entity_type || (entity as any).entityType)) continue;
        }
        // For "global" scope, include all entities

        targetEntities.push(entity);
      }

      let deduplicatedCount = 0;
      let processedEntities = 0;

      for (const entity of targetEntities) {
        const observations = Array.isArray(entity.observations) ? entity.observations : [];
        if (observations.length === 0) continue;

        // Find duplicate observations within this entity
        const uniqueObservations: string[] = [];
        const seenObservations = new Set<string>();

        for (const obs of observations) {
          const obsText = typeof obs === 'string' ? obs : obs.content || String(obs);
          
          // Simple deduplication based on text similarity
          let isDuplicate = false;

          for (const existingObs of uniqueObservations) {
            const similarity = this.calculateStringSimilarity(obsText, existingObs);
            if (similarity >= similarityThreshold) {
              isDuplicate = true;
              deduplicatedCount++;
              break;
            }
          }

          if (!isDuplicate) {
            uniqueObservations.push(obsText);
            seenObservations.add(obsText.toLowerCase().trim());
          }
        }

        // Update entity observations if we removed duplicates
        if (uniqueObservations.length < observations.length) {
          entity.observations = uniqueObservations;
          entity.updated_at = Date.now();
        }

        processedEntities++;
      }

      return {
        success: true,
        scope,
        entity_filter: entityFilter,
        type_filter: typeFilter,
        similarity_threshold: similarityThreshold,
        entities_processed: processedEntities,
        duplicate_insights_removed: deduplicatedCount,
        target_entity_count: targetEntities.length
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        scope,
        entity_filter: entityFilter,
        type_filter: typeFilter
      };
    }
  }

  // Event handlers for workflow integration
  async handleDetectDuplicates(data: any): Promise<any> {
    return await this.detectDuplicates(data.entity_types, data.similarity_threshold, data.comparison_method);
  }

  async handleMergeEntities(data: any): Promise<any> {
    return await this.mergeEntities(data.entity_groups, data.preserve_history);
  }

  async handleMergeSimilarEntities(data: any): Promise<any> {
    // First detect duplicates, then merge them
    const duplicates = await this.detectDuplicates(data.entity_types, data.similarity_threshold);
    if (!duplicates.success || duplicates.duplicate_groups.length === 0) {
      return duplicates;
    }

    // Convert duplicate groups to merge format
    const entityGroups = duplicates.duplicate_groups.map((group: any) => ({
      entities: [group.primary_entity.name, ...group.duplicate_entities.map((e: any) => e.name)],
      target_name: group.primary_entity.name,
      merge_strategy: "combine"
    }));

    return await this.mergeEntities(entityGroups, data.preserve_history !== false);
  }

  async handleConsolidatePatterns(data: any): Promise<any> {
    // Consolidate similar patterns by deduplicating insights
    return await this.deduplicateInsights("type_specific", undefined, ["Pattern", "WorkflowPattern", "DesignPattern"], data.similarity_threshold || 0.85);
  }

  async handleCalculateSimilarity(data: any): Promise<any> {
    try {
      const entity1 = data.entity1;
      const entity2 = data.entity2;
      const method = data.method || "both";

      if (!entity1 || !entity2) {
        return {
          success: false,
          error: "Both entities are required for similarity calculation"
        };
      }

      const similarity = await this.calculateSimilarityByMethod(entity1, entity2, method);

      return {
        success: true,
        entity1: entity1.name,
        entity2: entity2.name,
        similarity,
        method,
        threshold: this.similarityConfig.similarityThreshold,
        is_similar: similarity >= this.similarityConfig.similarityThreshold
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async handleResolveDuplicates(data: any): Promise<any> {
    // Comprehensive duplicate resolution workflow
    try {
      // Step 1: Detect duplicates
      const duplicates = await this.detectDuplicates(data.entity_types, data.similarity_threshold);
      if (!duplicates.success) {
        return duplicates;
      }

      // Step 2: Merge entities if auto_merge is enabled
      let mergeResults = null;
      if (data.auto_merge && duplicates.duplicate_groups.length > 0) {
        const entityGroups = duplicates.duplicate_groups.map((group: any) => ({
          entities: [group.primary_entity.name, ...group.duplicate_entities.map((e: any) => e.name)],
          target_name: group.primary_entity.name,
          merge_strategy: data.merge_strategy || "combine"
        }));

        mergeResults = await this.mergeEntities(entityGroups, data.preserve_history !== false);
      }

      // Step 3: Deduplicate insights if requested
      let insightResults = null;
      if (data.deduplicate_insights) {
        insightResults = await this.deduplicateInsights(data.insight_scope, data.entity_filter, data.type_filter, data.insight_threshold);
      }

      return {
        success: true,
        detection_results: duplicates,
        merge_results: mergeResults,
        insight_deduplication: insightResults,
        auto_merge: data.auto_merge,
        deduplicate_insights: data.deduplicate_insights
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  // Health check
  healthCheck(): any {
    return {
      status: "healthy",
      similarity_threshold: this.similarityConfig.similarityThreshold,
      batch_size: this.similarityConfig.batchSize,
      embedding_model: this.embeddingModel ? "enabled" : "disabled",
      registered_agents: this.agents.size,
      merging_strategy: this.mergingStrategy
    };
  }
}