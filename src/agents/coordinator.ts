import * as fs from 'fs';
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

export interface WorkflowDefinition {
  name: string;
  description: string;
  agents: string[];
  steps: WorkflowStep[];
  config: Record<string, any>;
}

export interface WorkflowStep {
  name: string;
  agent: string;
  action: string;
  parameters: Record<string, any>;
  dependencies?: string[];
  timeout?: number;
  condition?: string; // Optional condition for conditional execution (e.g., "{{params.autoRefresh}} === true")
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
  private writeProgressFile(execution: WorkflowExecution, workflow: WorkflowDefinition, currentStep?: string): void {
    try {
      const progressPath = `${this.repositoryPath}/.data/workflow-progress.json`;

      // Build detailed step info with timing data and result summaries
      const stepsDetail: Array<{
        name: string;
        status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
        duration?: number;
        error?: string;
        outputs?: Record<string, any>;
      }> = [];

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

      // Add current step if provided and not already in results
      if (currentStep && !execution.results[currentStep]) {
        stepsDetail.push({
          name: currentStep,
          status: 'running',
        });
      }

      const completedSteps = stepsDetail.filter(s => s.status === 'completed').map(s => s.name);
      const failedSteps = stepsDetail.filter(s => s.status === 'failed').map(s => s.name);

      const progress = {
        workflowName: workflow.name,
        executionId: execution.id,
        status: execution.status,
        team: this.team,
        repositoryPath: this.repositoryPath,
        startTime: execution.startTime.toISOString(),
        currentStep: currentStep || null,
        totalSteps: workflow.steps.length,
        completedSteps: completedSteps.length,
        failedSteps: failedSteps.length,
        stepsCompleted: completedSteps,
        stepsFailed: failedSteps,
        stepsDetail: stepsDetail, // New: detailed step info with timing
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
            action: "analyzeGitHistory",
            parameters: {
              repository_path: ".",
              checkpoint_enabled: false, // Disable checkpoint for full history analysis
              depth: 500, // Analyze up to 500 commits for complete analysis
              // NOTE: No days_back parameter = analyze all history regardless of date
            },
            timeout: 180, // Longer timeout for full history
          },
          {
            name: "analyze_vibe_history", 
            agent: "vibe_history",
            action: "analyzeVibeHistory",
            parameters: {
              history_path: ".specstory/history",
              checkpoint_enabled: true
            },
            timeout: 120,
          },
          {
            name: "semantic_analysis",
            agent: "semantic_analysis",
            action: "analyzeSemantics",
            parameters: {
              git_analysis_results: "{{analyze_git_history.result}}",
              vibe_analysis_results: "{{analyze_vibe_history.result}}"
            },
            dependencies: ["analyze_git_history", "analyze_vibe_history"],
            timeout: 180,
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
              vibe_analysis_results: "{{analyze_vibe_history.result}}"
            },
            dependencies: ["semantic_analysis", "web_search"],
            timeout: 300,
          },
          {
            name: "generate_observations",
            agent: "observation_generation",
            action: "generateStructuredObservations",
            parameters: {
              insights_results: "{{generate_insights.result}}",
              semantic_analysis_results: "{{semantic_analysis.result}}",
              git_analysis_results: "{{analyze_git_history.result}}"
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
            timeout: 60,
          },
          {
            name: "index_codebase",
            agent: "code_graph",
            action: "indexRepository",
            parameters: {
              target_path: "{{params.repositoryPath}}"
            },
            timeout: 300, // 5 minutes for large codebases
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
                code_graph: "{{transform_code_entities.result}}"
              }
            },
            dependencies: ["classify_with_ontology", "transform_code_entities"],
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
          max_concurrent_steps: 3,
          timeout: 1200, // 20 minutes total for comprehensive analysis
          quality_validation: true,
        },
      },
      {
        name: "incremental-analysis",
        description: "Incremental 13-agent analysis since last checkpoint with code graph and ontology",
        agents: ["git_history", "vibe_history", "semantic_analysis", "insight_generation",
                 "observation_generation", "ontology_classification", "quality_assurance",
                 "persistence", "deduplication", "content_validation", "code_graph", "documentation_linker"],
        steps: [
          {
            name: "analyze_recent_changes",
            agent: "git_history",
            action: "analyzeGitHistory",
            parameters: {
              repository: null,  // Will be filled from workflow params
              maxCommits: 10,
              sinceCommit: null
            },
            timeout: 60,
          },
          {
            name: "analyze_recent_vibes",
            agent: "vibe_history",
            action: "analyzeVibeHistory",
            parameters: {
              maxSessions: 5
            },
            timeout: 60,
          },
          {
            name: "analyze_semantics",
            agent: "semantic_analysis",
            action: "analyzeSemantics",
            parameters: {
              git_analysis_results: "{{analyze_recent_changes.result}}",
              vibe_analysis_results: "{{analyze_recent_vibes.result}}",
              incremental: true
            },
            dependencies: ["analyze_recent_changes", "analyze_recent_vibes"],
            timeout: 90,
          },
          {
            name: "generate_insights",
            agent: "insight_generation",
            action: "generateComprehensiveInsights",
            parameters: {
              git_analysis_results: "{{analyze_recent_changes.result}}",
              vibe_analysis_results: "{{analyze_recent_vibes.result}}",
              semantic_analysis_results: "{{analyze_semantics.result}}",
              incremental: true
            },
            dependencies: ["analyze_semantics"],
            timeout: 90,
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
            timeout: 30,
          },
          {
            name: "index_recent_code",
            agent: "code_graph",
            action: "indexRepository",
            parameters: {
              target_path: "{{params.repositoryPath}}"
            },
            timeout: 180, // 3 minutes for incremental
          },
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
                code_graph: "{{transform_code_entities_incremental.result}}"
              },
              lightweight: true // Skip heavy validation for incremental runs
            },
            dependencies: ["classify_with_ontology", "transform_code_entities_incremental"],
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
          max_concurrent_steps: 3,
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
            timeout: 300, // 5 minutes for large codebases
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

    workflows.forEach(workflow => {
      this.workflows.set(workflow.name, workflow);
    });

    log(`Initialized ${workflows.length} workflows`, "info");
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
        enableDeepValidation: true
      });
      contentValidationAgent.setGraphDB(this.graphDB);
      contentValidationAgent.setPersistenceAgent(persistenceAgent);
      contentValidationAgent.setInsightGenerationAgent(insightGenerationAgent);
      this.agents.set("content_validation", contentValidationAgent);

      // Register other agents with deduplication for access to knowledge graph
      dedupAgent.registerAgent("knowledge_graph", persistenceAgent);
      dedupAgent.registerAgent("persistence", persistenceAgent);

      // Code Graph Agent for AST-based code analysis (integrates with code-graph-rag)
      const codeGraphAgent = new CodeGraphAgent(this.repositoryPath);
      this.agents.set("code_graph", codeGraphAgent);

      // Documentation Linker Agent for linking docs to code entities
      const documentationLinkerAgent = new DocumentationLinkerAgent(this.repositoryPath);
      this.agents.set("documentation_linker", documentationLinkerAgent);

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
      
      // Execute workflow steps
      for (let i = 0; i < workflow.steps.length; i++) {
        execution.currentStep = i;
        const step = workflow.steps[i];

        // Write progress before starting step
        this.writeProgressFile(execution, workflow, step.name);

        // Check dependencies
        if (step.dependencies) {
          for (const dep of step.dependencies) {
            const depResult = execution.results[dep];
            // Check if dependency exists and wasn't a failure
            // Distinguish between: { error: "..." } (step failure) vs { ..., error: "info" } (success with warning)
            // A failure has ONLY an error field (and possibly _timing), success has other data fields
            const isFailure = !depResult || (depResult.error && Object.keys(depResult).filter(k => !k.startsWith('_')).length === 1);
            if (isFailure) {
              throw new Error(`Step dependency not satisfied: ${dep}`);
            }
          }
        }

        // Check condition if present
        if (step.condition) {
          const conditionResult = this.evaluateCondition(step.condition, parameters, execution.results);
          if (!conditionResult) {
            log(`Step skipped due to condition: ${step.name}`, "info", {
              condition: step.condition,
              result: conditionResult
            });
            execution.results[step.name] = { skipped: true, reason: 'condition not met' };
            continue;
          }
        }

        // Execute step with timing tracking
        const stepStartTime = new Date();
        try {
          const stepResult = await this.executeStepWithTimeout(execution, step, parameters);
          const stepEndTime = new Date();
          const stepDuration = stepEndTime.getTime() - stepStartTime.getTime();
          
          // Store timing information with result
          execution.results[step.name] = {
            ...stepResult,
            _timing: {
              startTime: stepStartTime,
              endTime: stepEndTime,
              duration: stepDuration,
              timeout: step.timeout || 60
            }
          };
          
          log(`Step completed: ${step.name}`, "info", {
            step: step.name,
            agent: step.agent,
            hasResult: !!stepResult,
            duration: `${(stepDuration / 1000).toFixed(1)}s`,
            timeoutUtilization: `${((stepDuration / 1000) / (step.timeout || 60) * 100).toFixed(1)}%`
          });

          // Update progress file after step completion
          this.writeProgressFile(execution, workflow);

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

          // QA Enforcement: Check quality assurance results and implement retry logic
          if (step.name === 'quality_assurance' && stepResult) {
            const qaFailures = this.validateQualityAssuranceResults(stepResult);
            if (qaFailures.length > 0) {
              log(`QA Enforcement: Quality issues detected, attempting intelligent retry`, "warning", {
                failures: qaFailures,
                step: step.name,
                workflow: execution.workflow
              });
              
              // Attempt to fix the issues by retrying failed steps with enhanced parameters
              const retryResult = await this.attemptQARecovery(qaFailures, execution, workflow);
              
              if (!retryResult.success) {
                const qaError = `Quality Assurance failed after retry with ${retryResult.remainingFailures.length} critical issues: ${retryResult.remainingFailures.join(', ')}`;
                log(`QA Enforcement: Halting workflow after retry attempt`, "error", {
                  failures: retryResult.remainingFailures,
                  step: step.name,
                  workflow: execution.workflow
                });
                throw new Error(qaError);
              }
              
              log(`QA Enforcement: Quality validation passed after retry`, "info");
            } else {
              log(`QA Enforcement: Quality validation passed`, "info");
            }
          }
          
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const stepEndTime = new Date();
          const stepDuration = stepEndTime.getTime() - stepStartTime.getTime();

          execution.results[step.name] = { error: errorMessage };
          execution.errors.push(`Step ${step.name} failed: ${errorMessage}`);

          // Update progress file after step failure
          this.writeProgressFile(execution, workflow);

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
            errors: [errorMessage]
          });

          log(`Step failed: ${step.name}`, "error", {
            step: step.name,
            agent: step.agent,
            error: errorMessage
          });

          // Stop workflow on step failure
          throw error;
        }
      }

      execution.status = "completed";
      execution.endTime = new Date();

      // Check if there were actual content changes before updating the checkpoint
      // This prevents "empty" updates that only touch timestamps
      const persistResult = execution.results?.persist_incremental || execution.results?.persist_analysis;
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
        stepsCompleted: execution.currentStep + 1,
        performanceScore: performanceMetrics.overallScore,
        bottlenecks: performanceMetrics.bottlenecks,
        summary
      });

      // Finalize and save workflow report
      const reportPath = this.reportAgent.finalizeReport('completed', {
        stepsCompleted: execution.currentStep + 1,
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

    // Add execution context
    stepParams._context = {
      workflow: execution.workflow,
      executionId: execution.id,
      previousResults: execution.results,
      step: step.name
    };

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Step timeout after ${step.timeout || 60}s`)), stepTimeout);
    });

    const executionPromise = this.executeStepOperation(step, stepParams, execution);

    try {
      return await Promise.race([executionPromise, timeoutPromise]);
    } catch (error) {
      log(`Step failed: ${step.name}`, "error", {
        agent: step.agent,
        action: step.action,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async executeStepOperation(step: WorkflowStep, parameters: Record<string, any>, execution: WorkflowExecution): Promise<any> {
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
        const [stepName, property = 'result'] = template.split('.');
        
        if (results[stepName] && !results[stepName].error) {
          const resolvedValue = property === 'result' ? results[stepName] : results[stepName][property];
          parameters[key] = resolvedValue;
          
          log(`Resolved template: ${value} -> ${typeof resolvedValue}`, "debug", {
            template: value,
            stepName,
            property,
            resolvedType: typeof resolvedValue
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
  private async attemptQARecovery(
    failures: string[],
    execution: WorkflowExecution,
    workflow: WorkflowDefinition
  ): Promise<{ success: boolean; remainingFailures: string[] }> {
    log('Attempting QA recovery', 'info', { failures });
    
    const remainingFailures: string[] = [];
    const failedSteps = new Set<string>();
    
    // Identify which steps need retry based on failures
    failures.forEach(failure => {
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
        log(`Retrying step ${stepName} with enhanced parameters`, 'info');
        
        // Build enhanced parameters based on the failure type
        const enhancedParams = this.buildEnhancedParameters(stepName, failures, execution);
        
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
        
        log(`Successfully retried step ${stepName}`, 'info');
        
      } catch (retryError) {
        const errorMsg = retryError instanceof Error ? retryError.message : String(retryError);
        remainingFailures.push(`${stepName}: ${errorMsg} (after retry)`);
        log(`Failed to retry step ${stepName}`, 'error', { error: errorMsg });
      }
    }
    
    // Re-run QA to check if issues are resolved
    if (remainingFailures.length === 0) {
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
                step: qaStep.name
              };
              const newQaResult = await qaAction.call(qaAgent, qaParams);
              
              // Validate the new QA results
              const newFailures = this.validateQualityAssuranceResults(newQaResult);
              if (newFailures.length > 0) {
                remainingFailures.push(...newFailures);
              }
            }
          }
        }
      } catch (qaError) {
        log('Failed to re-run QA after retry', 'error', qaError);
      }
    }
    
    return {
      success: remainingFailures.length === 0,
      remainingFailures
    };
  }

  /**
   * Build enhanced parameters for retry based on failure analysis
   */
  private buildEnhancedParameters(
    stepName: string,
    failures: string[],
    execution: WorkflowExecution
  ): any {
    const baseParams = execution.results[stepName]?._parameters || {};
    const enhancedParams = { ...baseParams };
    
    // Analyze failures to determine enhancement strategy
    const stepFailures = failures.filter(f => f.startsWith(`${stepName}:`));
    
    if (stepName === 'semantic_analysis') {
      // If semantic analysis failed due to missing insights, enhance the analysis depth
      if (stepFailures.some(f => f.includes('Missing insights'))) {
        enhancedParams.analysisDepth = 'comprehensive';
        enhancedParams.includeDetailedInsights = true;
        enhancedParams.minInsightLength = 200;
      }
    } else if (stepName === 'insight_generation') {
      // If insight generation failed, request more detailed insights
      enhancedParams.generateDetailedInsights = true;
      enhancedParams.includeCodeExamples = true;
      enhancedParams.minPatternSignificance = 5;
    } else if (stepName === 'web_search') {
      // If web search failed, try with broader search parameters
      enhancedParams.searchDepth = 'comprehensive';
      enhancedParams.includeAlternativePatterns = true;
    }
    
    // Add retry context to help agents understand they're in a retry
    enhancedParams._retryContext = {
      isRetry: true,
      previousFailures: stepFailures,
      enhancementReason: 'QA validation failure'
    };
    
    return enhancedParams;
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
    if (Array.isArray(result.commits)) summary.commitsCount = result.commits.length;
    if (Array.isArray(result.sessions)) summary.sessionsCount = result.sessions.length;
    if (Array.isArray(result.observations)) summary.observationsCount = result.observations.length;

    // Extract error info if present
    if (result.error) summary.error = result.error;
    if (result.errors && Array.isArray(result.errors)) summary.errorsCount = result.errors.length;
    if (result.warnings && Array.isArray(result.warnings)) summary.warningsCount = result.warnings.length;

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