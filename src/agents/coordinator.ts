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
                 "insight_generation", "observation_generation", "quality_assurance", "persistence", "deduplication"],
        steps: [
          {
            name: "analyze_git_history",
            agent: "git_history",
            action: "analyzeGitHistory",
            parameters: { 
              repository_path: ".",
              checkpoint_enabled: false, // Disable checkpoint for broader analysis
              depth: 100, // Number of commits to analyze
              days_back: 30 // Analyze commits from last 30 days
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
            timeout: 120,
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
                observations: "{{generate_observations.result}}"
              }
            },
            dependencies: ["generate_observations"],
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
                quality_assurance: "{{quality_assurance.result}}"
              }
            },
            dependencies: ["quality_assurance"],
            timeout: 60,
          },
          {
            name: "deduplicate_insights",
            agent: "deduplication",
            action: "handleResolveDuplicates",
            parameters: {
              entity_types: ["Pattern", "WorkflowPattern", "Insight", "DesignPattern"],
              similarity_threshold: 0.85,
              auto_merge: true,
              preserve_history: true,
              deduplicate_insights: true,
              insight_scope: "global",
              insight_threshold: 0.9,
              merge_strategy: "combine"
            },
            dependencies: ["persist_results"],
            timeout: 45,
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
        agents: ["git_history", "vibe_history", "semantic_analysis", "observation_generation", "persistence", "deduplication"],
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
            action: "generateStructuredObservations",
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
          },
          {
            name: "deduplicate_incremental",
            agent: "deduplication",
            action: "handleConsolidatePatterns",
            parameters: {
              similarity_threshold: 0.9
            },
            dependencies: ["persist_incremental"],
            timeout: 20,
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
      
      // Register other agents with deduplication for access to knowledge graph
      dedupAgent.registerAgent("knowledge_graph", persistenceAgent);
      dedupAgent.registerAgent("persistence", persistenceAgent);
      
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
      
      // Save successful workflow completion checkpoint
      try {
        const persistenceAgent = this.agents.get('persistence') as PersistenceAgent;
        if (persistenceAgent && persistenceAgent.saveSuccessfulWorkflowCompletion) {
          await persistenceAgent.saveSuccessfulWorkflowCompletion(workflowName, execution.endTime);
          log('Workflow completion checkpoint saved', 'info', { workflow: workflowName });
        }
      } catch (checkpointError) {
        log('Failed to save workflow completion checkpoint', 'warning', checkpointError);
        // Don't fail the workflow for checkpoint issues
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
Check the following locations for generated files:
- \`knowledge-management/insights/\` - Insight documents
- \`shared-memory-coding.json\` - Updated knowledge base
- Generated PlantUML diagrams and documentation
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