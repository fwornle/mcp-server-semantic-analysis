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
import * as path from "path";
import { GraphDatabaseAdapter } from "../storage/graph-database-adapter.js";

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

export class ContentValidationAgent {
  private repositoryPath: string;
  private insightsDirectory: string;
  private enableDeepValidation: boolean;
  private stalenessThresholdDays: number;
  private graphDB: GraphDatabaseAdapter | null = null;

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
      const insightPath = this.findInsightDocument(entityName);
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
   */
  async validateObservations(observations: string[]): Promise<ObservationValidation[]> {
    const validations: ObservationValidation[] = [];

    for (const observation of observations) {
      const validation: ObservationValidation = {
        observation,
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
      validation.extractedReferences.files = this.extractFileReferences(observation);

      // Extract command references
      validation.extractedReferences.commands = this.extractCommandReferences(observation);

      // Extract component references
      validation.extractedReferences.components = this.extractComponentReferences(observation);

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
      if (!fs.existsSync(insightPath)) {
        validation.isValid = false;
        validation.issues.push({
          type: "error",
          category: "file_reference",
          message: "Insight document does not exist",
          reference: insightPath
        });
        return validation;
      }

      const content = fs.readFileSync(insightPath, "utf-8");

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
      // Check if .puml file exists
      const pumlPath = diagramPath.replace(/\.png$/, ".puml");
      if (!fs.existsSync(pumlPath) && !fs.existsSync(diagramPath)) {
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

      const diagramContent = fs.existsSync(pumlPath)
        ? fs.readFileSync(pumlPath, "utf-8")
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
    // In practice, this would query the graph database
    // For now, we'll read from the shared memory file
    const sharedMemoryPath = path.join(
      this.repositoryPath,
      `shared-memory-${team}.json`
    );

    try {
      if (fs.existsSync(sharedMemoryPath)) {
        const content = JSON.parse(fs.readFileSync(sharedMemoryPath, "utf-8"));
        return content.entities?.find((e: any) => e.name === entityName);
      }
    } catch (error) {
      log(`Error loading entity from shared memory`, "error", error);
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
    return fs.existsSync(fullPath);
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

    return fs.existsSync(binPath) || fs.existsSync(scriptsPath);
  }

  private async componentExists(componentName: string): Promise<boolean> {
    // Search for the component in known directories
    try {
      const searchDirs = ['src', 'lib', 'scripts', 'integrations'];
      const classPattern = `class ${componentName}`;

      for (const dir of searchDirs) {
        const dirPath = path.join(this.repositoryPath, dir);
        if (!fs.existsSync(dirPath)) continue;

        // Check if a file with the component name exists
        const componentFile = path.join(dirPath, `${componentName.toLowerCase()}.ts`);
        const componentFileJs = path.join(dirPath, `${componentName.toLowerCase()}.js`);

        if (fs.existsSync(componentFile) || fs.existsSync(componentFileJs)) {
          return true;
        }

        // Recursively search for class definition in immediate .ts/.js files
        const files = this.findFilesInDir(dirPath, ['.ts', '.js'], 2);
        for (const file of files.slice(0, 50)) { // Limit search
          try {
            const content = fs.readFileSync(file, "utf-8");
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
   * Simple recursive file finder (limited depth)
   */
  private findFilesInDir(dir: string, extensions: string[], maxDepth: number, currentDepth: number = 0): string[] {
    if (currentDepth > maxDepth) return [];

    const files: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Skip node_modules, dist, .git
          if (['node_modules', 'dist', '.git', '.data'].includes(entry.name)) continue;
          files.push(...this.findFilesInDir(fullPath, extensions, maxDepth, currentDepth + 1));
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (extensions.includes(ext)) {
            files.push(fullPath);
          }
        }
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

  private findInsightDocument(entityName: string): string | null {
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
      if (fs.existsSync(p)) {
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
}

// Export default instance factory
export function createContentValidationAgent(
  config?: Partial<ContentValidationAgentConfig>
): ContentValidationAgent {
  return new ContentValidationAgent(config);
}
