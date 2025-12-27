import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';
import { GraphDatabaseAdapter } from '../storage/graph-database-adapter.js';
import { createOntologySystem, type OntologySystem } from '../ontology/index.js';
import { ContentValidationAgent, type EntityValidationReport } from './content-validation-agent.js';
import { CheckpointManager } from '../utils/checkpoint-manager.js';

export interface PersistenceResult {
  success: boolean;
  entitiesCreated: number;
  entitiesUpdated: number;
  checkpointUpdated: boolean;
  filesCreated: string[];
  errors: string[];
  summary: string;
  hasContentChanges: boolean;  // True if any actual content was created/modified (not just timestamp updates)
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
  // Bi-temporal staleness tracking (inspired by Graphiti)
  invalidating_commits?: string[];    // Git commits that may have made this entity stale
  staleness_score?: number;           // 0-100 where 100 = fresh
  staleness_check_at?: string;        // Timestamp of last staleness check
  staleness_method?: string;          // Method used: 'git-based' | 'pattern-match' | 'manual'
  // Entity rename tracking
  renamedFrom?: string;               // Previous entity name if renamed
  renamedAt?: string;                 // Timestamp when entity was renamed
  // Ontology classification metadata
  ontology?: {
    ontologyClass: string;              // Matched ontology class name
    ontologyVersion: string;            // Version of ontology used
    classificationConfidence: number;   // 0-1 confidence score
    classificationMethod: string;       // 'heuristic' | 'llm' | 'hybrid' | 'auto-assigned' | 'unclassified'
    ontologySource: 'upper' | 'lower';  // Which ontology provided the class
    properties?: Record<string, any>;   // Properties per ontology schema
    classifiedAt: string;               // ISO timestamp
  };
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

export interface PersistenceAgentConfig {
  enableOntology?: boolean;
  ontologyTeam?: string;
  ontologyUpperPath?: string;
  ontologyLowerPath?: string;
  ontologyMinConfidence?: number;
  enableValidation?: boolean;
  validationMode?: 'strict' | 'lenient' | 'disabled';
  // Content validation (codebase accuracy checking)
  enableContentValidation?: boolean;
  contentValidationMode?: 'strict' | 'lenient' | 'report-only';
  stalenessThresholdDays?: number;
}

export class PersistenceAgent {
  private repositoryPath: string;
  private sharedMemoryPath: string;
  private insightsDir: string;
  private graphDB: GraphDatabaseAdapter | null;
  private ontologySystem: OntologySystem | null = null;
  private contentValidationAgent: ContentValidationAgent | null = null;
  private config: PersistenceAgentConfig;
  private checkpointManager: CheckpointManager;

  constructor(repositoryPath: string = '.', graphDB?: GraphDatabaseAdapter, config?: PersistenceAgentConfig) {
    this.repositoryPath = repositoryPath;
    this.graphDB = graphDB || null;

    // Configure team FIRST so we can use it for paths
    this.config = {
      enableOntology: config?.enableOntology ?? true,
      ontologyTeam: config?.ontologyTeam || 'coding',
      ontologyUpperPath: config?.ontologyUpperPath || path.join(repositoryPath, '.data', 'ontologies', 'upper', 'development-knowledge-ontology.json'),
      ontologyLowerPath: config?.ontologyLowerPath || path.join(repositoryPath, '.data', 'ontologies', 'lower', 'coding-ontology.json'),
      ontologyMinConfidence: config?.ontologyMinConfidence || 0.7,
      enableValidation: config?.enableValidation ?? false,
      validationMode: config?.validationMode || 'lenient',
      // Content validation (codebase accuracy checking)
      enableContentValidation: config?.enableContentValidation ?? true,
      contentValidationMode: config?.contentValidationMode || 'lenient',
      stalenessThresholdDays: config?.stalenessThresholdDays || 30
    };

    // Initialize content validation agent if enabled
    if (this.config.enableContentValidation) {
      this.contentValidationAgent = new ContentValidationAgent({
        repositoryPath: this.repositoryPath,
        enableDeepValidation: true,
        stalenessThresholdDays: this.config.stalenessThresholdDays
      });
      log('PersistenceAgent: Content validation is ENABLED', 'info', {
        mode: this.config.contentValidationMode,
        stalenessThresholdDays: this.config.stalenessThresholdDays
      });
    }

    // CORRECTED: Use team-specific export path (e.g., coding.json, resi.coding.json, ui.coding.json)
    // This matches the actual GraphDB export structure
    this.sharedMemoryPath = path.join(repositoryPath, '.data', 'knowledge-export', `${this.config.ontologyTeam}.json`);
    this.insightsDir = path.join(repositoryPath, 'knowledge-management', 'insights');

    // Initialize checkpoint manager for non-git-tracked checkpoint storage
    this.checkpointManager = new CheckpointManager(repositoryPath);

    this.ensureDirectories();

    if (!this.graphDB) {
      log('PersistenceAgent initialized WITHOUT GraphDB - will fall back to JSON file writes', 'warning');
    } else {
      log('PersistenceAgent initialized WITH GraphDB - will use Graphology+LevelDB persistence', 'info');
    }

    if (this.config.enableOntology) {
      log('PersistenceAgent: Ontology classification is ENABLED', 'info', {
        team: this.config.ontologyTeam,
        minConfidence: this.config.ontologyMinConfidence
      });
    } else {
      log('PersistenceAgent: Ontology classification is DISABLED', 'warning');
    }
  }

  /**
   * Check if an insight document file exists
   * Used to only add "Details:" links when the file actually exists
   */
  private insightFileExists(entityName: string): boolean {
    const filePath = path.join(this.insightsDir, `${entityName}.md`);
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }

