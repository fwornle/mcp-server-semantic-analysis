import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';

export interface PersistenceResult {
  success: boolean;
  entitiesCreated: number;
  entitiesUpdated: number;
  checkpointUpdated: boolean;
  filesCreated: string[];
  errors: string[];
  summary: string;
}

export interface CheckpointData {
  lastGitAnalysis?: string;
  lastVibeAnalysis?: string;
  lastSemanticAnalysis?: string;
  lastFullAnalysis?: string;
  analysisCount: number;
  lastEntitySync?: string;
}

export interface SharedMemoryEntity {
  id: string;
  name: string;
  entityType: string;
  significance: number;
  observations: (string | ObservationObject)[];
  relationships: EntityRelationship[];
  metadata: EntityMetadata;
}

export interface ObservationObject {
  type: string;
  content: string;
  date: string;
  metadata?: Record<string, any>;
}

export interface EntityRelationship {
  from: string;
  to: string;
  relationType: string;
}

export interface EntityMetadata {
  created_at: string;
  last_updated: string;
  created_by?: string;
  version?: string;
  team?: string;
  source?: string;
  context?: string;
  tags?: string[];
}

export interface SharedMemoryStructure {
  entities: SharedMemoryEntity[];
  relations: EntityRelationship[];
  metadata: {
    last_updated: string;
    total_entities: number;
    total_relations: number;
    team: string;
    last_sync?: number;
    sync_source?: string;
    lastGitAnalysis?: string;
    lastVibeAnalysis?: string;
    lastSemanticAnalysis?: string;
    analysisCount?: number;
  };
}

export class PersistenceAgent {
  private repositoryPath: string;
  private sharedMemoryPath: string;
  private insightsDir: string;

  constructor(repositoryPath: string = '.') {
    this.repositoryPath = repositoryPath;
    this.sharedMemoryPath = path.join(repositoryPath, 'shared-memory-coding.json');
    this.insightsDir = path.join(repositoryPath, 'knowledge-management', 'insights');
    this.ensureDirectories();
  }

  async persistAnalysisResults(
    gitAnalysis: any,
    vibeAnalysis: any,
    semanticAnalysis: any,
    observations: any[],
    insightGeneration?: any
  ): Promise<PersistenceResult> {
    log('Starting comprehensive analysis persistence', 'info', {
      hasGitAnalysis: !!gitAnalysis,
      hasVibeAnalysis: !!vibeAnalysis,
      hasSemanticAnalysis: !!semanticAnalysis,
      observationsCount: observations.length,
      hasInsightGeneration: !!insightGeneration
    });

    const result: PersistenceResult = {
      success: false,
      entitiesCreated: 0,
      entitiesUpdated: 0,
      checkpointUpdated: false,
      filesCreated: [],
      errors: [],
      summary: ''
    };

    try {
      // Load current shared memory
      const sharedMemory = await this.loadSharedMemory();

      // Create entities from observations
      const createdEntities = await this.createEntitiesFromObservations(observations, sharedMemory);
      result.entitiesCreated = createdEntities.length;

      // Update relationships based on analysis results
      const updatedRelations = await this.updateEntityRelationships(sharedMemory, {
        gitAnalysis,
        vibeAnalysis,
        semanticAnalysis
      });

      // Save insight files if available
      if (insightGeneration?.insightDocument) {
        const insightFile = await this.saveInsightDocument(insightGeneration.insightDocument);
        if (insightFile) {
          result.filesCreated.push(insightFile);
        }
      }

      if (insightGeneration?.lessonsLearned) {
        const lessonsFile = await this.saveLessonsLearned(insightGeneration.lessonsLearned);
        if (lessonsFile) {
          result.filesCreated.push(lessonsFile);
        }
      }

      // Update analysis checkpoints
      const checkpointResult = await this.updateAnalysisCheckpoints({
        gitAnalysis,
        vibeAnalysis,
        semanticAnalysis
      });
      result.checkpointUpdated = checkpointResult;

      // Save updated shared memory
      await this.saveSharedMemory(sharedMemory);

      // Generate summary
      result.summary = this.generatePersistenceSummary(result, createdEntities, updatedRelations);
      result.success = true;

      log('Analysis persistence completed successfully', 'info', {
        entitiesCreated: result.entitiesCreated,
        entitiesUpdated: result.entitiesUpdated,
        filesCreated: result.filesCreated.length,
        checkpointUpdated: result.checkpointUpdated
      });

      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.errors.push(errorMessage);
      result.summary = `Persistence failed: ${errorMessage}`;
      
      log('Analysis persistence failed', 'error', error);
      return result;
    }
  }

