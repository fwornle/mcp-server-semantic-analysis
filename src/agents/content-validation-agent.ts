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
import type { InsightGenerationAgent } from "./insight-generation-agent.js";
import { GitHistoryAgent } from "./git-history-agent.js";
import { VibeHistoryAgent } from "./vibe-history-agent.js";
import { GitStalenessDetector, CommitEntityCorrelation } from "./git-staleness-detector.js";

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
  // Git-based staleness detection results
  gitStaleness?: {
    isStale: boolean;
    invalidatingCommits: string[];
    correlations: CommitEntityCorrelation[];
    stalenessScore: number;
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
  useGitBasedDetection?: boolean; // Use git commit history for staleness detection (default: true)
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
  private insightGenerationAgent: InsightGenerationAgent | null = null;
  private gitHistoryAgent: GitHistoryAgent | null = null;
  private vibeHistoryAgent: VibeHistoryAgent | null = null;
  private gitStalenessDetector: GitStalenessDetector | null = null;
  private useGitBasedDetection: boolean;

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
      path.join(this.repositoryPath, "knowledge-management", "insights");
    this.enableDeepValidation = config?.enableDeepValidation ?? true;
    this.stalenessThresholdDays = config?.stalenessThresholdDays ?? 30;
    this.useGitBasedDetection = config?.useGitBasedDetection ?? true;
    this.semanticAnalyzer = new SemanticAnalyzer();

    // Initialize GitStalenessDetector for git-based staleness detection
    if (this.useGitBasedDetection) {
      this.gitStalenessDetector = new GitStalenessDetector();
    }

    log(`ContentValidationAgent initialized`, "info", {
      repositoryPath: this.repositoryPath,
      insightsDirectory: this.insightsDirectory,
      enableDeepValidation: this.enableDeepValidation,
      useGitBasedDetection: this.useGitBasedDetection
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
   * Set the InsightGenerationAgent for regenerating insights during entity refresh
   */
  setInsightGenerationAgent(insightGenerationAgent: InsightGenerationAgent): void {
    this.insightGenerationAgent = insightGenerationAgent;
    log('InsightGenerationAgent set for ContentValidationAgent', 'info');
  }

  /**
   * Initialize analysis agents for entity refresh operations
   * Creates GitHistoryAgent and VibeHistoryAgent for running fresh analysis
   */
  initializeAnalysisAgents(): void {
    if (!this.gitHistoryAgent) {
      this.gitHistoryAgent = new GitHistoryAgent(this.repositoryPath);
    }
    if (!this.vibeHistoryAgent) {
      this.vibeHistoryAgent = new VibeHistoryAgent(this.repositoryPath);
    }
    log('Analysis agents initialized for entity refresh', 'info');
  }

  /**
   * Detect entity staleness using git commit history
   * Uses three-tier matching: file-path, topic/embedding, and LLM correlation
   * @param entity - The entity to check for staleness
   * @param team - The team/project namespace
   * @returns Array of commit-entity correlations indicating staleness
   */
  async detectEntityGitStaleness(
    entity: { name: string; entityType?: string; observations?: any[]; metadata?: any },
    team: string
  ): Promise<{
    isStale: boolean;
    correlations: CommitEntityCorrelation[];
    stalenessScore: number; // 0-100, 100 = fresh
    invalidatingCommits: string[];
  }> {
    // Default result - entity is fresh
    const result = {
      isStale: false,
      correlations: [] as CommitEntityCorrelation[],
      stalenessScore: 100,
      invalidatingCommits: [] as string[],
    };

    if (!this.useGitBasedDetection || !this.gitStalenessDetector) {
      log(`Git-based detection disabled, skipping`, 'debug', { entityName: entity.name });
      return result;
    }

    // Initialize git history agent if not already done
    if (!this.gitHistoryAgent) {
      this.gitHistoryAgent = new GitHistoryAgent(this.repositoryPath);
    }

    try {
      // Get entity's last_updated timestamp
      const entityLastUpdated = entity.metadata?.last_updated
        ? new Date(entity.metadata.last_updated)
        : null;

      if (!entityLastUpdated) {
        log(`Entity has no last_updated timestamp, treating as potentially stale`, 'debug', {
          entityName: entity.name
        });
        // If no timestamp, check recent commits (last 30 days by default)
        const sinceDate = new Date();
        sinceDate.setDate(sinceDate.getDate() - this.stalenessThresholdDays);
      }

      // Get commits since entity was last updated (or last 30 days if no timestamp)
      const sinceDate = entityLastUpdated || new Date(Date.now() - this.stalenessThresholdDays * 24 * 60 * 60 * 1000);

      // Use analyzeGitHistory to get commits - returns full analysis including commits array
      const analysisResult = await this.gitHistoryAgent.analyzeGitHistory({
        fromTimestamp: sinceDate.toISOString(),
        checkpoint_enabled: false // Don't use checkpoints for staleness detection
      });
      const commits = analysisResult.commits;

      if (commits.length === 0) {
        log(`No commits since entity last updated`, 'debug', {
          entityName: entity.name,
          lastUpdated: entityLastUpdated?.toISOString()
        });
        return result;
      }

      log(`Checking ${commits.length} commits against entity`, 'debug', {
        entityName: entity.name,
        sinceDate: sinceDate.toISOString()
      });

      // Convert entity format for GitStalenessDetector
      const graphEntity = {
        name: entity.name,
        entityType: entity.entityType,
        observations: entity.observations,
        metadata: entity.metadata
      };

      // Detect staleness using three-tier matching
      const correlations = await this.gitStalenessDetector.detectStaleness(commits, [graphEntity]);

      // Filter for correlations related to this entity that indicate staleness
      const relevantCorrelations = correlations.filter(
        c => c.entityName === entity.name && c.isStale
      );

      if (relevantCorrelations.length > 0) {
        result.isStale = true;
        result.correlations = relevantCorrelations;
        result.invalidatingCommits = relevantCorrelations.map(c => c.commitHash);

        // Calculate staleness score based on correlation relevance scores
        // Higher relevance = lower freshness score
        const avgRelevance = relevantCorrelations.reduce((sum, c) => sum + c.relevanceScore, 0) / relevantCorrelations.length;
        result.stalenessScore = Math.round((1 - avgRelevance) * 100);

        log(`Entity detected as stale via git analysis`, 'info', {
          entityName: entity.name,
          invalidatingCommits: result.invalidatingCommits.length,
          stalenessScore: result.stalenessScore,
          topMethod: relevantCorrelations[0]?.matchMethod
        });
      }

      return result;
    } catch (error) {
      log(`Error during git-based staleness detection`, 'error', { entityName: entity.name, error });
      // On error, return fresh status to avoid false positives
      return result;
    }
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
    log('Starting stale entity validation (git-based detection)', 'info', params);

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
        log(`Checking ${entities.length} entities for staleness via git-based detection`, 'info');
      }

      // Process entities in batches with event loop yields to prevent blocking
      const BATCH_SIZE = 10;
      let processedCount = 0;
      const team = 'coding';

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

        // Use git-based staleness detection (primary mechanism)
        if (this.useGitBasedDetection) {
          const gitStaleness = await this.detectEntityGitStaleness(entity, team);

          if (gitStaleness.isStale) {
            // Determine staleness severity based on score
            if (gitStaleness.stalenessScore < 40) {
              staleness = 'critical';
            } else if (gitStaleness.stalenessScore < 70) {
              staleness = 'moderate';
            }
            score = gitStaleness.stalenessScore;

            // Add issues from git-based detection
            for (const correlation of gitStaleness.correlations) {
              issues.push({
                type: staleness === 'critical' ? 'error' : 'warning',
                category: 'observation_staleness',
                message: `Entity may be outdated: commit ${correlation.commitHash.substring(0, 8)} (${correlation.matchMethod})`,
                reference: correlation.commitMessage.substring(0, 100),
                suggestion: `Review entity against recent changes: ${correlation.matchDetails?.substring(0, 80) || 'N/A'}`
              });
            }
          }
        }

        // Also validate file references in observations (still useful regardless of git-based detection)
        for (const observation of observations) {
          const obsText = typeof observation === 'string' ? observation : observation.content || '';
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

          // Determine action - NOTE: We now mark for review rather than auto-delete
          // Git-based detection may have false positives, so manual review is preferred
          if (staleness === 'critical') {
            result.refreshActions.push({
              entityName,
              action: 'manual_review_required',
              reason: `Git-based staleness detected: ${issues.length} relevant commits found. Review before making changes.`
            });
          }
        }
      }

      // Generate summary
      result.summary = this.generateStalenessSummary(result);

      log('Stale entity validation complete (git-based)', 'info', {
        totalChecked: result.totalEntitiesChecked,
        staleFound: result.staleEntitiesFound,
        critical: result.criticalStaleEntities,
        method: 'git-based-detection'
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

      // Git-based staleness detection (primary mechanism)
      if (this.useGitBasedDetection) {
        const gitStaleness = await this.detectEntityGitStaleness(entity, team);
        report.gitStaleness = gitStaleness;

        if (gitStaleness.isStale) {
          report.overallValid = false;
          report.totalIssues += gitStaleness.invalidatingCommits.length;
          report.criticalIssues += 1; // Git-based staleness is critical

          // Add recommendation with specific commit info
          const commitCount = gitStaleness.invalidatingCommits.length;
          const topCorrelation = gitStaleness.correlations[0];
          report.recommendations.push(
            `Entity may be outdated: ${commitCount} commit(s) since last update may affect this entity. ` +
            `Top match via ${topCorrelation?.matchMethod}: ${topCorrelation?.matchDetails?.substring(0, 100) || 'N/A'}`
          );
        }
      }

      // Validate observations (file/command/component references)
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
      } else {
        // Check if entity should have an insight document (non-trivial entities)
        const requiresInsight = this.entityRequiresInsightDocument(entityName, entity);
        if (requiresInsight) {
          report.overallValid = false;
          report.totalIssues += 1;
          report.criticalIssues += 1;
          report.suggestedActions.refreshInsight = true;
          report.recommendations.push(
            `Entity '${entityName}' is non-trivial but missing insight document. ` +
            `Expected at: knowledge-management/insights/${entityName}.md`
          );
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

      // NOTE: Pattern-based staleness detection removed in favor of git-based detection
      // Git-based detection is more accurate and self-maintaining (see detectEntityGitStaleness)

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
        // Use searchTerm for name matching (namePattern not supported by VKB API)
        const entities = await this.graphDB.queryEntities({
          searchTerm: entityName
        });
        // Find exact match and normalize field names
        const exactMatch = entities?.find((e: any) =>
          (e.name || e.entity_name) === entityName
        );
        if (exactMatch) {
          // Normalize API field names (entity_name/entity_type -> name/entityType)
          return {
            name: exactMatch.name || exactMatch.entity_name,
            entityType: exactMatch.entityType || exactMatch.entity_type,
            observations: exactMatch.observations || [],
            significance: exactMatch.significance,
            relationships: exactMatch.relationships || [],
            metadata: {
              ...exactMatch.metadata,
              source: exactMatch.source,
              team: exactMatch.team || team,
              created_at: exactMatch.created_at || exactMatch.extracted_at,
              last_updated: exactMatch.last_modified || exactMatch.last_updated
            }
          };
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

    // Known outdated patterns - comprehensive list
    const outdatedPatterns = [
      {
        pattern: /\bu[kK][bB]\b/gi,
        message: "References deprecated 'ukb' command",
        suggestion: "Use MCP semantic-analysis execute_workflow with 'incremental-analysis'"
      },
      {
        pattern: /`u[kK][bB]`/gi,
        message: "References deprecated command in code block",
        suggestion: "Use MCP semantic-analysis execute_workflow"
      },
      {
        pattern: /shared-memory\.json/gi,
        message: "References shared-memory.json (deprecated)",
        suggestion: "Use GraphDB persistence via MCP tools"
      },
      {
        pattern: /shared-memory-\w+\.json/gi,
        message: "References shared-memory JSON files (deprecated)",
        suggestion: "Update to reference Graphology + LevelDB storage"
      },
      {
        pattern: /SynchronizationAgent/gi,
        message: "References SynchronizationAgent (removed)",
        suggestion: "Use GraphDatabaseAdapter for persistence"
      },
      {
        pattern: /json-based.*persistence/gi,
        message: "References JSON-based persistence (deprecated)",
        suggestion: "Update to reference graph database persistence"
      },
      {
        pattern: /existing\s+shared-memory/gi,
        message: "References existing shared-memory format (deprecated)",
        suggestion: "Update to reference GraphDB + JSON export sync"
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
    const kebabFilename = entityName
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/\s+/g, "-");

    // Check multiple naming conventions for insight documents
    const possiblePaths = [
      // PascalCase (common for patterns/entities)
      path.join(this.insightsDirectory, `${entityName}.md`),
      // kebab-case
      path.join(this.insightsDirectory, `${kebabFilename}.md`),
      path.join(this.insightsDirectory, `${kebabFilename}-insight.md`),
      // Subdirectory variants
      path.join(this.insightsDirectory, entityName, `${kebabFilename}.md`),
      path.join(this.insightsDirectory, entityName, `${entityName}.md`),
    ];

    for (const p of possiblePaths) {
      const exists = await this.fileExists(p);
      if (exists) {
        return p;
      }
    }

    return null;
  }

  /**
   * Determine if an entity is non-trivial and should have an insight document.
   *
   * Non-trivial entities are those with:
   * - EntityType containing "Pattern", "Workflow", "Architecture", "System"
   * - Multiple observations (3+)
   * - Observations with architectural/design content
   */
  private entityRequiresInsightDocument(entityName: string, entity: any): boolean {
    // Entity types that typically require insight documents
    const significantTypePatterns = [
      /pattern/i,
      /workflow/i,
      /architecture/i,
      /system/i,
      /integration/i,
    ];

    const entityType = entity?.entityType || entity?.type || '';
    const hasSignificantType = significantTypePatterns.some(p => p.test(entityType));

    // Check entity name for significance indicators
    const hasSignificantName = significantTypePatterns.some(p => p.test(entityName));

    // Check observation count - entities with many observations are non-trivial
    const observations = entity?.observations || [];
    const hasMultipleObservations = observations.length >= 3;

    // Check observation content for architectural keywords
    const architecturalKeywords = [
      'architecture', 'pattern', 'design', 'implementation',
      'workflow', 'integration', 'system', 'component',
      'layer', 'module', 'service', 'agent'
    ];

    const hasArchitecturalContent = observations.some((obs: any) => {
      const text = typeof obs === 'string' ? obs : (obs.content || '');
      return architecturalKeywords.some(keyword =>
        text.toLowerCase().includes(keyword)
      );
    });

    // Entity requires insight if it's significant type/name OR has substantial content
    return (hasSignificantType || hasSignificantName) ||
           (hasMultipleObservations && hasArchitecturalContent);
  }

  private calculateValidationScore(report: EntityValidationReport): number {
    // Start with 100 and deduct based on issues
    let score = 100;

    // Git-based staleness has significant weight (primary detection mechanism)
    if (report.gitStaleness?.isStale) {
      // Use the staleness score directly (0-100, lower = more stale)
      // Weight it at 40% of total score
      const gitPenalty = (100 - report.gitStaleness.stalenessScore) * 0.4;
      score -= gitPenalty;
    }

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
    forceFullRefresh?: boolean;
  }): Promise<EntityRefreshResult> {
    const startTime = Date.now();
    log(`Starting entity refresh for: ${params.entityName}`, 'info', {
      team: params.team,
      hasExistingReport: !!params.validationReport,
      forceFullRefresh: params.forceFullRefresh
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
      // Step 1: Run validation if not provided (skip for force full refresh)
      if (!params.validationReport && !params.forceFullRefresh) {
        log('Running validation for entity', 'info');
        result.validationBefore = await this.validateEntityAccuracy(params.entityName, params.team);
      }

      // Check if entity needs refresh (per design decision: any score < 100)
      // Skip this check entirely when forceFullRefresh is true
      if (!params.forceFullRefresh && result.validationBefore.overallScore >= 100) {
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
      let allStaleObservations: string[] = [];

      // FORCE FULL REFRESH: Treat ALL observations as stale, regenerate from scratch
      if (params.forceFullRefresh) {
        log('Force full refresh - treating ALL observations as stale for complete regeneration', 'info', {
          entityName: params.entityName,
          observationCount: entity.observations?.length || 0
        });

        // Mark artificial score to indicate full refresh
        result.validationBefore.overallScore = 0;
        result.validationBefore.overallValid = false;

        // Force insight refresh when doing full refresh
        result.validationBefore.suggestedActions.refreshInsight = true;

        // Extract all current observations as stale
        allStaleObservations = (entity.observations || []).map((obs: string | { type?: string; content?: string }) =>
          typeof obs === 'string' ? obs : (obs.content || JSON.stringify(obs))
        );
      } else {
        // Normal mode: Check explicit stale observations from validation
        const observationsToRemove = result.validationBefore.suggestedActions.removeObservations;
        const observationsToUpdate = result.validationBefore.suggestedActions.updateObservations;
        allStaleObservations = [...observationsToRemove, ...observationsToUpdate];

        // If git-based staleness is detected but no specific observations flagged,
        // treat ALL observations as stale since the entity's context has changed
        if (allStaleObservations.length === 0 && result.validationBefore.gitStaleness?.isStale) {
          log('Git staleness detected - treating all observations as stale for regeneration', 'info', {
            stalenessScore: result.validationBefore.gitStaleness.stalenessScore,
            invalidatingCommits: result.validationBefore.gitStaleness.invalidatingCommits.length
          });

          // Extract all current observations as stale
          allStaleObservations = (entity.observations || []).map((obs: string | { type?: string; content?: string }) =>
            typeof obs === 'string' ? obs : (obs.content || JSON.stringify(obs))
          );
        }
      }

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

      // Step 6.5: Generate/refresh insight document and diagrams if needed
      const shouldRefreshInsight = params.forceFullRefresh ||
        params.regenerateInsight ||
        result.validationBefore.suggestedActions.refreshInsight;

      const shouldRegenerateDiagrams = params.forceFullRefresh ||
        params.regenerateDiagrams ||
        (result.validationBefore.suggestedActions.regenerateDiagrams?.length || 0) > 0;

      // Check if entity requires insight document (non-trivial entities)
      const requiresInsight = this.entityRequiresInsightDocument(params.entityName, entity);

      if ((shouldRefreshInsight || shouldRegenerateDiagrams) && requiresInsight) {
        log('Processing insight document and diagrams', 'info', {
          shouldRefreshInsight,
          shouldRegenerateDiagrams,
          requiresInsight
        });

        try {
          // Initialize InsightGenerationAgent if not already set
          if (!this.insightGenerationAgent) {
            const { InsightGenerationAgent } = await import('./insight-generation-agent.js');
            this.insightGenerationAgent = new InsightGenerationAgent(this.repositoryPath);
          }

          // Build current analysis context for insight generation
          const currentAnalysis = await this.buildInsightAnalysisContext(params.entityName, entity, newObservations);

          // Call refreshEntityInsights with proper parameters
          const insightResult = await this.insightGenerationAgent.refreshEntityInsights({
            validation_report: result.validationBefore,
            current_analysis: currentAnalysis,
            entityName: params.entityName,
            regenerate_diagrams: shouldRegenerateDiagrams
          });

          if (insightResult.success) {
            result.diagramsRegenerated = insightResult.regeneratedDiagrams;
            result.insightRefreshed = !!insightResult.refreshedInsightPath;

            // Add insight path as observation if it was generated
            if (insightResult.refreshedInsightPath) {
              // Convert absolute path to relative path for frontend compatibility
              // The VKB server serves /knowledge-management/* routes from the coding root
              const relativePath = insightResult.refreshedInsightPath.startsWith(this.repositoryPath)
                ? insightResult.refreshedInsightPath.slice(this.repositoryPath.length + 1) // +1 for trailing slash
                : insightResult.refreshedInsightPath;

              const insightObservation = {
                type: 'insight-document',
                content: `Detailed insight document available at: ${relativePath}`,
                date: new Date().toISOString(),
                metadata: {
                  insightPath: relativePath,
                  absolutePath: insightResult.refreshedInsightPath, // Keep absolute for debugging
                  diagramsGenerated: insightResult.regeneratedDiagrams.length,
                  generatedBy: 'entity-refresh'
                }
              };

              // Add the insight observation to the entity
              await this.persistenceAgent.updateEntityObservations({
                entityName: params.entityName,
                team: params.team,
                removeObservations: [],
                newObservations: [insightObservation]
              });

              result.observationChanges.added.push(insightObservation.content);
            }

            log('Insight document and diagrams processed', 'info', {
              insightPath: insightResult.refreshedInsightPath,
              diagramsRegenerated: insightResult.regeneratedDiagrams.length
            });
          } else {
            log('Insight refresh completed with issues', 'warning', {
              summary: insightResult.summary
            });
          }
        } catch (insightError) {
          // Don't fail the entire refresh if insight generation fails
          log('Insight/diagram generation failed (non-fatal)', 'warning', insightError);
        }
      }

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
   * Generate replacement observations by running ACTUAL CODEBASE ANALYSIS
   *
   * This method runs the full analysis pipeline to understand the current
   * state of the codebase, then generates accurate observations based on
   * real data - NOT by asking an LLM to guess.
   *
   * Analysis steps:
   * 1. Run git history analysis for relevant commits
   * 2. Run vibe/LSL history analysis for relevant conversations
   * 3. Scan codebase for actual file paths, commands, and components
   * 4. Generate observations from verified codebase facts
   */
  private async generateReplacementObservations(
    entityName: string,
    entity: any,
    staleObservations: string[],
    validationReport: EntityValidationReport
  ): Promise<Array<{ type: string; content: string; date: string; metadata: Record<string, any> }>> {
    const newObservations: Array<{ type: string; content: string; date: string; metadata: Record<string, any> }> = [];
    const now = new Date().toISOString();

    log(`Running FULL CODEBASE ANALYSIS for entity refresh: ${entityName}`, 'info', {
      staleObservationsCount: staleObservations.length
    });

    try {
      // Initialize analysis agents if not already done
      this.initializeAnalysisAgents();

      // Step 1: Extract search terms from entity name and existing observations
      const searchTerms = this.extractSearchTerms(entityName, entity, staleObservations);
      log('Extracted search terms for analysis', 'debug', { searchTerms });

      // Step 2: Run git history analysis to find relevant recent commits
      let gitAnalysisResults: any = null;
      if (this.gitHistoryAgent) {
        try {
          // Analyze commits from the last 90 days
          gitAnalysisResults = await this.gitHistoryAgent.analyzeGitHistory({
            incremental: false, // Full analysis for entity refresh
            days: 90
          });
          log('Git analysis completed', 'info', {
            commitsAnalyzed: gitAnalysisResults?.commits?.length || 0
          });
        } catch (gitError) {
          log('Git analysis failed, continuing with other sources', 'warning', gitError);
        }
      }

      // Step 3: Run vibe/LSL history analysis for relevant conversations
      let vibeAnalysisResults: any = null;
      if (this.vibeHistoryAgent) {
        try {
          vibeAnalysisResults = await this.vibeHistoryAgent.analyzeVibeHistory({
            incremental: false, // Full analysis for entity refresh
            days: 90
          });
          log('Vibe history analysis completed', 'info', {
            sessionsAnalyzed: vibeAnalysisResults?.sessions?.length || 0
          });
        } catch (vibeError) {
          log('Vibe analysis failed, continuing with other sources', 'warning', vibeError);
        }
      }

      // Step 4: Scan codebase for current state - VERIFY what actually exists
      const codebaseState = await this.scanCodebaseForEntityReferences(entityName, searchTerms);
      log('Codebase scan completed', 'info', {
        existingFiles: codebaseState.existingFiles.length,
        existingCommands: codebaseState.existingCommands.length,
        existingComponents: codebaseState.existingComponents.length
      });

      // Step 5: Build comprehensive context from REAL analysis data
      const analysisContext = this.buildAnalysisContext(
        entityName,
        entity,
        staleObservations,
        validationReport,
        gitAnalysisResults,
        vibeAnalysisResults,
        codebaseState
      );

      // Step 6: Generate observations using LLM but with REAL codebase facts
      const contextPrompt = `You are generating ACCURATE observations for the knowledge entity "${entityName}".

CRITICAL: You must ONLY generate observations based on the VERIFIED CODEBASE STATE provided below.
DO NOT invent or assume any technical details that are not in the provided context.

## Entity Information
- Name: ${entityName}
- Type: ${entity.entityType || 'Unknown'}
- Tags: ${(entity.tags || []).join(', ')}

## VERIFIED CODEBASE STATE (from actual codebase scan)
${analysisContext.codebaseFacts}

## Recent Git Activity (actual commits)
${analysisContext.gitContext || 'No recent git activity found'}

## Recent Conversations/Sessions (from LSL history)
${analysisContext.vibeContext || 'No recent conversation context found'}

## Issues Found with Current Observations
${analysisContext.issuesSummary}

## Stale Observations to Replace
${staleObservations.map((obs, i) => `${i + 1}. ${obs}`).join('\n')}

Generate ${staleObservations.length} replacement observations that:
1. Are 100% accurate based on the verified codebase state above
2. Reference only files, commands, and components that ACTUALLY EXIST
3. Use correct command names (vkb for visualization, MCP tools for knowledge operations)
4. Describe the CURRENT architecture, not historical or assumed patterns
5. Include specific file paths and component names from the verified state

Respond with a JSON array:
[
  {
    "type": "rule|implementation|validation|workflow|benefits|architecture",
    "content": "Accurate observation based on verified codebase state",
    "confidence": 0.9
  }
]`;

      const result = await this.semanticAnalyzer.analyzeContent(contextPrompt, {
        analysisType: 'code',
        provider: 'auto'
      });

      // Parse LLM response
      let parsedObservations: Array<{ type: string; content: string; confidence: number }> = [];
      try {
        const jsonMatch = result.insights.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          parsedObservations = JSON.parse(jsonMatch[0]);
        }
      } catch (parseError) {
        log('Failed to parse LLM response as JSON', 'warning', parseError);
      }

      if (parsedObservations.length > 0) {
        for (const obs of parsedObservations) {
          newObservations.push({
            type: obs.type || 'insight',
            content: obs.content,
            date: now,
            metadata: {
              confidence: obs.confidence || 0.85,
              refreshedAt: now,
              source: 'codebase-analysis-refresh',
              analysisMethod: 'full-pipeline',
              gitCommitsAnalyzed: gitAnalysisResults?.commits?.length || 0,
              vibeSessionsAnalyzed: vibeAnalysisResults?.sessions?.length || 0
            }
          });
        }
        log(`Generated ${newObservations.length} observations from full codebase analysis`, 'info');
      } else {
        // Fallback: Generate observations directly from codebase scan
        log('LLM parsing failed, generating from codebase scan directly', 'warning');
        newObservations.push(...this.generateObservationsFromCodebaseScan(
          entityName,
          codebaseState,
          staleObservations.length
        ));
      }

      return newObservations;

    } catch (error) {
      log('Full analysis failed, using codebase scan fallback', 'error', error);

      // Fallback: Generate observations from basic codebase scan
      const codebaseState = await this.scanCodebaseForEntityReferences(entityName, [entityName]);
      return this.generateObservationsFromCodebaseScan(entityName, codebaseState, staleObservations.length);
    }
  }

  /**
   * Extract search terms from entity name and observations for targeted analysis
   */
  private extractSearchTerms(entityName: string, entity: any, observations: string[]): string[] {
    const terms = new Set<string>();

    // Add entity name parts
    entityName.split(/(?=[A-Z])/).forEach(part => {
      if (part.length > 2) terms.add(part.toLowerCase());
    });
    terms.add(entityName.toLowerCase());

    // Add entity tags
    if (entity.tags) {
      entity.tags.forEach((tag: string) => terms.add(tag.toLowerCase()));
    }

    // Extract key terms from observations
    const keyTermPattern = /\b(GraphDB|LevelDB|Graphology|persistence|knowledge|entity|vkb|ukb|MCP|semantic|analysis|insight|pattern)\b/gi;
    observations.forEach(obs => {
      const matches = obs.match(keyTermPattern);
      if (matches) {
        matches.forEach(m => terms.add(m.toLowerCase()));
      }
    });

    return Array.from(terms).slice(0, 10); // Limit to top 10 terms
  }

  /**
   * Scan the codebase to verify what actually exists
   */
  private async scanCodebaseForEntityReferences(
    entityName: string,
    searchTerms: string[]
  ): Promise<{
    existingFiles: string[];
    existingCommands: string[];
    existingComponents: string[];
    relatedCodeSnippets: string[];
  }> {
    const result = {
      existingFiles: [] as string[],
      existingCommands: [] as string[],
      existingComponents: [] as string[],
      relatedCodeSnippets: [] as string[]
    };

    try {
      // Scan for relevant files based on entity topic
      const relevantPaths = [
        'src/knowledge-management',
        'lib/ukb-unified',
        'integrations/mcp-server-semantic-analysis/src',
        '.data/knowledge-graph',
        '.data/knowledge-export'
      ];

      for (const basePath of relevantPaths) {
        const fullPath = path.join(this.repositoryPath, basePath);
        if (fs.existsSync(fullPath)) {
          result.existingFiles.push(basePath);
        }
      }

      // Check for known command scripts
      const commandPaths = [
        { cmd: 'vkb', path: 'bin/vkb' },
        { cmd: 'coding', path: 'bin/coding' },
        { cmd: 'graph-sync', path: 'bin/graph-sync' }
      ];

      for (const { cmd, path: cmdPath } of commandPaths) {
        const fullPath = path.join(this.repositoryPath, cmdPath);
        if (fs.existsSync(fullPath)) {
          result.existingCommands.push(cmd);
        }
      }

      // Check for key service/component files
      const componentPaths = [
        { name: 'GraphDatabaseService', path: 'src/knowledge-management/GraphDatabaseService.js' },
        { name: 'GraphKnowledgeExporter', path: 'src/knowledge-management/GraphKnowledgeExporter.js' },
        { name: 'GraphDatabaseAdapter', path: 'integrations/mcp-server-semantic-analysis/src/storage/graph-database-adapter.ts' },
        { name: 'PersistenceAgent', path: 'integrations/mcp-server-semantic-analysis/src/agents/persistence-agent.ts' },
        { name: 'VkbApiClient', path: 'lib/ukb-unified/core/VkbApiClient.js' }
      ];

      for (const { name, path: compPath } of componentPaths) {
        const fullPath = path.join(this.repositoryPath, compPath);
        if (fs.existsSync(fullPath)) {
          result.existingComponents.push(name);
        }
      }

      // Check if shared-memory.json exists (it shouldn't anymore)
      const sharedMemoryPath = path.join(this.repositoryPath, '.mcp-sync/shared-memory.json');
      if (!fs.existsSync(sharedMemoryPath)) {
        result.relatedCodeSnippets.push('shared-memory.json has been REMOVED from the codebase');
      }

      // Check for knowledge graph database files
      const graphDbPath = path.join(this.repositoryPath, '.data/knowledge-graph');
      if (fs.existsSync(graphDbPath)) {
        result.relatedCodeSnippets.push('Knowledge storage uses Graphology + LevelDB at .data/knowledge-graph');
      }

      // Check for JSON export files
      const exportPath = path.join(this.repositoryPath, '.data/knowledge-export');
      if (fs.existsSync(exportPath)) {
        result.relatedCodeSnippets.push('JSON exports are at .data/knowledge-export (auto-synced from GraphDB)');
      }

    } catch (error) {
      log('Codebase scan encountered errors', 'warning', error);
    }

    return result;
  }

  /**
   * Build analysis context from all gathered data
   */
  private buildAnalysisContext(
    entityName: string,
    entity: any,
    staleObservations: string[],
    validationReport: EntityValidationReport,
    gitAnalysis: any,
    vibeAnalysis: any,
    codebaseState: any
  ): {
    codebaseFacts: string;
    gitContext: string;
    vibeContext: string;
    issuesSummary: string;
  } {
    // Format codebase facts
    const codebaseFacts = [
      '### Existing Files/Directories:',
      ...codebaseState.existingFiles.map((f: string) => `- ${f}`),
      '',
      '### Available Commands:',
      ...codebaseState.existingCommands.map((c: string) => `- ${c}`),
      '',
      '### Existing Components:',
      ...codebaseState.existingComponents.map((c: string) => `- ${c}`),
      '',
      '### Key Facts:',
      ...codebaseState.relatedCodeSnippets.map((s: string) => `- ${s}`)
    ].join('\n');

    // Format git context
    let gitContext = '';
    if (gitAnalysis?.commits?.length > 0) {
      const recentCommits = gitAnalysis.commits.slice(0, 5);
      gitContext = recentCommits.map((c: any) =>
        `- ${c.message?.substring(0, 100) || 'No message'} (${c.date || 'unknown date'})`
      ).join('\n');
    }

    // Format vibe context
    let vibeContext = '';
    if (vibeAnalysis?.sessions?.length > 0) {
      vibeContext = vibeAnalysis.sessions.slice(0, 3).map((s: any) =>
        `- Session on ${s.date || 'unknown'}: ${s.summary || s.topics?.join(', ') || 'No summary'}`
      ).join('\n');
    }

    // Format issues summary
    const issuesSummary = validationReport.observationValidations
      .filter(v => !v.isValid)
      .map(v => {
        const issues = v.issues.map(i => `  - ${i.category}: ${i.message}`).join('\n');
        return `Observation: "${v.observation.substring(0, 80)}..."\n${issues}`;
      })
      .join('\n\n');

    return { codebaseFacts, gitContext, vibeContext, issuesSummary };
  }

  /**
   * Build analysis context specifically for insight document generation.
   * This provides the data structure expected by InsightGenerationAgent.
   */
  private async buildInsightAnalysisContext(
    entityName: string,
    entity: any,
    newObservations: Array<{ type: string; content: string; date: string; metadata: Record<string, any> }>
  ): Promise<{
    git_analysis: any;
    vibe_analysis: any;
    patterns: any[];
    entity_info: any;
  }> {
    const context: {
      git_analysis: any;
      vibe_analysis: any;
      patterns: any[];
      entity_info: any;
    } = {
      git_analysis: null,
      vibe_analysis: null,
      patterns: [],
      entity_info: {
        name: entityName,
        type: entity.entityType || entity.type || 'Pattern',
        observations: newObservations.map(o => o.content)
      }
    };

    try {
      // Get git history for context if available
      if (this.gitHistoryAgent) {
        const gitResult = await this.gitHistoryAgent.analyzeGitHistory({
          sinceDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
          incremental: false
        });
        context.git_analysis = gitResult;
      }

      // Get vibe/session history if available
      if (this.vibeHistoryAgent) {
        const vibeResult = await this.vibeHistoryAgent.analyzeVibeHistory({
          sinceDate: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
          incremental: false
        });
        context.vibe_analysis = vibeResult;
      }

      // Extract patterns from entity observations
      context.patterns = newObservations
        .filter(o => o.type === 'pattern' || o.content.toLowerCase().includes('pattern'))
        .map(o => ({
          name: entityName,
          description: o.content,
          type: o.type,
          significance: 7
        }));

      // If no patterns found, create a general pattern from entity info
      if (context.patterns.length === 0) {
        context.patterns.push({
          name: entityName,
          description: `${entity.entityType || 'Pattern'} for ${entityName}: ${newObservations.slice(0, 3).map(o => o.content).join('. ')}`,
          type: entity.entityType || 'general',
          significance: 6
        });
      }

    } catch (error) {
      log('Error building insight analysis context', 'warning', error);
    }

    return context;
  }

  /**
   * Generate observations directly from codebase scan when LLM fails
   */
  private generateObservationsFromCodebaseScan(
    entityName: string,
    codebaseState: any,
    count: number
  ): Array<{ type: string; content: string; date: string; metadata: Record<string, any> }> {
    const now = new Date().toISOString();
    const observations: Array<{ type: string; content: string; date: string; metadata: Record<string, any> }> = [];

    // Generate observations based on actual codebase state
    if (entityName.toLowerCase().includes('persistence') || entityName.toLowerCase().includes('knowledge')) {
      if (codebaseState.existingComponents.includes('GraphDatabaseService')) {
        observations.push({
          type: 'implementation',
          content: `Knowledge persistence uses GraphDatabaseService (Graphology in-memory + LevelDB persistence) - NOT shared-memory.json`,
          date: now,
          metadata: { confidence: 0.95, source: 'codebase-scan', refreshedAt: now }
        });
      }

      if (codebaseState.existingComponents.includes('GraphKnowledgeExporter')) {
        observations.push({
          type: 'workflow',
          content: `GraphKnowledgeExporter listens to entity:stored events and auto-exports to JSON at .data/knowledge-export`,
          date: now,
          metadata: { confidence: 0.95, source: 'codebase-scan', refreshedAt: now }
        });
      }

      if (codebaseState.existingCommands.includes('vkb')) {
        observations.push({
          type: 'rule',
          content: `Use 'vkb' command for visualization (http://localhost:8080) and MCP semantic-analysis tools for programmatic access`,
          date: now,
          metadata: { confidence: 0.95, source: 'codebase-scan', refreshedAt: now }
        });
      }

      if (codebaseState.relatedCodeSnippets.some((s: string) => s.includes('shared-memory.json has been REMOVED'))) {
        observations.push({
          type: 'validation',
          content: `IMPORTANT: shared-memory.json no longer exists - all persistence goes through GraphDatabaseService`,
          date: now,
          metadata: { confidence: 1.0, source: 'codebase-scan', refreshedAt: now }
        });
      }
    }

    // Ensure we have at least 'count' observations
    while (observations.length < count) {
      observations.push({
        type: 'insight',
        content: `Entity ${entityName} - observations refreshed based on codebase scan on ${now}`,
        date: now,
        metadata: { confidence: 0.7, source: 'codebase-scan-fallback', refreshedAt: now }
      });
    }

    return observations.slice(0, count);
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
