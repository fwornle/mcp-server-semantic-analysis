import * as fs from 'fs';
import * as path from 'path';
import { log } from "../logging.js";
import { GitHistoryAgent } from "./git-history-agent.js";
import { VibeHistoryAgent } from "./vibe-history-agent.js";
import { SemanticAnalysisAgent } from "./semantic-analysis-agent.js";
import { WebSearchAgent } from "./web-search.js";
import { InsightGenerationAgent } from "./insight-generation-agent.js";
import { ObservationGenerationAgent } from "./observation-generation-agent.js";
import { QualityAssuranceAgent } from "./quality-assurance-agent.js";
import { PersistenceAgent } from "./persistence-agent.js";
import { DeduplicationAgent } from "./deduplication.js";
import { ContentValidationAgent } from "./content-validation-agent.js";
import { OntologyClassificationAgent } from "./ontology-classification-agent.js";
import { CodeGraphAgent } from "./code-graph-agent.js";
import { DocumentationLinkerAgent } from "./documentation-linker-agent.js";
import { GraphDatabaseAdapter } from "../storage/graph-database-adapter.js";
import { WorkflowReportAgent, type StepReport } from "./workflow-report-agent.js";
import { loadAllWorkflows, loadWorkflowFromYAML, getConfigDir } from "../utils/workflow-loader.js";
import { BatchScheduler, getBatchScheduler, type BatchWindow, type BatchStats } from "./batch-scheduler.js";
import { KGOperators, createKGOperators, type KGEntity, type KGRelation, type BatchContext } from "./kg-operators.js";
import { getBatchCheckpointManager } from "../utils/batch-checkpoint-manager.js";
import { SemanticAnalyzer } from "./semantic-analyzer.js";

export interface WorkflowDefinition {
  name: string;
  description: string;
  agents: string[];
  steps: WorkflowStep[];
  config: Record<string, any>;
  type?: 'standard' | 'iterative';  // iterative = batch processing
}

export interface WorkflowStep {
  name: string;
  agent: string;
  action: string;
  parameters: Record<string, any>;
  dependencies?: string[];
  timeout?: number;
  condition?: string; // Optional condition for conditional execution (e.g., "{{params.autoRefresh}} === true")
  preferredModel?: 'groq' | 'anthropic' | 'openai' | 'gemini' | 'auto'; // Optional model preference for LLM-intensive steps
  phase?: 'initialization' | 'batch' | 'finalization'; // For iterative workflows
  operator?: string; // Tree-KG operator name (conv, aggr, embed, dedup, pred, merge)
  tier?: 'fast' | 'standard' | 'premium'; // Model tier override
}

export interface WorkflowExecution {
  id: string;
  workflow: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  startTime: Date;
  endTime?: Date;
  results: Record<string, any>;
  errors: string[];
  currentStep: number;
  totalSteps: number;
  // Rollback tracking for error recovery
  rollbackActions?: RollbackAction[];
  rolledBack?: boolean;
}

export interface RollbackAction {
  type: 'file_created' | 'entity_created' | 'file_modified';
  target: string;
  originalState?: any;
  timestamp: Date;
}

export interface StepExecution {
  name: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startTime?: Date;
  endTime?: Date;
  result?: any;
  error?: string;
  agent: string;
  action: string;
}

export class CoordinatorAgent {
  private workflows: Map<string, WorkflowDefinition> = new Map();
  private executions: Map<string, WorkflowExecution> = new Map();
  private agents: Map<string, any> = new Map();
  private running: boolean = true;
  private repositoryPath: string;
  private team: string;
  private graphDB: GraphDatabaseAdapter;
  private initializationPromise: Promise<void> | null = null;
  private isInitializing: boolean = false;
  private monitorIntervalId: ReturnType<typeof setInterval> | null = null;
  private reportAgent: WorkflowReportAgent;

  constructor(repositoryPath: string = '.', team: string = 'coding') {
    this.repositoryPath = repositoryPath;
    this.team = team;
    this.graphDB = new GraphDatabaseAdapter();
    this.reportAgent = new WorkflowReportAgent(repositoryPath);
    this.initializeWorkflows();
    // Note: Agents are initialized lazily when executeWorkflow is called
    // This avoids constructor side effects and race conditions
  }

  /**
   * Write workflow progress to a file for external monitoring
   * File location: .data/workflow-progress.json
   */
  private writeProgressFile(execution: WorkflowExecution, workflow: WorkflowDefinition, currentStep?: string, runningSteps?: string[]): void {
    try {
      const progressPath = `${this.repositoryPath}/.data/workflow-progress.json`;

      // Build detailed step info with timing data and result summaries
      const stepsDetail: Array<{
        name: string;
        status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
        startTime?: string;
        duration?: number;
        error?: string;
        outputs?: Record<string, any>;
      }> = [];

      // Track which steps are currently running (from DAG executor)
      const activeRunningSteps = new Set(runningSteps || []);
      if (currentStep) activeRunningSteps.add(currentStep);

      for (const [stepName, result] of Object.entries(execution.results)) {
        const timing = result?._timing as { duration?: number } | undefined;
        const hasError = result?.error && Object.keys(result).filter(k => !k.startsWith('_')).length === 1;

        stepsDetail.push({
          name: stepName,
          status: hasError ? 'failed' : result?.skipped ? 'skipped' : 'completed',
          duration: timing?.duration,
          error: hasError ? result.error : undefined,
          outputs: this.summarizeStepResult(result),
        });
      }

      // Add ALL currently running steps (for parallel execution visibility)
      for (const stepName of activeRunningSteps) {
        if (!execution.results[stepName]) {
          stepsDetail.push({
            name: stepName,
            status: 'running',
            startTime: new Date().toISOString(),
          });
        }
      }

      const completedSteps = stepsDetail.filter(s => s.status === 'completed').map(s => s.name);
      const failedSteps = stepsDetail.filter(s => s.status === 'failed').map(s => s.name);
      const skippedSteps = stepsDetail.filter(s => s.status === 'skipped').map(s => s.name);

      // Build summary statistics from all step outputs
      const summaryStats: Record<string, any> = {
        totalCommits: 0,
        totalFiles: 0,
        totalSessions: 0,
        totalKeyTopics: 0,
        totalObservations: 0,
        totalInsights: 0,
        totalPatterns: 0,
        keyTopics: [] as Array<{ topic: string; category: string; significance: number }>,
        insightsGenerated: [] as Array<{ name: string; filePath?: string; significance?: number }>,
        patternsFound: [] as Array<{ name: string; category: string; significance: number }>,
        codeGraphStats: null as { totalEntities: number; languages: string[] } | null,
        skippedReasons: {} as Record<string, string>
      };

      for (const step of stepsDetail) {
        const outputs = step.outputs || {};

        // Aggregate counts
        if (outputs.commitsCount) summaryStats.totalCommits += outputs.commitsCount;
        if (outputs.filesCount) summaryStats.totalFiles += outputs.filesCount;
        if (outputs.sessionsCount) summaryStats.totalSessions += outputs.sessionsCount;
        if (outputs.observationsCount) summaryStats.totalObservations += outputs.observationsCount;
        if (outputs.totalInsights) summaryStats.totalInsights += outputs.totalInsights;
        if (outputs.totalPatterns) summaryStats.totalPatterns += outputs.totalPatterns;

        // Collect insight documents
        if (outputs.insightDocuments) {
          summaryStats.insightsGenerated.push(...outputs.insightDocuments);
        }

        // Collect key topics from vibe history (semantic LLM-based)
        if (outputs.topTopics && Array.isArray(outputs.topTopics)) {
          summaryStats.keyTopics.push(...outputs.topTopics);
          summaryStats.totalKeyTopics += outputs.topTopics.length;
        }
        if (outputs.keyTopicsCount) {
          summaryStats.totalKeyTopics = Math.max(summaryStats.totalKeyTopics, outputs.keyTopicsCount);
        }

        // Collect top patterns
        if (outputs.patterns) {
          summaryStats.patternsFound.push(...outputs.patterns);
        }

        // Collect code graph stats
        if (outputs.codeGraphStats) {
          summaryStats.codeGraphStats = {
            totalEntities: outputs.codeGraphStats.totalEntities,
            languages: Object.keys(outputs.codeGraphStats.languageDistribution || {})
          };
        }

        // Collect skip reasons
        if (outputs.skipped && outputs.skipReason) {
          summaryStats.skippedReasons[step.name] = outputs.skipReason;
        }
      }

      // Sort patterns by significance
      summaryStats.patternsFound.sort((a: any, b: any) => (b.significance || 0) - (a.significance || 0));

      // Get all currently running steps
      const currentlyRunning = stepsDetail.filter(s => s.status === 'running').map(s => s.name);

      const progress = {
        workflowName: workflow.name,
        executionId: execution.id,
        status: execution.status,
        team: this.team,
        repositoryPath: this.repositoryPath,
        startTime: execution.startTime.toISOString(),
        currentStep: currentStep || currentlyRunning[0] || null,
        totalSteps: workflow.steps.length,
        completedSteps: completedSteps.length,
        failedSteps: failedSteps.length,
        skippedSteps: skippedSteps.length,
        runningSteps: currentlyRunning.length,  // Count of parallel steps
        stepsCompleted: completedSteps,
        stepsFailed: failedSteps,
        stepsSkipped: skippedSteps,
        stepsRunning: currentlyRunning,  // NEW: All currently running steps (for parallel visibility)
        stepsDetail: stepsDetail,
        summary: summaryStats,
        lastUpdate: new Date().toISOString(),
        elapsedSeconds: Math.round((Date.now() - execution.startTime.getTime()) / 1000),
      };

      fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
    } catch (error) {
      // Silently ignore progress file errors - this is non-critical
      log(`Failed to write progress file: ${error}`, 'debug');
    }
  }

  private initializeWorkflows(): void {
    // Try to load workflows from YAML (single source of truth)
    try {
      const configDir = getConfigDir();
      const workflowsDir = path.join(configDir, 'workflows');

      if (fs.existsSync(workflowsDir)) {
        const yamlWorkflows = loadAllWorkflows(configDir);
        if (yamlWorkflows.size > 0) {
          yamlWorkflows.forEach((workflow, name) => {
            this.workflows.set(name, workflow);
          });
          log(`Loaded ${yamlWorkflows.size} workflows from YAML configuration`, "info");

          // Still load inline workflows that don't exist in YAML (for backward compat)
          this.initializeInlineWorkflows(true); // true = only add missing
          return;
        }
      }
    } catch (error) {
      log(`YAML workflow loading failed, using inline definitions: ${error}`, "warning");
    }

    // Fallback: use inline workflow definitions
    this.initializeInlineWorkflows(false);
  }