  private async createEntitiesFromObservations(
    observations: any[],
    sharedMemory: SharedMemoryStructure
  ): Promise<SharedMemoryEntity[]> {
    const createdEntities: SharedMemoryEntity[] = [];

    for (const observation of observations) {
      try {
        // Check if entity already exists
        const existingEntity = sharedMemory.entities.find(e => e.name === observation.name);
        
        if (existingEntity) {
          // Update existing entity with new observations
          const newObservations = observation.observations.filter((obs: any) => {
            const obsContent = typeof obs === 'string' ? obs : obs.content;
            return !existingEntity.observations.some(existing => {
              const existingContent = typeof existing === 'string' ? existing : existing.content;
              return existingContent === obsContent;
            });
          });

          if (newObservations.length > 0) {
            existingEntity.observations.push(...newObservations);
            existingEntity.metadata.last_updated = new Date().toISOString();
            log(`Updated existing entity: ${observation.name} with ${newObservations.length} new observations`, 'info');
          }
        } else {
          // Create new entity
          const newEntity: SharedMemoryEntity = {
            id: this.generateEntityId(observation.name),
            name: observation.name,
            entityType: observation.entityType || 'TransferablePattern',
            significance: observation.significance || 5,
            observations: this.formatObservations(observation.observations),
            relationships: observation.relationships || [],
            metadata: {
              created_at: new Date().toISOString(),
              last_updated: new Date().toISOString(),
              created_by: 'semantic-analysis-agent',
              version: '1.0',
              team: 'coding',
              source: 'semantic-analysis',
              context: 'comprehensive-analysis',
              tags: observation.tags || []
            }
          };

          sharedMemory.entities.push(newEntity);
          createdEntities.push(newEntity);
          
          log(`Created new entity: ${observation.name}`, 'info', {
            entityType: newEntity.entityType,
            significance: newEntity.significance,
            observationsCount: newEntity.observations.length
          });
        }
      } catch (error) {
        log(`Failed to process observation: ${observation.name}`, 'error', error);
      }
    }

    return createdEntities;
  }

  private async updateEntityRelationships(
    sharedMemory: SharedMemoryStructure,
    analysisData: any
  ): Promise<EntityRelationship[]> {
    const newRelations: EntityRelationship[] = [];

    // Create standard relationships for new entities
    const recentEntities = sharedMemory.entities.filter(e => {
      const createdAt = new Date(e.metadata.created_at);
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      return createdAt > oneHourAgo;
    });

    for (const entity of recentEntities) {
      // Relationship to CollectiveKnowledge
      const collectiveKnowledgeRelation: EntityRelationship = {
        from: entity.name,
        to: 'CollectiveKnowledge',
        relationType: 'contributes to'
      };

      // Relationship to Coding project
      const codingRelation: EntityRelationship = {
        from: entity.name,
        to: 'Coding',
        relationType: 'implemented in'
      };

      // Check if relationships already exist
      const existingRelations = sharedMemory.relations || [];
      const hasCollectiveKnowledgeRel = existingRelations.some(r => 
        r.from === entity.name && r.to === 'CollectiveKnowledge'
      );
      const hasCodingRel = existingRelations.some(r => 
        r.from === entity.name && r.to === 'Coding'
      );

      if (!hasCollectiveKnowledgeRel) {
        sharedMemory.relations.push(collectiveKnowledgeRelation);
        newRelations.push(collectiveKnowledgeRelation);
      }

      if (!hasCodingRel) {
        sharedMemory.relations.push(codingRelation);
        newRelations.push(codingRelation);
      }
    }

    log(`Updated entity relationships: ${newRelations.length} new relations created`, 'info');
    return newRelations;
  }

  private async saveInsightDocument(insightDocument: any): Promise<string | null> {
    try {
      if (!insightDocument.filePath) {
        log('Insight document has no file path - saving content directly', 'warning');
        const fileName = `${insightDocument.name || 'insight'}_${Date.now()}.md`;
        const filePath = path.join(this.insightsDir, fileName);
        await fs.promises.writeFile(filePath, insightDocument.content, 'utf8');
        return filePath;
      }

      // File already saved by InsightGenerationAgent, just verify it exists
      if (fs.existsSync(insightDocument.filePath)) {
        log(`Insight document verified: ${insightDocument.filePath}`, 'info');
        return insightDocument.filePath;
      } else {
        log(`Insight document file not found: ${insightDocument.filePath}`, 'warning');
        return null;
      }
    } catch (error) {
      log('Failed to save insight document', 'error', error);
      return null;
    }
  }

