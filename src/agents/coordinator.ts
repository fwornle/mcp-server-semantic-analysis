import { log } from "../logging.js";
import { GitHistoryAgent } from "./git-history-agent.js";
import { VibeHistoryAgent } from "./vibe-history-agent.js";
import { SemanticAnalysisAgent } from "./semantic-analysis-agent.js";
import { WebSearchAgent } from "./web-search.js";
import { InsightGenerationAgent } from "./insight-generation-agent.js";
import { ObservationGenerationAgent } from "./observation-generation-agent.js";
import { QualityAssuranceAgent } from "./quality-assurance-agent.js";
import { PersistenceAgent } from "./persistence-agent.js";
import { SynchronizationAgent } from "./synchronization.js";
import { DeduplicationAgent } from "./deduplication.js";

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
  
  constructor() {
    this.initializeWorkflows();
    this.initializeAgents();
    this.startBackgroundMonitor();
  }

  private initializeWorkflows(): void {
    // Define standard workflows
    const workflows: WorkflowDefinition[] = [
      {
        name: "complete-analysis",
        description: "Full 8-agent semantic analysis workflow",
        agents: ["git_history", "vibe_history", "semantic_analysis", "web_search", 
                 "insight_generation", "observation_generation", "quality_assurance", "persistence"],
        steps: [
          {
            name: "analyze_git_history",
            agent: "git_history",
            action: "analyzeGitHistory",
            parameters: { 
              repository_path: ".",
              checkpoint_enabled: true,
              depth: 100 // Number of commits to analyze
            },
            timeout: 120,
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
            parameters: {},
            dependencies: ["analyze_git_history", "analyze_vibe_history"],
            timeout: 180,
          },
          {
            name: "web_search",
            agent: "web_search",
            action: "searchSimilarPatterns",
            parameters: {},
            dependencies: ["semantic_analysis"],
            timeout: 90,
          },
          {
            name: "generate_insights",
            agent: "insight_generation",
            action: "generateInsights",
            parameters: {},
            dependencies: ["semantic_analysis", "web_search"],
            timeout: 120,
          },
          {
            name: "generate_observations",
            agent: "observation_generation",
            action: "generateObservations", 
            parameters: {},
            dependencies: ["generate_insights"],
            timeout: 90,
          },
          {
            name: "quality_assurance",
            agent: "quality_assurance",
            action: "validateWorkflow",
            parameters: {},
            dependencies: ["generate_observations"],
            timeout: 60,
          },
          {
            name: "persist_results",
            agent: "persistence",
            action: "persistToKnowledgeBase",
            parameters: {},
            dependencies: ["quality_assurance"],
            timeout: 60,
          }
        ],
        config: {
          max_concurrent_steps: 2,
          timeout: 900, // 15 minutes total
          quality_validation: true,
        },
      },
      {
        name: "incremental-analysis",
        description: "Incremental analysis since last checkpoint",
        agents: ["git_history", "vibe_history", "semantic_analysis", "observation_generation", "persistence"],
        steps: [
          {
            name: "analyze_recent_changes",
            agent: "git_history",
            action: "analyzeRecentChanges",
            parameters: { 
              since_last_checkpoint: true
            },
            timeout: 60,
          },
          {
            name: "analyze_recent_vibes",
            agent: "vibe_history", 
            action: "analyzeRecentVibes",
            parameters: {
              since_last_checkpoint: true
            },
            timeout: 60,
          },
          {
            name: "analyze_semantics",
            agent: "semantic_analysis",
            action: "analyzeSemantics",
            parameters: {
              incremental: true
            },
            dependencies: ["analyze_recent_changes", "analyze_recent_vibes"],
            timeout: 90,
          },
          {
            name: "generate_observations",
            agent: "observation_generation",
            action: "generateObservations",
            parameters: {
              incremental: true
            },
            dependencies: ["analyze_semantics"],
            timeout: 60,
          },
          {
            name: "persist_incremental",
            agent: "persistence",
            action: "persistIncremental",
            parameters: {},
            dependencies: ["generate_observations"],
            timeout: 30,
          }
        ],
        config: {
          max_concurrent_steps: 2,
          timeout: 420, // 7 minutes
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
    ];

    workflows.forEach(workflow => {
      this.workflows.set(workflow.name, workflow);
    });

    log(`Initialized ${workflows.length} workflows`, "info");
  }

  private initializeAgents(): void {
    try {
      log("Initializing 8-agent semantic analysis system", "info");
      
      // Core workflow agents
      const gitHistoryAgent = new GitHistoryAgent();
      this.agents.set("git_history", gitHistoryAgent);
      
      const vibeHistoryAgent = new VibeHistoryAgent();
      this.agents.set("vibe_history", vibeHistoryAgent);
      
      const semanticAnalysisAgent = new SemanticAnalysisAgent();
      this.agents.set("semantic_analysis", semanticAnalysisAgent);
      
      const webSearchAgent = new WebSearchAgent();
      this.agents.set("web_search", webSearchAgent);
      
      const insightGenerationAgent = new InsightGenerationAgent();
      this.agents.set("insight_generation", insightGenerationAgent);
      
      const observationGenerationAgent = new ObservationGenerationAgent();
      this.agents.set("observation_generation", observationGenerationAgent);
      
      const qualityAssuranceAgent = new QualityAssuranceAgent();
      this.agents.set("quality_assurance", qualityAssuranceAgent);
      
      const persistenceAgent = new PersistenceAgent();
      this.agents.set("persistence", persistenceAgent);
      
      // Supporting agents
      const syncAgent = new SynchronizationAgent();
      this.agents.set("synchronization", syncAgent);
      
      const dedupAgent = new DeduplicationAgent();
      this.agents.set("deduplication", dedupAgent);
      
      log(`Initialized ${this.agents.size} agents`, "info", {
        agents: Array.from(this.agents.keys())
      });
      
    } catch (error) {
      log("Failed to initialize agents", "error", error);
      throw error;
    }
  }

  async executeWorkflow(workflowName: string, parameters: Record<string, any> = {}): Promise<WorkflowExecution> {
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

    try {
      execution.status = "running";
      
      // Execute workflow steps
      for (let i = 0; i < workflow.steps.length; i++) {
        execution.currentStep = i;
        const step = workflow.steps[i];
        
        // Check dependencies
        if (step.dependencies) {
          for (const dep of step.dependencies) {
            if (!execution.results[dep] || execution.results[dep].error) {
              throw new Error(`Step dependency not satisfied: ${dep}`);
            }
          }
        }
        
        // Execute step
        try {
          const stepResult = await this.executeStepWithTimeout(execution, step, parameters);
          execution.results[step.name] = stepResult;
          
          log(`Step completed: ${step.name}`, "info", {
            step: step.name,
            agent: step.agent,
            hasResult: !!stepResult
          });
          
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          execution.results[step.name] = { error: errorMessage };
          execution.errors.push(`Step ${step.name} failed: ${errorMessage}`);
          
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
      
      // Generate summary
      const summary = this.generateWorkflowSummary(execution, workflow);
      
      log(`Workflow completed: ${executionId}`, "info", {
        duration: execution.endTime.getTime() - execution.startTime.getTime(),
        stepsCompleted: execution.currentStep + 1,
        summary
      });
      
    } catch (error) {
      execution.status = "failed";
      execution.endTime = new Date();
      execution.errors.push(error instanceof Error ? error.message : String(error));
      
      log(`Workflow failed: ${executionId}`, "error", {
        error: error instanceof Error ? error.message : String(error),
        currentStep: execution.currentStep,
        duration: execution.endTime.getTime() - execution.startTime.getTime(),
      });
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
  return `- **${step.name}**: ${status} ${result?.error ? 'Failed' : 'Completed'}`;
}).join('\n')}

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
Check the following locations for generated files:
- \`knowledge-management/insights/\` - Insight documents
- \`shared-memory-coding.json\` - Updated knowledge base
- Generated PlantUML diagrams and documentation
`;
    
    return summary.trim();
  }

  private startBackgroundMonitor(): void {
    setInterval(() => {
      this.monitorExecutions();
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

  shutdown(): void {
    this.running = false;
    log("CoordinatorAgent shutting down", "info");
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
}