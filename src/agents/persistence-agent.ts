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
  
  // Enhanced checkpoint data
  lastAnalyzedCommit?: string;
  lastProcessedVibeSession?: string;
  repositoryContextVersion?: string;
  processedCommitCount: number;
  processedVibeSessionCount: number;
  extractedPatterns: number;
  analysisCompleteness: number; // 0-100%
  confidenceScore: number;
}

export interface SharedMemoryEntity {
  id: string;
  name: string;
  entityType: string;
  significance: number;
  observations: (string | ObservationObject)[];
  relationships: EntityRelationship[];
  metadata: EntityMetadata;
  quick_reference?: {
    trigger: string;
    action: string;
    avoid: string;
    check: string;
  };
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
  validated_file_path?: string; // Track validated insight file path
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
    lastSuccessfulWorkflowCompletion?: string;
    lastCompletedWorkflow?: string;
    successfulWorkflowCount?: number;
    
    // Enhanced checkpoint fields
    lastAnalyzedCommit?: string;
    lastProcessedVibeSession?: string;
    repositoryContextVersion?: string;
    processedCommitCount?: number;
    processedVibeSessionCount?: number;
    extractedPatterns?: number;
    analysisCompleteness?: number;
    confidenceScore?: number;
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
    parameters: any
  ): Promise<PersistenceResult> {
    // Handle both direct parameters and coordinator parameter object
    let gitAnalysis, vibeAnalysis, semanticAnalysis, observations, insightGeneration;
    
    if (arguments.length === 1 && typeof parameters === 'object' && parameters._context) {
      // Called by coordinator with parameter object
      const context = parameters._context;
      const results = context.previousResults || {};
      
      gitAnalysis = results.analyze_git_history;
      vibeAnalysis = results.analyze_vibe_history;
      semanticAnalysis = results.semantic_analysis;
      observations = results.generate_observations?.observations || results.generate_observations || [];
      insightGeneration = results.generate_insights;
    } else if (arguments.length > 1) {
      // Called directly with separate parameters (backward compatibility)
      gitAnalysis = arguments[0];
      vibeAnalysis = arguments[1];
      semanticAnalysis = arguments[2];
      observations = arguments[3] || [];
      insightGeneration = arguments[4];
    } else if (parameters.workflow_results) {
      // Called by coordinator with workflow_results wrapper
      const results = parameters.workflow_results;
      gitAnalysis = results.git_history;
      vibeAnalysis = results.vibe_history;
      semanticAnalysis = results.semantic_analysis;
      observations = results.observations?.observations || results.observations || [];
      insightGeneration = results.insights;
    } else {
      // Single parameter call without context
      gitAnalysis = parameters.gitAnalysis;
      vibeAnalysis = parameters.vibeAnalysis;
      semanticAnalysis = parameters.semanticAnalysis;
      observations = parameters.observations?.observations || parameters.observations || [];
      insightGeneration = parameters.insightGeneration;
    }

    // Ensure observations is always an array
    if (!Array.isArray(observations)) {
      observations = [];
    }

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

      // Create entities from observations and analysis results
      // DISABLED: Skip malformed observations - use analysis results instead
      // const createdEntities = await this.createEntitiesFromObservations(observations, sharedMemory);
      const createdEntities: SharedMemoryEntity[] = [];
      
      // Also create entities from analysis results even if no observations provided
      const analysisEntities = await this.createEntitiesFromAnalysisResults({
        gitAnalysis,
        vibeAnalysis, 
        semanticAnalysis,
        insightGeneration
      }, sharedMemory);
      
      const totalCreated = createdEntities.length + analysisEntities.length;
      result.entitiesCreated = totalCreated;
      
      log('Entities created from persistence', 'info', {
        fromObservations: createdEntities.length,
        fromAnalysis: analysisEntities.length,
        total: totalCreated
      });

      // Update relationships based on analysis results
      const updatedRelations = await this.updateEntityRelationships(sharedMemory, {
        gitAnalysis,
        vibeAnalysis,
        semanticAnalysis
      });

      // Save insight files if available
      if (insightGeneration?.insightDocuments && insightGeneration.insightDocuments.length > 0) {
        // Save all generated insight documents
        for (const insightDoc of insightGeneration.insightDocuments) {
          const insightFile = await this.saveInsightDocument(insightDoc);
          if (insightFile) {
            result.filesCreated.push(insightFile);
          }
        }
      } else if (insightGeneration?.insightDocument) {
        // Fallback to single document for backward compatibility
        const insightFile = await this.saveInsightDocument(insightGeneration.insightDocument);
        if (insightFile) {
          result.filesCreated.push(insightFile);
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
          // CRITICAL: Validate insight file exists before creating entity (prevents phantom nodes)
          const insightFilePath = path.join(process.cwd(), 'knowledge-management', 'insights', `${observation.name}.md`);
          const insightFileExists = fs.existsSync(insightFilePath);
          
          if (!insightFileExists) {
            log(`VALIDATION FAILED: Insight file missing for entity ${observation.name} at ${insightFilePath}`, 'error', {
              entityName: observation.name,
              expectedPath: insightFilePath,
              preventingPhantomNode: true
            });
            // Skip creating entity to prevent phantom nodes
            continue;
          }
          
          // Create new entity only after file validation passes
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
              tags: observation.tags || [],
              validated_file_path: insightFilePath
            }
          };

          sharedMemory.entities.push(newEntity);
          createdEntities.push(newEntity);
          
          log(`Created new entity with validated file: ${observation.name}`, 'info', {
            entityType: newEntity.entityType,
            significance: newEntity.significance,
            observationsCount: newEntity.observations.length,
            validatedFile: insightFilePath
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
      log('🔍 PERSISTENCE TRACE: saveInsightDocument called', 'info', {
        name: insightDocument.name,
        hasFilePath: !!insightDocument.filePath,
        filePath: insightDocument.filePath,
        hasContent: !!insightDocument.content
      });
      
      if (!insightDocument.filePath) {
        log('🚨 NO FILEPATH - Creating new file', 'warning', { name: insightDocument.name });
        const fileName = `${insightDocument.name || 'insight'}_${Date.now()}.md`;
        log('🚨 GENERATED FILENAME', 'warning', { fileName });
        const filePath = path.join(this.insightsDir, fileName);
        log('🚨 FULL FILEPATH', 'warning', { fullPath: filePath });
        await fs.promises.writeFile(filePath, insightDocument.content, 'utf8');
        return filePath;
      }

      // File already saved by InsightGenerationAgent, just verify it exists
      log('🔍 CHECKING EXISTING FILE', 'info', { filePath: insightDocument.filePath });
      if (fs.existsSync(insightDocument.filePath)) {
        log('✅ FILE EXISTS - Using existing file', 'info', { filePath: insightDocument.filePath });
        return insightDocument.filePath;
      } else {
        log('❌ FILE NOT FOUND - Returning null', 'warning', { filePath: insightDocument.filePath });
        return null;
      }
    } catch (error) {
      log('💥 ERROR in saveInsightDocument', 'error', error);
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
        lastEntitySync: sharedMemory.metadata.last_updated,
        
        // Enhanced checkpoint data
        lastAnalyzedCommit: sharedMemory.metadata.lastAnalyzedCommit,
        lastProcessedVibeSession: sharedMemory.metadata.lastProcessedVibeSession,
        repositoryContextVersion: sharedMemory.metadata.repositoryContextVersion,
        processedCommitCount: sharedMemory.metadata.processedCommitCount || 0,
        processedVibeSessionCount: sharedMemory.metadata.processedVibeSessionCount || 0,
        extractedPatterns: sharedMemory.metadata.extractedPatterns || 0,
        analysisCompleteness: sharedMemory.metadata.analysisCompleteness || 0,
        confidenceScore: sharedMemory.metadata.confidenceScore || 0
      };
    } catch (error) {
      log('Failed to get analysis checkpoints', 'error', error);
      return {
        analysisCount: 0,
        processedCommitCount: 0,
        processedVibeSessionCount: 0,
        extractedPatterns: 0,
        analysisCompleteness: 0,
        confidenceScore: 0
      };
    }
  }

  async updateEnhancedCheckpoint(checkpointUpdates: Partial<CheckpointData>): Promise<boolean> {
    try {
      const sharedMemory = await this.loadSharedMemory();
      
      // Update enhanced checkpoint fields
      if (checkpointUpdates.lastAnalyzedCommit !== undefined) {
        sharedMemory.metadata.lastAnalyzedCommit = checkpointUpdates.lastAnalyzedCommit;
      }
      if (checkpointUpdates.lastProcessedVibeSession !== undefined) {
        sharedMemory.metadata.lastProcessedVibeSession = checkpointUpdates.lastProcessedVibeSession;
      }
      if (checkpointUpdates.repositoryContextVersion !== undefined) {
        sharedMemory.metadata.repositoryContextVersion = checkpointUpdates.repositoryContextVersion;
      }
      if (checkpointUpdates.processedCommitCount !== undefined) {
        sharedMemory.metadata.processedCommitCount = checkpointUpdates.processedCommitCount;
      }
      if (checkpointUpdates.processedVibeSessionCount !== undefined) {
        sharedMemory.metadata.processedVibeSessionCount = checkpointUpdates.processedVibeSessionCount;
      }
      if (checkpointUpdates.extractedPatterns !== undefined) {
        sharedMemory.metadata.extractedPatterns = checkpointUpdates.extractedPatterns;
      }
      if (checkpointUpdates.analysisCompleteness !== undefined) {
        sharedMemory.metadata.analysisCompleteness = checkpointUpdates.analysisCompleteness;
      }
      if (checkpointUpdates.confidenceScore !== undefined) {
        sharedMemory.metadata.confidenceScore = checkpointUpdates.confidenceScore;
      }
      
      // Update timestamp
      sharedMemory.metadata.last_updated = new Date().toISOString();
      
      await this.saveSharedMemory(sharedMemory);
      
      log('Enhanced checkpoint updated successfully', 'info', checkpointUpdates);
      return true;
    } catch (error) {
      log('Failed to update enhanced checkpoint', 'error', error);
      return false;
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

  private async createEntitiesFromAnalysisResults(
    analysisData: {
      gitAnalysis?: any;
      vibeAnalysis?: any;
      semanticAnalysis?: any;
      insightGeneration?: any;
    },
    sharedMemory: SharedMemoryStructure
  ): Promise<SharedMemoryEntity[]> {
    const entities: SharedMemoryEntity[] = [];
    const now = new Date().toISOString();

    try {
      // Create entity from insight generation if available
      if (analysisData.insightGeneration?.insightDocument) {
        const insight = analysisData.insightGeneration.insightDocument;
        
        // Clean up the insight name - remove duplicates and suffixes
        let cleanName = insight.name || 'SemanticAnalysisInsight';
        
        // Remove " - Implementation Analysis" suffix if present
        cleanName = cleanName.replace(/ - Implementation Analysis$/, '');
        
        // Remove duplicate pattern names (e.g., "PatternName - PatternName")
        const parts = cleanName.split(' - ');
        if (parts.length === 2 && parts[0] === parts[1]) {
          cleanName = parts[0];
        }
        
        // Extract actionable insights from the content in VkbCli format (simple strings)
        const detailedObservations = this.extractSimpleObservations(insight, cleanName, now);

        const entity: SharedMemoryEntity = {
          id: `analysis_${Date.now()}`,
          name: cleanName,
          entityType: 'TransferablePattern',
          significance: insight.metadata?.significance || 7,
          observations: detailedObservations,
          relationships: [],
          metadata: {
            created_at: now,
            last_updated: now,
            source: 'semantic-analysis-workflow',
            context: `comprehensive-analysis-${insight.metadata?.analysisTypes?.join('-') || 'semantic'}`,
            tags: insight.metadata?.analysisTypes
          },
          quick_reference: this.generateQuickReference(insight, cleanName)
        };

        // CRITICAL: Validate insight file exists before creating entity (prevents phantom nodes)
        const insightFilePath = path.join(process.cwd(), 'knowledge-management', 'insights', `${entity.name}.md`);
        const insightFileExists = fs.existsSync(insightFilePath);
        
        if (!insightFileExists) {
          log(`VALIDATION FAILED: Insight file missing for entity ${entity.name} at ${insightFilePath}`, 'error', {
            entityName: entity.name,
            expectedPath: insightFilePath,
            preventingPhantomNode: true,
            method: 'createEntitiesFromAnalysisResults'
          });
          // Skip creating entity to prevent phantom nodes
        } else {
          entity.metadata.validated_file_path = insightFilePath;
          entities.push(entity);
          sharedMemory.entities.push(entity);
          log(`Created entity with validated file: ${entity.name}`, 'info', {
            validatedFile: insightFilePath,
            method: 'createEntitiesFromAnalysisResults'
          });
        }
      }

      // Process additional insight files that may have been generated
      const insightsDir = path.join(process.cwd(), 'knowledge-management', 'insights');
      if (fs.existsSync(insightsDir)) {
        // Look for recently generated insight files (within last 5 minutes)
        const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
        const insightFiles = fs.readdirSync(insightsDir)
          .filter(file => file.endsWith('.md'))
          .map(file => {
            const fullPath = path.join(insightsDir, file);
            const stats = fs.statSync(fullPath);
            return { file, fullPath, mtime: stats.mtime.getTime() };
          })
          .filter(item => item.mtime > fiveMinutesAgo);

        for (const insightFile of insightFiles) {
          const patternName = path.basename(insightFile.file, '.md');
          
          // Skip if we already created this entity
          if (entities.some(e => e.name === patternName)) {
            continue;
          }
          
          // Create entity from insight file
          const insightContent = fs.readFileSync(insightFile.fullPath, 'utf8');
          const mockInsight = {
            name: patternName,
            content: insightContent,
            metadata: { significance: 7 }
          };
          
          const simpleObservations = this.extractSimpleObservations(mockInsight, patternName, now);
          
          const additionalEntity: SharedMemoryEntity = {
            id: `analysis_${Date.now()}_${patternName}`,
            name: patternName,
            entityType: 'TransferablePattern',
            significance: 7,
            observations: simpleObservations,
            relationships: [],
            metadata: {
              created_at: now,
              last_updated: now,
              source: 'semantic-analysis-workflow-additional',
              context: 'comprehensive-analysis-semantic',
              tags: ['pattern', 'additional']
            },
            quick_reference: this.generateQuickReferenceFromContent(insightContent, patternName)
          };
          
          entities.push(additionalEntity);
          sharedMemory.entities.push(additionalEntity);
          log(`Created additional entity from insight file: ${patternName}`, 'info', {
            file: insightFile.fullPath,
            method: 'createEntitiesFromAnalysisResults-additional'
          });
        }
      }

      // FIXED: Don't create separate entities for patterns to prevent phantom nodes
      // Patterns are already included in the main analysis insight document
      // Creating separate entities for patterns without corresponding insight files
      // was causing phantom nodes in shared-memory-coding.json
      if (analysisData.insightGeneration?.patternCatalog?.patterns) {
        log('Patterns included in main analysis insight document - no separate entities created', 'info', {
          patternCount: analysisData.insightGeneration.patternCatalog.patterns.length,
          reasoning: 'Preventing phantom nodes by including patterns in main analysis only'
        });
      }

      // Create entity from Git analysis insights if significant commits found
      if (analysisData.gitAnalysis?.commits?.length > 0) {
        const gitAnalysis = analysisData.gitAnalysis;
        const gitEntity: SharedMemoryEntity = {
          id: `git_analysis_${Date.now()}`,
          name: 'GitDevelopmentEvolution',
          entityType: 'DevelopmentInsight',
          significance: Math.min(8, Math.max(3, gitAnalysis.commits.length / 5)), // Scale based on commits
          observations: [
            {
              type: 'metric',
              content: `Analyzed ${gitAnalysis.commits.length} commits with ${gitAnalysis.architecturalDecisions?.length || 0} architectural decisions`,
              date: now
            },
            {
              type: 'insight',
              content: gitAnalysis.summary?.insights || 'Development patterns extracted from commit history',
              date: now
            }
          ],
          relationships: [],
          metadata: {
            created_at: now,
            last_updated: now,
            source: 'git-history-analysis',
            context: `git-evolution-${gitAnalysis.commits.length}-commits`,
            tags: ['git-analysis', 'development', 'evolution']
          }
        };

        // CRITICAL: Validate insight file exists before creating git entity
        const gitInsightPath = path.join(process.cwd(), 'knowledge-management', 'insights', `${gitEntity.name}.md`);
        const gitFileExists = fs.existsSync(gitInsightPath);
        
        if (!gitFileExists) {
          log(`VALIDATION FAILED: Git insight file missing for ${gitEntity.name} at ${gitInsightPath}`, 'error', {
            entityName: gitEntity.name,
            expectedPath: gitInsightPath,
            preventingPhantomNode: true,
            method: 'createEntitiesFromAnalysisResults-git'
          });
          // Skip creating git entity to prevent phantom nodes
        } else {
          gitEntity.metadata.validated_file_path = gitInsightPath;
          entities.push(gitEntity);
          sharedMemory.entities.push(gitEntity);
          log(`Created git entity with validated file: ${gitEntity.name}`, 'info', {
            validatedFile: gitInsightPath,
            method: 'createEntitiesFromAnalysisResults-git'
          });
        }
      }

      log('Created entities from analysis results', 'info', {
        entitiesCreated: entities.length,
        types: entities.map(e => e.entityType)
      });

      return entities;

    } catch (error) {
      log('Failed to create entities from analysis results', 'error', error);
      return [];
    }
  }

  async saveSuccessfulWorkflowCompletion(workflowName: string, timestamp: Date = new Date()): Promise<PersistenceResult> {
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
      
      // Update successful workflow completion checkpoint
      sharedMemory.metadata.lastSuccessfulWorkflowCompletion = timestamp.toISOString();
      sharedMemory.metadata.lastCompletedWorkflow = workflowName;
      sharedMemory.metadata.last_updated = timestamp.toISOString();
      
      // Increment successful workflow count
      sharedMemory.metadata.successfulWorkflowCount = (sharedMemory.metadata.successfulWorkflowCount || 0) + 1;
      
      await this.saveSharedMemory(sharedMemory);
      
      result.checkpointUpdated = true;
      result.success = true;
      result.summary = `Successful workflow completion recorded: ${workflowName}`;

      log('Successful workflow completion checkpoint saved', 'info', {
        workflow: workflowName,
        timestamp: timestamp.toISOString(),
        count: sharedMemory.metadata.successfulWorkflowCount
      });

      return result;
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
      result.summary = `Workflow completion checkpoint failed: ${result.errors[0]}`;
      log('Failed to save workflow completion checkpoint', 'error', error);
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

  async createUkbEntity(entityData: {
    name: string;
    type: string;
    insights: string;
    significance?: number;
    tags?: string[];
  }): Promise<{ success: boolean; details: string }> {
    try {
      log(`Creating UKB entity: ${entityData.name}`, 'info', {
        type: entityData.type,
        significance: entityData.significance
      });

      const currentDate = new Date().toISOString();
      
      // Create structured observation from insights
      const observations = [
        {
          type: 'insight',
          content: entityData.insights,
          date: currentDate,
          metadata: {
            source: 'manual_creation',
            significance: entityData.significance || 5
          }
        },
        {
          type: 'link',
          content: `Details: ${entityData.name}.md`,
          date: currentDate,
          metadata: {
            source: 'ukb_tool',
            fileValidated: true
          }
        }
      ];

      // Create entity structure
      const entity: SharedMemoryEntity = {
        id: `entity_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: entityData.name,
        entityType: entityData.type,
        significance: entityData.significance || 5,
        observations,
        relationships: [],
        metadata: {
          created_at: currentDate,
          last_updated: currentDate,
          created_by: 'ukb_tool',
          version: '1.0'
        }
      };

      // Load shared memory
      const sharedMemory = await this.loadSharedMemory();
      
      // Check if entity already exists
      const existingEntity = sharedMemory.entities.find(e => e.name === entityData.name);
      if (existingEntity) {
        return {
          success: false,
          details: `Entity '${entityData.name}' already exists`
        };
      }

      // CRITICAL: Validate insight file exists before creating UKB entity
      const ukbInsightPath = path.join(process.cwd(), 'knowledge-management', 'insights', `${entity.name}.md`);
      const ukbFileExists = fs.existsSync(ukbInsightPath);
      
      if (!ukbFileExists) {
        log(`VALIDATION FAILED: UKB insight file missing for ${entity.name} at ${ukbInsightPath}`, 'error', {
          entityName: entity.name,
          expectedPath: ukbInsightPath,
          preventingPhantomNode: true,
          method: 'createUkbEntity'
        });
        return {
          success: false,
          details: `Insight file validation failed: ${ukbInsightPath} not found`
        };
      }
      
      // Add validated entity
      entity.metadata.validated_file_path = ukbInsightPath;
      sharedMemory.entities.push(entity);
      sharedMemory.metadata.total_entities = sharedMemory.entities.length;
      sharedMemory.metadata.last_updated = currentDate;

      // Save updated shared memory
      await this.saveSharedMemory(sharedMemory);

      // Create insight document
      const insightPath = path.join(this.insightsDir, `${entityData.name}.md`);
      const insightContent = `# ${entityData.name}

**Type:** ${entityData.type}
**Significance:** ${entityData.significance || 5}/10
**Created:** ${currentDate}
**Tags:** ${entityData.tags?.join(', ') || 'None'}

## Insights

${entityData.insights}

## Metadata

- **Entity ID:** ${entity.id}
- **Created By:** ukb_tool
- **Version:** 1.0
`;

      await fs.promises.writeFile(insightPath, insightContent, 'utf8');

      log(`UKB entity created successfully: ${entityData.name}`, 'info', {
        entityId: entity.id,
        insightPath
      });

      return {
        success: true,
        details: `Entity '${entityData.name}' created with insight document at ${insightPath}`
      };

    } catch (error) {
      log(`Failed to create UKB entity: ${entityData.name}`, 'error', error);
      return {
        success: false,
        details: `Failed to create entity: ${error instanceof Error ? error.message : String(error)}`
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


  private generateEntitySummary(analysisData: any): string {
    const summaryPoints = [];
    
    if (analysisData.gitAnalysis?.commits?.length) {
      summaryPoints.push(`Git analysis: ${analysisData.gitAnalysis.commits.length} commits analyzed`);
    }
    
    if (analysisData.semanticAnalysis?.patterns?.length) {
      summaryPoints.push(`${analysisData.semanticAnalysis.patterns.length} patterns identified`);
    }
    
    if (analysisData.semanticAnalysis?.codeAnalysis?.complexity) {
      const complexity = analysisData.semanticAnalysis.codeAnalysis.complexity;
      summaryPoints.push(`Code complexity: avg ${complexity.averageComplexity?.toFixed(1) || 'N/A'}`);
    }
    
    if (analysisData.vibeAnalysis?.conversations?.length) {
      summaryPoints.push(`${analysisData.vibeAnalysis.conversations.length} conversations analyzed`);
    }

    summaryPoints.push('Cross-session persistence, agent-agnostic design');
    summaryPoints.push('Generated insights with PlantUML diagrams');
    
    return summaryPoints.join('\n');
  }

  /**
   * Extract actionable observations from insight content following shared-memory pattern structure
   */
  private extractActionableObservations(insight: any, cleanName: string, now: string): any[] {
    const observations = [];

    // Extract key implementation details from the content
    const content = insight.content || '';
    const sections = this.parseInsightSections(content);

    // Rule/Key Principle observation
    if (sections.problem || sections.solution) {
      observations.push({
        type: 'rule',
        content: this.extractRule(sections, cleanName),
        date: now
      });
    }

    // Basic implementation observation
    if (sections.implementation || sections.technical) {
      observations.push({
        type: 'basic_implementation',
        content: this.extractImplementation(sections),
        date: now
      });
    }

    // Performance/Benefits observation
    if (sections.performance || sections.benefits) {
      observations.push({
        type: 'performance',
        content: this.extractPerformance(sections),
        date: now
      });
    }

    // Applicability observation
    observations.push({
      type: 'applicability',
      content: this.extractApplicability(sections) || 'General software development patterns',
      date: now
    });

    // Trigger criteria observation
    observations.push({
      type: 'trigger_criteria',
      content: this.extractTriggerCriteria(sections, cleanName),
      date: now
    });

    // Link observation
    observations.push({
      type: 'link',
      content: `Details: knowledge-management/insights/${cleanName}.md`,
      date: now
    });

    return observations;
  }

  /**
   * Extract simple string observations like VkbCli format (not complex objects)
   */
  private extractSimpleObservations(insight: any, cleanName: string, now: string): string[] {
    const observations: string[] = [];
    const content = insight.content || insight.description || '';
    
    // Try structured sections first
    const sections = this.parseInsightSections(content);
    let hasStructuredContent = false;

    // Problem statement
    if (sections.problem) {
      const problemText = sections.problem.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
      if (problemText.length > 20) {
        observations.push(`Problem: ${problemText.substring(0, 250) + (problemText.length > 250 ? '...' : '')}`);
        hasStructuredContent = true;
      }
    }

    // Solution statement  
    if (sections.solution) {
      const solutionText = sections.solution.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
      if (solutionText.length > 20) {
        observations.push(`Solution: ${solutionText.substring(0, 250) + (solutionText.length > 250 ? '...' : '')}`);
        hasStructuredContent = true;
      }
    }

    // Implementation approach
    if (sections.implementation) {
      const implText = sections.implementation.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
      if (implText.length > 20) {
        observations.push(`Implementation: ${implText.substring(0, 250) + (implText.length > 250 ? '...' : '')}`);
        hasStructuredContent = true;
      }
    }

    // If no structured content found, extract meaningful content from insight files
    if (!hasStructuredContent && content) {
      // Extract pattern description from Overview section
      const overviewMatch = content.match(/## Overview[\s\S]*?(?=##|$)/i);
      if (overviewMatch) {
        const overview = overviewMatch[0].replace(/## Overview\s*/i, '').trim();
        const problemMatch = overview.match(/\*\*Problem:\*\*\s*([^*\n]+)/i);
        const solutionMatch = overview.match(/\*\*Solution:\*\*\s*([^*\n]+)/i);
        
        if (problemMatch) {
          observations.push(`Problem: ${problemMatch[1].trim()}`);
        }
        if (solutionMatch) {
          observations.push(`Solution: ${solutionMatch[1].trim()}`);
        }
      }
      
      // Extract from Problem & Solution section
      const problemSolutionMatch = content.match(/## Problem & Solution[\s\S]*?(?=##|$)/i);
      if (problemSolutionMatch && observations.length === 0) {
        const section = problemSolutionMatch[0];
        const descMatch = section.match(/\*\*Description:\*\*\s*([^*\n]+)/i);
        const approachMatch = section.match(/\*\*Approach:\*\*\s*([^*\n]+)/i);
        
        if (descMatch) {
          observations.push(`Pattern: ${descMatch[1].trim()}`);
        }
        if (approachMatch) {
          observations.push(`Approach: ${approachMatch[1].trim()}`);
        }
      }
      
      // Extract implementation bullets from Implementation section
      const implMatch = content.match(/## Implementation Details[\s\S]*?(?=##|$)/i);
      if (implMatch) {
        const implSection = implMatch[0];
        const bullets = implSection.match(/^- (.+)$/gm);
        if (bullets && bullets.length > 0) {
          const implList = bullets.slice(0, 4).map((b: string) => b.replace(/^- /, '')).join(', ');
          observations.push(`Implementation: ${implList}`);
        }
      }
      
      // Extract significance rating
      const sigMatch = content.match(/\*\*Significance:\*\*\s*(\d+\/\d+)[^*]*([^*\n]+)/i);
      if (sigMatch) {
        observations.push(`Significance: ${sigMatch[1]} - ${sigMatch[2].trim()}`);
      }
      
      // Extract applicability from context
      const contextMatch = content.match(/\*\*Domain:\*\*\s*([^*\n]+)/i);
      const langMatch = content.match(/\*\*Primary Languages:\*\*\s*([^*\n]+)/i);
      if (contextMatch || langMatch) {
        const domains = [];
        if (contextMatch) domains.push(contextMatch[1].trim().toLowerCase());
        if (langMatch) domains.push(langMatch[1].trim().toLowerCase());
        observations.push(`Applies to: ${domains.join(', ')} and similar contexts`);
      }
      
      // Fallback to generic content only if nothing else worked
      if (observations.length === 0 && typeof content === 'string') {
        const applicability = this.extractApplicability(content);
        if (applicability) {
          observations.push(applicability);
        }
      }
    }

    // Key learnings/rationale - only if we have structured content
    if (hasStructuredContent) {
      const learnings = this.extractKeyLearnings(sections);
      if (learnings) {
        observations.push(`Learning: ${learnings}`);
      }
    }

    // Applicability - enhanced for better domain detection
    const applicability = this.extractApplicability(sections.solution || sections.implementation || content || '');
    if (applicability && !applicability.includes('General software development')) {
      observations.push(`Applies to: ${applicability}`);
    }

    // Link with full URL like VkbCli
    observations.push(`Details: http://localhost:8080/knowledge-management/insights/${cleanName}.md`);

    return observations;
  }

  /**
   * Parse insight content into sections
   */
  private parseInsightSections(content: string): any {
    const sections: any = {};
    
    // Extract problem statement
    const problemMatch = content.match(/## Problem[\s\S]*?(?=##|$)/i);
    if (problemMatch) {
      sections.problem = problemMatch[0].replace(/## Problem\s*/i, '').trim();
    }

    // Extract solution
    const solutionMatch = content.match(/## Solution[\s\S]*?(?=##|$)/i);
    if (solutionMatch) {
      sections.solution = solutionMatch[0].replace(/## Solution\s*/i, '').trim();
    }

    // Extract implementation details
    const implMatch = content.match(/## Implementation[\s\S]*?(?=##|$)/i);
    if (implMatch) {
      sections.implementation = implMatch[0].replace(/## Implementation\s*/i, '').trim();
    }

    // Extract technical details
    const techMatch = content.match(/## Technical[\s\S]*?(?=##|$)/i);
    if (techMatch) {
      sections.technical = techMatch[0].replace(/## Technical\s*/i, '').trim();
    }

    // Extract performance information
    const perfMatch = content.match(/## Performance[\s\S]*?(?=##|$)/i);
    if (perfMatch) {
      sections.performance = perfMatch[0].replace(/## Performance\s*/i, '').trim();
    }

    return sections;
  }

  /**
   * Extract a key rule/principle from the sections
   */
  private extractRule(sections: any, cleanName: string): string {
    if (sections.problem && sections.solution) {
      // Try to extract the core principle
      const firstSentence = sections.solution.split('.')[0];
      if (firstSentence.length > 10 && firstSentence.length < 200) {
        return firstSentence + '.';
      }
    }
    
    return `Apply ${cleanName} pattern for systematic ${this.inferDomain(sections)} improvements`;
  }

  /**
   * Extract basic implementation details
   */
  private extractImplementation(sections: any): string {
    // Look for code snippets or specific implementation steps
    const codeMatch = sections.implementation?.match(/```[\s\S]*?```/);
    if (codeMatch) {
      return codeMatch[0].replace(/```[\w]*\n?|```/g, '').trim();
    }

    // Look for bullet points or numbered steps
    const steps = sections.implementation?.match(/[-•*]\s.*$/gm);
    if (steps && steps.length > 0) {
      return steps[0].replace(/[-•*]\s/, '').trim();
    }

    // Fallback to first meaningful sentence
    const firstSentence = (sections.implementation || sections.technical || '')
      .split('.')[0]?.trim();
    
    return firstSentence || 'Pattern-specific implementation approach';
  }

  /**
   * Extract performance benefits
   */
  private extractPerformance(sections: any): string {
    if (sections.performance) {
      const firstLine = sections.performance.split('\n')[0].trim();
      if (firstLine.length > 10) {
        return firstLine;
      }
    }

    return 'Improved system performance and maintainability through pattern application';
  }


  /**
   * Extract trigger criteria
   */
  private extractTriggerCriteria(sections: any, cleanName: string): string {
    if (sections.problem) {
      const problemDesc = sections.problem.split('.')[0].trim();
      if (problemDesc.length > 10 && problemDesc.length < 150) {
        return `When experiencing: ${problemDesc.toLowerCase()}`;
      }
    }

    const domain = this.inferDomain(sections);
    return `Apply when ${domain} complexity requires systematic pattern-based solution`;
  }

  /**
   * Infer the domain from content sections
   */
  private inferDomain(sections: any): string {
    const content = (sections.problem || sections.solution || sections.implementation || '').toLowerCase();
    
    if (content.includes('performance') || content.includes('optimization')) return 'performance';
    if (content.includes('architecture') || content.includes('design')) return 'architectural';
    if (content.includes('state') || content.includes('data')) return 'state management';
    if (content.includes('api') || content.includes('service')) return 'service integration';
    if (content.includes('ui') || content.includes('interface')) return 'user interface';
    if (content.includes('security') || content.includes('auth')) return 'security';
    
    return 'system';
  }

  /**
   * Generate quick reference section like other entities in shared-memory files
   */
  private generateQuickReference(insight: any, cleanName: string): any {
    const content = insight.content || '';
    const sections = this.parseInsightSections(content);
    
    return {
      trigger: this.extractTriggerCondition(sections, cleanName),
      action: this.extractActionSummary(sections, cleanName),
      avoid: this.extractAvoidanceGuidance(sections),
      check: this.extractSuccessCheck(sections)
    };
  }

  /**
   * Extract trigger condition for quick reference
   */
  private extractTriggerCondition(sections: any, cleanName: string): string {
    if (sections.problem) {
      const problem = sections.problem.split('.')[0].trim();
      if (problem.length > 10 && problem.length < 100) {
        return problem;
      }
    }
    
    const domain = this.inferDomain(sections);
    return `${domain.charAt(0).toUpperCase() + domain.slice(1)} complexity requiring ${cleanName} pattern solution`;
  }

  /**
   * Extract action summary for quick reference
   */
  private extractActionSummary(sections: any, cleanName: string): string {
    // Look for implementation steps
    if (sections.implementation) {
      const firstStep = sections.implementation.split('.')[0].trim();
      if (firstStep.length > 10 && firstStep.length < 150) {
        return firstStep;
      }
    }

    if (sections.solution) {
      const firstSolution = sections.solution.split('.')[0].trim();
      if (firstSolution.length > 10 && firstSolution.length < 150) {
        return firstSolution;
      }
    }

    return `Apply ${cleanName} pattern with systematic implementation approach`;
  }

  /**
   * Extract avoidance guidance for quick reference
   */
  private extractAvoidanceGuidance(sections: any): string {
    // Look for anti-patterns or warnings in the content
    const content = (sections.problem || sections.solution || sections.implementation || '').toLowerCase();
    
    if (content.includes('avoid') || content.includes('don\'t') || content.includes('never')) {
      const avoidMatch = content.match(/(?:avoid|don't|never)[^.]*\./i);
      if (avoidMatch) {
        return avoidMatch[0].trim();
      }
    }

    // Generic avoidance guidance based on domain
    const domain = this.inferDomain(sections);
    switch (domain) {
      case 'performance':
        return 'Avoid premature optimization without measurement';
      case 'architectural':
        return 'Avoid tightly coupled components and monolithic structures';
      case 'state management':
        return 'Avoid direct state mutation and complex prop drilling';
      case 'security':
        return 'Avoid hardcoded secrets and unvalidated inputs';
      default:
        return 'Avoid ad-hoc solutions without systematic pattern application';
    }
  }

  /**
   * Extract success check criteria for quick reference
   */
  private extractSuccessCheck(sections: any): string {
    if (sections.performance) {
      const perfLine = sections.performance.split('\n')[0].trim();
      if (perfLine.length > 10 && perfLine.length < 100) {
        return perfLine;
      }
    }

    // Look for measurable outcomes
    const content = sections.solution || sections.implementation || '';
    const metricMatch = content.match(/\d+%|\d+x|improved|reduced|increased/i);
    if (metricMatch) {
      const sentence = content.split('.').find((s: string) => s.includes(metricMatch[0]));
      if (sentence && sentence.trim().length < 120) {
        return sentence.trim();
      }
    }

    return 'Measurable improvement in system maintainability and performance';
  }

  /**
   * Extract key learnings for simple observations
   */
  private extractKeyLearnings(sections: any): string | null {
    // Look for rationale or key insights
    const solution = sections.solution || '';
    const implementation = sections.implementation || '';
    
    // Try to find a sentence that explains "why" or "because"
    const combined = solution + ' ' + implementation;
    const sentences = combined.split(/[.!?]+/).filter(s => s.trim().length > 20);
    
    for (const sentence of sentences) {
      if (sentence.toLowerCase().includes('because') || 
          sentence.toLowerCase().includes('provides') || 
          sentence.toLowerCase().includes('enables') ||
          sentence.toLowerCase().includes('allows')) {
        const cleaned = sentence.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
        if (cleaned.length > 30 && cleaned.length < 200) {
          return cleaned;
        }
      }
    }
    
    return null;
  }

  /**
   * Extract applicability for simple observations
   */
  private extractApplicability(contentOrSections: any): string | null {
    const content = (typeof contentOrSections === 'string' 
      ? contentOrSections 
      : (contentOrSections?.solution || contentOrSections?.implementation || '')
    ).toLowerCase();
    
    // Build applicability based on content domains
    const domains = [];
    if (content.includes('architecture') || content.includes('design')) domains.push('system architecture');
    if (content.includes('performance') || content.includes('optimization')) domains.push('performance optimization');
    if (content.includes('state') || content.includes('data')) domains.push('state management');
    if (content.includes('api') || content.includes('service')) domains.push('API design');
    if (content.includes('workflow') || content.includes('process')) domains.push('development workflows');
    if (content.includes('collaboration') || content.includes('team')) domains.push('team collaboration');
    if (content.includes('documentation') || content.includes('knowledge')) domains.push('knowledge management');
    
    if (domains.length > 0) {
      return `Applicable to ${domains.join(', ')} and similar domain challenges`;
    }
    
    return 'General software development patterns and architectural challenges';
  }

  /**
   * Generate quick reference from insight content
   */
  private generateQuickReferenceFromContent(content: string, patternName: string): any {
    const sections = this.parseInsightSections(content);
    
    return {
      trigger: sections.problem ? sections.problem.split('.')[0].trim() : `When ${patternName} pattern is needed`,
      action: sections.solution ? sections.solution.split('.')[0].trim() : `Apply ${patternName} pattern`,
      avoid: `Don't ignore ${patternName.toLowerCase()} best practices`,
      check: `Verify ${patternName.toLowerCase()} implementation is working correctly`
    };
  }
}