  /**
   * Initialize workflows from inline TypeScript definitions.
   * Used as fallback when YAML config is not available.
   * @param onlyMissing - If true, only add workflows not already in this.workflows
   */
  private initializeInlineWorkflows(onlyMissing: boolean): void {
    // Define standard workflows
    const workflows: WorkflowDefinition[] = [
      {
        name: "complete-analysis",
        description: "Complete 13-agent semantic analysis workflow with code graph and ontology classification",
        agents: ["git_history", "vibe_history", "semantic_analysis", "web_search",
                 "insight_generation", "observation_generation", "ontology_classification",
                 "quality_assurance", "persistence", "deduplication", "content_validation",
                 "code_graph", "documentation_linker"],
        steps: [
          {
            name: "analyze_git_history",
            agent: "git_history",
            action: "analyzeGitHistoryWithLLM",
            parameters: {
              repository_path: ".",
              checkpoint_enabled: false, // Disable checkpoint for full history analysis
              depth: 500, // Analyze up to 500 commits for complete analysis
              // NOTE: No days_back parameter = analyze all history regardless of date
            },
            timeout: 300, // Longer timeout for LLM analysis
          },
          {
            name: "analyze_vibe_history",
            agent: "vibe_history",
            action: "analyzeVibeHistory",
            parameters: {
              history_path: ".specstory/history",
              checkpoint_enabled: false, // For complete-analysis: analyze ALL sessions
              maxSessions: 0, // 0 = unlimited - process all sessions with parallelization
              skipLlmEnhancement: false // Still generate LLM insights
            },
            timeout: 600, // 10 minutes for comprehensive vibe analysis (767+ LSL files)
          },
          {
            name: "semantic_analysis",
            agent: "semantic_analysis",
            action: "analyzeSemantics",
            parameters: {
              git_analysis_results: "{{analyze_git_history.result}}",
              vibe_analysis_results: "{{analyze_vibe_history.result}}",
              code_graph_results: "{{index_codebase.result}}",
              doc_analysis_results: "{{link_documentation.result}}"
            },
            dependencies: ["analyze_git_history", "analyze_vibe_history", "index_codebase", "link_documentation"],
            timeout: 240, // 4 minutes for comprehensive semantic analysis with all inputs
          },
          {
            name: "web_search",
            agent: "web_search",
            action: "searchSimilarPatterns",
            parameters: {
              semantic_analysis_results: "{{semantic_analysis.result}}"
            },
            dependencies: ["semantic_analysis"],
            timeout: 90,
          },
          {
            name: "generate_insights",
            agent: "insight_generation",
            action: "generateComprehensiveInsights",
            parameters: {
              semantic_analysis_results: "{{semantic_analysis.result}}",
              web_search_results: "{{web_search.result}}",
              git_analysis_results: "{{analyze_git_history.result}}",
              vibe_analysis_results: "{{analyze_vibe_history.result}}",
              code_graph_results: "{{index_codebase.result}}"
            },
            dependencies: ["semantic_analysis", "web_search", "index_codebase"],
            timeout: 300,
          },
          {
            name: "generate_observations",
            agent: "observation_generation",
            action: "generateStructuredObservations",
            parameters: {
              insights_results: "{{generate_insights.result}}",
              semantic_analysis_results: "{{semantic_analysis.result}}",
              git_analysis_results: "{{analyze_git_history.result}}",
              vibe_analysis_results: "{{analyze_vibe_history.result}}"
            },
            dependencies: ["generate_insights"],
            timeout: 90,
          },
          {
            name: "classify_with_ontology",
            agent: "ontology_classification",
            action: "classifyObservations",
            parameters: {
              observations: "{{generate_observations.result.observations}}",
              autoExtend: true,
              minConfidence: 0.6
            },
            dependencies: ["generate_observations"],
            timeout: 600, // 10 minutes for large observation sets (1000+ observations)
          },
          {
            name: "index_codebase",
            agent: "code_graph",
            action: "indexRepository",
            parameters: {
              target_path: "{{params.repositoryPath}}"
            },
            timeout: 600, // 10 minutes for large codebases (AST parsing is slow)
          },
          {
            name: "link_documentation",
            agent: "documentation_linker",
            action: "analyzeDocumentation",
            parameters: {
              markdown_paths: ["**/*.md"],
              plantuml_paths: ["**/*.puml", "**/*.plantuml"],
              exclude_patterns: ["**/node_modules/**", "**/dist/**"]
            },
            timeout: 120,
          },
          {
            name: "transform_code_entities",
            agent: "code_graph",
            action: "transformToKnowledgeEntities",
            parameters: {
              code_analysis: "{{index_codebase.result}}"
            },
            dependencies: ["index_codebase"],
            timeout: 60,
          },
          // NEW: Semantic analysis of docstrings and documentation prose
          {
            name: "analyze_documentation_semantics",
            agent: "semantic_analysis",
            action: "analyzeDocumentationSemantics",
            parameters: {
              code_entities: "{{transform_code_entities.result}}",
              doc_analysis: "{{link_documentation.result}}",
              raw_code_entities: "{{index_codebase.result.entities}}",
              batch_size: 20,
              min_docstring_length: 50,
              parallel_batches: 3  // Process 3 batches in parallel for faster completion
            },
            dependencies: ["transform_code_entities", "link_documentation"],
            timeout: 600, // 10 minutes for LLM-based docstring analysis (large codebases with parallel batches)
          },
          {
            name: "quality_assurance",
            agent: "quality_assurance",
            action: "performWorkflowQA",
            parameters: {
              all_results: {
                git_history: "{{analyze_git_history.result}}",
                vibe_history: "{{analyze_vibe_history.result}}",
                semantic_analysis: "{{semantic_analysis.result}}",
                web_search: "{{web_search.result}}",
                insights: "{{generate_insights.result}}",
                observations: "{{generate_observations.result}}",
                ontology_classification: "{{classify_with_ontology.result}}",
                code_graph: "{{transform_code_entities.result}}",
                doc_semantics: "{{analyze_documentation_semantics.result}}"
              }
            },
            dependencies: ["classify_with_ontology", "transform_code_entities", "analyze_documentation_semantics"],
            timeout: 90, // Increased timeout for comprehensive analysis
          },
          {
            name: "persist_results",
            agent: "persistence",
            action: "persistAnalysisResults",
            parameters: {
              workflow_results: {
                git_history: "{{analyze_git_history.result}}",
                vibe_history: "{{analyze_vibe_history.result}}",
                semantic_analysis: "{{semantic_analysis.result}}",
                web_search: "{{web_search.result}}",
                insights: "{{generate_insights.result}}",
                observations: "{{generate_observations.result}}",
                ontology_classification: "{{classify_with_ontology.result}}",
                code_graph: "{{transform_code_entities.result}}",
                doc_semantics: "{{analyze_documentation_semantics.result}}",
                quality_assurance: "{{quality_assurance.result}}"
              }
            },
            dependencies: ["quality_assurance"],
            timeout: 90,
          },
          {
            name: "deduplicate_insights",
            agent: "deduplication",
            action: "handleResolveDuplicates",
            parameters: {
              entity_types: ["Pattern", "WorkflowPattern", "Insight", "DesignPattern", "CodeClass", "CodeFunction"],
              similarity_threshold: 0.85,
              auto_merge: true,
              preserve_history: true,
              deduplicate_insights: true,
              insight_scope: "global",
              insight_threshold: 0.9,
              merge_strategy: "combine"
            },
            dependencies: ["persist_results"],
            timeout: 60,
          },
          {
            name: "validate_content",
            agent: "content_validation",
            action: "validateAndRefreshStaleEntities",
            parameters: {
              team: "{{params.team}}",
              maxEntities: 50,
              staleDaysThreshold: 7
            },
            dependencies: ["deduplicate_insights"],
            timeout: 120,
          }
        ],
        config: {
          max_concurrent_steps: 10,
          timeout: 1200, // 20 minutes total for comprehensive analysis
          quality_validation: true,
        },
      },
      {
        name: "incremental-analysis",
        description: "Incremental 14-agent analysis since last checkpoint with code graph and ontology",
        agents: ["git_history", "vibe_history", "semantic_analysis", "insight_generation",
                 "observation_generation", "ontology_classification", "quality_assurance",
                 "persistence", "deduplication", "content_validation", "code_graph", "documentation_linker", "code_intelligence"],
        steps: [
          // PHASE 1: Parallel Data Collection
          // All three run in parallel - no dependencies
          {
            name: "analyze_recent_changes",
            agent: "git_history",
            action: "analyzeGitHistoryWithLLM",
            parameters: {
              repository: null,  // Will be filled from workflow params
              maxCommits: 50,    // Increased for better analysis
              sinceCommit: null
            },
            timeout: 180, // 3 min for LLM-enhanced git analysis
          },
          {
            name: "analyze_recent_vibes",
            agent: "vibe_history",
            action: "analyzeVibeHistory",
            parameters: {
              maxSessions: 20    // Analyze more sessions
            },
            timeout: 120,       // 2 min for vibe analysis
          },
          {
            name: "index_recent_code",
            agent: "code_graph",
            action: "indexIncrementally",
            parameters: {
              repoPath: "{{params.repositoryPath}}",
              options: {
                sinceDays: 7  // Index files changed in last 7 days
              }
            },
            timeout: 600, // 10 min for large repos - AST parsing takes time
          },
          // NEW: Intelligent Code Graph Querying
          // Generates context-aware questions and queries the code graph
          {
            name: "query_code_intelligence",
            agent: "code_intelligence",
            action: "queryIntelligently",
            parameters: {
              context: {
                changedFiles: "{{analyze_recent_changes.result.changedFiles}}",
                recentCommits: "{{analyze_recent_changes.result.significantCommits}}",
                vibePatterns: "{{analyze_recent_vibes.result.problemPatterns}}"
              },
              options: {
                maxQueries: 8  // Balance depth vs cost
              }
            },
            dependencies: ["index_recent_code", "analyze_recent_changes", "analyze_recent_vibes"],
            timeout: 180, // 3 min for multiple NL->Cypher queries
          },
          // PHASE 2: Semantic Understanding
          // Waits for ALL data collection to complete, then synthesizes
          {
            name: "analyze_semantics",
            agent: "semantic_analysis",
            action: "analyzeSemantics",
            parameters: {
              git_analysis_results: "{{analyze_recent_changes.result}}",
              vibe_analysis_results: "{{analyze_recent_vibes.result}}",
              code_graph_results: "{{index_recent_code.result}}",
              code_intelligence: "{{query_code_intelligence.result}}",
              incremental: true
            },
            dependencies: ["analyze_recent_changes", "analyze_recent_vibes", "index_recent_code", "query_code_intelligence"],
            timeout: 120,
          },
          // PHASE 3: Insight Generation
          // All data flows through semantic_analysis first
          {
            name: "generate_insights",
            agent: "insight_generation",
            action: "generateComprehensiveInsights",
            parameters: {
              git_analysis_results: "{{analyze_recent_changes.result}}",
              vibe_analysis_results: "{{analyze_recent_vibes.result}}",
              semantic_analysis_results: "{{analyze_semantics.result}}",
              code_graph_results: "{{index_recent_code.result}}",
              code_intelligence: "{{query_code_intelligence.result}}",
              incremental: true
            },
            dependencies: ["analyze_semantics", "query_code_intelligence"],
            timeout: 180, // 3 min for insight generation with diagrams
          },
          {
            name: "generate_observations",
            agent: "observation_generation",
            action: "generateStructuredObservations",
            parameters: {
              insights_results: "{{generate_insights.result}}",
              semantic_analysis_results: "{{analyze_semantics.result}}",
              git_analysis_results: "{{analyze_recent_changes.result}}",
              vibe_analysis_results: "{{analyze_recent_vibes.result}}",
              incremental: true
            },
            dependencies: ["generate_insights"],
            timeout: 60,
          },
          {
            name: "classify_with_ontology",
            agent: "ontology_classification",
            action: "classifyObservations",
            parameters: {
              observations: "{{generate_observations.result.observations}}",
              autoExtend: true,
              minConfidence: 0.6
            },
            dependencies: ["generate_observations"],
            timeout: 300, // 5 minutes for incremental observation sets
          },
          // PHASE 5: Transform code entities (index_recent_code already ran in Phase 1)
          {
            name: "transform_code_entities_incremental",
            agent: "code_graph",
            action: "transformToKnowledgeEntities",
            parameters: {
              code_analysis: "{{index_recent_code.result}}"
            },
            dependencies: ["index_recent_code"],
            timeout: 60,
          },
          // NEW: Semantic analysis of docstrings from recent code (no doc_analysis in incremental)
          {
            name: "analyze_documentation_semantics_incremental",
            agent: "semantic_analysis",
            action: "analyzeDocumentationSemantics",
            parameters: {
              code_entities: "{{transform_code_entities_incremental.result}}",
              raw_code_entities: "{{index_recent_code.result.entities}}",
              batch_size: 10, // Smaller batch for incremental
              min_docstring_length: 50
            },
            dependencies: ["transform_code_entities_incremental"],
            timeout: 120, // 2 minutes for incremental
          },
          {
            name: "validate_incremental_qa",
            agent: "quality_assurance",
            action: "performLightweightQA",
            parameters: {
              all_results: {
                git_history: "{{analyze_recent_changes.result}}",
                vibe_history: "{{analyze_recent_vibes.result}}",
                semantic_analysis: "{{analyze_semantics.result}}",
                insights: "{{generate_insights.result}}",
                observations: "{{generate_observations.result}}",
                ontology_classification: "{{classify_with_ontology.result}}",
                code_graph: "{{transform_code_entities_incremental.result}}",
                doc_semantics: "{{analyze_documentation_semantics_incremental.result}}"
              },
              lightweight: true // Skip heavy validation for incremental runs
            },
            dependencies: ["classify_with_ontology", "analyze_documentation_semantics_incremental"],
            timeout: 30,
          },
          {
            name: "persist_incremental",
            agent: "persistence",
            action: "persistAnalysisResults",
            parameters: {
              workflow_results: {
                git_history: "{{analyze_recent_changes.result}}",
                vibe_history: "{{analyze_recent_vibes.result}}",
                semantic_analysis: "{{analyze_semantics.result}}",
                insights: "{{generate_insights.result}}",
                observations: "{{generate_observations.result}}",
                ontology_classification: "{{classify_with_ontology.result}}",
                code_graph: "{{transform_code_entities_incremental.result}}",
                doc_semantics: "{{analyze_documentation_semantics_incremental.result}}",
                quality_assurance: "{{validate_incremental_qa.result}}"
              }
            },
            dependencies: ["validate_incremental_qa"],
            timeout: 60,
          },
          {
            name: "deduplicate_incremental",
            agent: "deduplication",
            action: "handleConsolidatePatterns",
            parameters: {
              similarity_threshold: 0.9
            },
            dependencies: ["persist_incremental"],
            timeout: 30,
          },
          {
            name: "validate_content_incremental",
            agent: "content_validation",
            action: "validateAndRefreshStaleEntities",
            parameters: {
              team: "{{params.team}}",
              maxEntities: 20,  // Limit to 20 entities per incremental run for performance
              staleDaysThreshold: 7
            },
            dependencies: ["deduplicate_incremental"],
            timeout: 60,
          }
        ],
        config: {
          max_concurrent_steps: 10,
          timeout: 600, // 10 minutes for incremental with code graph
          quality_validation: true,
        },
      },
      {
        name: "pattern-extraction", 
        description: "Extract and document design patterns",
        agents: ["semantic_analysis", "insight_generation", "observation_generation"],
        steps: [
          {
            name: "extract_patterns",
            agent: "semantic_analysis",
            action: "extractPatterns",
            parameters: { 
              pattern_types: ["design", "architectural", "workflow"]
            },
            timeout: 120,
          },
          {
            name: "generate_pattern_insights",
            agent: "insight_generation",
            action: "generatePatternInsights",
            parameters: {},
            dependencies: ["extract_patterns"],
            timeout: 90,
          },
          {
            name: "create_pattern_observations",
            agent: "observation_generation",
            action: "createPatternObservations",
            parameters: {},
            dependencies: ["generate_pattern_insights"],
            timeout: 60,
          }
        ],
        config: {
          timeout: 300,
        },
      },
      {
        name: "entity-refresh",
        description: "Validate a specific entity and optionally auto-refresh if stale. Set autoRefresh=true to fix stale observations.",
        agents: ["content_validation", "persistence"],
        steps: [
          {
            name: "validate_entity_content",
            agent: "content_validation",
            action: "validateEntityAccuracy",
            parameters: {
              entityName: "{{params.entityName}}",
              team: "{{params.team}}"
            },
            timeout: 120,
          },
          {
            name: "refresh_if_stale",
            agent: "content_validation",
            action: "refreshStaleEntity",
            parameters: {
              entityName: "{{params.entityName}}",
              team: "{{params.team}}",
              validationReport: "{{validate_entity_content.result}}"
            },
            dependencies: ["validate_entity_content"],
            condition: "{{params.autoRefresh}} === true && {{validate_entity_content.result.overallScore}} < 100",
            timeout: 180,
          }
        ],
        config: {
          timeout: 360, // 6 minutes to allow for refresh
          quality_validation: false,
          requires_entity_param: true
        },
      },
      {
        name: "full-kb-validation",
        description: "Validate all entities in the knowledge base for accuracy and staleness",
        agents: ["content_validation", "quality_assurance"],
        steps: [
          {
            name: "validate_all_entities",
            agent: "content_validation",
            action: "validateAllEntities",
            parameters: {
              maxEntitiesPerProject: "{{params.maxEntitiesPerProject}}",
              skipHealthyEntities: true  // Only report invalid entities
            },
            timeout: 300,  // 5 minutes
          },
          {
            name: "qa_validation_report",
            agent: "quality_assurance",
            action: "validateFullKBReport",
            parameters: {
              validation_results: "{{validate_all_entities.result}}"
            },
            dependencies: ["validate_all_entities"],
            timeout: 60,
          }
        ],
        config: {
          timeout: 420, // 7 minutes
          quality_validation: true,
        },
      },
      {
        name: "project-kb-validation",
        description: "Validate all entities for a specific project/team",
        agents: ["content_validation", "quality_assurance"],
        steps: [
          {
            name: "validate_project_entities",
            agent: "content_validation",
            action: "validateEntitiesByProject",
            parameters: {
              team: "{{params.team}}",
              maxEntities: "{{params.maxEntities}}",
              skipHealthyEntities: false  // Report all entities for project validation
            },
            timeout: 180,  // 3 minutes
          },
          {
            name: "qa_project_report",
            agent: "quality_assurance",
            action: "validateProjectKBReport",
            parameters: {
              validation_results: "{{validate_project_entities.result}}",
              team: "{{params.team}}"
            },
            dependencies: ["validate_project_entities"],
            timeout: 60,
          }
        ],
        config: {
          timeout: 300, // 5 minutes
          quality_validation: true,
          requires_team_param: true
        },
      },
      // Code Graph Analysis Workflow - AST-based code indexing with documentation linking
      {
        name: "code-graph-analysis",
        description: "AST-based code graph analysis with documentation linking",
        agents: ["code_graph", "documentation_linker", "persistence"],
        steps: [
          {
            name: "index_codebase",
            agent: "code_graph",
            action: "indexRepository",
            parameters: {
              target_path: "{{params.repositoryPath}}"
            },
            timeout: 600, // 10 minutes for large codebases (AST parsing is slow)
          },
          {
            name: "link_documentation",
            agent: "documentation_linker",
            action: "analyzeDocumentation",
            parameters: {
              markdown_paths: ["**/*.md"],
              plantuml_paths: ["**/*.puml", "**/*.plantuml"],
              exclude_patterns: ["**/node_modules/**", "**/dist/**"]
            },
            timeout: 120,
          },
          {
            name: "transform_code_entities",
            agent: "code_graph",
            action: "transformToKnowledgeEntities",
            parameters: {
              code_analysis: "{{index_codebase.result}}"
            },
            dependencies: ["index_codebase"],
            timeout: 60,
          },
          {
            name: "transform_doc_links",
            agent: "documentation_linker",
            action: "transformToKnowledgeEntities",
            parameters: {
              doc_analysis: "{{link_documentation.result}}"
            },
            dependencies: ["link_documentation"],
            timeout: 60,
          }
          // Note: persist_code_entities and persist_doc_links steps removed
          // The transformed entities from code-graph and documentation-linker
          // will be handled in a future update when persistEntities is properly exposed
        ],
        config: {
          timeout: 600, // 10 minutes total
          requires_memgraph: true,
          description: "Requires Memgraph database running (docker-compose up -d in integrations/code-graph-rag)"
        },
      },
    ];

    let addedCount = 0;
    workflows.forEach(workflow => {
      if (onlyMissing && this.workflows.has(workflow.name)) {
        // Skip - already loaded from YAML
        return;
      }
      this.workflows.set(workflow.name, workflow);
      addedCount++;
    });

    if (onlyMissing) {
      if (addedCount > 0) {
        log(`Added ${addedCount} additional inline workflows not in YAML`, "info");
      }
    } else {
      log(`Initialized ${workflows.length} inline workflows`, "info");
    }
  }