  private async saveLessonsLearned(lessonsLearned: any): Promise<string | null> {
    try {
      if (!lessonsLearned.filePath) {
        log('Lessons learned has no file path - saving content directly', 'warning');
        const fileName = `lessons_learned_${Date.now()}.md`;
        const filePath = path.join(this.insightsDir, fileName);
        await fs.promises.writeFile(filePath, lessonsLearned.content, 'utf8');
        return filePath;
      }

      // File already saved by InsightGenerationAgent, just verify it exists
      if (fs.existsSync(lessonsLearned.filePath)) {
        log(`Lessons learned document verified: ${lessonsLearned.filePath}`, 'info');
        return lessonsLearned.filePath;
      } else {
        log(`Lessons learned file not found: ${lessonsLearned.filePath}`, 'warning');
        return null;
      }
    } catch (error) {
      log('Failed to save lessons learned document', 'error', error);
      return null;
    }
  }

  private async updateAnalysisCheckpoints(analysisData: any): Promise<boolean> {
    try {
      const sharedMemory = await this.loadSharedMemory();
      const timestamp = new Date().toISOString();
      let updated = false;

      // Update specific analysis timestamps
      if (analysisData.gitAnalysis) {
        sharedMemory.metadata.lastGitAnalysis = timestamp;
        updated = true;
      }

      if (analysisData.vibeAnalysis) {
        sharedMemory.metadata.lastVibeAnalysis = timestamp;
        updated = true;
      }

      if (analysisData.semanticAnalysis) {
        sharedMemory.metadata.lastSemanticAnalysis = timestamp;
        updated = true;
      }

      // Update general metadata
      if (updated) {
        sharedMemory.metadata.last_updated = timestamp;
        sharedMemory.metadata.analysisCount = (sharedMemory.metadata.analysisCount || 0) + 1;
        sharedMemory.metadata.last_sync = Date.now() / 1000; // Unix timestamp
        sharedMemory.metadata.sync_source = 'semantic_analysis_agent';

        await this.saveSharedMemory(sharedMemory);
        log('Analysis checkpoints updated successfully', 'info', {
          lastGitAnalysis: sharedMemory.metadata.lastGitAnalysis,
          lastVibeAnalysis: sharedMemory.metadata.lastVibeAnalysis,
          lastSemanticAnalysis: sharedMemory.metadata.lastSemanticAnalysis,
          analysisCount: sharedMemory.metadata.analysisCount
        });
      }

      return updated;
    } catch (error) {
      log('Failed to update analysis checkpoints', 'error', error);
      return false;
    }
  }

  async getLastAnalysisCheckpoints(): Promise<CheckpointData> {
    try {
      const sharedMemory = await this.loadSharedMemory();
      return {
        lastGitAnalysis: sharedMemory.metadata.lastGitAnalysis,
        lastVibeAnalysis: sharedMemory.metadata.lastVibeAnalysis,
        lastSemanticAnalysis: sharedMemory.metadata.lastSemanticAnalysis,
        lastFullAnalysis: sharedMemory.metadata.last_updated,
        analysisCount: sharedMemory.metadata.analysisCount || 0,
        lastEntitySync: sharedMemory.metadata.last_updated
      };
    } catch (error) {
      log('Failed to get analysis checkpoints', 'error', error);
      return {
        analysisCount: 0
      };
    }
  }

  private async loadSharedMemory(): Promise<SharedMemoryStructure> {
    try {
      if (!fs.existsSync(this.sharedMemoryPath)) {
        log('Creating new shared memory structure', 'info');
        return this.createEmptySharedMemory();
      }

      const content = await fs.promises.readFile(this.sharedMemoryPath, 'utf8');
      const data = JSON.parse(content);

      // Ensure proper structure
      if (!data.entities) data.entities = [];
      if (!data.relations) data.relations = [];
      if (!data.metadata) data.metadata = {};

      // Ensure metadata has required fields
      if (!data.metadata.last_updated) data.metadata.last_updated = new Date().toISOString();
      if (!data.metadata.total_entities) data.metadata.total_entities = data.entities.length;
      if (!data.metadata.total_relations) data.metadata.total_relations = data.relations.length;
      if (!data.metadata.team) data.metadata.team = 'coding';

      return data as SharedMemoryStructure;
    } catch (error) {
      log('Failed to load shared memory, creating new structure', 'warning', error);
      return this.createEmptySharedMemory();
    }
  }

