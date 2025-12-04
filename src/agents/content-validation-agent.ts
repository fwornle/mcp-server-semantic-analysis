/**
 * ContentValidationAgent
 *
 * Validates that entity content (observations, insights, PlantUML diagrams) is accurate
 * and in-sync with the current codebase before updates.
 *
 * Key responsibilities:
 * 1. Parse entities for file paths, command names, API endpoints
 * 2. Verify references exist in codebase
 * 3. Detect stale observations and diagrams
 * 4. Generate refresh reports with actionable recommendations
 */

import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { GraphDatabaseAdapter } from "../storage/graph-database-adapter.js";
import { SemanticAnalyzer } from "./semantic-analyzer.js";
import type { PersistenceAgent } from "./persistence-agent.js";

// Simple logger
const log = (message: string, level: string = "info", data?: any) => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [ContentValidationAgent] [${level.toUpperCase()}] ${message}`;
  if (data) {
    console.log(logMessage, JSON.stringify(data, null, 2));
  } else {
    console.log(logMessage);
  }
};

// Validation result interfaces
export interface ValidationIssue {
  type: "error" | "warning" | "info";
  category: "file_reference" | "command_reference" | "api_endpoint" | "component_reference" | "diagram_staleness" | "observation_staleness";
  message: string;
  reference: string;
  suggestion?: string;
  location?: string;
}

export interface ObservationValidation {
  observation: string;
  isValid: boolean;
  issues: ValidationIssue[];
  extractedReferences: {
    files: string[];
    commands: string[];
    components: string[];
    apis: string[];
  };
}

export interface DiagramValidation {
  diagramPath: string;
  isValid: boolean;
  issues: ValidationIssue[];
  referencedComponents: string[];
  missingComponents: string[];
}

export interface InsightValidation {
  insightPath: string;
  isValid: boolean;
  issues: ValidationIssue[];
  outdatedSections: string[];
  diagramValidations: DiagramValidation[];
}

export interface EntityValidationReport {
  entityName: string;
  team: string;
  validatedAt: string;
  overallValid: boolean;
  overallScore: number; // 0-100
  totalIssues: number;
  criticalIssues: number;
  observationValidations: ObservationValidation[];
  insightValidation?: InsightValidation;
  recommendations: string[];
  suggestedActions: {
    removeObservations: string[];
    updateObservations: string[];
    regenerateDiagrams: string[];
    refreshInsight: boolean;
  };
}

export interface StaleEntityInfo {
  entityName: string;
  entityType: string;
  staleness: 'critical' | 'moderate' | 'low';
  score: number;
  issues: ValidationIssue[];
  requiresRefresh: boolean;
  lastUpdated?: string;
}

export interface StaleEntitiesValidationResult {
  validatedAt: string;
  totalEntitiesChecked: number;
  staleEntitiesFound: number;
  criticalStaleEntities: number;
  staleEntities: StaleEntityInfo[];
  refreshActions: {
    entityName: string;
    action: 'deleted' | 'delete_failed' | 'scheduled_for_refresh' | 'auto_refreshed' | 'manual_review_required';
    reason: string;
  }[];
  summary: string;
}

export interface ContentValidationAgentConfig {
  repositoryPath: string;
  insightsDirectory: string;
  enableDeepValidation: boolean;
  stalenessThresholdDays?: number;
}

// Entity refresh result interfaces
export interface ObservationRefreshResult {
  removed: string[];
  added: string[];
  unchanged: number;
}

export interface EntityRefreshResult {
  entityName: string;
  team: string;
  refreshedAt: string;
  validationBefore: EntityValidationReport;
  validationAfter?: EntityValidationReport;
  observationChanges: ObservationRefreshResult;
  diagramsRegenerated: string[];
  insightRefreshed: boolean;
  success: boolean;
  error?: string;
}

export class ContentValidationAgent {
  private repositoryPath: string;
  private insightsDirectory: string;
  private enableDeepValidation: boolean;
  private stalenessThresholdDays: number;
  private graphDB: GraphDatabaseAdapter | null = null;
  private semanticAnalyzer: SemanticAnalyzer;
  private persistenceAgent: PersistenceAgent | null = null;

  // Known patterns for reference extraction
  private filePathPatterns = [
    /`([^`]+\.[a-z]{2,4})`/gi,                          // `file.ts`
    /\b(src\/[^\s,)]+)/gi,                              // src/path/file.ts
    /\b(integrations\/[^\s,)]+)/gi,                     // integrations/path/file.ts
    /\b(lib\/[^\s,)]+)/gi,                              // lib/path/file.ts
    /\b(scripts\/[^\s,)]+)/gi,                          // scripts/path/file.ts
    /\b(config\/[^\s,)]+)/gi,                           // config/path/file.ts
  ];

  private commandPatterns = [
    /\b(ukb|vkb|coding|claude-mcp)\b/gi,                // Known commands
    /`([a-z][a-z0-9-]+)`\s+command/gi,                  // `command` command
    /run\s+`([^`]+)`/gi,                                // run `command`
    /execute\s+`([^`]+)`/gi,                            // execute `command`
  ];

  private componentPatterns = [
    /\b([A-Z][a-zA-Z0-9]+Agent)\b/g,                    // *Agent classes
    /\b([A-Z][a-zA-Z0-9]+Service)\b/g,                  // *Service classes
    /\b([A-Z][a-zA-Z0-9]+Manager)\b/g,                  // *Manager classes
    /\b([A-Z][a-zA-Z0-9]+Adapter)\b/g,                  // *Adapter classes
  ];

  constructor(config?: Partial<ContentValidationAgentConfig>) {
    this.repositoryPath = config?.repositoryPath || process.cwd();
    this.insightsDirectory = config?.insightsDirectory ||
      path.join(this.repositoryPath, ".ukb", "insights");
    this.enableDeepValidation = config?.enableDeepValidation ?? true;
    this.stalenessThresholdDays = config?.stalenessThresholdDays ?? 30;
    this.semanticAnalyzer = new SemanticAnalyzer();

    log(`ContentValidationAgent initialized`, "info", {
      repositoryPath: this.repositoryPath,
      insightsDirectory: this.insightsDirectory,
      enableDeepValidation: this.enableDeepValidation
    });
  }

  /**
   * Set the GraphDatabaseAdapter for querying entities
   */
  setGraphDB(graphDB: GraphDatabaseAdapter): void {
    this.graphDB = graphDB;
    log('GraphDatabaseAdapter set for ContentValidationAgent', 'info');
  }

  /**
   * Set the PersistenceAgent for updating entities
   */
  setPersistenceAgent(persistenceAgent: PersistenceAgent): void {
    this.persistenceAgent = persistenceAgent;
    log('PersistenceAgent set for ContentValidationAgent', 'info');
  }

  /**
   * Validate all entities in the graph database for staleness
   * Called during incremental-analysis workflow to detect outdated entities
   */
  async validateAndRefreshStaleEntities(params: {
    semantic_analysis_results?: any;
    observations?: any;
    stalenessThresholdDays?: number;
    autoRefresh?: boolean;
  }): Promise<StaleEntitiesValidationResult> {
    log('Starting stale entity validation', 'info', params);

    const result: StaleEntitiesValidationResult = {
      validatedAt: new Date().toISOString(),
      totalEntitiesChecked: 0,
      staleEntitiesFound: 0,
      criticalStaleEntities: 0,
      staleEntities: [],
      refreshActions: [],
      summary: ''
    };

    try {
      // Get all entities from the graph database
      if (!this.graphDB) {
        // Initialize graphDB if not set
        this.graphDB = new GraphDatabaseAdapter();
        await this.graphDB.initialize();
        log('GraphDatabaseAdapter initialized for content validation', 'info');
      } else if (!this.graphDB.initialized) {
        // graphDB was set but not initialized
        await this.graphDB.initialize();
        log('GraphDatabaseAdapter re-initialized for content validation', 'info');
      }

      const allEntities = await this.graphDB.queryEntities({}) || [];

      // Limit processing to prevent extremely long runs
      const MAX_ENTITIES_TO_CHECK = 100;
      const entities = allEntities.slice(0, MAX_ENTITIES_TO_CHECK);
      result.totalEntitiesChecked = entities.length;

      if (allEntities.length > MAX_ENTITIES_TO_CHECK) {
        log(`Large knowledge base: ${allEntities.length} entities, checking first ${MAX_ENTITIES_TO_CHECK}`, 'warning');
      } else {
        log(`Checking ${entities.length} entities for staleness`, 'info');
      }

      // Known deprecated/outdated patterns to check for
      const deprecatedPatterns = [
        { pattern: /\bukb\b/gi, replacement: 'vkb or graph database operations', severity: 'critical' as const },
        { pattern: /shared-memory-\w+\.json/gi, replacement: 'GraphDatabaseService', severity: 'critical' as const },
        { pattern: /\.ukb\//gi, replacement: '.data/knowledge-graph/', severity: 'moderate' as const },
        { pattern: /SynchronizationAgent/gi, replacement: 'GraphDatabaseAdapter (auto-persistence)', severity: 'moderate' as const },
        { pattern: /PersistenceFile/gi, replacement: 'GraphDatabaseService', severity: 'moderate' as const },
        { pattern: /shared-memory\.json/gi, replacement: 'LevelDB graph storage', severity: 'critical' as const },
      ];

      // Process entities in batches with event loop yields to prevent blocking
      const BATCH_SIZE = 10;
      let processedCount = 0;

      for (const entity of entities) {
        // Yield to event loop every BATCH_SIZE entities to prevent blocking
        if (processedCount > 0 && processedCount % BATCH_SIZE === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
        processedCount++;

        const entityName = entity.name || entity.id || 'Unknown';
        const entityType = entity.type || entity.entityType || 'Unknown';
        const observations = entity.observations || [];

        const issues: ValidationIssue[] = [];
        let staleness: 'critical' | 'moderate' | 'low' = 'low';
        let score = 100;

        // Check observations for deprecated patterns
        for (const observation of observations) {
          const obsText = typeof observation === 'string' ? observation : observation.content || '';

          for (const { pattern, replacement, severity } of deprecatedPatterns) {
            const matches = obsText.match(pattern);
            if (matches) {
              issues.push({
                type: severity === 'critical' ? 'error' : 'warning',
                category: 'observation_staleness',
                message: `Observation references deprecated concept: "${matches[0]}"`,
                reference: obsText.substring(0, 100) + (obsText.length > 100 ? '...' : ''),
                suggestion: `Update to use: ${replacement}`
              });

              if (severity === 'critical') {
                staleness = 'critical';
                score -= 30;
              } else if (severity === 'moderate' && staleness !== 'critical') {
                staleness = 'moderate';
                score -= 15;
              }
            }
          }

          // Also validate file references in observations
          const fileRefs = this.extractFileReferences(obsText);
          for (const fileRef of fileRefs) {
            if (!this.fileExists(fileRef)) {
              issues.push({
                type: 'warning',
                category: 'file_reference',
                message: `Referenced file no longer exists: ${fileRef}`,
                reference: fileRef,
                suggestion: 'Update or remove this file reference'
              });
              score -= 10;
              if (staleness === 'low') staleness = 'moderate';
            }
          }
        }

        // Check entity name itself for deprecated patterns
        for (const { pattern, replacement, severity } of deprecatedPatterns) {
          if (pattern.test(entityName)) {
            issues.push({
              type: 'error',
              category: 'observation_staleness',
              message: `Entity name contains deprecated concept`,
              reference: entityName,
              suggestion: `Consider renaming or updating to reflect: ${replacement}`
            });
            staleness = 'critical';
            score -= 25;
          }
        }

        // Add to stale entities if issues found
        if (issues.length > 0) {
          result.staleEntitiesFound++;
          if (staleness === 'critical') {
            result.criticalStaleEntities++;
          }

          const staleEntity: StaleEntityInfo = {
            entityName,
            entityType,
            staleness,
            score: Math.max(0, score),
            issues,
            requiresRefresh: staleness === 'critical' || score < 50,
            lastUpdated: entity.updatedAt || entity.createdAt
          };

          result.staleEntities.push(staleEntity);

          // Determine action
          if (params.autoRefresh && staleness === 'critical') {
            result.refreshActions.push({
              entityName,
              action: 'deleted',
              reason: `Critical staleness detected: ${issues.length} issues found - entity deleted`
            });

            // Actually delete the stale entity
            try {
              const entityId = entity.id || entityName;
              await this.graphDB.deleteEntity(entityId);
              log(`Deleted stale entity: ${entityName}`, 'info', { entityId, issues: issues.length });
            } catch (deleteError) {
              log(`Failed to delete stale entity: ${entityName}`, 'error', deleteError);
              // Update the action to reflect failure
              result.refreshActions[result.refreshActions.length - 1].action = 'delete_failed';
              result.refreshActions[result.refreshActions.length - 1].reason =
                `Delete failed: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`;
            }
          } else if (staleness === 'critical') {
            result.refreshActions.push({
              entityName,
              action: 'manual_review_required',
              reason: `Critical staleness requires manual review`
            });
          }
        }
      }

      // Generate summary
      result.summary = this.generateStalenessSummary(result);

      log('Stale entity validation complete', 'info', {
        totalChecked: result.totalEntitiesChecked,
        staleFound: result.staleEntitiesFound,
        critical: result.criticalStaleEntities
      });

    } catch (error) {
      log('Error during stale entity validation', 'error', error);
      result.summary = `Validation error: ${error instanceof Error ? error.message : String(error)}`;
    }

    return result;
  }

  /**
   * Generate a human-readable summary of staleness validation
   */
  private generateStalenessSummary(result: StaleEntitiesValidationResult): string {
    const lines: string[] = [];

    lines.push(`## Stale Entity Validation Summary`);
    lines.push(`Validated at: ${result.validatedAt}`);
    lines.push(`Total entities checked: ${result.totalEntitiesChecked}`);
    lines.push(`Stale entities found: ${result.staleEntitiesFound}`);
    lines.push(`Critical stale entities: ${result.criticalStaleEntities}`);
    lines.push('');

    if (result.staleEntities.length > 0) {
      lines.push(`### Stale Entities Requiring Attention`);
      for (const entity of result.staleEntities) {
        lines.push(`- **${entity.entityName}** (${entity.entityType})`);
        lines.push(`  - Staleness: ${entity.staleness.toUpperCase()}, Score: ${entity.score}/100`);
        lines.push(`  - Issues: ${entity.issues.length}`);
        for (const issue of entity.issues.slice(0, 3)) {
          lines.push(`    - [${issue.type}] ${issue.message}`);
        }
        if (entity.issues.length > 3) {
          lines.push(`    - ... and ${entity.issues.length - 3} more issues`);
        }
      }
    } else {
      lines.push('All entities are up-to-date. No staleness detected.');
    }

    if (result.refreshActions.length > 0) {
      lines.push('');
      lines.push(`### Recommended Actions`);
      for (const action of result.refreshActions) {
        lines.push(`- ${action.entityName}: ${action.action} - ${action.reason}`);
      }
    }

    return lines.join('\n');
  }

  // ==================== Batch Validation Methods ====================

  /**
   * Validate all entities for a specific project/team
   * Returns validation reports for each entity with aggregated summary
   */
  async validateEntitiesByProject(team: string, options?: {
    maxEntities?: number;
    skipHealthyEntities?: boolean;
    progressCallback?: (current: number, total: number, entityName: string) => void;
  }): Promise<{
    team: string;
    validatedAt: string;
    totalEntities: number;
    validatedEntities: number;
    invalidEntities: number;
    reports: EntityValidationReport[];
    summary: string;
  }> {
    const startTime = Date.now();
    const maxEntities = options?.maxEntities ?? Infinity;
    const skipHealthy = options?.skipHealthyEntities ?? false;

    log(`Starting batch validation for project: ${team}`, "info");

    const result = {
      team,
      validatedAt: new Date().toISOString(),
      totalEntities: 0,
      validatedEntities: 0,
      invalidEntities: 0,
      reports: [] as EntityValidationReport[],
      summary: ""
    };

    try {
      // Get all entities for this team
      let entities: any[] = [];

      if (this.graphDB && this.graphDB.initialized) {
        entities = await this.graphDB.queryEntities({});
      } else {
        // Fallback to knowledge export file
        const knowledgeExportPath = path.join(
          this.repositoryPath,
          '.data',
          'knowledge-export',
          `${team}.json`
        );
        try {
          const content = JSON.parse(await fsPromises.readFile(knowledgeExportPath, "utf-8"));
          entities = content.entities || [];
        } catch {
          log(`No knowledge export found for team: ${team}`, "warning");
        }
      }

      result.totalEntities = entities.length;
      const entitiesToValidate = entities.slice(0, maxEntities);

      for (let i = 0; i < entitiesToValidate.length; i++) {
        const entity = entitiesToValidate[i];
        const entityName = entity.name || entity.entityName;

        // Yield to event loop to prevent blocking
        if (i > 0 && i % 5 === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }

        if (options?.progressCallback) {
          options.progressCallback(i + 1, entitiesToValidate.length, entityName);
        }

        try {
          const report = await this.validateEntityAccuracy(entityName, team);
          result.validatedEntities++;

          if (!report.overallValid) {
            result.invalidEntities++;
            result.reports.push(report);
          } else if (!skipHealthy) {
            result.reports.push(report);
          }
        } catch (error) {
          log(`Error validating entity ${entityName}`, "error", error);
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      result.summary = `Validated ${result.validatedEntities}/${result.totalEntities} entities for team ${team} in ${elapsed}s. Found ${result.invalidEntities} invalid entities.`;

      log(result.summary, "info");

    } catch (error) {
      log(`Error during batch validation for team ${team}`, "error", error);
      result.summary = `Batch validation error: ${error instanceof Error ? error.message : String(error)}`;
    }

    return result;
  }

  /**
   * Validate all entities across all projects in the knowledge base
   * Returns aggregated validation results for the entire knowledge base
   */
  async validateAllEntities(options?: {
    maxEntitiesPerProject?: number;
    skipHealthyEntities?: boolean;
    progressCallback?: (team: string, current: number, total: number) => void;
  }): Promise<{
    validatedAt: string;
    totalProjects: number;
    totalEntities: number;
    totalInvalidEntities: number;
    projectResults: Map<string, {
      validatedEntities: number;
      invalidEntities: number;
      reports: EntityValidationReport[];
    }>;
    summary: string;
  }> {
    const startTime = Date.now();

    log("Starting full knowledge base validation", "info");

    const result = {
      validatedAt: new Date().toISOString(),
      totalProjects: 0,
      totalEntities: 0,
      totalInvalidEntities: 0,
      projectResults: new Map<string, {
        validatedEntities: number;
        invalidEntities: number;
        reports: EntityValidationReport[];
      }>(),
      summary: ""
    };

    try {
      // Find all project knowledge export files
      const knowledgeExportDir = path.join(this.repositoryPath, '.data', 'knowledge-export');
      const files = await this.findFilesInDirAsync(knowledgeExportDir, ['.json'], 1);

      const projectTeams = files
        .map(f => path.basename(f, '.json'))
        .filter(name => !name.startsWith('.') && name !== 'metadata');

      result.totalProjects = projectTeams.length;

      for (const team of projectTeams) {
        if (options?.progressCallback) {
          options.progressCallback(team, 0, 0);
        }

        const projectResult = await this.validateEntitiesByProject(team, {
          maxEntities: options?.maxEntitiesPerProject,
          skipHealthyEntities: options?.skipHealthyEntities,
          progressCallback: options?.progressCallback
            ? (current, total, _entityName) => options.progressCallback!(team, current, total)
            : undefined
        });

        result.totalEntities += projectResult.validatedEntities;
        result.totalInvalidEntities += projectResult.invalidEntities;

        result.projectResults.set(team, {
          validatedEntities: projectResult.validatedEntities,
          invalidEntities: projectResult.invalidEntities,
          reports: projectResult.reports
        });
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      result.summary = `Full KB validation complete: ${result.totalProjects} projects, ${result.totalEntities} entities, ${result.totalInvalidEntities} invalid in ${elapsed}s`;

      log(result.summary, "info");

    } catch (error) {
      log("Error during full knowledge base validation", "error", error);
      result.summary = `Full KB validation error: ${error instanceof Error ? error.message : String(error)}`;
    }

    return result;
  }

  /**
   * Main entry point: Validate all content for an entity
   */
  async validateEntityAccuracy(entityName: string, team: string): Promise<EntityValidationReport> {
    log(`Starting validation for entity: ${entityName}`, "info");

    const report: EntityValidationReport = {
      entityName,
      team,
      validatedAt: new Date().toISOString(),
      overallValid: true,
      overallScore: 100,
      totalIssues: 0,
      criticalIssues: 0,
      observationValidations: [],
      recommendations: [],
      suggestedActions: {
        removeObservations: [],
        updateObservations: [],
        regenerateDiagrams: [],
        refreshInsight: false,
      }
    };

    try {
      // Load entity from graph database (would be injected in practice)
      const entity = await this.loadEntity(entityName, team);

      if (!entity) {
        report.overallValid = false;
        report.recommendations.push(`Entity '${entityName}' not found in team '${team}'`);
        return report;
      }

      // Validate observations
      if (entity.observations && entity.observations.length > 0) {
        report.observationValidations = await this.validateObservations(entity.observations);

        for (const validation of report.observationValidations) {
          if (!validation.isValid) {
            report.overallValid = false;
            const criticalIssues = validation.issues.filter(i => i.type === "error");
            report.criticalIssues += criticalIssues.length;
            report.totalIssues += validation.issues.length;

            if (criticalIssues.length > 0) {
              report.suggestedActions.removeObservations.push(validation.observation);
            } else {
              report.suggestedActions.updateObservations.push(validation.observation);
            }
          }
        }
      }

      // Validate insight document if exists
      const insightPath = await this.findInsightDocument(entityName);
      if (insightPath) {
        report.insightValidation = await this.validateInsightDocument(insightPath);

        if (!report.insightValidation.isValid) {
          report.overallValid = false;
          report.totalIssues += report.insightValidation.issues.length;
          report.criticalIssues += report.insightValidation.issues.filter(i => i.type === "error").length;

          if (report.insightValidation.outdatedSections.length > 0) {
            report.suggestedActions.refreshInsight = true;
          }

          for (const diagramValidation of report.insightValidation.diagramValidations) {
            if (!diagramValidation.isValid) {
              report.suggestedActions.regenerateDiagrams.push(diagramValidation.diagramPath);
            }
          }
        }
      }

      // Calculate overall score
      report.overallScore = this.calculateValidationScore(report);

      // Generate recommendations
      report.recommendations = this.generateRecommendations(report);

      log(`Validation complete for ${entityName}`, "info", {
        overallValid: report.overallValid,
        overallScore: report.overallScore,
        totalIssues: report.totalIssues
      });

    } catch (error) {
      log(`Error validating entity ${entityName}`, "error", error);
      report.overallValid = false;
      report.recommendations.push(`Validation error: ${error}`);
    }

    return report;
  }

  /**
   * Validate individual observations for accuracy
   * Observations can be strings or objects with {type, content} structure
   */
  async validateObservations(observations: (string | { type?: string; content?: string })[]): Promise<ObservationValidation[]> {
    const validations: ObservationValidation[] = [];

    for (const obs of observations) {
      // Extract the text content from the observation
      // Handle both string observations and object observations with {type, content}
      const observationText = typeof obs === 'string'
        ? obs
        : (obs.content || JSON.stringify(obs));

      const validation: ObservationValidation = {
        observation: observationText,
        isValid: true,
        issues: [],
        extractedReferences: {
          files: [],
          commands: [],
          components: [],
          apis: []
        }
      };

      // Extract file references
      validation.extractedReferences.files = this.extractFileReferences(observationText);

      // Extract command references
      validation.extractedReferences.commands = this.extractCommandReferences(observationText);

      // Extract component references
      validation.extractedReferences.components = this.extractComponentReferences(observationText);

      // Validate file references exist
      for (const file of validation.extractedReferences.files) {
        const exists = await this.fileExists(file);
        if (!exists) {
          validation.isValid = false;
          validation.issues.push({
            type: "error",
            category: "file_reference",
            message: `Referenced file does not exist`,
            reference: file,
            suggestion: `Remove or update this file reference`
          });
        }
      }

      // Validate command references
      for (const command of validation.extractedReferences.commands) {
        const isValid = await this.validateCommandReference(command);
        if (!isValid) {
          validation.isValid = false;
          validation.issues.push({
            type: "error",
            category: "command_reference",
            message: `Referenced command is no longer valid`,
            reference: command,
            suggestion: `Update command reference or remove observation`
          });
        }
      }

      // Validate component references (check if classes exist in codebase)
      if (this.enableDeepValidation) {
        for (const component of validation.extractedReferences.components) {
          const exists = await this.componentExists(component);
          if (!exists) {
            validation.isValid = false;
            validation.issues.push({
              type: "warning",
              category: "component_reference",
              message: `Referenced component may not exist`,
              reference: component,
              suggestion: `Verify component exists or update reference`
            });
          }
        }
      }

      validations.push(validation);
    }

    return validations;
  }

  /**
   * Validate insight document and its diagrams
   */
  async validateInsightDocument(insightPath: string): Promise<InsightValidation> {
    const validation: InsightValidation = {
      insightPath,
      isValid: true,
      issues: [],
      outdatedSections: [],
      diagramValidations: []
    };

    try {
      const insightExists = await this.fileExists(insightPath);
      if (!insightExists) {
        validation.isValid = false;
        validation.issues.push({
          type: "error",
          category: "file_reference",
          message: "Insight document does not exist",
          reference: insightPath
        });
        return validation;
      }

      const content = await fsPromises.readFile(insightPath, "utf-8");

      // Check for outdated patterns in content
      const outdatedPatterns = this.detectOutdatedPatterns(content);
      for (const pattern of outdatedPatterns) {
        validation.isValid = false;
        validation.issues.push({
          type: "warning",
          category: "observation_staleness",
          message: pattern.message,
          reference: pattern.reference,
          suggestion: pattern.suggestion
        });
        validation.outdatedSections.push(pattern.reference);
      }

      // Find and validate PlantUML diagrams
      const diagramReferences = this.extractDiagramReferences(content);
      const insightDir = path.dirname(insightPath);

      for (const diagramRef of diagramReferences) {
        const diagramPath = path.isAbsolute(diagramRef)
          ? diagramRef
          : path.join(insightDir, diagramRef);

        const diagramValidation = await this.validatePlantUMLDiagram(diagramPath, content);
        validation.diagramValidations.push(diagramValidation);

        if (!diagramValidation.isValid) {
          validation.isValid = false;
          validation.issues.push(...diagramValidation.issues);
        }
      }

    } catch (error) {
      validation.isValid = false;
      validation.issues.push({
        type: "error",
        category: "file_reference",
        message: `Error reading insight document: ${error}`,
        reference: insightPath
      });
    }

    return validation;
  }

  /**
   * Validate PlantUML diagrams for accuracy
   */
  async validatePlantUMLDiagram(diagramPath: string, insightContent?: string): Promise<DiagramValidation> {
    const validation: DiagramValidation = {
      diagramPath,
      isValid: true,
      issues: [],
      referencedComponents: [],
      missingComponents: []
    };

    try {
      // Check if .puml file exists (async)
      const pumlPath = diagramPath.replace(/\.png$/, ".puml");
      const pumlExists = await this.fileExists(pumlPath);
      const diagramExists = await this.fileExists(diagramPath);

      if (!pumlExists && !diagramExists) {
        validation.isValid = false;
        validation.issues.push({
          type: "error",
          category: "diagram_staleness",
          message: "Diagram file does not exist",
          reference: diagramPath,
          suggestion: "Regenerate the diagram"
        });
        return validation;
      }

      const diagramContent = pumlExists
        ? await fsPromises.readFile(pumlPath, "utf-8")
        : "";

      // Extract component names from PlantUML
      validation.referencedComponents = this.extractPlantUMLComponents(diagramContent);

      // Check if referenced components exist in codebase
      for (const component of validation.referencedComponents) {
        const exists = await this.componentExists(component);
        if (!exists) {
          validation.missingComponents.push(component);
        }
      }

      if (validation.missingComponents.length > 0) {
        validation.isValid = false;
        validation.issues.push({
          type: "warning",
          category: "diagram_staleness",
          message: `Diagram references ${validation.missingComponents.length} components that may not exist`,
          reference: diagramPath,
          suggestion: `Regenerate diagram. Missing: ${validation.missingComponents.join(", ")}`
        });
      }

      // Check for outdated naming patterns in diagram
      const outdatedDiagramPatterns = this.detectOutdatedPatternsInDiagram(diagramContent);
      for (const pattern of outdatedDiagramPatterns) {
        validation.isValid = false;
        validation.issues.push({
          type: "error",
          category: "diagram_staleness",
          message: pattern.message,
          reference: diagramPath,
          suggestion: pattern.suggestion
        });
      }

    } catch (error) {
      validation.isValid = false;
      validation.issues.push({
        type: "error",
        category: "diagram_staleness",
        message: `Error validating diagram: ${error}`,
        reference: diagramPath
      });
    }

    return validation;
  }

  /**
   * Generate refresh report with actionable recommendations
   */
  generateRefreshReport(report: EntityValidationReport): string {
    const lines: string[] = [
      `# Entity Validation Report: ${report.entityName}`,
      ``,
      `**Team:** ${report.team}`,
      `**Validated:** ${report.validatedAt}`,
      `**Overall Score:** ${report.overallScore}/100`,
      `**Status:** ${report.overallValid ? "VALID" : "NEEDS REFRESH"}`,
      ``,
    ];

    if (report.totalIssues > 0) {
      lines.push(`## Issues Found: ${report.totalIssues} (${report.criticalIssues} critical)`);
      lines.push(``);

      // Group issues by category
      const allIssues: ValidationIssue[] = [];
      for (const ov of report.observationValidations) {
        allIssues.push(...ov.issues);
      }
      if (report.insightValidation) {
        allIssues.push(...report.insightValidation.issues);
      }

      const byCategory = new Map<string, ValidationIssue[]>();
      for (const issue of allIssues) {
        const cat = issue.category;
        if (!byCategory.has(cat)) {
          byCategory.set(cat, []);
        }
        byCategory.get(cat)!.push(issue);
      }

      for (const [category, issues] of byCategory) {
        lines.push(`### ${category.replace(/_/g, " ").toUpperCase()}`);
        for (const issue of issues) {
          lines.push(`- [${issue.type.toUpperCase()}] ${issue.message}`);
          lines.push(`  - Reference: \`${issue.reference}\``);
          if (issue.suggestion) {
            lines.push(`  - Suggestion: ${issue.suggestion}`);
          }
        }
        lines.push(``);
      }
    }

    if (report.recommendations.length > 0) {
      lines.push(`## Recommendations`);
      for (const rec of report.recommendations) {
        lines.push(`- ${rec}`);
      }
      lines.push(``);
    }

    if (Object.values(report.suggestedActions).some(v =>
      Array.isArray(v) ? v.length > 0 : v)) {
      lines.push(`## Suggested Actions`);

      if (report.suggestedActions.removeObservations.length > 0) {
        lines.push(`### Remove Observations`);
        for (const obs of report.suggestedActions.removeObservations) {
          lines.push(`- "${obs.substring(0, 80)}${obs.length > 80 ? "..." : ""}"`);
        }
      }

      if (report.suggestedActions.updateObservations.length > 0) {
        lines.push(`### Update Observations`);
        for (const obs of report.suggestedActions.updateObservations) {
          lines.push(`- "${obs.substring(0, 80)}${obs.length > 80 ? "..." : ""}"`);
        }
      }

      if (report.suggestedActions.regenerateDiagrams.length > 0) {
        lines.push(`### Regenerate Diagrams`);
        for (const diag of report.suggestedActions.regenerateDiagrams) {
          lines.push(`- \`${diag}\``);
        }
      }

      if (report.suggestedActions.refreshInsight) {
        lines.push(`### Refresh Insight Document`);
        lines.push(`- Re-generate the insight document with current codebase state`);
      }
    }

    return lines.join("\n");
  }

  // ==================== Private Helper Methods ====================

  private async loadEntity(entityName: string, team: string): Promise<any> {
    // First try to load from graph database if available
    if (this.graphDB && this.graphDB.initialized) {
      try {
        // Use queryEntities with exact name pattern to find the entity
        const entities = await this.graphDB.queryEntities({
          namePattern: `^${entityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
        });
        if (entities && entities.length > 0) {
          return entities[0];
        }
      } catch (error) {
        log(`Error loading entity from graph database, falling back to file`, "warning", error);
      }
    }

    // Fallback: read from the knowledge export file (async)
    const knowledgeExportPath = path.join(
      this.repositoryPath,
      '.data',
      'knowledge-export',
      `${team}.json`
    );

    try {
      await fsPromises.access(knowledgeExportPath, fs.constants.F_OK);
      const content = JSON.parse(await fsPromises.readFile(knowledgeExportPath, "utf-8"));
      return content.entities?.find((e: any) => e.name === entityName);
    } catch (error) {
      // File doesn't exist or can't be read
      log(`Error loading entity from knowledge export`, "error", error);
    }

    return null;
  }

  private extractFileReferences(text: string): string[] {
    const files = new Set<string>();

    for (const pattern of this.filePathPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const filePath = match[1];
        if (filePath && !filePath.includes("*") && !filePath.includes("{")) {
          files.add(filePath);
        }
      }
    }

    return Array.from(files);
  }

  private extractCommandReferences(text: string): string[] {
    const commands = new Set<string>();

    for (const pattern of this.commandPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const command = match[1];
        if (command) {
          commands.add(command.toLowerCase());
        }
      }
    }

    return Array.from(commands);
  }

  private extractComponentReferences(text: string): string[] {
    const components = new Set<string>();

    for (const pattern of this.componentPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const component = match[1];
        if (component) {
          components.add(component);
        }
      }
    }

    return Array.from(components);
  }

  private extractDiagramReferences(content: string): string[] {
    const diagrams = new Set<string>();

    // Match markdown image references
    const imgPattern = /!\[.*?\]\(([^)]+\.(?:png|puml))\)/gi;
    let match;
    while ((match = imgPattern.exec(content)) !== null) {
      diagrams.add(match[1]);
    }

    // Match PlantUML include patterns
    const includePattern = /!include\s+([^\s]+\.puml)/gi;
    while ((match = includePattern.exec(content)) !== null) {
      diagrams.add(match[1]);
    }

    return Array.from(diagrams);
  }

  private extractPlantUMLComponents(content: string): string[] {
    const components = new Set<string>();

    // Extract class/component names from PlantUML
    const patterns = [
      /class\s+"?([^"\s{]+)"?\s*{?/gi,           // class ClassName
      /component\s+"?([^"\s]+)"?/gi,             // component ComponentName
      /participant\s+"?([^"\s]+)"?/gi,           // participant Name
      /actor\s+"?([^"\s]+)"?/gi,                 // actor Name
      /database\s+"?([^"\s]+)"?/gi,              // database Name
      /node\s+"?([^"\s]+)"?/gi,                  // node Name
      /package\s+"?([^"\s{]+)"?\s*{?/gi,         // package Name
      /rectangle\s+"?([^"\s{]+)"?\s*{?/gi,       // rectangle Name
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const name = match[1];
        if (name && !name.startsWith("@") && !name.startsWith("#")) {
          components.add(name);
        }
      }
    }

    return Array.from(components);
  }

  private async fileExists(filePath: string): Promise<boolean> {
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.repositoryPath, filePath);
    try {
      await fsPromises.access(fullPath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async validateCommandReference(command: string): Promise<boolean> {
    // Known deprecated/removed commands
    const deprecatedCommands = ["ukb"];

    if (deprecatedCommands.includes(command.toLowerCase())) {
      return false;
    }

    // Known valid commands
    const validCommands = ["vkb", "coding", "claude-mcp"];
    if (validCommands.includes(command.toLowerCase())) {
      return true;
    }

    // Check if command exists in bin/ or scripts/
    const binPath = path.join(this.repositoryPath, "bin", command);
    const scriptsPath = path.join(this.repositoryPath, "scripts", `${command}.js`);

    try {
      await fsPromises.access(binPath, fs.constants.F_OK);
      return true;
    } catch {
      try {
        await fsPromises.access(scriptsPath, fs.constants.F_OK);
        return true;
      } catch {
        return false;
      }
    }
  }

  private async componentExists(componentName: string): Promise<boolean> {
    // Search for the component in known directories
    try {
      const searchDirs = ['src', 'lib', 'scripts', 'integrations'];
      const classPattern = `class ${componentName}`;

      for (const dir of searchDirs) {
        const dirPath = path.join(this.repositoryPath, dir);

        // Check if directory exists (async)
        try {
          await fsPromises.access(dirPath, fs.constants.F_OK);
        } catch {
          continue;
        }

        // Check if a file with the component name exists
        const componentFile = path.join(dirPath, `${componentName.toLowerCase()}.ts`);
        const componentFileJs = path.join(dirPath, `${componentName.toLowerCase()}.js`);

        try {
          await fsPromises.access(componentFile, fs.constants.F_OK);
          return true;
        } catch {
          try {
            await fsPromises.access(componentFileJs, fs.constants.F_OK);
            return true;
          } catch {
            // Continue searching
          }
        }

        // Recursively search for class definition in immediate .ts/.js files
        const files = await this.findFilesInDirAsync(dirPath, ['.ts', '.js'], 2);
        for (const file of files.slice(0, 50)) { // Limit search
          try {
            const content = await fsPromises.readFile(file, "utf-8");
            if (content.includes(classPattern)) {
              return true;
            }
          } catch {
            // Skip unreadable files
          }
        }
      }

      return false;
    } catch {
      return true; // Assume exists if search fails
    }
  }

  /**
   * Async recursive file finder (limited depth) - non-blocking version
   */
  private async findFilesInDirAsync(dir: string, extensions: string[], maxDepth: number, currentDepth: number = 0): Promise<string[]> {
    if (currentDepth > maxDepth) return [];

    const files: string[] = [];
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Skip node_modules, dist, .git
          if (['node_modules', 'dist', '.git', '.data'].includes(entry.name)) continue;
          const subFiles = await this.findFilesInDirAsync(fullPath, extensions, maxDepth, currentDepth + 1);
          files.push(...subFiles);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (extensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }

      // Yield to event loop periodically to prevent blocking
      if (files.length > 0 && files.length % 20 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    } catch {
      // Skip unreadable directories
    }

    return files;
  }

  private detectOutdatedPatterns(content: string): Array<{message: string, reference: string, suggestion: string}> {
    const issues: Array<{message: string, reference: string, suggestion: string}> = [];

    // Known outdated patterns
    const outdatedPatterns = [
      {
        pattern: /\bukb\b.*command/gi,
        message: "References 'ukb' as a command (deprecated)",
        suggestion: "Use MCP workflow 'incremental-analysis' instead"
      },
      {
        pattern: /shared-memory-\w+\.json/gi,
        message: "References shared-memory JSON files (deprecated)",
        suggestion: "Update to reference Graphology + LevelDB storage"
      },
      {
        pattern: /SynchronizationAgent/gi,
        message: "References SynchronizationAgent (removed)",
        suggestion: "Use GraphDatabaseService for persistence"
      },
      {
        pattern: /json-based.*persistence/gi,
        message: "References JSON-based persistence (deprecated)",
        suggestion: "Update to reference graph database persistence"
      },
    ];

    for (const {pattern, message, suggestion} of outdatedPatterns) {
      const match = pattern.exec(content);
      if (match) {
        issues.push({
          message,
          reference: match[0],
          suggestion
        });
      }
    }

    return issues;
  }

  private detectOutdatedPatternsInDiagram(content: string): Array<{message: string, suggestion: string}> {
    const issues: Array<{message: string, suggestion: string}> = [];

    // Check for deprecated components in diagrams
    const deprecatedComponents = [
      { name: "SynchronizationAgent", message: "Diagram shows removed SynchronizationAgent" },
      { name: "shared-memory", message: "Diagram references deprecated shared-memory files" },
      { name: "ukb", message: "Diagram references deprecated ukb command" },
    ];

    for (const {name, message} of deprecatedComponents) {
      if (content.toLowerCase().includes(name.toLowerCase())) {
        issues.push({
          message,
          suggestion: `Regenerate diagram to reflect current architecture`
        });
      }
    }

    return issues;
  }

  private async findInsightDocument(entityName: string): Promise<string | null> {
    // Convert entity name to filename format (kebab-case)
    const filename = entityName
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/\s+/g, "-");

    const possiblePaths = [
      path.join(this.insightsDirectory, `${filename}.md`),
      path.join(this.insightsDirectory, `${filename}-insight.md`),
      path.join(this.insightsDirectory, entityName, `${filename}.md`),
    ];

    for (const p of possiblePaths) {
      const exists = await this.fileExists(p);
      if (exists) {
        return p;
      }
    }

    return null;
  }

  private calculateValidationScore(report: EntityValidationReport): number {
    // Start with 100 and deduct based on issues
    let score = 100;

    // Deduct for critical issues
    score -= report.criticalIssues * 10;

    // Deduct for non-critical issues
    const nonCritical = report.totalIssues - report.criticalIssues;
    score -= nonCritical * 3;

    // Deduct for suggested actions
    score -= report.suggestedActions.removeObservations.length * 5;
    score -= report.suggestedActions.regenerateDiagrams.length * 5;
    if (report.suggestedActions.refreshInsight) {
      score -= 10;
    }

    return Math.max(0, Math.min(100, score));
  }

  private generateRecommendations(report: EntityValidationReport): string[] {
    const recommendations: string[] = [];

    if (report.criticalIssues > 0) {
      recommendations.push(
        `CRITICAL: ${report.criticalIssues} critical issues found. Entity content may be significantly outdated.`
      );
    }

    if (report.suggestedActions.removeObservations.length > 0) {
      recommendations.push(
        `Remove ${report.suggestedActions.removeObservations.length} outdated observations that reference non-existent resources`
      );
    }

    if (report.suggestedActions.regenerateDiagrams.length > 0) {
      recommendations.push(
        `Regenerate ${report.suggestedActions.regenerateDiagrams.length} PlantUML diagrams with current architecture`
      );
    }

    if (report.suggestedActions.refreshInsight) {
      recommendations.push(
        `Re-generate insight document to reflect current codebase state`
      );
    }

    if (report.overallScore < 50) {
      recommendations.push(
        `Entity requires comprehensive refresh. Consider running 'entity-refresh' workflow.`
      );
    } else if (report.overallScore < 80) {
      recommendations.push(
        `Entity has moderate staleness. Review and update flagged items.`
      );
    }

    return recommendations;
  }

  /**
   * Refresh a stale entity by regenerating observations using LLM
   *
   * This method:
   * 1. Runs validation if not already provided
   * 2. Uses LLM to generate replacement observations for stale ones
   * 3. Calls PersistenceAgent.updateEntityObservations() to persist changes
   * 4. Returns refresh result with before/after comparison
   */
  async refreshStaleEntity(params: {
    entityName: string;
    team: string;
    validationReport?: EntityValidationReport;
    regenerateDiagrams?: boolean;
    regenerateInsight?: boolean;
  }): Promise<EntityRefreshResult> {
    const startTime = Date.now();
    log(`Starting entity refresh for: ${params.entityName}`, 'info', {
      team: params.team,
      hasExistingReport: !!params.validationReport
    });

    const result: EntityRefreshResult = {
      entityName: params.entityName,
      team: params.team,
      refreshedAt: new Date().toISOString(),
      validationBefore: params.validationReport || {
        entityName: params.entityName,
        team: params.team,
        validatedAt: '',
        overallValid: true,
        overallScore: 100,
        totalIssues: 0,
        criticalIssues: 0,
        observationValidations: [],
        recommendations: [],
        suggestedActions: {
          removeObservations: [],
          updateObservations: [],
          regenerateDiagrams: [],
          refreshInsight: false
        }
      },
      observationChanges: {
        removed: [],
        added: [],
        unchanged: 0
      },
      diagramsRegenerated: [],
      insightRefreshed: false,
      success: false
    };

    try {
      // Step 1: Run validation if not provided
      if (!params.validationReport) {
        log('Running validation for entity', 'info');
        result.validationBefore = await this.validateEntityAccuracy(params.entityName, params.team);
      }

      // Check if entity needs refresh (per design decision: any score < 100)
      if (result.validationBefore.overallScore >= 100) {
        log('Entity is already up-to-date, no refresh needed', 'info');
        result.success = true;
        return result;
      }

      // Step 2: Check if PersistenceAgent is available
      if (!this.persistenceAgent) {
        result.error = 'PersistenceAgent not set. Call setPersistenceAgent() first.';
        log(result.error, 'error');
        return result;
      }

      // Step 3: Load entity to get current observations
      const entity = await this.loadEntity(params.entityName, params.team);
      if (!entity) {
        result.error = `Entity '${params.entityName}' not found in team '${params.team}'`;
        log(result.error, 'error');
        return result;
      }

      // Step 4: Identify stale observations to remove
      const observationsToRemove = result.validationBefore.suggestedActions.removeObservations;
      const observationsToUpdate = result.validationBefore.suggestedActions.updateObservations;
      const allStaleObservations = [...observationsToRemove, ...observationsToUpdate];

      if (allStaleObservations.length === 0) {
        log('No stale observations found to refresh', 'info');
        result.success = true;
        return result;
      }

      log(`Found ${allStaleObservations.length} stale observations to refresh`, 'info');

      // Step 5: Use LLM to generate replacement observations
      const newObservations = await this.generateReplacementObservations(
        params.entityName,
        entity,
        allStaleObservations,
        result.validationBefore
      );

      log(`Generated ${newObservations.length} replacement observations`, 'info');

      // Step 6: Update entity through PersistenceAgent
      const updateResult = await this.persistenceAgent.updateEntityObservations({
        entityName: params.entityName,
        team: params.team,
        removeObservations: allStaleObservations,
        newObservations: newObservations
      });

      if (!updateResult.success) {
        result.error = `Failed to update entity: ${updateResult.details}`;
        log(result.error, 'error');
        return result;
      }

      result.observationChanges = {
        removed: allStaleObservations,
        added: newObservations.map(obs => typeof obs === 'string' ? obs : obs.content),
        unchanged: entity.observations.length - allStaleObservations.length
      };

      // Step 7: Re-validate to confirm improvements
      result.validationAfter = await this.validateEntityAccuracy(params.entityName, params.team);

      result.success = true;
      const duration = Date.now() - startTime;
      log(`Entity refresh completed successfully`, 'info', {
        entityName: params.entityName,
        scoreBefore: result.validationBefore.overallScore,
        scoreAfter: result.validationAfter.overallScore,
        observationsRemoved: result.observationChanges.removed.length,
        observationsAdded: result.observationChanges.added.length,
        durationMs: duration
      });

      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.error = `Entity refresh failed: ${errorMessage}`;
      log(result.error, 'error', error);
      return result;
    }
  }

  /**
   * Generate replacement observations for stale ones using LLM
   */
  private async generateReplacementObservations(
    entityName: string,
    entity: any,
    staleObservations: string[],
    validationReport: EntityValidationReport
  ): Promise<Array<{ type: string; content: string; date: string; metadata: Record<string, any> }>> {
    const newObservations: Array<{ type: string; content: string; date: string; metadata: Record<string, any> }> = [];

    // Build context from validation issues
    const issuesSummary = validationReport.observationValidations
      .filter(v => !v.isValid)
      .map(v => {
        const issues = v.issues.map(i => `- ${i.category}: ${i.message}`).join('\n');
        return `Observation: "${v.observation.substring(0, 100)}..."\nIssues:\n${issues}`;
      })
      .join('\n\n');

    // Get current architecture context from the codebase
    const contextPrompt = `You are analyzing a knowledge entity named "${entityName}" that has stale observations.

The entity type is: ${entity.entityType || 'Unknown'}
Current entity tags: ${(entity.tags || []).join(', ')}

The following observations were flagged as stale with these issues:
${issuesSummary}

Original stale observations:
${staleObservations.map((obs, i) => `${i + 1}. ${obs}`).join('\n')}

Based on modern software architecture patterns and the issues identified, generate replacement observations that:
1. Remove references to deprecated commands (like 'ukb' - replace with 'mcp__semantic-analysis__execute_workflow')
2. Remove references to non-existent files or paths
3. Update component names to reflect current architecture
4. Keep the semantic meaning and insights intact while correcting technical details

Respond with a JSON array of observations in this format:
[
  {
    "type": "insight|implementation|architecture|pattern|learning",
    "content": "The updated observation content",
    "confidence": 0.0-1.0
  }
]

Generate exactly ${staleObservations.length} replacement observations.`;

    try {
      const result = await this.semanticAnalyzer.analyzeContent(contextPrompt, {
        analysisType: 'general',
        provider: 'auto'
      });

      // Parse LLM response
      let parsedObservations: Array<{ type: string; content: string; confidence: number }> = [];
      try {
        // Try to extract JSON from the response
        const jsonMatch = result.insights.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          parsedObservations = JSON.parse(jsonMatch[0]);
        }
      } catch (parseError) {
        log('Failed to parse LLM response as JSON, using fallback', 'warning', parseError);
      }

      const now = new Date().toISOString();

      if (parsedObservations.length > 0) {
        for (const obs of parsedObservations) {
          newObservations.push({
            type: obs.type || 'insight',
            content: obs.content,
            date: now,
            metadata: {
              confidence: obs.confidence || 0.7,
              refreshedAt: now,
              source: 'llm-refresh',
              originallyStale: true
            }
          });
        }
      } else {
        // Fallback: Create minimal replacement observations
        log('Using fallback observation generation', 'warning');
        for (const staleObs of staleObservations) {
          // Simple cleanup: remove known deprecated patterns
          let cleaned = staleObs
            .replace(/\bukb\b/gi, 'semantic-analysis workflow')
            .replace(/\.ukb\//g, '.data/knowledge-')
            .replace(/shared-memory\.json/g, 'knowledge-graph database');

          newObservations.push({
            type: 'insight',
            content: cleaned,
            date: now,
            metadata: {
              confidence: 0.5,
              refreshedAt: now,
              source: 'pattern-replacement',
              originallyStale: true
            }
          });
        }
      }

      return newObservations;

    } catch (error) {
      log('LLM observation generation failed, using pattern-based fallback', 'error', error);

      // Fallback: Pattern-based replacement
      const now = new Date().toISOString();
      for (const staleObs of staleObservations) {
        let cleaned = staleObs
          .replace(/\bukb\b/gi, 'semantic-analysis workflow')
          .replace(/\.ukb\//g, '.data/knowledge-')
          .replace(/shared-memory\.json/g, 'knowledge-graph database');

        newObservations.push({
          type: 'insight',
          content: cleaned,
          date: now,
          metadata: {
            confidence: 0.4,
            refreshedAt: now,
            source: 'pattern-replacement-fallback',
            originallyStale: true
          }
        });
      }

      return newObservations;
    }
  }

  /**
   * Refresh all stale entities in a team or globally
   *
   * This method:
   * 1. Validates all entities in scope
   * 2. Identifies entities with score < 100 (per design decision)
   * 3. Optionally shows a preview (dryRun mode)
   * 4. Refreshes each stale entity sequentially
   */
  async refreshAllStaleEntities(params: {
    team?: string;           // Optional: specific team, or all teams if not provided
    scoreThreshold?: number; // Default: 100 (any issue triggers refresh per design decision)
    dryRun?: boolean;        // Preview mode - don't make changes
    maxEntities?: number;    // Limit for safety (default: 50)
  }): Promise<{
    dryRun: boolean;
    entitiesScanned: number;
    entitiesNeedingRefresh: number;
    entitiesRefreshed: number;
    entitiesFailed: number;
    results: EntityRefreshResult[];
    summary: string;
    confirmationRequired?: {
      entitiesAffected: Array<{ name: string; currentScore: number; issues: number }>;
      message: string;
    };
  }> {
    const scoreThreshold = params.scoreThreshold ?? 100;
    const maxEntities = params.maxEntities ?? 50;
    const dryRun = params.dryRun ?? false;

    log(`Starting batch entity refresh`, 'info', {
      team: params.team || 'all',
      scoreThreshold,
      dryRun,
      maxEntities
    });

    const batchResult = {
      dryRun,
      entitiesScanned: 0,
      entitiesNeedingRefresh: 0,
      entitiesRefreshed: 0,
      entitiesFailed: 0,
      results: [] as EntityRefreshResult[],
      summary: '',
      confirmationRequired: undefined as {
        entitiesAffected: Array<{ name: string; currentScore: number; issues: number }>;
        message: string;
      } | undefined
    };

    try {
      // Step 1: Get all entities from the graph database
      if (!this.graphDB) {
        batchResult.summary = 'GraphDB not set. Call setGraphDB() first.';
        log(batchResult.summary, 'error');
        return batchResult;
      }

      let entities: any[] = [];
      try {
        // Query all entities, optionally filtered by team
        const queryParams = params.team
          ? { namePattern: '.*', team: params.team }
          : { namePattern: '.*' };

        entities = await this.graphDB.queryEntities(queryParams);
      } catch (error) {
        // Fallback: try loading from shared memory export
        log('GraphDB query failed, trying shared memory fallback', 'warning', error);
        const entity = await this.loadEntity('*', params.team || 'coding');
        if (entity) {
          entities = [entity];
        }
      }

      batchResult.entitiesScanned = entities.length;
      log(`Found ${entities.length} entities to scan`, 'info');

      // Step 2: Validate each entity and collect stale ones
      const staleEntities: Array<{
        entity: any;
        validationReport: EntityValidationReport;
      }> = [];

      for (const entity of entities) {
        const entityName = entity.name || entity.entityName;
        const entityTeam = entity.team || params.team || 'coding';

        try {
          const report = await this.validateEntityAccuracy(entityName, entityTeam);

          if (report.overallScore < scoreThreshold) {
            staleEntities.push({ entity, validationReport: report });

            if (staleEntities.length >= maxEntities) {
              log(`Reached max entities limit (${maxEntities})`, 'warning');
              break;
            }
          }
        } catch (error) {
          log(`Failed to validate entity ${entityName}`, 'warning', error);
        }
      }

      batchResult.entitiesNeedingRefresh = staleEntities.length;
      log(`Found ${staleEntities.length} stale entities`, 'info');

      // Step 3: In dryRun mode, return confirmation required
      if (dryRun || staleEntities.length > 0) {
        batchResult.confirmationRequired = {
          entitiesAffected: staleEntities.map(({ entity, validationReport }) => ({
            name: entity.name || entity.entityName,
            currentScore: validationReport.overallScore,
            issues: validationReport.totalIssues
          })),
          message: `Found ${staleEntities.length} entities with validation score below ${scoreThreshold}. ${dryRun ? 'This is a dry run - no changes will be made.' : 'Proceed with refresh?'}`
        };

        if (dryRun) {
          batchResult.summary = `Dry run complete. ${staleEntities.length} entities would be refreshed out of ${entities.length} scanned.`;
          return batchResult;
        }
      }

      // Step 4: Refresh each stale entity
      for (const { entity, validationReport } of staleEntities) {
        const entityName = entity.name || entity.entityName;
        const entityTeam = entity.team || params.team || 'coding';

        try {
          const refreshResult = await this.refreshStaleEntity({
            entityName,
            team: entityTeam,
            validationReport
          });

          batchResult.results.push(refreshResult);

          if (refreshResult.success) {
            batchResult.entitiesRefreshed++;
          } else {
            batchResult.entitiesFailed++;
          }
        } catch (error) {
          log(`Failed to refresh entity ${entityName}`, 'error', error);
          batchResult.entitiesFailed++;
          batchResult.results.push({
            entityName,
            team: entityTeam,
            refreshedAt: new Date().toISOString(),
            validationBefore: validationReport,
            observationChanges: { removed: [], added: [], unchanged: 0 },
            diagramsRegenerated: [],
            insightRefreshed: false,
            success: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      // Step 5: Generate summary
      const avgScoreBefore = staleEntities.length > 0
        ? Math.round(staleEntities.reduce((sum, e) => sum + e.validationReport.overallScore, 0) / staleEntities.length)
        : 100;

      const successfulRefreshes = batchResult.results.filter(r => r.success && r.validationAfter);
      const avgScoreAfter = successfulRefreshes.length > 0
        ? Math.round(successfulRefreshes.reduce((sum, r) => sum + (r.validationAfter?.overallScore || 0), 0) / successfulRefreshes.length)
        : avgScoreBefore;

      batchResult.summary = `Batch refresh complete. Scanned: ${batchResult.entitiesScanned}, Needed refresh: ${batchResult.entitiesNeedingRefresh}, Refreshed: ${batchResult.entitiesRefreshed}, Failed: ${batchResult.entitiesFailed}. Average score: ${avgScoreBefore} → ${avgScoreAfter}`;

      log(batchResult.summary, 'info');
      return batchResult;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      batchResult.summary = `Batch refresh failed: ${errorMessage}`;
      log(batchResult.summary, 'error', error);
      return batchResult;
    }
  }
}

// Export default instance factory
export function createContentValidationAgent(
  config?: Partial<ContentValidationAgentConfig>
): ContentValidationAgent {
  return new ContentValidationAgent(config);
}