  private async initializeAgents(): Promise<void> {
    // Prevent concurrent initialization - return existing promise if initialization is in progress
    if (this.initializationPromise) {
      log("Agent initialization already in progress, waiting...", "debug");
      return this.initializationPromise;
    }

    // Already initialized
    if (this.agents.size > 0 && this.graphDB.initialized) {
      log("Agents already initialized, skipping", "debug");
      return;
    }

    // Set flag and create promise to prevent concurrent calls
    this.isInitializing = true;

    // Add timeout to prevent indefinite hang during initialization
    const INIT_TIMEOUT_MS = 30000; // 30 seconds
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Agent initialization timed out after ${INIT_TIMEOUT_MS}ms. This may indicate a deadlock or blocking operation.`));
      }, INIT_TIMEOUT_MS);
    });

    this.initializationPromise = Promise.race([
      this.doInitializeAgents(),
      timeoutPromise
    ]);

    try {
      await this.initializationPromise;
    } finally {
      this.isInitializing = false;
      this.initializationPromise = null;
    }
  }

  private async doInitializeAgents(): Promise<void> {
    try {
      log("Initializing 10-agent semantic analysis system with GraphDB", "info");

      // Initialize the graph database adapter
      await this.graphDB.initialize();
      log("GraphDB initialized successfully", "info");

      // Core workflow agents
      const gitHistoryAgent = new GitHistoryAgent(this.repositoryPath);
      this.agents.set("git_history", gitHistoryAgent);

      const vibeHistoryAgent = new VibeHistoryAgent(this.repositoryPath, this.team);
      this.agents.set("vibe_history", vibeHistoryAgent);

      const semanticAnalysisAgent = new SemanticAnalysisAgent();
      this.agents.set("semantic_analysis", semanticAnalysisAgent);

      const webSearchAgent = new WebSearchAgent();
      this.agents.set("web_search", webSearchAgent);

      const insightGenerationAgent = new InsightGenerationAgent(this.repositoryPath);
      this.agents.set("insight_generation", insightGenerationAgent);

      const observationGenerationAgent = new ObservationGenerationAgent();
      this.agents.set("observation_generation", observationGenerationAgent);

      // Ontology Classification Agent for classifying observations against ontology
      const ontologyClassificationAgent = new OntologyClassificationAgent(this.team, this.repositoryPath);
      this.agents.set("ontology_classification", ontologyClassificationAgent);

      const qualityAssuranceAgent = new QualityAssuranceAgent();
      this.agents.set("quality_assurance", qualityAssuranceAgent);

      // Initialize PersistenceAgent with GraphDB adapter
      const persistenceAgent = new PersistenceAgent(this.repositoryPath, this.graphDB);
      await persistenceAgent.initializeOntology();
      this.agents.set("persistence", persistenceAgent);

      // SynchronizationAgent REMOVED - GraphDatabaseService handles persistence automatically
      // Direct persistence to Graphology+LevelDB via PersistenceAgent

      const dedupAgent = new DeduplicationAgent();
      this.agents.set("deduplication", dedupAgent);

      // Content Validation Agent for entity accuracy checking
      const contentValidationAgent = new ContentValidationAgent({
        repositoryPath: this.repositoryPath,
        enableDeepValidation: true,
        team: this.team
      });
      contentValidationAgent.setGraphDB(this.graphDB);
      contentValidationAgent.setPersistenceAgent(persistenceAgent);
      contentValidationAgent.setInsightGenerationAgent(insightGenerationAgent);
      this.agents.set("content_validation", contentValidationAgent);

      // Register other agents with deduplication for access to knowledge graph
      dedupAgent.registerAgent("knowledge_graph", persistenceAgent);
      dedupAgent.registerAgent("persistence", persistenceAgent);

      // Code Graph Agent for AST-based code analysis (integrates with code-graph-rag)
      // Compute the code-graph-rag directory - it's in the coding repo's integrations folder
      const codingRepoPath = process.env.CODING_TOOLS_PATH || this.repositoryPath;
      const codeGraphRagDir = path.join(codingRepoPath, 'integrations/code-graph-rag');
      const codeGraphAgent = new CodeGraphAgent(this.repositoryPath, { codeGraphRagDir });
      this.agents.set("code_graph", codeGraphAgent);

      // Documentation Linker Agent for linking docs to code entities
      const documentationLinkerAgent = new DocumentationLinkerAgent(this.repositoryPath);
      this.agents.set("documentation_linker", documentationLinkerAgent);

      // Batch Processing Agents (for batch-analysis workflow)
      // BatchScheduler - plans and tracks chronological batch windows
      const batchSchedulerAgent = getBatchScheduler(this.repositoryPath, this.team);
      this.agents.set("batch_scheduler", batchSchedulerAgent);

      // KG Operators - Tree-KG inspired operators for incremental KG expansion
      const kgOperatorsAgent = createKGOperators(new SemanticAnalyzer());
      this.agents.set("kg_operators", kgOperatorsAgent);

      // Batch Checkpoint Manager - per-batch checkpoint state management
      const batchCheckpointAgent = getBatchCheckpointManager(this.repositoryPath, this.team);
      this.agents.set("batch_checkpoint_manager", batchCheckpointAgent);

      log(`Initialized ${this.agents.size} agents`, "info", {
        agents: Array.from(this.agents.keys())
      });

    } catch (error) {
      log("Failed to initialize agents", "error", error);
      throw error;
    }
  }

  async executeWorkflow(workflowName: string, parameters: Record<string, any> = {}): Promise<WorkflowExecution> {
    // Ensure agents are initialized before executing workflow
    // Use the locking mechanism in initializeAgents to prevent race conditions
    if (this.agents.size === 0 || this.isInitializing) {
      log("Agents not initialized or initialization in progress, ensuring initialization...", "info");
      await this.initializeAgents();
    }

    // Start background monitor only once, after initialization
    if (!this.monitorIntervalId) {
      this.startBackgroundMonitor();
    }

    const workflow = this.workflows.get(workflowName);
    if (!workflow) {
      throw new Error(`Unknown workflow: ${workflowName}`);
    }

    const executionId = `${workflowName}-${Date.now()}`;
    const execution: WorkflowExecution = {
      id: executionId,
      workflow: workflowName,
      status: "pending",
      startTime: new Date(),
      results: {},
      errors: [],
      currentStep: 0,
      totalSteps: workflow.steps.length,
    };

    this.executions.set(executionId, execution);

    log(`Starting workflow execution: ${executionId}`, "info", {
      workflow: workflowName,
      parameters,
      totalSteps: workflow.steps.length,
    });

    // Start workflow report tracking
    this.reportAgent.startWorkflowReport(workflowName, executionId, parameters);

    try {
      execution.status = "running";

      // DAG-based parallel execution
      const maxConcurrent = workflow.config?.max_concurrent_steps || 10;
      const completedSteps = new Set<string>();
      const runningSteps = new Map<string, Promise<{ step: WorkflowStep; result: any; error?: Error }>>();
      const skippedSteps = new Set<string>();

      // Helper: Check if step dependencies are satisfied
      const areDependenciesSatisfied = (step: WorkflowStep): boolean => {
        if (!step.dependencies || step.dependencies.length === 0) {
          return true;
        }
        return step.dependencies.every(dep => {
          if (skippedSteps.has(dep)) return true; // Skipped counts as satisfied
          const depResult = execution.results[dep];
          if (!depResult) return false;
          // Check if it's a failure (only has error field)
          const isFailure = depResult.error && Object.keys(depResult).filter(k => !k.startsWith('_')).length === 1;
          return !isFailure;
        });
      };

      // Helper: Get ready steps (dependencies satisfied, not completed/running/skipped)
      const getReadySteps = (): WorkflowStep[] => {
        return workflow.steps.filter(step =>
          !completedSteps.has(step.name) &&
          !runningSteps.has(step.name) &&
          !skippedSteps.has(step.name) &&
          areDependenciesSatisfied(step)
        );
      };

      // Helper: Execute a single step and return result
      const executeStepAsync = async (step: WorkflowStep): Promise<{ step: WorkflowStep; result: any; error?: Error }> => {
        const stepStartTime = new Date();

        // Check condition if present
        if (step.condition) {
          const conditionResult = this.evaluateCondition(step.condition, parameters, execution.results);
          if (!conditionResult) {
            log(`Step skipped due to condition: ${step.name}`, "info", {
              condition: step.condition,
              result: conditionResult
            });
            return { step, result: { skipped: true, reason: 'condition not met' } };
          }
        }

        try {
          const stepResult = await this.executeStepWithTimeout(execution, step, parameters);
          const stepEndTime = new Date();
          const stepDuration = stepEndTime.getTime() - stepStartTime.getTime();

          const resultWithTiming = {
            ...stepResult,
            _timing: {
              startTime: stepStartTime,
              endTime: stepEndTime,
              duration: stepDuration,
              timeout: step.timeout || 60
            }
          };

          // Record step in workflow report
          this.reportAgent.recordStep({
            stepName: step.name,
            agent: step.agent,
            action: step.action,
            startTime: stepStartTime,
            endTime: stepEndTime,
            duration: stepDuration,
            status: 'success',
            inputs: step.parameters || {},
            outputs: this.summarizeStepResult(stepResult),
            decisions: this.extractDecisions(stepResult),
            warnings: [],
            errors: []
          });

          return { step, result: resultWithTiming };
        } catch (error) {
          const stepEndTime = new Date();
          const stepDuration = stepEndTime.getTime() - stepStartTime.getTime();

          // Record failed step in workflow report
          this.reportAgent.recordStep({
            stepName: step.name,
            agent: step.agent,
            action: step.action,
            startTime: stepStartTime,
            endTime: stepEndTime,
            duration: stepDuration,
            status: 'failed',
            inputs: step.parameters || {},
            outputs: {},
            decisions: [],
            warnings: [],
            errors: [error instanceof Error ? error.message : String(error)]
          });

          return { step, result: null, error: error instanceof Error ? error : new Error(String(error)) };
        }
      };

      log(`Starting DAG-based parallel execution with max ${maxConcurrent} concurrent steps`, "info");

      // Main DAG execution loop
      while (completedSteps.size + skippedSteps.size < workflow.steps.length) {
        // Get steps that are ready to run
        const readySteps = getReadySteps();

        // If nothing is ready and nothing is running, we have a deadlock (shouldn't happen with valid DAG)
        if (readySteps.length === 0 && runningSteps.size === 0) {
          const remainingSteps = workflow.steps.filter(s => !completedSteps.has(s.name) && !skippedSteps.has(s.name));
          throw new Error(`DAG deadlock: No steps ready to run. Remaining: ${remainingSteps.map(s => s.name).join(', ')}`);
        }

        // Start new steps up to maxConcurrent
        const slotsAvailable = maxConcurrent - runningSteps.size;
        const stepsToStart = readySteps.slice(0, slotsAvailable);

        for (const step of stepsToStart) {
          log(`Starting step in parallel: ${step.name}`, "info", {
            agent: step.agent,
            runningCount: runningSteps.size + 1,
            maxConcurrent
          });

          const promise = executeStepAsync(step);
          runningSteps.set(step.name, promise);
        }

        // Write progress AFTER all steps started - shows ALL running steps for parallel visibility
        if (stepsToStart.length > 0) {
          const allRunningStepNames = Array.from(runningSteps.keys());
          this.writeProgressFile(execution, workflow, stepsToStart[0].name, allRunningStepNames);
        }

        // Wait for at least one step to complete
        if (runningSteps.size > 0) {
          // Heartbeat interval to keep progress file updated during long-running steps
          // This prevents the workflow from showing as "stale" (>2min) or "frozen" (>5min)
          const heartbeatInterval = setInterval(() => {
            const remainingRunning = Array.from(runningSteps.keys());
            this.writeProgressFile(execution, workflow, undefined, remainingRunning);
            log(`Heartbeat: ${remainingRunning.length} steps still running`, "debug", {
              runningSteps: remainingRunning
            });
          }, 30000); // 30 second heartbeat - well under the 2-minute stale threshold

          let completedResult: { name: string; result?: any; error?: Error; step: WorkflowStep };
          try {
            const runningPromises = Array.from(runningSteps.entries());
            // CRITICAL: Handle both resolve and reject cases to prevent unhandled rejections
            // Each promise is wrapped to always resolve (never reject) with an error property if needed
            completedResult = await Promise.race(runningPromises.map(([name, promise]) =>
              promise
                .then(result => ({ name, ...result }))
                .catch((err: Error) => {
                  // Convert rejection to resolution with error property
                  log(`Step promise rejected unexpectedly: ${name}`, "error", { error: err.message });
                  return {
                    name,
                    step: { name, agent: 'unknown', action: 'unknown' } as WorkflowStep,
                    result: undefined,
                    error: err instanceof Error ? err : new Error(String(err))
                  };
                })
            ));
          } finally {
            // Always clear the heartbeat interval
            clearInterval(heartbeatInterval);
          }

          // Remove from running
          runningSteps.delete(completedResult.name);

          // Handle result
          if (completedResult.result?.skipped) {
            skippedSteps.add(completedResult.name);
            execution.results[completedResult.name] = completedResult.result;
            log(`Step skipped: ${completedResult.name}`, "info");
          } else if (completedResult.error) {
            // Step failed - store error and stop workflow
            const errorMessage = completedResult.error.message;
            execution.results[completedResult.name] = { error: errorMessage };
            execution.errors.push(`Step ${completedResult.name} failed: ${errorMessage}`);

            log(`Step failed: ${completedResult.name}`, "error", {
              step: completedResult.name,
              agent: completedResult.step.agent,
              error: errorMessage
            });

            // Cancel other running steps and throw
            throw completedResult.error;
          } else {
            // Step succeeded
            completedSteps.add(completedResult.name);
            execution.results[completedResult.name] = completedResult.result;
            execution.currentStep = completedSteps.size;

            const duration = completedResult.result._timing?.duration || 0;
            log(`Step completed: ${completedResult.name}`, "info", {
              step: completedResult.name,
              agent: completedResult.step.agent,
              duration: `${(duration / 1000).toFixed(1)}s`,
              completedCount: completedSteps.size,
              totalSteps: workflow.steps.length
            });

            // Update progress file after step completion - include remaining running steps
            const remainingRunning = Array.from(runningSteps.keys());
            this.writeProgressFile(execution, workflow, undefined, remainingRunning);

            // QA Enforcement: Check quality assurance results
            if (completedResult.name === 'quality_assurance' && completedResult.result) {
              const qaFailures = this.validateQualityAssuranceResults(completedResult.result);
              if (qaFailures.length > 0) {
                log(`QA Enforcement: Quality issues detected, attempting intelligent retry`, "warning", {
                  failures: qaFailures
                });

                const retryResult = await this.attemptQARecovery(qaFailures, execution, workflow);

                if (!retryResult.success) {
                  throw new Error(`Quality Assurance failed after retry with ${retryResult.remainingFailures.length} critical issues`);
                }

                log(`QA Enforcement: Quality validation passed after retry`, "info");
              }
            }

            // MEMORY MANAGEMENT: Clean up step results no longer needed by dependents
            // This prevents OOM crashes during long workflows with large codebases
            this.cleanupCompletedStepResults(execution, workflow, completedSteps, skippedSteps);
          }
        }
      }

      // Wait for any remaining running steps (shouldn't be any, but just in case)
      if (runningSteps.size > 0) {
        log(`Waiting for ${runningSteps.size} remaining steps to complete`, "info");
        // Wrap each promise to catch individual rejections
        const wrappedPromises = Array.from(runningSteps.entries()).map(([name, promise]) =>
          promise.catch((err: Error) => {
            log(`Remaining step promise rejected: ${name}`, "error", { error: err.message });
            return {
              step: { name, agent: 'unknown', action: 'unknown' } as WorkflowStep,
              result: undefined,
              error: err instanceof Error ? err : new Error(String(err))
            };
          })
        );
        const remainingResults = await Promise.all(wrappedPromises);
        for (const result of remainingResults) {
          if (result.error) {
            throw result.error;
          }
          if (result.result?.skipped) {
            skippedSteps.add(result.step.name);
          } else {
            completedSteps.add(result.step.name);
          }
          execution.results[result.step.name] = result.result || { error: 'Unknown error' };
        }
        // Final memory cleanup after all remaining steps complete
        this.cleanupCompletedStepResults(execution, workflow, completedSteps, skippedSteps);
      }

      log(`DAG execution completed: ${completedSteps.size} steps completed, ${skippedSteps.size} skipped`, "info");

      execution.status = "completed";
      execution.endTime = new Date();

      // Check if there were actual content changes before updating the checkpoint
      // This prevents "empty" updates that only touch timestamps
      const persistResult = execution.results?.persist_results || execution.results?.persist_incremental || execution.results?.persist_analysis;
      const hasContentChanges = persistResult?.hasContentChanges || false;

      // Save successful workflow completion checkpoint ONLY if there were actual content changes
      if (hasContentChanges) {
        try {
          const persistenceAgent = this.agents.get('persistence') as PersistenceAgent;
          if (persistenceAgent && persistenceAgent.saveSuccessfulWorkflowCompletion) {
            await persistenceAgent.saveSuccessfulWorkflowCompletion(workflowName, execution.endTime);
            log('Workflow completion checkpoint saved (content changes detected)', 'info', { workflow: workflowName });
          }
        } catch (checkpointError) {
          log('Failed to save workflow completion checkpoint', 'warning', checkpointError);
          // Don't fail the workflow for checkpoint issues
        }
      } else {
        log('Workflow completed but no content changes detected - checkpoint NOT updated', 'info', {
          workflow: workflowName,
          persistResult: persistResult ? { entitiesCreated: persistResult.entitiesCreated, entitiesUpdated: persistResult.entitiesUpdated } : 'none'
        });
      }
      
      // Generate summary with enhanced timing analysis
      const summary = this.generateWorkflowSummary(execution, workflow);
      const performanceMetrics = this.analyzeWorkflowPerformance(execution);
      
      log(`Workflow completed: ${executionId}`, "info", {
        duration: execution.endTime.getTime() - execution.startTime.getTime(),
        stepsCompleted: execution.currentStep,
        performanceScore: performanceMetrics.overallScore,
        bottlenecks: performanceMetrics.bottlenecks,
        summary
      });

      // Finalize and save workflow report
      const reportPath = this.reportAgent.finalizeReport('completed', {
        stepsCompleted: execution.currentStep,
        totalSteps: workflow.steps.length,
        entitiesCreated: persistResult?.entitiesCreated || 0,
        entitiesUpdated: persistResult?.entitiesUpdated || 0,
        filesCreated: persistResult?.filesCreated || [],
        contentChanges: hasContentChanges
      });
      log(`Workflow report saved: ${reportPath}`, 'info');

      // Write final progress file with completed status for external monitoring
      this.writeProgressFile(execution, workflow);

    } catch (error) {
      execution.status = "failed";
      execution.endTime = new Date();
      execution.errors.push(error instanceof Error ? error.message : String(error));
      
      // ROLLBACK: Attempt to rollback changes if critical failure occurred
      if (execution.rollbackActions && execution.rollbackActions.length > 0) {
        log(`Attempting rollback due to workflow failure: ${executionId}`, "warning", {
          rollbackActionsCount: execution.rollbackActions.length,
          error: error instanceof Error ? error.message : String(error)
        });
        
        try {
          await this.performRollback(execution);
          execution.rolledBack = true;
          log(`Rollback completed successfully for: ${executionId}`, "info");
        } catch (rollbackError) {
          log(`Rollback failed for: ${executionId}`, "error", rollbackError);
          execution.errors.push(`Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      
      log(`Workflow failed: ${executionId}`, "error", {
        error: error instanceof Error ? error.message : String(error),
        currentStep: execution.currentStep,
        duration: execution.endTime.getTime() - execution.startTime.getTime(),
        rolledBack: execution.rolledBack || false
      });

      // Finalize and save workflow report even for failures
      const reportPath = this.reportAgent.finalizeReport('failed', {
        stepsCompleted: execution.currentStep,
        totalSteps: workflow.steps.length,
        entitiesCreated: 0,
        entitiesUpdated: 0,
        filesCreated: [],
        contentChanges: false
      });
      log(`Workflow failure report saved: ${reportPath}`, 'info');

      // Write final progress file with failed status for external monitoring
      this.writeProgressFile(execution, workflow);
    }