  private async saveSharedMemory(sharedMemory: SharedMemoryStructure): Promise<void> {
    try {
      // Update counts
      sharedMemory.metadata.total_entities = sharedMemory.entities.length;
      sharedMemory.metadata.total_relations = sharedMemory.relations.length;
      sharedMemory.metadata.last_updated = new Date().toISOString();

      // Write with proper formatting
      const content = JSON.stringify(sharedMemory, null, 2);
      await fs.promises.writeFile(this.sharedMemoryPath, content, 'utf8');

      log('Shared memory saved successfully', 'info', {
        entitiesCount: sharedMemory.entities.length,
        relationsCount: sharedMemory.relations.length,
        path: this.sharedMemoryPath
      });
    } catch (error) {
      log('Failed to save shared memory', 'error', error);
      throw error;
    }
  }

  private createEmptySharedMemory(): SharedMemoryStructure {
    return {
      entities: [],
      relations: [],
      metadata: {
        last_updated: new Date().toISOString(),
        total_entities: 0,
        total_relations: 0,
        team: 'coding',
        analysisCount: 0
      }
    };
  }

  private formatObservations(observations: any[]): (string | ObservationObject)[] {
    return observations.map(obs => {
      if (typeof obs === 'string') {
        return obs;
      }

      if (typeof obs === 'object' && obs.content) {
        return {
          type: obs.type || 'insight',
          content: obs.content,
          date: obs.date || new Date().toISOString(),
          metadata: obs.metadata || {}
        };
      }

      // Fallback for unexpected formats
      return String(obs);
    });
  }

  private generateEntityId(name: string): string {
    // Generate a consistent but unique ID
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const cleanName = name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    return `${cleanName}_${timestamp}_${randomSuffix}`;
  }

  private generatePersistenceSummary(
    result: PersistenceResult,
    createdEntities: SharedMemoryEntity[],
    updatedRelations: EntityRelationship[]
  ): string {
    const parts = [];

    if (result.entitiesCreated > 0) {
      parts.push(`Created ${result.entitiesCreated} new entities`);
    }

    if (result.entitiesUpdated > 0) {
      parts.push(`Updated ${result.entitiesUpdated} existing entities`);
    }

    if (updatedRelations.length > 0) {
      parts.push(`Added ${updatedRelations.length} new relationships`);
    }

    if (result.filesCreated.length > 0) {
      parts.push(`Generated ${result.filesCreated.length} insight documents`);
    }

    if (result.checkpointUpdated) {
      parts.push('Updated analysis checkpoints');
    }

    const entityNames = createdEntities.slice(0, 3).map(e => e.name);
    if (entityNames.length > 0) {
      parts.push(`Key entities: ${entityNames.join(', ')}${createdEntities.length > 3 ? '...' : ''}`);
    }

    return parts.length > 0 
      ? `Persistence completed: ${parts.join(', ')}`
      : 'Persistence completed with no changes';
  }