  /**
   * Calculate Jaccard similarity between two strings (word-based).
   * Used to detect semantically similar observations and prevent duplicates.
   * @returns similarity score between 0 (no overlap) and 1 (identical)
   */
  private calculateJaccardSimilarity(str1: string, str2: string): number {
    const words1 = new Set(str1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(str2.toLowerCase().split(/\s+/).filter(w => w.length > 2));

    if (words1.size === 0 && words2.size === 0) return 1; // Both empty = identical
    if (words1.size === 0 || words2.size === 0) return 0; // One empty = no similarity

    const intersection = new Set([...words1].filter(word => words2.has(word)));
    const union = new Set([...words1, ...words2]);

    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * Initialize the ontology system asynchronously
   * Must be called after construction before using classification
   */
  async initializeOntology(): Promise<void> {
    if (!this.config.enableOntology) {
      log('Ontology disabled, skipping initialization', 'info');
      return;
    }

    try {
      log('Initializing ontology system', 'info', {
        upperPath: this.config.ontologyUpperPath,
        lowerPath: this.config.ontologyLowerPath
      });

      this.ontologySystem = await createOntologySystem({
        enabled: true,
        team: this.config.ontologyTeam,
        upperOntologyPath: this.config.ontologyUpperPath || '',
        lowerOntologyPath: this.config.ontologyLowerPath,
        validation: { mode: 'lenient' },
        classification: {
          enableLLM: false,  // Start with heuristics only for performance
          enableHeuristics: true,
          minConfidence: this.config.ontologyMinConfidence
        },
        caching: { enabled: true, maxEntries: 100 }
      });

      log('Ontology system initialized successfully', 'info', {
        team: this.config.ontologyTeam
      });
    } catch (error) {
      log('Failed to initialize ontology system', 'error', error);
      this.ontologySystem = null;
      // Don't throw - fall back to unclassified entities
    }
  }

  /**
   * Classify an entity using the ontology system
   * Returns the classified entity type or falls back to 'TransferablePattern'
   *
   * @param entityName - The name/title of the entity
   * @param entityContent - The content/observations to classify
   * @returns Classified entity type and metadata
   */
  private async classifyEntity(entityName: string, entityContent: string): Promise<{
    entityType: string;
    confidence: number;
    method: string;
    ontologyMetadata?: any;
  }> {
    // If ontology is disabled or not initialized, use default type
    if (!this.config.enableOntology || !this.ontologySystem) {
      log('Ontology classification unavailable, using default type', 'debug', {
        entityName,
        reason: !this.config.enableOntology ? 'disabled' : 'not initialized'
      });
      return {
        entityType: 'TransferablePattern',
        confidence: 0,
        method: 'fallback'
      };
    }

    try {
      // Prepare classification text (combine name and content)
      const classificationText = `${entityName}\n\n${entityContent}`;

      log('Classifying entity with ontology system', 'debug', {
        entityName,
        team: this.config.ontologyTeam,
        textLength: classificationText.length
      });

      // Perform classification
      const classification = await this.ontologySystem.classifier.classify(classificationText, {
        team: this.config.ontologyTeam,
        enableHeuristics: true,
        minConfidence: this.config.ontologyMinConfidence
      });

      if (classification && classification.confidence >= this.config.ontologyMinConfidence!) {
        log('Entity classified successfully', 'info', {
          entityName,
          entityType: classification.entityClass,
          confidence: classification.confidence,
          method: classification.method
        });

        return {
          entityType: classification.entityClass,
          confidence: classification.confidence,
          method: classification.method || 'ontology',
          ontologyMetadata: {
            ontologyName: classification.ontology,
            classificationMethod: classification.method,
            confidence: classification.confidence
          }
        };
      } else {
        log('Classification confidence below threshold, using fallback', 'warning', {
          entityName,
          confidence: classification?.confidence || 0,
          threshold: this.config.ontologyMinConfidence
        });

        return {
          entityType: 'TransferablePattern',
          confidence: classification?.confidence || 0,
          method: 'fallback_low_confidence'
        };
      }
    } catch (error) {
      log('Entity classification failed, using fallback', 'error', {
        entityName,
        error: error instanceof Error ? error.message : String(error)
      });

      return {
        entityType: 'TransferablePattern',
        confidence: 0,
        method: 'fallback_error'
      };
    }
  }

  /**
   * Validate an entity against the ontology schema
   *
   * @param entityType - The classified entity type
   * @param entityData - The entity data to validate
   * @returns Validation result with errors and warnings
   */
  private validateEntity(entityType: string, entityData: Record<string, any>): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  } {
    // Validation disabled or ontology not available
    if (!this.config.enableValidation || !this.ontologySystem || this.config.validationMode === 'disabled') {
      return { valid: true, errors: [], warnings: [] };
    }

    // Skip validation for TransferablePattern (generic fallback type)
    if (entityType === 'TransferablePattern') {
      return { valid: true, errors: [], warnings: [] };
    }

    try {
      const result = this.ontologySystem.validator.validate(
        entityType,
        entityData,
        {
          mode: this.config.validationMode || 'lenient',
          team: this.config.ontologyTeam,
          allowUnknownProperties: true,
          failFast: false
        }
      );

      const errors = result.errors.map(e => `${e.path}: ${e.message}`);
      const warnings = (result.warnings || []).map(w => `${w.path}: ${w.message}`);

      if (!result.valid) {
        log('Entity validation failed', 'warning', {
          entityType,
          errorCount: errors.length,
          warningCount: warnings.length,
          mode: this.config.validationMode
        });
      } else if (warnings.length > 0) {
        log('Entity validation passed with warnings', 'info', {
          entityType,
          warningCount: warnings.length
        });
      }

      return {
        valid: result.valid,
        errors,
        warnings
      };
    } catch (error) {
      log('Validation error', 'error', {
        entityType,
        error: error instanceof Error ? error.message : String(error)
      });

      // In lenient mode, validation errors don't block persistence
      return {
        valid: this.config.validationMode !== 'strict',
        errors: [`Validation error: ${error instanceof Error ? error.message : String(error)}`],
        warnings: []
      };
    }
  }

  async persistAnalysisResults(
    parameters: any
  ): Promise<PersistenceResult> {
    // Handle both direct parameters and coordinator parameter object
    let gitAnalysis, vibeAnalysis, semanticAnalysis, observations, insightGeneration, ontologyClassification: any;

    if (arguments.length === 1 && typeof parameters === 'object' && parameters._context) {
      // Called by coordinator with parameter object
      const context = parameters._context;
      const results = context.previousResults || {};

      // Support both complete-analysis and incremental-analysis step names
      gitAnalysis = results.analyze_git_history || results.analyze_recent_changes;
      vibeAnalysis = results.analyze_vibe_history || results.analyze_recent_vibes;
      semanticAnalysis = results.semantic_analysis || results.analyze_semantics;
      observations = results.generate_observations?.observations || results.generate_observations || [];
      insightGeneration = results.generate_insights;
      ontologyClassification = results.classify_with_ontology;
    } else if (arguments.length > 1) {
      // Called directly with separate parameters (backward compatibility)
      gitAnalysis = arguments[0];
      vibeAnalysis = arguments[1];
      semanticAnalysis = arguments[2];
      observations = arguments[3] || [];
      insightGeneration = arguments[4];
      ontologyClassification = arguments[5];
    } else if (parameters.workflow_results) {
      // Called by coordinator with workflow_results wrapper
      const results = parameters.workflow_results;

      // DEBUG: Log what we're receiving
      log('Persistence received workflow_results', 'debug', {
        hasWorkflowResults: !!parameters.workflow_results,
        workflowResultsKeys: Object.keys(parameters.workflow_results || {}),
        git_history_type: typeof results.git_history,
        git_history_truthiness: !!results.git_history,
        vibe_history_type: typeof results.vibe_history,
        vibe_history_truthiness: !!results.vibe_history,
        semantic_analysis_type: typeof results.semantic_analysis,
        observations_type: typeof results.observations
      });

      gitAnalysis = results.git_history;
      vibeAnalysis = results.vibe_history;
      semanticAnalysis = results.semantic_analysis;
      observations = results.observations?.observations || results.observations || [];
      insightGeneration = results.insights;
      // Extract ontology classification results
      ontologyClassification = results.ontology_classification;
    } else {
      // Single parameter call without context
      gitAnalysis = parameters.gitAnalysis;
      vibeAnalysis = parameters.vibeAnalysis;
      semanticAnalysis = parameters.semanticAnalysis;
      observations = parameters.observations?.observations || parameters.observations || [];
      insightGeneration = parameters.insightGeneration;
      ontologyClassification = parameters.ontologyClassification;
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
      hasInsightGeneration: !!insightGeneration,
      hasOntologyClassification: !!ontologyClassification,
      classifiedCount: ontologyClassification?.classified?.length || 0
    });

    const result: PersistenceResult = {
      success: false,
      entitiesCreated: 0,
      entitiesUpdated: 0,
      checkpointUpdated: false,
      filesCreated: [],
      errors: [],
      summary: '',
      hasContentChanges: false  // Will be set to true if entities/relations/files are actually created/modified
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
        insightGeneration,
        ontologyClassification
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

      // Determine if there were actual content changes (not just timestamp updates)
      // updatedRelations is an array of EntityRelationship, check its length
      const relationsCreated = Array.isArray(updatedRelations) ? updatedRelations.length : 0;
      result.hasContentChanges =
        result.entitiesCreated > 0 ||
        result.entitiesUpdated > 0 ||
        result.filesCreated.length > 0 ||
        relationsCreated > 0;

      log('Analysis persistence completed successfully', 'info', {
        entitiesCreated: result.entitiesCreated,
        entitiesUpdated: result.entitiesUpdated,
        filesCreated: result.filesCreated.length,
        checkpointUpdated: result.checkpointUpdated,
        hasContentChanges: result.hasContentChanges
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
              team: this.config.ontologyTeam,
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
      // Relationship to CollectiveKnowledge (use underscore for consistency)
      const collectiveKnowledgeRelation: EntityRelationship = {
        from: entity.name,
        to: 'CollectiveKnowledge',
        relationType: 'contributes_to'
      };

      // Relationship to Coding project (use underscore for consistency)
      const codingRelation: EntityRelationship = {
        from: entity.name,
        to: 'Coding',
        relationType: 'implemented_in'
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
      const timestamp = new Date();
      let updated = false;

      // Update specific analysis timestamps using CheckpointManager (NOT git-tracked shared memory)
      if (analysisData.gitAnalysis) {
        this.checkpointManager.setLastGitAnalysis(timestamp);
        updated = true;
      }

      if (analysisData.vibeAnalysis) {
        this.checkpointManager.setLastVibeAnalysis(timestamp);
        updated = true;
      }

      if (analysisData.semanticAnalysis) {
        // Note: semantic analysis checkpoint could be added to CheckpointManager if needed
        updated = true;
      }

      // Log checkpoint updates (no shared memory modification - timestamps are in workflow-checkpoints.json)
      if (updated) {
        const checkpoints = this.checkpointManager.loadCheckpoints();
        log('Analysis checkpoints updated successfully (stored in workflow-checkpoints.json)', 'info', {
          lastGitAnalysis: checkpoints.lastGitAnalysis,
          lastVibeAnalysis: checkpoints.lastVibeAnalysis,
          lastSuccessfulWorkflowCompletion: checkpoints.lastSuccessfulWorkflowCompletion
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
      if (!data.metadata.team) data.metadata.team = this.config.ontologyTeam;

      // Strip volatile checkpoint fields that now belong in CheckpointManager (workflow-checkpoints.json)
      // These should NOT be persisted in the git-tracked JSON file
      delete data.metadata.lastVibeAnalysis;
      delete data.metadata.lastGitAnalysis;
      delete data.metadata.lastSemanticAnalysis;

      return data as SharedMemoryStructure;
    } catch (error) {
      log('Failed to load shared memory, creating new structure', 'warning', error);
      return this.createEmptySharedMemory();
    }
  }

  /**
   * Store an entity to the graph database
   * FAIL-FAST: GraphDB MUST be available. Health monitor handles restart if unavailable.
   */
  private async storeEntityToGraph(entity: SharedMemoryEntity): Promise<string> {
    if (!this.graphDB) {
      throw new Error('GraphDB not available. Health monitor should detect and restart services.');
    }

    try {
      // Prepare entity content for classification
      const observationsText = entity.observations
        .map(obs => typeof obs === 'string' ? obs : obs.content)
        .join('\n');
      const entityContent = `${observationsText}`;

      // PROTECTED INFRASTRUCTURE ENTITIES: These should NEVER be re-classified
      // They have fixed types that determine visualization colors and semantic meaning
      const PROTECTED_ENTITY_TYPES: Record<string, string> = {
        'Coding': 'Project',
        'CollectiveKnowledge': 'System',
        // Add other infrastructure entities as needed
      };

      let entityType: string;
      let classification: { entityType: string; confidence: number; method: string; ontologyMetadata?: any } = {
        entityType: 'TransferablePattern',
        confidence: 0,
        method: 'fallback'
      };

      // Check if this is a protected entity
      if (PROTECTED_ENTITY_TYPES[entity.name]) {
        entityType = PROTECTED_ENTITY_TYPES[entity.name];
        classification = {
          entityType,
          confidence: 1.0,
          method: 'protected-infrastructure',
          ontologyMetadata: { protected: true, reason: 'Infrastructure entity with fixed type' }
        };
        log('Using protected entity type (not re-classifying)', 'info', {
          entityName: entity.name,
          protectedType: entityType,
          originalType: entity.entityType
        });
      } else {
        // Classify the entity using the ontology system
        classification = await this.classifyEntity(entity.name, entityContent);

        // Use classified entity type (or fallback to original if not classified)
        entityType = classification.entityType || entity.entityType || 'TransferablePattern';
      }

      // CONTENT VALIDATION: Check if existing entity content is accurate
      let contentValidationReport: EntityValidationReport | null = null;
      if (this.contentValidationAgent && this.config.enableContentValidation) {
        // Check if entity already exists (this is an update, not a create)
        const existingEntity = await this.graphDB?.queryEntities({ namePattern: entity.name });

        if (existingEntity && existingEntity.length > 0) {
          log('Running content validation for existing entity', 'info', {
            entityName: entity.name
          });

          contentValidationReport = await this.contentValidationAgent.validateEntityAccuracy(
            entity.name,
            this.config.ontologyTeam || 'coding'
          );

          if (!contentValidationReport.overallValid) {
            const mode = this.config.contentValidationMode;
            const report = this.contentValidationAgent.generateRefreshReport(contentValidationReport);

            if (mode === 'strict') {
              // In strict mode, block the update and suggest entity-refresh workflow
              log('Content validation failed in strict mode', 'error', {
                entityName: entity.name,
                overallScore: contentValidationReport.overallScore,
                totalIssues: contentValidationReport.totalIssues,
                criticalIssues: contentValidationReport.criticalIssues
              });
              throw new Error(
                `Entity content validation failed (score: ${contentValidationReport.overallScore}/100). ` +
                `Run 'entity-refresh' workflow to fix: ${contentValidationReport.recommendations[0]}`
              );
            } else if (mode === 'lenient') {
              // In lenient mode, log warning but continue
              log('Content validation found issues (lenient mode)', 'warning', {
                entityName: entity.name,
                overallScore: contentValidationReport.overallScore,
                totalIssues: contentValidationReport.totalIssues,
                recommendations: contentValidationReport.recommendations
              });
            } else {
              // report-only mode: just log the report
              log('Content validation report (report-only mode)', 'info', {
                entityName: entity.name,
                overallScore: contentValidationReport.overallScore,
                overallValid: contentValidationReport.overallValid
              });
            }
          } else {
            log('Content validation passed', 'info', {
              entityName: entity.name,
              overallScore: contentValidationReport.overallScore
            });
          }
        }
      }

      // Prepare entity data for validation
      const entityDataForValidation = {
        name: entity.name,
        observations: entity.observations,
        significance: entity.significance,
        relationships: entity.relationships,
        metadata: entity.metadata
      };

      // Validate the entity against ontology schema
      const validation = this.validateEntity(entityType, entityDataForValidation);

      // In strict mode, fail if validation fails
      if (!validation.valid && this.config.validationMode === 'strict') {
        const errorMessage = `Entity validation failed in strict mode: ${validation.errors.join(', ')}`;
        log(errorMessage, 'error', {
          entityName: entity.name,
          entityType,
          errors: validation.errors
        });
        throw new Error(errorMessage);
      }

      // Enhance metadata with both classification and validation info
      const enhancedMetadata = {
        ...entity.metadata,
        ontology: classification.ontologyMetadata,
        classificationConfidence: classification.confidence,
        classificationMethod: classification.method,
        validation: {
          valid: validation.valid,
          errors: validation.errors,
          warnings: validation.warnings,
          mode: this.config.validationMode
        },
        // Content validation (codebase accuracy) results
        contentValidation: contentValidationReport ? {
          overallValid: contentValidationReport.overallValid,
          overallScore: contentValidationReport.overallScore,
          totalIssues: contentValidationReport.totalIssues,
          criticalIssues: contentValidationReport.criticalIssues,
          validatedAt: contentValidationReport.validatedAt,
          mode: this.config.contentValidationMode
        } : undefined,
        // Bi-temporal staleness tracking (inspired by Graphiti)
        invalidating_commits: contentValidationReport?.gitStaleness?.invalidatingCommits,
        staleness_score: contentValidationReport?.gitStaleness?.stalenessScore ?? 100,
        staleness_check_at: contentValidationReport?.validatedAt,
        staleness_method: contentValidationReport?.gitStaleness ? 'git-based' : undefined
      };

      // Create automatic relationships for graph connectivity
      const autoRelationships = [...(entity.relationships || [])];

      // Add relationship to CollectiveKnowledge if not already present
      const hasCollectiveKnowledgeRel = autoRelationships.some(r =>
        r.to === 'CollectiveKnowledge'
      );
      if (!hasCollectiveKnowledgeRel) {
        autoRelationships.push({
          from: entity.name,
          to: 'CollectiveKnowledge',
          relationType: 'contributes_to'
        });
      }

      // Add project relationship if team metadata exists
      // Use capitalized team name (e.g., "coding" -> "Coding") as Project entity name
      if (entity.metadata?.team) {
        const teamName = entity.metadata.team;
        const projectName = teamName.charAt(0).toUpperCase() + teamName.slice(1);
        const hasProjectRel = autoRelationships.some(r =>
          r.from === projectName && r.to === entity.name
        );
        if (!hasProjectRel) {
          // Only add the relationship if the project entity exists
          // The relationship will be validated during storeEntity; skip if source doesn't exist
          autoRelationships.push({
            from: projectName,
            to: entity.name,
            relationType: 'contains'
          });
        }
      }

      const graphEntity = {
        name: entity.name,
        entityType: entityType,
        observations: entity.observations,
        confidence: 1.0,
        source: entity.metadata.source || 'mcp-semantic-analysis',
        significance: entity.significance,
        relationships: autoRelationships,
        metadata: enhancedMetadata,
        quick_reference: entity.quick_reference
      };

      const nodeId = await this.graphDB.storeEntity(graphEntity);

      log('Entity stored to graph database with ontology classification and validation', 'info', {
        entityName: entity.name,
        nodeId,
        entityType: entityType,
        classificationConfidence: classification.confidence,
        classificationMethod: classification.method,
        validationValid: validation.valid,
        validationWarnings: validation.warnings.length
      });

      return nodeId;
    } catch (error) {
      log('Failed to store entity to graph database', 'error', error);
      throw error;
    }
  }

  /**
   * Persists shared memory to GraphDB (single source of truth)
   * FAIL-FAST: GraphDB MUST be available. Health monitor handles restart if unavailable.
   * No fallback to JSON - GraphKnowledgeExporter handles JSON export via events.
   */
  private async saveSharedMemory(sharedMemory: SharedMemoryStructure): Promise<void> {
    try {
      // Update counts
      sharedMemory.metadata.total_entities = sharedMemory.entities.length;
      sharedMemory.metadata.total_relations = sharedMemory.relations.length;
      sharedMemory.metadata.last_updated = new Date().toISOString();

      // FAIL-FAST: GraphDB MUST be available
      if (!this.graphDB) {
        throw new Error('GraphDB not available. Health monitor should detect and restart services.');
      }

      // Store each entity to the graph database
      log('Storing entities to GraphDB (Graphology+LevelDB)', 'info', {
        entitiesCount: sharedMemory.entities.length
      });

      for (const entity of sharedMemory.entities) {
        await this.storeEntityToGraph(entity);
      }

      // Store relationships (using adapter's object signature)
      for (const relation of sharedMemory.relations) {
        try {
          await this.graphDB.storeRelationship(relation);
        } catch (error: unknown) {
          // Skip if entities don't exist (e.g., orphan relations)
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (errorMessage.includes('not found')) {
            log('Skipping relation to non-existent entity', 'debug', {
              from: relation.from,
              to: relation.to,
              relationType: relation.relationType
            });
          } else {
            throw error;
          }
        }
      }

      log('Shared memory persisted to GraphDB successfully', 'info', {
        entitiesCount: sharedMemory.entities.length,
        relationsCount: sharedMemory.relations.length
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
        team: this.config.ontologyTeam || 'coding',
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

  /**
   * Serialize observations array to a string for storage.
   * Handles both string and ObservationTemplate objects properly.
   */
  private serializeObservationsToString(observations: any[]): string {
    if (!observations || observations.length === 0) {
      return '';
    }

    return observations.map(obs => {
      if (typeof obs === 'string') {
        return obs;
      }

      if (typeof obs === 'object' && obs !== null) {
        // Handle ObservationTemplate objects
        if (obs.content) {
          const typePrefix = obs.type ? `**${obs.type.charAt(0).toUpperCase() + obs.type.slice(1)}:** ` : '';
          return `${typePrefix}${obs.content}`;
        }
        // Fallback: serialize as JSON if it has meaningful properties
        try {
          return JSON.stringify(obs);
        } catch {
          return '[Complex Object]';
        }
      }

      // Fallback for primitives
      return String(obs);
    }).join('\n\n');
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
      summary: '',
      hasContentChanges: false
    };

    try {
      // Use CheckpointManager instead of writing to git-tracked shared memory JSON
      // This prevents meaningless timestamp-only updates to coding.json
      this.checkpointManager.setLastGitAnalysis(new Date());

      result.checkpointUpdated = true;
      result.success = true;
      result.summary = 'Git analysis checkpoint updated (stored in workflow-checkpoints.json)';

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
      summary: '',
      hasContentChanges: false
    };

    try {
      // Use CheckpointManager instead of writing to git-tracked shared memory JSON
      // This prevents meaningless timestamp-only updates to coding.json
      this.checkpointManager.setLastVibeAnalysis(new Date());

      result.checkpointUpdated = true;
      result.success = true;
      result.summary = 'Vibe analysis checkpoint updated (stored in workflow-checkpoints.json)';

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
      ontologyClassification?: any;
    },
    sharedMemory: SharedMemoryStructure
  ): Promise<SharedMemoryEntity[]> {
    const entities: SharedMemoryEntity[] = [];
    const now = new Date().toISOString();

    // Build a map of entity names to their ontology classification
    const ontologyMap = new Map<string, any>();
    if (analysisData.ontologyClassification?.classified) {
      for (const classified of analysisData.ontologyClassification.classified) {
        if (classified.original?.name) {
          ontologyMap.set(classified.original.name, classified.ontologyMetadata);
        }
      }
      log('Built ontology classification map', 'debug', {
        mappedEntities: ontologyMap.size,
        totalClassified: analysisData.ontologyClassification.classified.length
      });
    }

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

        // Look up ontology classification for this entity
        const ontologyMeta = ontologyMap.get(cleanName);

        const entity: SharedMemoryEntity = {
          id: `analysis_${Date.now()}`,
          name: cleanName,
          entityType: ontologyMeta?.ontologyClass || 'TransferablePattern',
          significance: insight.metadata?.significance || 7,
          observations: detailedObservations,
          relationships: [],
          metadata: {
            created_at: now,
            last_updated: now,
            source: 'semantic-analysis-workflow',
            context: `comprehensive-analysis-${insight.metadata?.analysisTypes?.join('-') || 'semantic'}`,
            tags: insight.metadata?.analysisTypes,
            // Add ontology classification metadata
            ontology: ontologyMeta ? {
              ontologyClass: ontologyMeta.ontologyClass,
              ontologyVersion: ontologyMeta.ontologyVersion,
              classificationConfidence: ontologyMeta.classificationConfidence,
              classificationMethod: ontologyMeta.classificationMethod,
              ontologySource: ontologyMeta.ontologySource,
              properties: ontologyMeta.properties,
              classifiedAt: ontologyMeta.classifiedAt
            } : undefined
          },
          quick_reference: this.generateQuickReference(insight, cleanName)
        };

        // CRITICAL: Validate insight file exists before creating entity (prevents phantom nodes)
        const insightFilePath = path.join(this.repositoryPath, 'knowledge-management', 'insights', `${entity.name}.md`);
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
      const insightsDir = path.join(this.repositoryPath, 'knowledge-management', 'insights');
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
      // was causing phantom nodes in knowledge-export/coding.json
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
        const gitInsightPath = path.join(this.repositoryPath, 'knowledge-management', 'insights', `${gitEntity.name}.md`);
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
      summary: '',
      hasContentChanges: false
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
      const observations: any[] = [
        {
          type: 'insight',
          content: entityData.insights,
          date: currentDate,
          metadata: {
            source: 'manual_creation',
            significance: entityData.significance || 5
          }
        }
      ];

      // Only add Details link if the insight file actually exists
      if (this.insightFileExists(entityData.name)) {
        observations.push({
          type: 'link',
          content: `Details: http://localhost:8080/knowledge-management/insights/${entityData.name}.md`,
          date: currentDate,
          metadata: {
            source: 'ukb_tool',
            fileValidated: true
          }
        });
      }

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
      const ukbInsightPath = path.join(this.repositoryPath, 'knowledge-management', 'insights', `${entity.name}.md`);
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
   * Extract actionable observations from insight content following knowledge-export pattern structure
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

    // Only add Details link if the insight file actually exists
    if (this.insightFileExists(cleanName)) {
      observations.push({
        type: 'link',
        content: `Details: http://localhost:8080/knowledge-management/insights/${cleanName}.md`,
        date: now
      });
    }

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

    // Only add Details link if the insight file actually exists
    if (this.insightFileExists(cleanName)) {
      observations.push(`Details: http://localhost:8080/knowledge-management/insights/${cleanName}.md`);
    }

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
   * Generate quick reference section like other entities in knowledge-export files
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

  // ==================== Entity Update Methods ====================

  /**
   * Update entity observations - remove stale ones and optionally add new ones
   * Used by the entity refresh flow after content validation
   */
  async updateEntityObservations(params: {
    entityName: string;
    team: string;
    removeObservations: string[];
    newObservations?: (string | ObservationObject)[];
  }): Promise<{
    success: boolean;
    updatedEntity: SharedMemoryEntity | null;
    removedCount: number;
    addedCount: number;
    details: string;
  }> {
    const result = {
      success: false,
      updatedEntity: null as SharedMemoryEntity | null,
      removedCount: 0,
      addedCount: 0,
      details: ''
    };

    try {
      log(`Updating entity observations: ${params.entityName}`, 'info', {
        team: params.team,
        toRemove: params.removeObservations.length,
        toAdd: params.newObservations?.length || 0
      });

      // Load entity from GraphDB or shared memory
      let entity: SharedMemoryEntity | null = null;

      if (this.graphDB) {
        // Use searchTerm for exact name match (namePattern not supported by VKB API)
        const entities = await this.graphDB.queryEntities({
          searchTerm: params.entityName
        });
        // Find exact match (searchTerm may return partial matches)
        const exactMatch = entities?.find((e: any) =>
          (e.name || e.entity_name) === params.entityName
        );
        if (exactMatch) {
          // PROTECTED INFRASTRUCTURE ENTITIES: Enforce correct types
          const PROTECTED_ENTITY_TYPES: Record<string, string> = {
            'Coding': 'Project',
            'CollectiveKnowledge': 'System',
          };
          const entityName = exactMatch.name || exactMatch.entity_name;
          const protectedType = PROTECTED_ENTITY_TYPES[entityName];

          // Normalize field names (API returns entity_name/entity_type, internal uses name/entityType)
          entity = {
            name: entityName,
            entityType: protectedType || exactMatch.entityType || exactMatch.entity_type,
            observations: exactMatch.observations || [],
            significance: exactMatch.significance,
            relationships: exactMatch.relationships || [],
            metadata: {
              ...exactMatch.metadata,
              source: exactMatch.source,
              team: exactMatch.team,
              created_at: exactMatch.created_at || exactMatch.extracted_at,
              last_updated: exactMatch.last_modified || exactMatch.last_updated
            }
          } as SharedMemoryEntity;

          if (protectedType) {
            log('Enforcing protected entity type on load', 'info', {
              entityName,
              protectedType,
              originalType: exactMatch.entityType || exactMatch.entity_type
            });
          }
        }
      }

      if (!entity) {
        // Fallback to shared memory file
        const sharedMemory = await this.loadSharedMemory();
        entity = sharedMemory.entities.find(e => e.name === params.entityName) || null;
      }

      if (!entity) {
        result.details = `Entity '${params.entityName}' not found in team '${params.team}'`;
        return result;
      }

      const originalCount = entity.observations.length;

      // Remove stale observations
      if (params.removeObservations.length > 0) {
        entity.observations = entity.observations.filter(obs => {
          const obsContent = typeof obs === 'string' ? obs : obs.content;
          // Check if this observation should be removed (partial match for flexibility)
          const shouldRemove = params.removeObservations.some(toRemove => {
            // Match if the observation content contains the removal string
            // or if the removal string contains the observation content
            return obsContent.includes(toRemove) || toRemove.includes(obsContent.substring(0, 50));
          });
          return !shouldRemove;
        });
        result.removedCount = originalCount - entity.observations.length;
      }

      // Add new observations with deduplication
      if (params.newObservations && params.newObservations.length > 0) {
        const now = new Date().toISOString();
        const SIMILARITY_THRESHOLD = 0.7; // 70% word overlap = too similar

        // Get existing observation contents for comparison
        const existingContents = entity.observations.map(obs =>
          typeof obs === 'string' ? obs : (obs.content || '')
        );

        const formattedObservations = params.newObservations.map(obs => {
          if (typeof obs === 'string') {
            return obs;
          }
          return {
            type: obs.type || 'insight',
            content: obs.content,
            date: obs.date || now,
            metadata: {
              ...obs.metadata,
              refreshedAt: now,
              source: 'entity-refresh'
            }
          };
        });

        // Filter out observations that are too similar to existing ones
        const uniqueObservations = formattedObservations.filter(newObs => {
          const newContent = typeof newObs === 'string' ? newObs : newObs.content;

          // Check against existing observations
          const isTooSimilarToExisting = existingContents.some(existingContent =>
            this.calculateJaccardSimilarity(newContent, existingContent) >= SIMILARITY_THRESHOLD
          );

          if (isTooSimilarToExisting) {
            log('Skipping duplicate observation (too similar to existing)', 'debug', {
              content: newContent.substring(0, 80) + '...'
            });
            return false;
          }
          return true;
        });

        // Also deduplicate within the new observations themselves
        const seenContents = new Set<string>();
        const dedupedObservations = uniqueObservations.filter(obs => {
          const content = typeof obs === 'string' ? obs : obs.content;
          // Check if we've already added a similar observation in this batch
          const isDuplicate = [...seenContents].some(seen =>
            this.calculateJaccardSimilarity(content, seen) >= SIMILARITY_THRESHOLD
          );
          if (!isDuplicate) {
            seenContents.add(content);
            return true;
          }
          return false;
        });

        entity.observations.push(...dedupedObservations);
        result.addedCount = dedupedObservations.length;

        if (formattedObservations.length !== dedupedObservations.length) {
          log('Deduplication filtered observations', 'info', {
            original: formattedObservations.length,
            afterDedup: dedupedObservations.length,
            filtered: formattedObservations.length - dedupedObservations.length
          });
        }
      }

      // Update metadata
      entity.metadata.last_updated = new Date().toISOString();

      // Persist to GraphDB (single source of truth)
      // GraphKnowledgeExporter will handle JSON export via entity:stored event
      // FAIL-FAST: GraphDB MUST be available. Health monitor handles restart if unavailable.
      if (!this.graphDB) {
        throw new Error('GraphDB not available. Health monitor should detect and restart services.');
      }
      await this.storeEntityToGraph(entity);

      result.success = true;
      result.updatedEntity = entity;
      result.details = `Updated entity '${params.entityName}': removed ${result.removedCount} observations, added ${result.addedCount} observations`;

      log('Entity observations updated successfully', 'info', {
        entityName: params.entityName,
        removedCount: result.removedCount,
        addedCount: result.addedCount,
        newTotal: entity.observations.length
      });

      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.details = `Failed to update entity observations: ${errorMessage}`;
      log('Entity observation update failed', 'error', error);
      return result;
    }
  }

  /**
   * Delete an entity completely from the knowledge base
   */
  async deleteEntity(entityName: string, team: string): Promise<{
    success: boolean;
    details: string;
  }> {
    try {
      log(`Deleting entity: ${entityName}`, 'info', { team });

      // Delete from GraphDB
      if (this.graphDB) {
        try {
          await this.graphDB.deleteEntity(entityName);
        } catch (error) {
          log('Entity not found in GraphDB or delete failed', 'warning', error);
        }
      }

      // Also remove from shared memory file
      const sharedMemory = await this.loadSharedMemory();
      const initialCount = sharedMemory.entities.length;
      sharedMemory.entities = sharedMemory.entities.filter(e => e.name !== entityName);

      // Remove relations involving this entity
      sharedMemory.relations = sharedMemory.relations.filter(
        r => r.from !== entityName && r.to !== entityName
      );

      if (sharedMemory.entities.length < initialCount) {
        await this.saveSharedMemory(sharedMemory);
        log(`Entity deleted: ${entityName}`, 'info');
        return {
          success: true,
          details: `Entity '${entityName}' deleted from team '${team}'`
        };
      } else {
        return {
          success: false,
          details: `Entity '${entityName}' not found in team '${team}'`
        };
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`Failed to delete entity: ${entityName}`, 'error', error);
      return {
        success: false,
        details: `Failed to delete entity: ${errorMessage}`
      };
    }
  }

  /**
   * Convert entity name to kebab-case for file naming
   */
  private toKebabCase(str: string): string {
    return str
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .replace(/\s+/g, '-')
      .toLowerCase();
  }

  /**
   * Rename an entity with optional file migration
   * This handles:
   * 1. Creating new entity with new name
   * 2. Updating all relations referencing old name
   * 3. Migrating insight and diagram files
   * 4. Deleting old entity
   */
  async renameEntity(params: {
    oldName: string;
    newName: string;
    team: string;
    migrateFiles?: boolean;
  }): Promise<{
    success: boolean;
    migratedFiles: string[];
    deletedFiles: string[];
    details: string;
  }> {
    const migrateFiles = params.migrateFiles ?? true;
    const result = {
      success: false,
      migratedFiles: [] as string[],
      deletedFiles: [] as string[],
      details: ''
    };

    try {
      log(`Renaming entity: ${params.oldName} -> ${params.newName}`, 'info', { team: params.team });

      // Step 1: Load existing entity
      const existingEntity = await this.getEntity(params.oldName, params.team);
      if (!existingEntity) {
        result.details = `Entity '${params.oldName}' not found`;
        return result;
      }

      // Step 2: Create new entity data with new name
      const newEntity: SharedMemoryEntity = {
        ...existingEntity,
        name: params.newName,
        metadata: {
          ...existingEntity.metadata,
          renamedFrom: params.oldName,
          renamedAt: new Date().toISOString()
        }
      };

      // Step 3: Migrate files if requested
      if (migrateFiles) {
        const fileResults = await this.migrateEntityFiles(params.oldName, params.newName);
        result.migratedFiles = fileResults.migrated;
        result.deletedFiles = fileResults.deleted;
      }

      // Step 4: Update shared memory - change relations and entities
      const sharedMemory = await this.loadSharedMemory();

      // Update relations - change all references from oldName to newName
      sharedMemory.relations = sharedMemory.relations.map(r => ({
        ...r,
        from: r.from === params.oldName ? params.newName : r.from,
        to: r.to === params.oldName ? params.newName : r.to
      }));

      // Remove old entity and add new
      sharedMemory.entities = sharedMemory.entities.filter(e => e.name !== params.oldName);
      sharedMemory.entities.push(newEntity);
      await this.saveSharedMemory(sharedMemory);

      // Step 5: Update GraphDB
      if (this.graphDB) {
        try {
          await this.graphDB.deleteEntity(params.oldName);
          // Re-add with new name through normal persistence flow
        } catch (error) {
          log('GraphDB delete during rename failed', 'warning', error);
        }
      }

      result.success = true;
      result.details = `Successfully renamed '${params.oldName}' to '${params.newName}'`;
      log(result.details, 'info', {
        migratedFiles: result.migratedFiles.length,
        deletedFiles: result.deletedFiles.length
      });

    } catch (error) {
      result.details = `Rename failed: ${error instanceof Error ? error.message : String(error)}`;
      log(result.details, 'error');
    }

    return result;
  }

  /**
   * Helper to migrate insight and diagram files during entity rename
   */
  private async migrateEntityFiles(oldName: string, newName: string): Promise<{
    migrated: string[];
    deleted: string[];
  }> {
    const result = { migrated: [] as string[], deleted: [] as string[] };
    const pumlDir = path.join(this.insightsDir, 'puml');
    const imagesDir = path.join(this.insightsDir, 'images');

    const oldKebab = this.toKebabCase(oldName);
    const newKebab = this.toKebabCase(newName);

    try {
      // Migrate insight markdown file
      const oldInsightPath = path.join(this.insightsDir, `${oldName}.md`);
      const newInsightPath = path.join(this.insightsDir, `${newName}.md`);
      if (fs.existsSync(oldInsightPath)) {
        fs.renameSync(oldInsightPath, newInsightPath);
        result.migrated.push(newInsightPath);
        result.deleted.push(oldInsightPath);
        log(`Migrated insight: ${oldName}.md -> ${newName}.md`, 'info');
      }

      // Migrate PUML files
      if (fs.existsSync(pumlDir)) {
        const pumlFiles = fs.readdirSync(pumlDir).filter(f => f.startsWith(`${oldKebab}-`) && f.endsWith('.puml'));
        for (const file of pumlFiles) {
          const newFileName = file.replace(oldKebab, newKebab);
          const oldPath = path.join(pumlDir, file);
          const newPath = path.join(pumlDir, newFileName);
          fs.renameSync(oldPath, newPath);
          result.migrated.push(newPath);
          result.deleted.push(oldPath);
          log(`Migrated PUML: ${file} -> ${newFileName}`, 'info');
        }
      }

      // Migrate PNG files
      if (fs.existsSync(imagesDir)) {
        const pngFiles = fs.readdirSync(imagesDir).filter(f => f.startsWith(`${oldKebab}-`) && f.endsWith('.png'));
        for (const file of pngFiles) {
          const newFileName = file.replace(oldKebab, newKebab);
          const oldPath = path.join(imagesDir, file);
          const newPath = path.join(imagesDir, newFileName);
          fs.renameSync(oldPath, newPath);
          result.migrated.push(newPath);
          result.deleted.push(oldPath);
          log(`Migrated PNG: ${file} -> ${newFileName}`, 'info');
        }
      }
    } catch (error) {
      log(`File migration error: ${error}`, 'warning');
    }

    return result;
  }

  /**
   * Clean up orphaned files for an entity or find orphans globally
   */
  async cleanupEntityFiles(params: {
    entityName?: string;
    team: string;
    cleanOrphans?: boolean;
  }): Promise<{
    deletedFiles: string[];
    errors: string[];
  }> {
    const result = { deletedFiles: [] as string[], errors: [] as string[] };
    const pumlDir = path.join(this.insightsDir, 'puml');
    const imagesDir = path.join(this.insightsDir, 'images');

    try {
      if (params.entityName) {
        // Clean specific entity files
        const kebabName = this.toKebabCase(params.entityName);

        const filesToCheck = [
          path.join(this.insightsDir, `${params.entityName}.md`)
        ];

        // Add PUML files
        if (fs.existsSync(pumlDir)) {
          const pumlFiles = fs.readdirSync(pumlDir)
            .filter(f => f.startsWith(`${kebabName}-`))
            .map(f => path.join(pumlDir, f));
          filesToCheck.push(...pumlFiles);
        }

        // Add PNG files
        if (fs.existsSync(imagesDir)) {
          const pngFiles = fs.readdirSync(imagesDir)
            .filter(f => f.startsWith(`${kebabName}-`))
            .map(f => path.join(imagesDir, f));
          filesToCheck.push(...pngFiles);
        }

        for (const file of filesToCheck) {
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
            result.deletedFiles.push(file);
            log(`Deleted: ${file}`, 'info');
          }
        }
      }

      if (params.cleanOrphans) {
        // Find all entities in knowledge base
        const allEntities = await this.getAllEntities(params.team);
        const entityNames = new Set(allEntities.map(e => e.name));
        const entityKebabNames = new Set(allEntities.map(e => this.toKebabCase(e.name)));

        // Check insight files
        const insightFiles = fs.readdirSync(this.insightsDir).filter(f => f.endsWith('.md'));
        for (const file of insightFiles) {
          const entityName = file.replace('.md', '');
          // Skip README and other non-entity files
          if (!entityNames.has(entityName) && entityName !== 'README' && !file.startsWith('_')) {
            const filePath = path.join(this.insightsDir, file);
            fs.unlinkSync(filePath);
            result.deletedFiles.push(filePath);
            log(`Deleted orphan insight: ${file}`, 'info');
          }
        }

        // Check PUML files
        if (fs.existsSync(pumlDir)) {
          const pumlFiles = fs.readdirSync(pumlDir).filter(f => f.endsWith('.puml'));
          for (const file of pumlFiles) {
            // Skip style files
            if (file.startsWith('_')) continue;

            // Extract entity name prefix (everything before the diagram type)
            const parts = file.replace('.puml', '').split('-');
            // Try progressively longer prefixes to match entity
            let matched = false;
            for (let i = parts.length - 1; i > 0; i--) {
              const prefix = parts.slice(0, i).join('-');
              if (entityKebabNames.has(prefix)) {
                matched = true;
                break;
              }
            }

            if (!matched) {
              const filePath = path.join(pumlDir, file);
              fs.unlinkSync(filePath);
              result.deletedFiles.push(filePath);
              log(`Deleted orphan PUML: ${file}`, 'info');
            }
          }
        }

        // Check PNG files
        if (fs.existsSync(imagesDir)) {
          const pngFiles = fs.readdirSync(imagesDir).filter(f => f.endsWith('.png'));
          for (const file of pngFiles) {
            const parts = file.replace('.png', '').split('-');
            let matched = false;
            for (let i = parts.length - 1; i > 0; i--) {
              const prefix = parts.slice(0, i).join('-');
              if (entityKebabNames.has(prefix)) {
                matched = true;
                break;
              }
            }

            if (!matched) {
              const filePath = path.join(imagesDir, file);
              fs.unlinkSync(filePath);
              result.deletedFiles.push(filePath);
              log(`Deleted orphan PNG: ${file}`, 'info');
            }
          }
        }
      }

      log(`Cleanup complete: ${result.deletedFiles.length} files removed`, 'info');
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
      log('Cleanup failed', 'error', error);
    }

    return result;
  }

  /**
   * Get entity by name from GraphDB or shared memory
   */
  async getEntity(entityName: string, team: string): Promise<SharedMemoryEntity | null> {
    try {
      // Try GraphDB first
      if (this.graphDB) {
        // Use searchTerm for VKB API compatibility (namePattern not supported by VKB API)
        const entities = await this.graphDB.queryEntities({
          searchTerm: entityName,
          team
        });

        // DEBUG: Log what we received to diagnose the update vs create issue
        log(`getEntity: searching for '${entityName}'`, 'info', {
          resultsCount: entities?.length || 0,
          resultNames: entities?.slice(0, 5).map((e: any) => e.name || e.entity_name) || []
        });

        // CRITICAL: Find exact match - searchTerm returns partial matches
        // VKB API ignores namePattern and returns all entities without proper filtering
        const exactMatch = entities?.find((e: any) =>
          (e.name || e.entity_name) === entityName
        );
        if (exactMatch) {
          log(`getEntity: exact match FOUND for '${entityName}'`, 'info');
          return exactMatch as SharedMemoryEntity;
        }
        log(`getEntity: NO exact match for '${entityName}' - will CREATE`, 'info');
      }

      // Fallback to shared memory
      const sharedMemory = await this.loadSharedMemory();
      const found = sharedMemory.entities.find(e => e.name === entityName) || null;
      log(`getEntity: shared memory lookup for '${entityName}': ${found ? 'FOUND' : 'not found'}`, 'info');
      return found;

    } catch (error) {
      log(`Failed to get entity: ${entityName}`, 'error', error);
      return null;
    }
  }

  /**
   * Get all entities for a team
   */
  async getAllEntities(team: string): Promise<SharedMemoryEntity[]> {
    try {
      // Try GraphDB first
      if (this.graphDB) {
        const entities = await this.graphDB.queryEntities({});
        if (entities && entities.length > 0) {
          return entities as SharedMemoryEntity[];
        }
      }

      // Fallback to shared memory
      const sharedMemory = await this.loadSharedMemory();
      return sharedMemory.entities;

    } catch (error) {
      log(`Failed to get all entities for team: ${team}`, 'error', error);
      return [];
    }
  }

  /**
   * Persist an array of transformed entities (from code-graph or documentation-linker)
   * This creates UKB entities from the transformed results of transformToKnowledgeEntities
   */
  async persistEntities(params: {
    entities: Array<{
      name: string;
      entityType: string;
      observations: string[];
      significance: number;
    }> | null | undefined;
    team: string;
  }): Promise<{
    success: boolean;
    created: number;
    updated: number;
    failed: number;
    details: string;
  }> {
    const result = {
      success: false,
      created: 0,
      updated: 0,
      failed: 0,
      details: ''
    };

    try {
      const { entities, team } = params;

      // DEBUG: Log what we received
      log('persistEntities called', 'info', {
        paramsKeys: Object.keys(params),
        hasEntities: !!entities,
        entitiesType: typeof entities,
        isArray: Array.isArray(entities),
        entitiesLength: Array.isArray(entities) ? entities.length : 'N/A',
        team
      });

      // TRACE: Write to file for debugging
      const fs = await import('fs');
      const traceFile = `${process.cwd()}/logs/persist-trace-${Date.now()}.json`;
      await fs.promises.mkdir(`${process.cwd()}/logs`, { recursive: true });
      await fs.promises.writeFile(traceFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        paramsKeys: Object.keys(params),
        hasEntities: !!entities,
        entitiesType: typeof entities,
        isArray: Array.isArray(entities),
        entitiesLength: Array.isArray(entities) ? entities.length : 'N/A',
        entitiesSample: Array.isArray(entities) ? entities.slice(0, 2) : null,
        team
      }, null, 2));
      log(`TRACE: persistEntities params written to ${traceFile}`, 'info');

      // Handle empty/null/undefined input gracefully
      if (!entities || !Array.isArray(entities) || entities.length === 0) {
        result.success = true;
        result.details = 'No entities to persist (empty or null input)';
        log(result.details, 'info');
        return result;
      }

      log(`Persisting ${entities.length} entities for team: ${team}`, 'info');

      for (const entity of entities) {
        try {
          // Skip entities with empty or invalid names
          if (!entity.name || entity.name.trim() === '') {
            log('Skipping entity with empty name', 'warning');
            result.failed++;
            continue;
          }

          // Check if entity already exists
          const existingEntity = await this.getEntity(entity.name, team);

          if (existingEntity) {
            // Update existing entity - add new observations
            const newObservations = entity.observations.filter(
              obs => !existingEntity.observations.some(
                existing => (typeof existing === 'string' ? existing : existing.content) === obs
              )
            );

            if (newObservations.length > 0) {
              const updateResult = await this.updateEntityObservations({
                entityName: entity.name,
                team,
                removeObservations: [],
                newObservations
              });

              if (updateResult.success) {
                result.updated++;
                log(`Updated entity: ${entity.name} with ${newObservations.length} new observations`, 'info');
              } else {
                result.failed++;
                log(`Failed to update entity: ${entity.name}`, 'warning');
              }
            } else {
              // Entity exists but no new observations - count as updated (no-op)
              result.updated++;
            }
          } else {
            // Create new entity using createUkbEntity
            const createResult = await this.createUkbEntity({
              name: entity.name,
              type: entity.entityType,
              insights: this.serializeObservationsToString(entity.observations),
              significance: entity.significance
            });

            if (createResult.success) {
              result.created++;
              log(`Created entity: ${entity.name}`, 'info');
            } else {
              result.failed++;
              log(`Failed to create entity: ${entity.name} - ${createResult.details}`, 'warning');
            }
          }
        } catch (entityError) {
          result.failed++;
          log(`Error processing entity ${entity.name}`, 'error', entityError);
        }
      }

      result.success = result.failed === 0 || (result.created + result.updated) > 0;
      result.details = `Persisted entities: ${result.created} created, ${result.updated} updated, ${result.failed} failed`;
      log(result.details, 'info');

    } catch (error) {
      result.details = `Failed to persist entities: ${error instanceof Error ? error.message : String(error)}`;
      log(result.details, 'error');
    }

    return result;
  }
}