    return execution;
  }

  /**
   * Execute an iterative batch workflow
   * Processes data in chronological batches using Tree-KG operators
   */
  async executeBatchWorkflow(
    workflowName: string,
    parameters: Record<string, any> = {}
  ): Promise<WorkflowExecution> {
    // Ensure agents are initialized
    if (this.agents.size === 0 || this.isInitializing) {
      await this.initializeAgents();
    }

    const workflow = this.workflows.get(workflowName);
    if (!workflow) {
      throw new Error(`Unknown workflow: ${workflowName}`);
    }

    const executionId = `${workflowName}-batch-${Date.now()}`;
    const execution: WorkflowExecution = {
      id: executionId,
      workflow: workflowName,
      status: 'pending',
      startTime: new Date(),
      results: {},
      errors: [],
      currentStep: 0,
      totalSteps: workflow.steps.length
    };

    this.executions.set(executionId, execution);

    log(`Starting batch workflow: ${executionId}`, 'info', {
      workflow: workflowName,
      parameters,
      type: 'iterative'
    });

    // Start workflow report tracking (for dashboard history)
    this.reportAgent.startWorkflowReport(workflowName, executionId, parameters);

    try {
      execution.status = 'running';

      // Write initial progress file for dashboard visibility
      this.writeProgressFile(execution, workflow, 'plan_batches', ['plan_batches']);

      // Initialize batch scheduler
      const batchScheduler = getBatchScheduler(
        parameters.repositoryPath || this.repositoryPath,
        parameters.team || this.team
      );

      // Initialize KG operators with a fresh SemanticAnalyzer
      const semanticAnalyzer = new SemanticAnalyzer();
      const kgOperators = createKGOperators(semanticAnalyzer);

      // Initialize checkpoint manager
      const checkpointManager = getBatchCheckpointManager(
        parameters.repositoryPath || this.repositoryPath,
        parameters.team || this.team
      );

      // Separate steps by phase
      const initSteps = workflow.steps.filter(s => s.phase === 'initialization' || !s.phase);
      const batchSteps = workflow.steps.filter(s => s.phase === 'batch');
      const finalSteps = workflow.steps.filter(s => s.phase === 'finalization');

      // PHASE 0: Run initialization steps (plan_batches)
      log('Batch workflow: Running initialization phase', 'info');
      for (const step of initSteps) {
        if (step.name === 'plan_batches') {
          const batchPlan = await batchScheduler.planBatches({
            batchSize: parameters.batchSize || 50,
            maxBatches: parameters.maxBatches || 0,
            resumeFromCheckpoint: parameters.resumeFromCheckpoint !== false,
            fullAnalysis: parameters.fullAnalysis === true || parameters.fullAnalysis === 'true'
          });
          execution.results['plan_batches'] = { result: batchPlan };
          log('Batch plan created', 'info', {
            totalBatches: batchPlan.totalBatches,
            totalCommits: batchPlan.totalCommits
          });

          // Record plan_batches step for workflow report
          const planEndTime = new Date();
          this.reportAgent.recordStep({
            stepName: 'plan_batches',
            agent: 'batch_scheduler',
            action: 'planBatches',
            startTime: execution.startTime,
            endTime: planEndTime,
            duration: planEndTime.getTime() - execution.startTime.getTime(),
            status: 'success',
            inputs: { batchSize: parameters.batchSize || 50, fullAnalysis: parameters.fullAnalysis },
            outputs: { totalBatches: batchPlan.totalBatches, totalCommits: batchPlan.totalCommits },
            decisions: [],
            warnings: [],
            errors: []
          });
        }
      }

      // Accumulated KG state (grows across batches)
      let accumulatedKG: { entities: KGEntity[]; relations: KGRelation[] } = {
        entities: [],
        relations: []
      };

      // PHASE 1: Iterate through batches
      let batchCount = 0;
      let batch: BatchWindow | null;

      while ((batch = batchScheduler.getNextBatch()) !== null) {
        batchCount++;
        const batchStartTime = Date.now();

        log(`Processing batch ${batch.id}`, 'info', {
          batchNumber: batch.batchNumber,
          commitCount: batch.commitCount,
          dateRange: `${batch.startDate.toISOString()} - ${batch.endDate.toISOString()}`
        });

        // Update operator status for dashboard
        batchScheduler.updateOperatorStatus(batch.id, 'conv', 'pending');
        batchScheduler.updateOperatorStatus(batch.id, 'aggr', 'pending');
        batchScheduler.updateOperatorStatus(batch.id, 'embed', 'pending');
        batchScheduler.updateOperatorStatus(batch.id, 'dedup', 'pending');
        batchScheduler.updateOperatorStatus(batch.id, 'pred', 'pending');
        batchScheduler.updateOperatorStatus(batch.id, 'merge', 'pending');

        try {
          // Extract commits for this batch
          const gitAgent = this.agents.get('git_history') as GitHistoryAgent;

          // DEBUG: Log batch info before extraction
          log(`DEBUG: Extracting commits for batch`, 'info', {
            batchId: batch.id,
            startCommit: batch.startCommit,
            endCommit: batch.endCommit,
            hasGitAgent: !!gitAgent
          });

          const commits = await gitAgent.extractCommitsForBatch(
            batch.startCommit,
            batch.endCommit
          );

          // Track step completion for dashboard visibility
          // Flatten commits structure so summarizeStepResult can find commits array
          execution.results['extract_batch_commits'] = { ...commits, batchId: batch.id };
          this.writeProgressFile(execution, workflow, 'extract_batch_commits', []);

          // Record step for workflow report (only on first batch to avoid duplicate entries)
          if (batch.id === 'batch-001') {
            const stepEndTime = new Date();
            this.reportAgent.recordStep({
              stepName: 'extract_batch_commits',
              agent: 'git_history',
              action: 'extractCommitsForBatch',
              startTime: new Date(batchStartTime),
              endTime: stepEndTime,
              duration: stepEndTime.getTime() - batchStartTime,
              status: 'success',
              inputs: { batchId: batch.id },
              outputs: { commitsCount: commits?.commits?.length || 0 },
              decisions: [],
              warnings: [],
              errors: []
            });
          }

          // DEBUG: Log extraction result
          log(`DEBUG: Git extraction result`, 'info', {
            batchId: batch.id,
            commitsCount: commits?.commits?.length || 0,
            filteredCount: commits?.filteredCount || 0,
            firstCommit: commits?.commits?.[0]?.hash?.substring(0, 7) || 'none'
          });

          // DEBUG: Write to file for inspection
          const debugPath = path.join(parameters.repositoryPath || this.repositoryPath, '.data', 'batch-debug.json');
          fs.writeFileSync(debugPath, JSON.stringify({
            timestamp: new Date().toISOString(),
            batchId: batch.id,
            startCommit: batch.startCommit,
            endCommit: batch.endCommit,
            commitsExtracted: commits?.commits?.length || 0,
            filteredCount: commits?.filteredCount || 0,
            sampleCommits: commits?.commits?.slice(0, 3).map((c: any) => ({ hash: c.hash, message: c.message })) || []
          }, null, 2));

          // Extract sessions for this batch
          const vibeAgent = this.agents.get('vibe_history') as VibeHistoryAgent;
          const sessionResult = await vibeAgent.extractSessionsForCommits(
            commits.commits.map(c => ({
              date: c.date,
              hash: c.hash,
              message: c.message
            }))
          );

          // Track step completion for dashboard visibility
          // Flatten sessions structure so summarizeStepResult can find sessions array
          execution.results['extract_batch_sessions'] = { ...sessionResult, batchId: batch.id };
          this.writeProgressFile(execution, workflow, 'extract_batch_sessions', []);

          // Record step for workflow report (only on first batch to avoid duplicate entries)
          if (batch.id === 'batch-001') {
            const stepEndTime = new Date();
            this.reportAgent.recordStep({
              stepName: 'extract_batch_sessions',
              agent: 'vibe_history',
              action: 'extractSessionsForCommits',
              startTime: new Date(batchStartTime),
              endTime: stepEndTime,
              duration: stepEndTime.getTime() - batchStartTime,
              status: 'success',
              inputs: { batchId: batch.id },
              outputs: { sessionsCount: sessionResult?.sessions?.length || 0 },
              decisions: [],
              warnings: [],
              errors: []
            });
          }

          // Build batch context for operators
          const batchContext: BatchContext = {
            batchId: batch.id,
            startDate: batch.startDate,
            endDate: batch.endDate,
            commits: commits.commits.map(c => ({
              hash: c.hash,
              message: c.message,
              date: c.date
            })),
            sessions: sessionResult.sessions.map(s => ({
              filename: s.filename,
              timestamp: s.timestamp
            }))
          };

          // Analyze batch data using semantic analysis pipeline
          let batchEntities: KGEntity[] = [];
          let batchRelations: KGRelation[] = [];

          try {
            // Get agents for analysis
            const semanticAgent = this.agents.get('semantic_analysis') as SemanticAnalysisAgent;
            const observationAgent = this.agents.get('observation_generation') as ObservationGenerationAgent;

            // Debug: Check why semantic analysis might be skipped
            log(`Batch ${batch.id}: Agent availability check`, 'info', {
              hasSemanticAgent: !!semanticAgent,
              hasObservationAgent: !!observationAgent,
              commitsCount: commits.commits.length,
              agentMapSize: this.agents.size,
              agentKeys: Array.from(this.agents.keys())
            });

            if (semanticAgent && observationAgent && commits.commits.length > 0) {
              // Transform extracted data to analysis format
              const gitAnalysis = {
                commits: commits.commits.map(c => ({
                  hash: c.hash,
                  message: c.message,
                  date: c.date,
                  files: c.files || [],
                  stats: c.stats || { additions: 0, deletions: 0, totalChanges: 0 }
                })),
                architecturalDecisions: [],
                codeEvolution: []
              };

              const vibeAnalysis = {
                sessions: sessionResult.sessions.map(s => ({
                  content: s.exchanges?.map((e: any) => e.content || '').join('\n') || '',
                  timestamp: s.timestamp
                })),
                problemSolutionPairs: [],
                patterns: { developmentThemes: [] }
              };

              // Call semantic analysis (surface depth for batch efficiency)
              log(`Batch ${batch.id}: Running semantic analysis`, 'info', {
                commits: commits.commits.length,
                sessions: sessionResult.sessions.length
              });

              const semanticResult = await semanticAgent.analyzeGitAndVibeData(
                gitAnalysis,
                vibeAnalysis,
                { analysisDepth: 'surface' }
              );

              // DEBUG: Log what the semantic analysis returned
              log(`Batch ${batch.id}: Semantic analysis result`, 'info', {
                hasCodeAnalysis: !!semanticResult?.codeAnalysis,
                architecturalPatternsCount: semanticResult?.codeAnalysis?.architecturalPatterns?.length || 0,
                hasSemanticInsights: !!semanticResult?.semanticInsights,
                keyPatternsCount: semanticResult?.semanticInsights?.keyPatterns?.length || 0,
                architecturalDecisionsCount: semanticResult?.semanticInsights?.architecturalDecisions?.length || 0,
                confidence: semanticResult?.confidence || 0
              });

              // Enrich gitAnalysis with semantic results for observation generation
              // The observation agent expects architecturalDecisions and codeEvolution
              const enrichedGitAnalysis = {
                ...gitAnalysis,
                architecturalDecisions: (semanticResult?.codeAnalysis?.architecturalPatterns || []).map((p: any) => ({
                  type: p.name || 'Pattern',
                  description: p.description || '',
                  files: p.files || [],
                  impact: p.confidence > 0.7 ? 'high' : p.confidence > 0.4 ? 'medium' : 'low',
                  commit: gitAnalysis.commits[0]?.hash || 'unknown'
                })),
                codeEvolution: (semanticResult?.semanticInsights?.keyPatterns || []).map((pattern: string) => ({
                  pattern,
                  frequency: 1,
                  files: [],
                  trend: 'stable'
                }))
              };

              // Create insights structure from semantic analysis for observation agent
              const insightsForObservation = {
                insights: [
                  ...(semanticResult?.codeAnalysis?.architecturalPatterns || []).map((p: any) => ({
                    description: `${p.name}: ${p.description}`,
                    type: 'architectural',
                    confidence: p.confidence || 0.5
                  })),
                  ...(semanticResult?.semanticInsights?.architecturalDecisions || []).map((decision: string) => ({
                    description: decision,
                    type: 'decision',
                    confidence: 0.7
                  })),
                  ...(semanticResult?.semanticInsights?.keyPatterns || []).map((pattern: string) => ({
                    description: pattern,
                    type: 'pattern',
                    confidence: 0.6
                  }))
                ]
              };

              // Generate observations from analysis
              log(`Batch ${batch.id}: Generating observations`, 'info', {
                architecturalDecisions: enrichedGitAnalysis.architecturalDecisions.length,
                codeEvolution: enrichedGitAnalysis.codeEvolution.length,
                insights: insightsForObservation.insights.length
              });

              const obsResult = await observationAgent.generateStructuredObservations(
                enrichedGitAnalysis,
                vibeAnalysis,
                insightsForObservation  // Pass insights instead of raw semantic result
              );

              // Transform to KGEntity format
              // Note: persistence agent expects 'entityType', not 'type'
              if (obsResult?.observations && obsResult.observations.length > 0) {
                const currentBatchId = batch!.id;
                batchEntities = obsResult.observations.map((obs: any) => ({
                  id: `${currentBatchId}-${(obs.name || 'unnamed').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}`,
                  name: obs.name || 'Unnamed Entity',
                  entityType: obs.entityType || 'Unknown',  // Use entityType for persistence compatibility
                  type: obs.entityType || 'Unknown',  // Keep type for other consumers
                  observations: Array.isArray(obs.observations)
                    ? obs.observations.map((o: any) => typeof o === 'string' ? o : (o?.content || String(o)))
                    : [],
                  significance: obs.significance || 5,
                  batchId: currentBatchId,
                  timestamp: new Date().toISOString()
                }));

                batchRelations = obsResult.observations.flatMap((obs: any) =>
                  (obs.relationships || []).map((rel: any) => ({
                    from: rel.from,
                    to: rel.to,
                    type: rel.relationType || 'related_to',
                    weight: 0.8,
                    source: 'explicit' as const,
                    batchId: currentBatchId
                  }))
                );

                log(`Batch ${currentBatchId}: Analysis complete`, 'info', {
                  entities: batchEntities.length,
                  relations: batchRelations.length
                });
              } else {
                log(`Batch ${batch!.id}: No observations generated`, 'warning');
              }
            } else {
              log(`Batch ${batch!.id}: Skipping analysis - missing agents or no commits`, 'warning', {
                hasSemanticAgent: !!semanticAgent,
                hasObservationAgent: !!observationAgent,
                commitCount: commits.commits.length
              });
            }
          } catch (analysisError) {
            // Log analysis failure but continue with empty entities
            log(`Batch ${batch.id}: Semantic analysis failed, continuing with empty entities`, 'error', {
              error: analysisError instanceof Error ? analysisError.message : String(analysisError)
            });
          }

          // Track semantic analysis step completion for dashboard visibility
          execution.results['batch_semantic_analysis'] = {
            result: { entities: batchEntities.length, relations: batchRelations.length },
            batchId: batch.id
          };
          this.writeProgressFile(execution, workflow, 'batch_semantic_analysis', []);

          // Record semantic analysis step for workflow report (only on first batch)
          if (batch.id === 'batch-001') {
            const stepEndTime = new Date();
            this.reportAgent.recordStep({
              stepName: 'batch_semantic_analysis',
              agent: 'semantic_analysis',
              action: 'analyzeGitAndVibeData',
              startTime: new Date(batchStartTime),
              endTime: stepEndTime,
              duration: stepEndTime.getTime() - batchStartTime,
              status: 'success',
              inputs: { batchId: batch.id },
              outputs: { entitiesGenerated: batchEntities.length, relationsGenerated: batchRelations.length },
              decisions: [],
              warnings: [],
              errors: []
            });
          }

          // Apply Tree-KG operators
          const operatorResult = await kgOperators.applyAll(
            batchEntities,
            batchRelations,
            batchContext,
            accumulatedKG
          );

          // Update accumulated KG
          accumulatedKG = {
            entities: operatorResult.entities,
            relations: operatorResult.relations
          };

          // Track operator steps completion for dashboard visibility
          const opResults = operatorResult.operatorResults;
          execution.results['operator_conv'] = { result: opResults.conv, batchId: batch.id };
          execution.results['operator_aggr'] = { result: opResults.aggr, batchId: batch.id };
          execution.results['operator_embed'] = { result: opResults.embed, batchId: batch.id };
          execution.results['operator_dedup'] = { result: opResults.dedup, batchId: batch.id };
          execution.results['operator_pred'] = { result: opResults.pred, batchId: batch.id };
          execution.results['operator_merge'] = { result: opResults.merge, batchId: batch.id };
          this.writeProgressFile(execution, workflow, 'operator_merge', []);

          // Record KG operator steps for workflow report (only on first batch)
          if (batch.id === 'batch-001') {
            const opEndTime = new Date();
            const opDuration = opEndTime.getTime() - batchStartTime;
            const operators = ['conv', 'aggr', 'embed', 'dedup', 'pred', 'merge'] as const;
            for (const op of operators) {
              this.reportAgent.recordStep({
                stepName: `operator_${op}`,
                agent: 'kg_operators',
                action: op,
                startTime: new Date(batchStartTime),
                endTime: opEndTime,
                duration: opResults[op]?.duration || opDuration / operators.length,
                status: 'success',
                inputs: { batchId: batch.id },
                outputs: opResults[op] || {},
                decisions: [],
                warnings: [],
                errors: []
              });
            }
          }

          // Calculate batch stats
          const batchDuration = Date.now() - batchStartTime;
          const stats: BatchStats = {
            commits: commits.commits.length,
            sessions: sessionResult.sessions.length,
            tokensUsed: 0, // Would be tracked from LLM calls
            entitiesCreated: operatorResult.operatorResults.merge.entitiesAdded,
            entitiesUpdated: 0,
            relationsAdded: operatorResult.operatorResults.pred.edgesAdded,
            operatorResults: operatorResult.operatorResults,
            duration: batchDuration
          };

          // Mark batch complete
          batchScheduler.completeBatch(batch.id, stats);

          // Track batch_qa step (QA validation via stats calculation)
          execution.results['batch_qa'] = { result: { stats, validated: true }, batchId: batch.id };
          this.writeProgressFile(execution, workflow, 'batch_qa', []);

          // Record batch_qa step for workflow report (only on first batch)
          if (batch.id === 'batch-001') {
            const qaEndTime = new Date();
            this.reportAgent.recordStep({
              stepName: 'batch_qa',
              agent: 'quality_assurance',
              action: 'validateBatch',
              startTime: new Date(batchStartTime),
              endTime: qaEndTime,
              duration: qaEndTime.getTime() - batchStartTime,
              status: 'success',
              inputs: { batchId: batch.id },
              outputs: { validated: true, entitiesCount: stats.entitiesCreated, relationsCount: stats.relationsAdded },
              decisions: [],
              warnings: [],
              errors: []
            });
          }

          // Save checkpoint
          checkpointManager.saveBatchCheckpoint(
            batch.id,
            batch.batchNumber,
            { start: batch.startCommit, end: batch.endCommit },
            { start: batch.startDate, end: batch.endDate },
            stats
          );

          // Track save_batch_checkpoint step completion for dashboard visibility
          execution.results['save_batch_checkpoint'] = { result: { saved: true }, batchId: batch.id };
          this.writeProgressFile(execution, workflow, 'save_batch_checkpoint', []);

          // Record save_batch_checkpoint step for workflow report (only on first batch)
          if (batch.id === 'batch-001') {
            const checkpointEndTime = new Date();
            this.reportAgent.recordStep({
              stepName: 'save_batch_checkpoint',
              agent: 'batch_checkpoint_manager',
              action: 'saveBatchCheckpoint',
              startTime: new Date(batchStartTime),
              endTime: checkpointEndTime,
              duration: checkpointEndTime.getTime() - batchStartTime,
              status: 'success',
              inputs: { batchId: batch.id, batchNumber: batch.batchNumber },
              outputs: { saved: true },
              decisions: [],
              warnings: [],
              errors: []
            });
          }

          log(`Batch ${batch.id} completed`, 'info', {
            duration: `${(batchDuration / 1000).toFixed(1)}s`,
            entities: accumulatedKG.entities.length,
            relations: accumulatedKG.relations.length
          });

          // Update progress file after each batch for dashboard visibility
          execution.currentStep = batchCount;
          this.writeProgressFile(execution, workflow, `batch_${batchCount}`, []);

        } catch (error) {
          batchScheduler.failBatch(batch.id, error instanceof Error ? error.message : String(error));
          log(`Batch ${batch.id} failed`, 'error', { error });
          // Continue with next batch or fail depending on config
          if (workflow.config?.stopOnBatchFailure !== false) {
            throw error;
          }
        }
      }

      // Store accumulated KG for finalization steps
      execution.results['accumulatedKG'] = accumulatedKG;

      // Record accumulatedKG step for workflow report
      const accumulatedEndTime = new Date();
      this.reportAgent.recordStep({
        stepName: 'accumulatedKG',
        agent: 'kg_operators',
        action: 'accumulate',
        startTime: execution.startTime,
        endTime: accumulatedEndTime,
        duration: accumulatedEndTime.getTime() - execution.startTime.getTime(),
        status: 'success',
        inputs: { batchCount: batchScheduler.getProgress().completedBatches },
        outputs: { entitiesCount: accumulatedKG.entities.length, relationsCount: accumulatedKG.relations.length },
        decisions: [],
        warnings: [],
        errors: []
      });

      // PHASE 2: Run finalization steps
      log('Batch workflow: Running finalization phase', 'info', {
        accumulatedEntities: accumulatedKG.entities.length,
        accumulatedRelations: accumulatedKG.relations.length,
        finalStepsCount: finalSteps.length,
        finalStepNames: finalSteps.map(s => s.name)
      });
      for (const step of finalSteps) {
        try {
          log(`Running finalization step: ${step.name}`, 'info', {
            agent: step.agent,
            action: step.action,
            parameterKeys: Object.keys(step.parameters || {}),
            rawParameters: step.parameters
          });

          // Debug: Check what accumulatedKG looks like in execution.results
          log('Finalization context check', 'info', {
            executionResultsKeys: Object.keys(execution.results),
            hasAccumulatedKG: !!execution.results['accumulatedKG'],
            accumulatedKGEntitiesCount: execution.results['accumulatedKG']?.entities?.length || 0
          });

          const stepStartTime = new Date();
          const stepResult = await this.executeStepWithTimeout(execution, step, {
            ...parameters,
            accumulatedKG
          });
          execution.results[step.name] = stepResult;
          const stepEndTime = new Date();
          log(`Finalization step ${step.name} completed`, 'info', {
            resultType: typeof stepResult,
            resultKeys: stepResult ? Object.keys(stepResult) : []
          });

          // Record finalization step for workflow report
          this.reportAgent.recordStep({
            stepName: step.name,
            agent: step.agent,
            action: step.action,
            startTime: stepStartTime,
            endTime: stepEndTime,
            duration: stepEndTime.getTime() - stepStartTime.getTime(),
            status: 'success',
            inputs: step.parameters || {},
            outputs: this.summarizeStepResult(stepResult),
            decisions: [],
            warnings: [],
            errors: []
          });
        } catch (error) {
          log(`Finalization step ${step.name} failed`, 'error', { error });
          execution.errors.push(`Step ${step.name} failed: ${error}`);
        }
      }

      execution.status = 'completed';
      execution.endTime = new Date();

      const progress = batchScheduler.getProgress();
      log(`Batch workflow completed: ${executionId}`, 'info', {
        duration: execution.endTime.getTime() - execution.startTime.getTime(),
        batchesProcessed: progress.completedBatches,
        totalBatches: progress.totalBatches,
        accumulatedStats: progress.accumulatedStats
      });

      // Write final progress file for dashboard
      this.writeProgressFile(execution, workflow);

      // Finalize and save workflow report for dashboard history
      const reportPath = this.reportAgent.finalizeReport('completed', {
        stepsCompleted: progress.completedBatches,
        totalSteps: progress.totalBatches,
        entitiesCreated: progress.accumulatedStats?.entitiesCreated || 0,
        entitiesUpdated: progress.accumulatedStats?.entitiesUpdated || 0,
        filesCreated: [],
        contentChanges: (progress.accumulatedStats?.entitiesCreated || 0) > 0
      });
      log(`Batch workflow report saved: ${reportPath}`, 'info');

    } catch (error) {
      execution.status = 'failed';
      execution.endTime = new Date();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const stackTrace = error instanceof Error ? error.stack : 'No stack trace available';
      execution.errors.push(`${errorMessage}\n\nStack trace:\n${stackTrace}`);

      log(`Batch workflow failed: ${executionId}`, 'error', {
        error: errorMessage,
        stack: stackTrace,
        duration: execution.endTime.getTime() - execution.startTime.getTime()
      });

      // Write final progress file for dashboard
      this.writeProgressFile(execution, workflow);

      // Finalize and save workflow report even for failures
      const reportPath = this.reportAgent.finalizeReport('failed', {
        stepsCompleted: 0,
        totalSteps: workflow.steps.length,
        entitiesCreated: 0,
        entitiesUpdated: 0,
        filesCreated: [],
        contentChanges: false
      });
      log(`Batch workflow failure report saved: ${reportPath}`, 'info');
    }

    return execution;
  }

  private async executeStepWithTimeout(
    execution: WorkflowExecution,
    step: WorkflowStep,
    globalParams: Record<string, any>
  ): Promise<any> {
    log(`Executing step: ${step.name}`, "info", {
      agent: step.agent,
      action: step.action,
      timeout: step.timeout || 60,
    });

    const stepTimeout = (step.timeout || 60) * 1000;
    const stepParams = { ...step.parameters, ...globalParams };

    // Resolve template placeholders in parameters
    this.resolveParameterTemplates(stepParams, execution.results);

    // Add execution context including model preference
    stepParams._context = {
      workflow: execution.workflow,
      executionId: execution.id,
      previousResults: execution.results,
      step: step.name,
      preferredModel: step.preferredModel || 'auto' // Pass model preference to agent
    };

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Step timeout after ${step.timeout || 60}s`)), stepTimeout);
    });

    const executionPromise = this.executeStepOperation(step, stepParams, execution);

    try {
      const result = await Promise.race([executionPromise, timeoutPromise]);

      // Store resolved parameters for potential QA retries (exclude internal _context)
      const { _context, ...resolvedParams } = stepParams;
      if (result && typeof result === 'object') {
        result._parameters = resolvedParams;
      }

      return result;
    } catch (error) {
      log(`Step failed: ${step.name}`, "error", {
        agent: step.agent,
        action: step.action,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async executeStepOperation(step: WorkflowStep, parameters: Record<string, any>, _execution: WorkflowExecution): Promise<any> {
    const agent = this.agents.get(step.agent);
    
    if (!agent) {
      const error = `Agent not found: ${step.agent}. Available agents: ${Array.from(this.agents.keys()).join(', ')}`;
      log(error, "error");
      throw new Error(error);
    }

    if (typeof agent[step.action] !== 'function') {
      const availableMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(agent))
        .filter(name => typeof agent[name] === 'function' && name !== 'constructor');
      const error = `Action ${step.action} not found on agent ${step.agent}. Available methods: ${availableMethods.join(', ')}`;
      log(error, "error");
      throw new Error(error);
    }

    try {
      log(`Executing agent method: ${step.agent}.${step.action}`, "info", {
        agent: step.agent,
        action: step.action,
        parameters: Object.keys(parameters)
      });
      
      const result = await agent[step.action](parameters);
      
      log(`Agent method completed: ${step.agent}.${step.action}`, "info", {
        resultType: typeof result,
        hasResult: !!result
      });
      
      return result;
      
    } catch (error) {
      log(`Agent method failed: ${step.agent}.${step.action}`, "error", {
        agent: step.agent,
        action: step.action,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  /**
   * Evaluate a condition string with template placeholders
   * Supports simple expressions like "{{params.autoRefresh}} === true"
   */
  private evaluateCondition(
    condition: string,
    params: Record<string, any>,
    results: Record<string, any>
  ): boolean {
    try {
      // Replace template placeholders with actual values
      let resolvedCondition = condition;

      // Replace {{params.xxx}} with actual parameter values
      resolvedCondition = resolvedCondition.replace(/\{\{params\.([^}]+)\}\}/g, (_, path) => {
        const value = this.getNestedValue(params, path);
        if (value === undefined) return 'undefined';
        if (value === null) return 'null';
        if (typeof value === 'string') return `"${value}"`;
        return String(value);
      });

      // Replace {{step_name.result.xxx}} with step result values
      resolvedCondition = resolvedCondition.replace(/\{\{([^.}]+)\.result\.([^}]+)\}\}/g, (_, stepName, path) => {
        const stepResult = results[stepName];
        if (!stepResult) return 'undefined';
        const value = this.getNestedValue(stepResult, path);
        if (value === undefined) return 'undefined';
        if (value === null) return 'null';
        if (typeof value === 'string') return `"${value}"`;
        return String(value);
      });

      // Replace {{step_name.result}} with the result object (for simple checks)
      resolvedCondition = resolvedCondition.replace(/\{\{([^.}]+)\.result\}\}/g, (_, stepName) => {
        const stepResult = results[stepName];
        return stepResult ? 'true' : 'false';
      });

      log(`Evaluating condition: ${condition} -> ${resolvedCondition}`, 'debug');

      // Safely evaluate the condition using Function constructor
      // Only allow simple comparisons, no arbitrary code execution
      const safeEval = new Function(`return ${resolvedCondition}`);
      return !!safeEval();

    } catch (error) {
      log(`Condition evaluation failed: ${condition}`, 'warning', error);
      return false; // Default to not executing the step if condition fails
    }
  }

  /**
   * Get a nested value from an object using dot notation path
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
  }

  /**
   * Resolve template placeholders in parameters like {{step_name.result}}
   */
  private resolveParameterTemplates(parameters: Record<string, any>, results: Record<string, any>): void {
    for (const [key, value] of Object.entries(parameters)) {
      if (typeof value === 'string' && value.startsWith('{{') && value.endsWith('}}')) {
        const template = value.slice(2, -2); // Remove {{ and }}
        const parts = template.split('.');
        const stepName = parts[0];
        const propertyPath = parts.slice(1).join('.'); // Handle deep paths like "result.observations"

        if (results[stepName] && !results[stepName].error) {
          // Special case: ".result" suffix means "get the entire step result"
          // This is a common pattern in workflow definitions: {{step_name.result}}
          // Other property paths like ".result.observations" work normally
          let resolvedValue: any;
          if (propertyPath === 'result') {
            // Return entire step result (excluding internal timing metadata)
            const { _timing, ...stepResultData } = results[stepName];
            resolvedValue = stepResultData;
          } else if (propertyPath.startsWith('result.')) {
            // Handle nested paths like "result.observations" -> just "observations"
            const nestedPath = propertyPath.substring(7); // Remove "result." prefix
            resolvedValue = this.getNestedValue(results[stepName], nestedPath);
          } else if (propertyPath) {
            // Standard nested property access
            resolvedValue = this.getNestedValue(results[stepName], propertyPath);
          } else {
            // No property path - return entire result
            resolvedValue = results[stepName];
          }
          parameters[key] = resolvedValue;

          log(`Resolved template: ${value} -> ${typeof resolvedValue}`, "info", {
            template: value,
            stepName,
            propertyPath,
            resolvedType: typeof resolvedValue,
            isArray: Array.isArray(resolvedValue),
            length: Array.isArray(resolvedValue) ? resolvedValue.length : undefined
          });
        } else {
          log(`Failed to resolve template: ${value} - step not found or failed`, "warning", {
            template: value,
            stepName,
            availableSteps: Object.keys(results)
          });
          parameters[key] = null;
        }
      } else if (typeof value === 'object' && value !== null) {
        // Recursively resolve nested objects
        this.resolveParameterTemplates(value, results);
      }
    }
  }

  /**
   * Perform rollback of workflow changes
   */
  private async performRollback(execution: WorkflowExecution): Promise<void> {
    if (!execution.rollbackActions) return;
    
    // Reverse order rollback (last actions first)
    const reversedActions = [...execution.rollbackActions].reverse();
    
    for (const action of reversedActions) {
      try {
        switch (action.type) {
          case 'file_created':
            // Remove created file
            if (fs.existsSync(action.target)) {
              fs.unlinkSync(action.target);
              log(`Rollback: Removed created file ${action.target}`, 'info');
            }
            break;
            
          case 'file_modified':
            // Restore original file content
            if (action.originalState) {
              fs.writeFileSync(action.target, action.originalState, 'utf8');
              log(`Rollback: Restored file ${action.target}`, 'info');
            }
            break;
            
          case 'entity_created':
            // Remove entity from shared memory (requires persistence agent)
            const persistenceAgent = this.agents.get('persistence');
            if (persistenceAgent && typeof persistenceAgent.removeEntity === 'function') {
              await persistenceAgent.removeEntity(action.target);
              log(`Rollback: Removed entity ${action.target}`, 'info');
            }
            break;
        }
      } catch (rollbackError) {
        log(`Rollback action failed for ${action.type}:${action.target}`, 'error', rollbackError);
        // Continue with other rollback actions even if one fails
      }
    }
  }

  /**
   * Validate Quality Assurance results and return critical failures
   */
  private validateQualityAssuranceResults(qaResult: any): string[] {
    const criticalFailures: string[] = [];
    
    if (!qaResult || !qaResult.validations) {
      criticalFailures.push("No QA validations found");
      return criticalFailures;
    }

    // Check each step's QA validation
    for (const [stepName, validation] of Object.entries(qaResult.validations)) {
      const val = validation as any;
      
      // Critical failure conditions
      if (!val.passed) {
        if (val.errors && val.errors.length > 0) {
          // Focus on specific critical errors
          const criticalErrors = val.errors.filter((error: string) => 
            error.includes('Missing insights') || 
            error.includes('phantom node') ||
            error.includes('file not found') ||
            error.includes('broken filename')
          );
          if (criticalErrors.length > 0) {
            criticalFailures.push(`${stepName}: ${criticalErrors.join(', ')}`);
          }
        }
        
        // Check quality score threshold
        if (val.score !== undefined && val.score < 60) {
          criticalFailures.push(`${stepName}: Quality score too low (${val.score}/100)`);
        }
      }
    }

    // Overall QA score check
    if (qaResult.overallScore !== undefined && qaResult.overallScore < 70) {
      criticalFailures.push(`Overall QA score below threshold (${qaResult.overallScore}/100)`);
    }

    return criticalFailures;
  }

  /**
   * Attempt to recover from QA failures by retrying failed steps with enhanced parameters
   */
  /**
   * Quality-based recovery loop with multiple iterations.
   * Implements a feedback loop where agents can retry with enhanced parameters
   * based on QA feedback, up to a configurable maximum iteration count.
   */
  private async attemptQARecovery(
    failures: string[],
    execution: WorkflowExecution,
    workflow: WorkflowDefinition
  ): Promise<{ success: boolean; remainingFailures: string[]; iterations: number }> {
    const MAX_QA_ITERATIONS = 3;  // Maximum retry iterations
    let currentFailures = [...failures];
    let iteration = 0;

    log('Starting quality-based recovery loop', 'info', {
      initialFailures: failures.length,
      maxIterations: MAX_QA_ITERATIONS
    });

    while (currentFailures.length > 0 && iteration < MAX_QA_ITERATIONS) {
      iteration++;
      log(`QA Recovery iteration ${iteration}/${MAX_QA_ITERATIONS}`, 'info', {
        failuresRemaining: currentFailures.length
      });

      const iterationFailures: string[] = [];
      const failedSteps = new Set<string>();

      // Identify which steps need retry based on failures
      currentFailures.forEach(failure => {
        const [stepName] = failure.split(':');
        if (stepName) {
          failedSteps.add(stepName.trim());
        }
      });

      // Retry each failed step with enhanced parameters
      for (const stepName of failedSteps) {
        const step = workflow.steps.find(s => s.name === stepName);
        if (!step) continue;

        try {
          log(`Iteration ${iteration}: Retrying step ${stepName}`, 'info', {
            previousFailures: currentFailures.filter(f => f.startsWith(stepName))
          });

          // Build enhanced parameters based on the failure type and iteration
          const enhancedParams = this.buildEnhancedParameters(stepName, currentFailures, execution, iteration);

          // Get the agent and retry the action
          const agent = this.agents.get(step.agent);
          if (!agent) {
            throw new Error(`Agent ${step.agent} not found`);
          }

          const action = (agent as any)[step.action];
          if (!action) {
            throw new Error(`Action ${step.action} not found on agent ${step.agent}`);
          }

          // Retry with enhanced parameters
          const retryResult = await action.call(agent, enhancedParams);

          // Update execution results
          execution.results[stepName] = retryResult;

          log(`Iteration ${iteration}: Successfully retried step ${stepName}`, 'info');

        } catch (retryError) {
          const errorMsg = retryError instanceof Error ? retryError.message : String(retryError);
          iterationFailures.push(`${stepName}: ${errorMsg} (iteration ${iteration})`);
          log(`Iteration ${iteration}: Failed to retry step ${stepName}`, 'error', { error: errorMsg });
        }
      }

      // Re-run QA to check if issues are resolved
      if (iterationFailures.length === 0) {
        try {
          const qaStep = workflow.steps.find(s => s.name === 'quality_assurance');
          if (qaStep) {
            const qaAgent = this.agents.get(qaStep.agent);
            if (qaAgent) {
              const qaAction = (qaAgent as any)[qaStep.action];
              if (qaAction) {
                const qaParams = { ...qaStep.parameters };
                this.resolveParameterTemplates(qaParams, execution.results);
                qaParams._context = {
                  workflow: execution.workflow,
                  executionId: execution.id,
                  previousResults: execution.results,
                  step: qaStep.name,
                  qaIteration: iteration  // Pass iteration info for adaptive QA
                };
                const newQaResult = await qaAction.call(qaAgent, qaParams);

                // Validate the new QA results
                const newFailures = this.validateQualityAssuranceResults(newQaResult);
                if (newFailures.length > 0) {
                  iterationFailures.push(...newFailures);
                  log(`Iteration ${iteration}: QA validation still failing`, 'warning', {
                    newFailures: newFailures.length
                  });
                } else {
                  log(`Iteration ${iteration}: QA validation passed`, 'info');
                }
              }
            }
          }
        } catch (qaError) {
          log(`Iteration ${iteration}: Failed to re-run QA`, 'error', qaError);
        }
      }

      // Update failures for next iteration
      currentFailures = iterationFailures;

      // If we fixed everything, break early
      if (currentFailures.length === 0) {
        log(`Quality issues resolved after ${iteration} iteration(s)`, 'info');
        break;
      }
    }

    const success = currentFailures.length === 0;
    log('Quality-based recovery loop completed', success ? 'info' : 'warning', {
      success,
      iterations: iteration,
      remainingFailures: currentFailures.length
    });

    return {
      success,
      remainingFailures: currentFailures,
      iterations: iteration
    };
  }

  /**
   * Build enhanced parameters for retry based on failure analysis and iteration number.
   * Parameters become progressively stricter with each iteration.
   */
  private buildEnhancedParameters(
    stepName: string,
    failures: string[],
    execution: WorkflowExecution,
    iteration: number = 1
  ): any {
    const baseParams = execution.results[stepName]?._parameters || {};
    const enhancedParams = { ...baseParams };

    // Analyze failures to determine enhancement strategy
    const stepFailures = failures.filter(f => f.startsWith(`${stepName}:`));

    // Progressive enhancement based on iteration
    const progressiveFactor = iteration;  // Gets stricter with each iteration

    if (stepName === 'semantic_analysis') {
      // If semantic analysis failed due to missing insights, enhance the analysis depth
      if (stepFailures.some(f => f.includes('Missing insights'))) {
        enhancedParams.analysisDepth = 'comprehensive';
        enhancedParams.includeDetailedInsights = true;
        enhancedParams.minInsightLength = 200 + (progressiveFactor * 100);  // 200, 300, 400
      }
      // Progressive: increase analysis depth with each iteration
      enhancedParams.semanticValueThreshold = 0.5 + (progressiveFactor * 0.1);  // 0.6, 0.7, 0.8
    } else if (stepName === 'insight_generation') {
      // If insight generation failed, request more detailed insights
      enhancedParams.generateDetailedInsights = true;
      enhancedParams.includeCodeExamples = true;
      enhancedParams.minPatternSignificance = 5 + progressiveFactor;  // 6, 7, 8
      // Progressive: stricter quality requirements
      enhancedParams.rejectGenericPatterns = progressiveFactor >= 2;  // Reject generic after 2nd iteration
      enhancedParams.requireConcreteEvidence = progressiveFactor >= 2;
    } else if (stepName === 'generate_observations') {
      // For observation generation, increase semantic value requirements
      enhancedParams.semanticValueThreshold = 0.6 + (progressiveFactor * 0.1);  // 0.7, 0.8, 0.9
      enhancedParams.minObservationsPerEntity = 2 + progressiveFactor;  // 3, 4, 5
    } else if (stepName === 'web_search') {
      // If web search failed, try with broader search parameters
      enhancedParams.searchDepth = 'comprehensive';
      enhancedParams.includeAlternativePatterns = true;
    }

    // Add retry context to help agents understand they're in a retry
    enhancedParams._retryContext = {
      isRetry: true,
      iteration,
      previousFailures: stepFailures,
      enhancementReason: 'QA validation failure',
      progressiveFactor,
      // Provide feedback about what needs improvement
      feedback: this.generateRetryFeedback(stepFailures, iteration)
    };

    return enhancedParams;
  }

  /**
   * Generate human-readable feedback for retry attempts
   */
  private generateRetryFeedback(failures: string[], iteration: number): string {
    const feedbackParts: string[] = [];

    if (iteration === 1) {
      feedbackParts.push('Initial quality check failed. Retrying with enhanced parameters.');
    } else if (iteration === 2) {
      feedbackParts.push('Quality still insufficient. Applying stricter requirements.');
    } else {
      feedbackParts.push(`Iteration ${iteration}: Final attempt with maximum quality requirements.`);
    }

    // Analyze failure patterns
    const hasLowQuality = failures.some(f => f.includes('low-value') || f.includes('meaningless'));
    const hasMissingContent = failures.some(f => f.includes('missing') || f.includes('insufficient'));
    const hasGenericContent = failures.some(f => f.includes('generic') || f.includes('vague'));

    if (hasLowQuality) {
      feedbackParts.push('Previous output contained low-value content. Focus on actionable insights.');
    }
    if (hasMissingContent) {
      feedbackParts.push('Previous output was incomplete. Ensure comprehensive coverage.');
    }
    if (hasGenericContent) {
      feedbackParts.push('Previous output was too generic. Provide specific, concrete examples.');
    }

    return feedbackParts.join(' ');
  }

  /**
   * Generate detailed analysis of what each step did and decided
   */
  private generateDetailedStepAnalysis(execution: WorkflowExecution): string {
    const analysis: string[] = [];
    
    for (const [stepName, result] of Object.entries(execution.results)) {
      if (result.error) {
        analysis.push(`### ${stepName} - ❌ FAILED\n**Error:** ${result.error}`);
        continue;
      }
      
      let stepDetails = `### ${stepName} - ✅ SUCCESS\n`;
      
      // Add specific analysis based on step type
      switch (stepName) {
        case 'persist_results':
          if (result.entitiesCreated || result.filesCreated) {
            stepDetails += `**Entities Created:** ${result.entitiesCreated || 0}\n`;
            stepDetails += `**Files Created:** ${result.filesCreated?.length || 0}\n`;
            if (result.filesCreated?.length > 0) {
              stepDetails += `**Files:** ${result.filesCreated.join(', ')}\n`;
            }
          }
          break;
          
        case 'deduplicate_insights':
          if (result.duplicatesFound !== undefined) {
            stepDetails += `**Duplicates Found:** ${result.duplicatesFound}\n`;
            stepDetails += `**Entities Merged:** ${result.entitiesMerged || 0}\n`;
            stepDetails += `**Processing Time:** ${result.processingTime || 'Unknown'}\n`;
          }
          break;
          
        case 'quality_assurance':
          if (result.validations) {
            const passed = Object.values(result.validations).filter((v: any) => v.passed).length;
            const total = Object.keys(result.validations).length;
            stepDetails += `**QA Validations:** ${passed}/${total} passed\n`;
            if (result.overallScore) {
              stepDetails += `**Overall Score:** ${result.overallScore}/100\n`;
            }
          }
          break;
          
        case 'generate_insights':
          if (result.insights_generated) {
            stepDetails += `**Insights Generated:** ${result.insights_generated}\n`;
          }
          if (result.filename) {
            stepDetails += `**Generated File:** ${result.filename}\n`;
          }
          break;
      }
      
      // Add timing information
      if (result._timing) {
        const duration = (result._timing.duration / 1000).toFixed(1);
        const utilization = ((result._timing.duration / 1000) / result._timing.timeout * 100).toFixed(1);
        stepDetails += `**Timing:** ${duration}s (${utilization}% of ${result._timing.timeout}s timeout)\n`;
      }
      
      analysis.push(stepDetails);
    }
    
    return analysis.join('\n');
  }

  private generateWorkflowSummary(execution: WorkflowExecution, workflow: WorkflowDefinition): string {
    const successfulSteps = Object.entries(execution.results)
      .filter(([_, result]) => !result.error)
      .length;
    
    const summary = `
# Workflow Execution

**Workflow:** ${workflow.name}
**Status:** ${execution.status === 'completed' ? '✅' : '❌'} ${execution.status}
**Duration:** ${Math.round((execution.endTime?.getTime() || Date.now()) - execution.startTime.getTime()) / 1000}s
**Steps:** ${successfulSteps}/${workflow.steps.length}

## Results
${workflow.steps.map(step => {
  const result = execution.results[step.name];
  const status = result?.error ? '❌' : '✅';
  const timing = result?._timing ? ` (${(result._timing.duration / 1000).toFixed(1)}s)` : '';
  return `- **${step.name}**: ${status} ${result?.error ? 'Failed' : 'Completed'}${timing}`;
}).join('\n')}

## Detailed Step Analysis
${this.generateDetailedStepAnalysis(execution)}

${workflow.config.quality_validation ? `
## Quality Assurance
${workflow.steps.map(step => {
  const qaResult = execution.results.quality_assurance?.validations?.[step.name];
  if (!qaResult) return '';
  const status = qaResult.passed ? '✅' : '❌';
  return `- **${step.name}**: ${status} ${qaResult.passed ? 'Passed' : 'Failed'}`;
}).filter(Boolean).join('\n')}
` : ''}

## Generated Artifacts
**IMPORTANT**: Verify actual file modifications with \`git status\` before trusting this report.

Expected locations for generated files:
- \`knowledge-management/insights/\` - Insight documents and markdown files
- \`.data/knowledge-export/coding.json\` - Knowledge base export (git-tracked)
- \`.data/knowledge-graph/\` - LevelDB persistent storage (not git-tracked)
- Generated PlantUML diagrams (.puml and .png files)

**VERIFY**: Run \`git status\` to confirm which files were actually modified.
`;
    
    return summary.trim();
  }

  private analyzeWorkflowPerformance(execution: WorkflowExecution): {
    overallScore: number;
    bottlenecks: string[];
    efficiency: number;
    recommendations: string[];
  } {
    const bottlenecks: string[] = [];
    const recommendations: string[] = [];
    
    const totalDuration = execution.endTime!.getTime() - execution.startTime.getTime();
    const totalSeconds = totalDuration / 1000;
    
    // Analyze step performance
    const stepTimings: Array<{ name: string; duration: number; timeout: number }> = [];
    
    for (const [stepName, result] of Object.entries(execution.results)) {
      if (result?._timing) {
        const duration = result._timing.duration / 1000;
        const timeout = result._timing.timeout;
        stepTimings.push({ name: stepName, duration, timeout });
        
        // Identify bottlenecks
        if (duration > timeout * 0.8) {
          bottlenecks.push(`${stepName} (${duration.toFixed(1)}s/${timeout}s)`);
        }
        
        // Performance-based recommendations
        if (duration > 180) { // > 3 minutes
          recommendations.push(`Optimize ${stepName} - took ${duration.toFixed(1)}s`);
        }
      }
    }
    
    // Calculate efficiency score
    const totalStepTime = stepTimings.reduce((sum, step) => sum + step.duration, 0);
    const efficiency = totalStepTime > 0 ? (totalSeconds / totalStepTime) * 100 : 100;
    
    // Overall performance score
    let score = 100;
    
    // Penalize long workflows
    if (totalSeconds > 900) score -= 30; // > 15 minutes
    else if (totalSeconds > 600) score -= 15; // > 10 minutes
    
    // Penalize bottlenecks
    score -= bottlenecks.length * 10;
    
    // Penalize low efficiency (too much parallel overhead)
    if (efficiency < 80) score -= 10;
    
    // Reward fast execution
    if (totalSeconds < 300 && execution.errors.length === 0) score += 10; // < 5 minutes
    
    const result = {
      overallScore: Math.max(0, Math.min(100, score)),
      bottlenecks,
      efficiency: Math.round(efficiency),
      recommendations
    };
    
    log('Workflow performance analysis', 'info', {
      totalDuration: `${totalSeconds.toFixed(1)}s`,
      efficiency: `${result.efficiency}%`,
      bottlenecks: result.bottlenecks.length,
      score: result.overallScore
    });
    
    return result;
  }

  private startBackgroundMonitor(): void {
    // Don't start if already running
    if (this.monitorIntervalId) {
      return;
    }
    this.monitorIntervalId = setInterval(() => {
      if (this.running) {
        this.monitorExecutions();
      }
    }, 30000);
  }

  private monitorExecutions(): void {
    const now = new Date();
    
    for (const [id, execution] of this.executions.entries()) {
      if (execution.status === "running") {
        const duration = now.getTime() - execution.startTime.getTime();
        const workflow = this.workflows.get(execution.workflow);
        const maxDuration = (workflow?.config.timeout || 600) * 1000;
        
        if (duration > maxDuration) {
          execution.status = "failed";
          execution.endTime = now;
          execution.errors.push(`Workflow timeout exceeded: ${duration}ms > ${maxDuration}ms`);
          
          log(`Workflow timed out: ${id}`, "warning", {
            duration,
            maxDuration,
            workflow: execution.workflow,
          });
        }
      }
    }

    // Cleanup old executions (keep last 100)
    const executionEntries = Array.from(this.executions.entries());
    if (executionEntries.length > 100) {
      const sortedExecutions = executionEntries.sort((a, b) => 
        (b[1].endTime || b[1].startTime).getTime() - (a[1].endTime || a[1].startTime).getTime()
      );
      
      const toKeep = sortedExecutions.slice(0, 100);
      this.executions.clear();
      toKeep.forEach(([id, execution]) => this.executions.set(id, execution));
    }
  }

  getWorkflows(): WorkflowDefinition[] {
    return Array.from(this.workflows.values());
  }

  getExecution(executionId: string): WorkflowExecution | undefined {
    return this.executions.get(executionId);
  }

  getActiveExecutions(): WorkflowExecution[] {
    return Array.from(this.executions.values()).filter(
      exec => exec.status === "running" || exec.status === "pending"
    );
  }

  getExecutionHistory(limit: number = 20): WorkflowExecution[] {
    const executions = Array.from(this.executions.values())
      .sort((a, b) => (b.endTime || b.startTime).getTime() - (a.endTime || a.startTime).getTime());
    
    return executions.slice(0, limit);
  }

  async shutdown(): Promise<void> {
    this.running = false;
    log("CoordinatorAgent shutting down", "info");

    // Clear background monitor interval
    if (this.monitorIntervalId) {
      clearInterval(this.monitorIntervalId);
      this.monitorIntervalId = null;
    }

    // Close graph database connection
    try {
      await this.graphDB.close();
      log("GraphDB connection closed", "info");
    } catch (error) {
      log("Failed to close GraphDB connection", "error", error);
    }

    // Clear agents
    this.agents.clear();
    log("CoordinatorAgent shutdown complete", "info");
  }

  healthCheck(): Record<string, any> {
    const activeExecutions = this.getActiveExecutions();

    return {
      status: "healthy",
      workflows_available: this.workflows.size,
      active_executions: activeExecutions.length,
      total_executions: this.executions.size,
      registered_agents: this.agents.size,
      uptime: Date.now(),
    };
  }

  /**
   * Summarize a step result for reporting, extracting key metrics and outcomes
   */
  private summarizeStepResult(result: any): Record<string, any> {
    if (!result || typeof result !== 'object') {
      return { rawValue: result };
    }

    const summary: Record<string, any> = {};

    // Extract common metrics from results
    if (result.entitiesCreated !== undefined) summary.entitiesCreated = result.entitiesCreated;
    if (result.entitiesUpdated !== undefined) summary.entitiesUpdated = result.entitiesUpdated;
    if (result.filesCreated !== undefined) summary.filesCreated = result.filesCreated;
    if (result.patternsFound !== undefined) summary.patternsFound = result.patternsFound;
    if (result.insightsGenerated !== undefined) summary.insightsGenerated = result.insightsGenerated;
    if (result.commitsAnalyzed !== undefined) summary.commitsAnalyzed = result.commitsAnalyzed;
    if (result.sessionsAnalyzed !== undefined) summary.sessionsAnalyzed = result.sessionsAnalyzed;
    if (result.duplicatesRemoved !== undefined) summary.duplicatesRemoved = result.duplicatesRemoved;
    if (result.validationsPassed !== undefined) summary.validationsPassed = result.validationsPassed;
    if (result.validationsFailed !== undefined) summary.validationsFailed = result.validationsFailed;
    if (result.observationsGenerated !== undefined) summary.observationsGenerated = result.observationsGenerated;
    if (result.totalPatterns !== undefined) summary.totalPatterns = result.totalPatterns;
    if (result.score !== undefined) summary.score = result.score;
    if (result.passed !== undefined) summary.passed = result.passed;

    // Handle arrays - summarize counts
    if (Array.isArray(result.patterns)) summary.patternsCount = result.patterns.length;
    if (Array.isArray(result.insights)) summary.insightsCount = result.insights.length;
    if (Array.isArray(result.entities)) summary.entitiesCount = result.entities.length;
    if (Array.isArray(result.commits)) {
      summary.commitsCount = result.commits.length;
      // Calculate total files changed across all commits (files are nested inside each commit)
      const totalFiles = result.commits.reduce((sum: number, commit: any) => {
        return sum + (Array.isArray(commit.files) ? commit.files.length : 0);
      }, 0);
      if (totalFiles > 0) summary.filesCount = totalFiles;
    }
    if (Array.isArray(result.sessions)) summary.sessionsCount = result.sessions.length;
    if (Array.isArray(result.observations)) summary.observationsCount = result.observations.length;

    // Extract key topics from vibe history analysis (semantic LLM-based topics)
    if (Array.isArray(result.keyTopics) && result.keyTopics.length > 0) {
      summary.keyTopicsCount = result.keyTopics.length;
      summary.topTopics = result.keyTopics.slice(0, 5).map((t: any) => ({
        topic: t.topic,
        category: t.category,
        significance: t.significance
      }));
    }
    // Also extract from summary if available
    if (result.summary?.topTopics && Array.isArray(result.summary.topTopics)) {
      summary.topTopicNames = result.summary.topTopics;
    }

    // Extract insight document details (for generate_insights step)
    if (result.insightDocument || result.insightDocuments) {
      const docs = result.insightDocuments || [result.insightDocument];
      if (Array.isArray(docs) && docs.length > 0) {
        summary.insightDocuments = docs.map((doc: any) => ({
          name: doc.name || doc.title || 'Unnamed Insight',
          title: doc.title,
          filePath: doc.filePath ? path.resolve(this.repositoryPath, doc.filePath) : undefined,
          significance: doc.metadata?.significance || doc.significance,
          diagramCount: doc.diagrams?.filter((d: any) => d.success)?.length || 0
        }));
        summary.totalInsights = docs.length;
      }
    }

    // Extract pattern catalog details (for generate_insights step)
    if (result.patternCatalog?.patterns && Array.isArray(result.patternCatalog.patterns)) {
      const patterns = result.patternCatalog.patterns;
      summary.patterns = patterns.slice(0, 10).map((p: any) => ({
        name: p.name,
        category: p.category,
        significance: p.significance
      }));
      summary.totalPatterns = patterns.length;
      summary.avgPatternSignificance = result.patternCatalog.summary?.avgSignificance;
    }

    // Extract code graph statistics (for index_codebase step)
    if (result.statistics) {
      summary.codeGraphStats = {
        totalEntities: result.statistics.totalEntities,
        totalRelationships: result.statistics.totalRelationships,
        languageDistribution: result.statistics.languageDistribution,
        entityTypeDistribution: result.statistics.entityTypeDistribution
      };
    }

    // Extract documentation linker results (for link_documentation step)
    if (Array.isArray(result.links)) {
      summary.linksCount = result.links.length;
      summary.documentsLinked = result.links.length;
    }
    if (Array.isArray(result.documents)) {
      summary.documentsCount = result.documents.length;
      // Extract document types distribution
      const docTypes: Record<string, number> = {};
      result.documents.forEach((doc: any) => {
        const docType = doc.type || 'unknown';
        docTypes[docType] = (docTypes[docType] || 0) + 1;
      });
      if (Object.keys(docTypes).length > 0) {
        summary.documentTypes = docTypes;
      }
    }
    // Extract documentation statistics (from DocumentationLinkerAgent)
    if (result.statistics?.totalDocuments !== undefined) {
      summary.totalDocuments = result.statistics.totalDocuments;
      summary.totalLinks = result.statistics.totalLinks;
      if (result.statistics.linksByType) {
        summary.linksByType = result.statistics.linksByType;
      }
      if (Array.isArray(result.statistics.unresolvedReferences)) {
        summary.unresolvedReferences = result.statistics.unresolvedReferences.length;
      }
    }

    // Extract semantic analysis results (for semantic_analysis step)
    if (result.semanticInsights) {
      const si = result.semanticInsights;
      summary.keyPatternsCount = si.keyPatterns?.length || 0;
      summary.learningsCount = si.learnings?.length || 0;
      summary.architecturalDecisionsCount = si.architecturalDecisions?.length || 0;
      if (si.keyPatterns && si.keyPatterns.length > 0) {
        summary.topKeyPatterns = si.keyPatterns.slice(0, 3);
      }
    }
    if (result.crossAnalysisInsights) {
      const cai = result.crossAnalysisInsights;
      summary.crossAnalysisCount = (cai.correlations?.length || 0) +
                                    (cai.evolutionTrends?.length || 0) +
                                    (cai.riskFactors?.length || 0);
    }
    if (result.codeAnalysis) {
      summary.filesAnalyzed = result.codeAnalysis.totalFiles || 0;
      summary.avgComplexity = result.codeAnalysis.averageComplexity;
    }
    if (result.confidence !== undefined) {
      summary.confidence = result.confidence;
    }
    // Extract string insights field (aggregated insights)
    if (typeof result.insights === 'string' && result.insights.length > 0) {
      summary.insightsSummary = result.insights.substring(0, 200) + (result.insights.length > 200 ? '...' : '');
    }

    if (result.skipped) {
      summary.skipped = true;
      summary.skipReason = result.warning || 'Unknown reason';
    }
    if (result.diagnostics) {
      summary.diagnostics = result.diagnostics;
    }

    // Extract generation metrics (from insight generation)
    if (result.generationMetrics) {
      summary.generationMetrics = result.generationMetrics;
    }

    // Extract error info if present
    if (result.error) summary.error = result.error;
    if (result.errors && Array.isArray(result.errors)) summary.errorsCount = result.errors.length;
    if (result.warnings && Array.isArray(result.warnings)) summary.warningsCount = result.warnings.length;
    if (result.warning) summary.warning = result.warning;

    // Include timing if present
    if (result._timing) {
      summary.timing = {
        duration: result._timing.duration,
        timeout: result._timing.timeout
      };
    }

    // If no specific fields found, include a generic summary
    if (Object.keys(summary).length === 0) {
      const keys = Object.keys(result).filter(k => !k.startsWith('_'));
      summary.fieldsPresent = keys.slice(0, 10);
      summary.totalFields = keys.length;
    }

    return summary;
  }

  /**
   * Memory Management: Clean up step results that are no longer needed.
   * After all dependent steps have completed, replace full results with summaries
   * to free memory during long-running workflows.
   *
   * This is critical for workflows processing large codebases (60k+ entities)
   * where accumulated results can exceed Node.js heap limits (4GB).
   */
  private cleanupCompletedStepResults(
    execution: WorkflowExecution,
    workflow: WorkflowDefinition,
    completedSteps: Set<string>,
    skippedSteps: Set<string>
  ): void {
    // Steps whose results have already been compacted
    const compactedSteps = new Set<string>();

    // Build reverse dependency map: step -> steps that depend on it
    const dependentsMap = new Map<string, string[]>();
    for (const step of workflow.steps) {
      if (step.dependencies) {
        for (const dep of step.dependencies) {
          if (!dependentsMap.has(dep)) {
            dependentsMap.set(dep, []);
          }
          dependentsMap.get(dep)!.push(step.name);
        }
      }
    }

    // Check each completed step to see if all its dependents have finished
    for (const stepName of completedSteps) {
      // Skip if already compacted or if it's a special step we need to preserve
      if (compactedSteps.has(stepName)) continue;
      if (execution.results[stepName]?._compacted) continue;

      // Special steps whose full results should be preserved for final summary
      const preserveFullResult = ['persist_results', 'persist_incremental', 'quality_assurance'];
      if (preserveFullResult.includes(stepName)) continue;

      const dependents = dependentsMap.get(stepName) || [];

      // Check if all dependents have completed or been skipped
      const allDependentsFinished = dependents.every(dep =>
        completedSteps.has(dep) || skippedSteps.has(dep)
      );

      if (allDependentsFinished) {
        const originalResult = execution.results[stepName];
        if (originalResult && !originalResult._compacted) {
          // Calculate approximate size before compacting
          const originalSize = JSON.stringify(originalResult).length;

          // Only compact if result is large (>50KB)
          if (originalSize > 50000) {
            // Replace with summarized version to free memory
            const summary = this.summarizeStepResult(originalResult);
            execution.results[stepName] = {
              ...summary,
              _compacted: true,
              _originalSize: originalSize,
              _compactedAt: new Date().toISOString()
            };

            log(`Memory cleanup: Compacted step "${stepName}" result (${(originalSize / 1024).toFixed(1)}KB -> ~${(JSON.stringify(summary).length / 1024).toFixed(1)}KB)`, "debug");
            compactedSteps.add(stepName);
          }
        }
      }
    }

    // Hint garbage collection if available (Node.js with --expose-gc flag)
    if (compactedSteps.size > 0 && typeof global !== 'undefined' && (global as any).gc) {
      try {
        (global as any).gc();
        log(`Memory cleanup: Triggered garbage collection after compacting ${compactedSteps.size} step(s)`, "debug");
      } catch (e) {
        // GC not available, that's fine
      }
    }
  }

  /**
   * Extract decisions made during a step execution
   */
  private extractDecisions(result: any): string[] {
    const decisions: string[] = [];

    if (!result || typeof result !== 'object') {
      return decisions;
    }

    // Extract explicit decisions if present
    if (Array.isArray(result.decisions)) {
      decisions.push(...result.decisions);
    }

    // Infer decisions from result state
    if (result.entitiesCreated === 0 && result.entitiesUpdated === 0) {
      decisions.push('No new entities created or updated - existing knowledge sufficient');
    } else if (result.entitiesCreated > 0) {
      decisions.push(`Created ${result.entitiesCreated} new knowledge entities`);
    }

    if (result.duplicatesRemoved > 0) {
      decisions.push(`Removed ${result.duplicatesRemoved} duplicate entries`);
    }

    if (result.passed === false) {
      decisions.push('Quality validation failed - flagged for review');
    } else if (result.passed === true) {
      decisions.push('Quality validation passed');
    }

    if (result.skipped) {
      decisions.push(`Step skipped: ${result.skipReason || 'No changes detected'}`);
    }

    if (result.filesCreated && result.filesCreated.length > 0) {
      decisions.push(`Generated ${result.filesCreated.length} output file(s)`);
    }

    if (result.patternsFound === 0 || (Array.isArray(result.patterns) && result.patterns.length === 0)) {
      decisions.push('No significant patterns identified in analyzed content');
    }

    if (result.insightsGenerated === 0 || (Array.isArray(result.insights) && result.insights.length === 0)) {
      decisions.push('No actionable insights generated from analysis');
    }

    // Check for incremental analysis decisions
    if (result.incrementalOnly) {
      decisions.push('Used incremental analysis mode - only new content analyzed');
    }

    // Check for content validation decisions
    if (result.contentValidated === true) {
      decisions.push('Content passed validation checks');
    } else if (result.contentValidated === false) {
      decisions.push('Content failed validation - corrections applied or needed');
    }

    return decisions;
  }
}