  private ensureDirectories(): void {
    const dirs = [
      this.insightsDir,
      path.join(this.insightsDir, 'puml'),
      path.join(this.insightsDir, 'images')
    ];

    dirs.forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        log(`Created directory: ${dir}`, 'info');
      }
    });
  }

  // Enhanced persistence methods for specific use cases

  async persistGitAnalysisOnly(gitAnalysis: any): Promise<PersistenceResult> {
    const result: PersistenceResult = {
      success: false,
      entitiesCreated: 0,
      entitiesUpdated: 0,
      checkpointUpdated: false,
      filesCreated: [],
      errors: [],
      summary: ''
    };

    try {
      const sharedMemory = await this.loadSharedMemory();
      
      // Update git analysis checkpoint
      sharedMemory.metadata.lastGitAnalysis = new Date().toISOString();
      sharedMemory.metadata.last_updated = new Date().toISOString();
      
      await this.saveSharedMemory(sharedMemory);
      
      result.checkpointUpdated = true;
      result.success = true;
      result.summary = 'Git analysis checkpoint updated';

      return result;
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
      result.summary = `Git persistence failed: ${result.errors[0]}`;
      return result;
    }
  }

  async persistVibeAnalysisOnly(vibeAnalysis: any): Promise<PersistenceResult> {
    const result: PersistenceResult = {
      success: false,
      entitiesCreated: 0,
      entitiesUpdated: 0,
      checkpointUpdated: false,
      filesCreated: [],
      errors: [],
      summary: ''
    };

    try {
      const sharedMemory = await this.loadSharedMemory();
      
      // Update vibe analysis checkpoint
      sharedMemory.metadata.lastVibeAnalysis = new Date().toISOString();
      sharedMemory.metadata.last_updated = new Date().toISOString();
      
      await this.saveSharedMemory(sharedMemory);
      
      result.checkpointUpdated = true;
      result.success = true;
      result.summary = 'Vibe analysis checkpoint updated';

      return result;
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
      result.summary = `Vibe persistence failed: ${result.errors[0]}`;
      return result;
    }
  }

  async getKnowledgeBaseStats(): Promise<{
    totalEntities: number;
    entitiesByType: Record<string, number>;
    totalRelations: number;
    lastAnalysisRun: string | null;
    analysisCount: number;
  }> {
    try {
      const sharedMemory = await this.loadSharedMemory();
      
      const entitiesByType: Record<string, number> = {};
      sharedMemory.entities.forEach(entity => {
        entitiesByType[entity.entityType] = (entitiesByType[entity.entityType] || 0) + 1;
      });

      return {
        totalEntities: sharedMemory.entities.length,
        entitiesByType,
        totalRelations: sharedMemory.relations.length,
        lastAnalysisRun: sharedMemory.metadata.last_updated,
        analysisCount: sharedMemory.metadata.analysisCount || 0
      };
    } catch (error) {
      log('Failed to get knowledge base stats', 'error', error);
      return {
        totalEntities: 0,
        entitiesByType: {},
        totalRelations: 0,
        lastAnalysisRun: null,
        analysisCount: 0
      };
    }
  }

  async validateKnowledgeBaseIntegrity(): Promise<{
    valid: boolean;
    issues: string[];
    repaired: boolean;
  }> {
    const issues: string[] = [];
    let repaired = false;

    try {
      const sharedMemory = await this.loadSharedMemory();

      // Check for missing required fields
      sharedMemory.entities.forEach((entity, index) => {
        if (!entity.name) {
          issues.push(`Entity at index ${index} missing name`);
        }
        if (!entity.entityType) {
          issues.push(`Entity ${entity.name || index} missing entityType`);
          entity.entityType = 'Unknown';
          repaired = true;
        }
        if (!entity.metadata) {
          issues.push(`Entity ${entity.name || index} missing metadata`);
          entity.metadata = {
            created_at: new Date().toISOString(),
            last_updated: new Date().toISOString(),
            created_by: 'system-repair'
          };
          repaired = true;
        }
      });

      // Check for orphaned relations
      const entityNames = new Set(sharedMemory.entities.map(e => e.name));
      sharedMemory.relations = sharedMemory.relations.filter(relation => {
        const fromExists = entityNames.has(relation.from);
        const toExists = entityNames.has(relation.to);
        
        if (!fromExists || !toExists) {
          issues.push(`Orphaned relation: ${relation.from} -> ${relation.to}`);
          repaired = true;
          return false;
        }
        return true;
      });

      // Repair metadata counts
      const actualEntityCount = sharedMemory.entities.length;
      const actualRelationCount = sharedMemory.relations.length;
      
      if (sharedMemory.metadata.total_entities !== actualEntityCount) {
        issues.push(`Entity count mismatch: ${sharedMemory.metadata.total_entities} vs ${actualEntityCount}`);
        sharedMemory.metadata.total_entities = actualEntityCount;
        repaired = true;
      }
      
      if (sharedMemory.metadata.total_relations !== actualRelationCount) {
        issues.push(`Relation count mismatch: ${sharedMemory.metadata.total_relations} vs ${actualRelationCount}`);
        sharedMemory.metadata.total_relations = actualRelationCount;
        repaired = true;
      }

      // Save repairs if any were made
      if (repaired) {
        await this.saveSharedMemory(sharedMemory);
        log('Knowledge base integrity issues repaired', 'info', { issuesFound: issues.length });
      }

      return {
        valid: issues.length === 0,
        issues,
        repaired
      };

    } catch (error) {
      log('Knowledge base integrity validation failed', 'error', error);
      return {
        valid: false,
        issues: [`Validation failed: ${error instanceof Error ? error.message : String(error)}`],
        repaired: false
      };
    }
  }

  // Utility method for external access to shared memory path
  get sharedMemoryFilePath(): string {
    return this.sharedMemoryPath;
  }

  // Utility method for external access to insights directory
  get insightsDirectory(): string {
    return this.insightsDir;
  }
}