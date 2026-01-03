/**
 * Smart Orchestrator - Adaptive Multi-Agent Routing System
 *
 * Replaces mechanical coordinator with intelligent, semantic-aware orchestration.
 * Key capabilities:
 * - decideNextSteps(): LLM/rule-based hybrid routing decisions
 * - smartRetry(): Semantic guidance for retries, not just parameter tightening
 * - interpretResult(): Adaptive workflow modifications based on agent outputs
 * - Confidence propagation between agents
 * - Dynamic step addition/skipping
 *
 * @module orchestrator/smart-orchestrator
 * @version 1.0.0
 */

import { log } from '../logging.js';
import {
  AgentResponse,
  AgentIssue,
  RoutingDecision,
  WorkflowModification,
  MultiAgentProcessData,
  UpstreamContext,
  createDefaultRouting,
  hasCriticalIssues,
  hasRetryableIssues,
  aggregateUpstreamContexts,
} from '../types/agent-response.js';
import { SemanticAnalyzer } from '../agents/semantic-analyzer.js';

/**
 * Step status in the workflow
 */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'retrying';

/**
 * Extended step result with multi-agent metadata
 */
export interface StepResultWithMetadata {
  stepName: string;
  status: StepStatus;
  result: any;
  agentResponse?: AgentResponse<any>;
  confidence: number;
  issues: AgentIssue[];
  retryCount: number;
  startTime: Date;
  endTime?: Date;
  routingDecision?: RoutingDecision;
}

/**
 * Workflow state tracking for dynamic modifications
 */
export interface WorkflowState {
  workflowId: string;
  workflowName: string;
  startTime: Date;
  status: 'running' | 'completed' | 'failed' | 'terminated';

  /** Step results with metadata */
  stepResults: Map<string, StepResultWithMetadata>;

  /** Confidence scores per step */
  stepConfidences: Record<string, {
    overall: number;
    breakdown: {
      dataCompleteness: number;
      semanticCoherence: number;
      upstreamInfluence: number;
      processingQuality: number;
    };
    upstreamInfluence: number;
  }>;

  /** History of routing decisions */
  routingHistory: RoutingDecision[];

  /** Dynamic workflow modifications */
  modifications: WorkflowModification[];

  /** Retry tracking per step */
  retryHistory: Record<string, {
    count: number;
    lastRetryReason: string;
    confidenceProgression: number[];
    issues: AgentIssue[];
  }>;

  /** Steps marked for skipping */
  skippedSteps: Set<string>;

  /** Dynamically added steps */
  addedSteps: string[];
}

/**
 * Configuration for SmartOrchestrator
 */
export interface SmartOrchestratorConfig {
  /** Maximum retry attempts per step */
  maxRetries: number;

  /** Confidence threshold below which retry is recommended */
  retryThreshold: number;

  /** Confidence threshold below which to skip downstream */
  skipThreshold: number;

  /** Whether to use LLM for complex routing decisions */
  useLLMRouting: boolean;

  /** Maximum concurrent steps */
  maxConcurrentSteps: number;

  /** Timeout per step in milliseconds */
  defaultStepTimeout: number;
}

/**
 * Smart Orchestrator - Adaptive routing for multi-agent workflows
 */
export class SmartOrchestrator {
  private config: SmartOrchestratorConfig;
  private semanticAnalyzer: SemanticAnalyzer;
  private workflowState: WorkflowState | null = null;

  constructor(config?: Partial<SmartOrchestratorConfig>) {
    this.config = {
      maxRetries: 3,
      retryThreshold: 0.5,
      skipThreshold: 0.3,
      useLLMRouting: true,
      maxConcurrentSteps: 3,
      defaultStepTimeout: 120000,
      ...config,
    };
    this.semanticAnalyzer = new SemanticAnalyzer();
  }

  /**
   * Initialize workflow state for a new workflow run
   */
  initializeWorkflow(workflowId: string, workflowName: string): void {
    this.workflowState = {
      workflowId,
      workflowName,
      startTime: new Date(),
      status: 'running',
      stepResults: new Map(),
      stepConfidences: {},
      routingHistory: [],
      modifications: [],
      retryHistory: {},
      skippedSteps: new Set(),
      addedSteps: [],
    };

    log('SmartOrchestrator initialized workflow', 'info', { workflowId, workflowName });
  }

  /**
   * Decide which steps should run next based on current state
   *
   * Uses hybrid approach:
   * - Rule-based for simple cases (fast)
   * - LLM-assisted for complex routing decisions
   */
  async decideNextSteps(
    availableSteps: string[],
    completedSteps: string[],
    stepDependencies: Record<string, string[]>
  ): Promise<{
    stepsToRun: string[];
    stepsToSkip: string[];
    stepsToAdd?: string[];
    reasoning: string;
    llmAssisted: boolean;
  }> {
    if (!this.workflowState) {
      throw new Error('Workflow not initialized. Call initializeWorkflow first.');
    }

    const startTime = Date.now();
    const stepsToRun: string[] = [];
    const stepsToSkip: string[] = [];

    // Get ready steps (dependencies satisfied, not skipped)
    for (const step of availableSteps) {
      if (completedSteps.includes(step)) continue;
      if (this.workflowState.skippedSteps.has(step)) {
        stepsToSkip.push(step);
        continue;
      }

      const dependencies = stepDependencies[step] || [];
      const dependenciesMet = dependencies.every(dep =>
        completedSteps.includes(dep) || this.workflowState!.skippedSteps.has(dep)
      );

      if (dependenciesMet) {
        // Check if upstream confidence is too low
        const upstreamConfidence = this.calculateUpstreamConfidence(step, stepDependencies);
        if (upstreamConfidence < this.config.skipThreshold) {
          log(`Skipping ${step} due to low upstream confidence (${upstreamConfidence.toFixed(2)})`, 'info');
          this.markStepSkipped(step, `Upstream confidence too low (${upstreamConfidence.toFixed(2)})`);
          stepsToSkip.push(step);
        } else {
          stepsToRun.push(step);
        }
      }
    }

    // Limit concurrent steps
    const limitedSteps = stepsToRun.slice(0, this.config.maxConcurrentSteps);

    // Simple case: clear next steps, no LLM needed
    if (stepsToRun.length <= this.config.maxConcurrentSteps && stepsToSkip.length === 0) {
      return {
        stepsToRun: limitedSteps,
        stepsToSkip,
        reasoning: `${limitedSteps.length} step(s) ready with dependencies satisfied`,
        llmAssisted: false,
      };
    }

    // Complex case: use LLM if configured
    if (this.config.useLLMRouting && (stepsToRun.length > this.config.maxConcurrentSteps || this.hasComplexState())) {
      try {
        const llmDecision = await this.getLLMRoutingDecision(stepsToRun, completedSteps, stepDependencies);
        log('LLM routing decision made', 'info', { processingTimeMs: Date.now() - startTime });
        return {
          ...llmDecision,
          llmAssisted: true,
        };
      } catch (error) {
        log('LLM routing failed, using rule-based fallback', 'warning', error);
      }
    }

    return {
      stepsToRun: limitedSteps,
      stepsToSkip,
      reasoning: `Selected ${limitedSteps.length} highest-priority step(s) from ${stepsToRun.length} ready`,
      llmAssisted: false,
    };
  }

  /**
   * Execute a smart retry with semantic guidance
   *
   * Unlike mechanical retries that just tighten thresholds, smart retry:
   * - Passes specific guidance about what went wrong
   * - Includes examples of good vs bad output
   * - Adjusts parameters based on the specific issues
   * - Propagates upstream context for awareness
   */
  async smartRetry(
    stepName: string,
    previousResult: StepResultWithMetadata,
    originalParameters: Record<string, unknown>
  ): Promise<{
    shouldRetry: boolean;
    enhancedParameters: Record<string, unknown>;
    retryGuidance: {
      issues: AgentIssue[];
      instructions: string;
      examples?: string[];
      upstreamContext?: UpstreamContext[];
    };
    reasoning: string;
  }> {
    if (!this.workflowState) {
      throw new Error('Workflow not initialized');
    }

    const retryCount = this.workflowState.retryHistory[stepName]?.count || 0;

    // Check if retries exhausted
    if (retryCount >= this.config.maxRetries) {
      return {
        shouldRetry: false,
        enhancedParameters: originalParameters,
        retryGuidance: {
          issues: previousResult.issues,
          instructions: 'Max retries exhausted',
        },
        reasoning: `Step ${stepName} has exhausted ${this.config.maxRetries} retry attempts`,
      };
    }

    // Check if there are retryable issues
    const retryableIssues = previousResult.issues.filter(i => i.retryable);
    if (retryableIssues.length === 0) {
      return {
        shouldRetry: false,
        enhancedParameters: originalParameters,
        retryGuidance: {
          issues: previousResult.issues,
          instructions: 'No retryable issues found',
        },
        reasoning: 'All issues are non-retryable',
      };
    }

    // Build semantic guidance
    const instructions = this.buildRetryInstructions(stepName, retryableIssues, retryCount);
    const examples = this.getRetryExamples(stepName, retryableIssues);
    const upstreamContext = this.getUpstreamContext(stepName);

    // Build enhanced parameters
    const enhancedParameters = this.buildEnhancedParameters(
      stepName,
      originalParameters,
      retryableIssues,
      retryCount
    );

    // Add retry guidance to parameters
    enhancedParameters._retryGuidance = {
      issues: retryableIssues,
      instructions,
      examples,
      upstreamContext,
      retryAttempt: retryCount + 1,
    };

    // Update retry history
    if (!this.workflowState.retryHistory[stepName]) {
      this.workflowState.retryHistory[stepName] = {
        count: 0,
        lastRetryReason: '',
        confidenceProgression: [],
        issues: [],
      };
    }
    this.workflowState.retryHistory[stepName].count++;
    this.workflowState.retryHistory[stepName].lastRetryReason = instructions;
    this.workflowState.retryHistory[stepName].confidenceProgression.push(previousResult.confidence);
    this.workflowState.retryHistory[stepName].issues = retryableIssues;

    return {
      shouldRetry: true,
      enhancedParameters,
      retryGuidance: {
        issues: retryableIssues,
        instructions,
        examples,
        upstreamContext,
      },
      reasoning: `Retry ${retryCount + 1}/${this.config.maxRetries} for ${stepName}: ${instructions}`,
    };
  }

  /**
   * Interpret an agent's result and decide on workflow modifications
   */
  async interpretResult(
    stepName: string,
    agentResponse: AgentResponse<any>
  ): Promise<{
    action: 'proceed' | 'retry' | 'skip_downstream' | 'add_steps' | 'terminate';
    modifications: WorkflowModification[];
    reasoning: string;
  }> {
    if (!this.workflowState) {
      throw new Error('Workflow not initialized');
    }

    // Store the result
    const stepResult: StepResultWithMetadata = {
      stepName,
      status: 'completed',
      result: agentResponse.data,
      agentResponse,
      confidence: agentResponse.metadata.confidence,
      issues: agentResponse.metadata.issues,
      retryCount: this.workflowState.retryHistory[stepName]?.count || 0,
      startTime: new Date(),
      endTime: new Date(),
    };
    this.workflowState.stepResults.set(stepName, stepResult);

    // Store confidence
    this.workflowState.stepConfidences[stepName] = {
      overall: agentResponse.metadata.confidence,
      breakdown: agentResponse.metadata.confidenceBreakdown,
      upstreamInfluence: agentResponse.metadata.confidenceBreakdown.upstreamInfluence,
    };

    const modifications: WorkflowModification[] = [];

    // Check for critical issues
    if (hasCriticalIssues(agentResponse)) {
      const nonRetryable = agentResponse.metadata.issues.filter(
        i => i.severity === 'critical' && !i.retryable
      );
      if (nonRetryable.length > 0) {
        return {
          action: 'terminate',
          modifications: [],
          reasoning: `Critical non-retryable issue: ${nonRetryable[0].message}`,
        };
      }
    }

    // Check if retry is recommended
    if (agentResponse.routing.retryRecommendation?.shouldRetry) {
      if ((this.workflowState.retryHistory[stepName]?.count || 0) < this.config.maxRetries) {
        return {
          action: 'retry',
          modifications: [],
          reasoning: agentResponse.routing.retryRecommendation.reason,
        };
      }
    }

    // Check for skip recommendations
    if (agentResponse.routing.skipRecommendations.length > 0) {
      for (const skipStep of agentResponse.routing.skipRecommendations) {
        this.markStepSkipped(skipStep, `Recommended by ${stepName}`);
        modifications.push({
          type: 'skip',
          targetStep: skipStep,
          reason: `Recommended by ${stepName} due to confidence ${agentResponse.metadata.confidence.toFixed(2)}`,
          timestamp: new Date().toISOString(),
          source: stepName,
        });
      }
    }

    // Check for suggested next steps (could add dynamic steps)
    if (agentResponse.routing.suggestedNextSteps.length > 0) {
      // Log suggestions but don't add steps dynamically yet
      log(`Step ${stepName} suggests next steps`, 'info', {
        suggestions: agentResponse.routing.suggestedNextSteps,
      });
    }

    // Check if escalation needed
    if (agentResponse.routing.escalationNeeded) {
      // For now, log escalation but continue
      log(`Step ${stepName} requests escalation`, 'warning', {
        reason: agentResponse.routing.escalationReason,
      });
    }

    // Store modifications
    this.workflowState.modifications.push(...modifications);

    return {
      action: modifications.length > 0 ? 'skip_downstream' : 'proceed',
      modifications,
      reasoning: modifications.length > 0
        ? `Applied ${modifications.length} modification(s)`
        : `Confidence ${agentResponse.metadata.confidence.toFixed(2)} - proceeding`,
    };
  }

  /**
   * Record a routing decision in history
   */
  recordRoutingDecision(decision: RoutingDecision): void {
    if (!this.workflowState) return;
    this.workflowState.routingHistory.push(decision);
  }

  /**
   * Mark a step as skipped
   */
  markStepSkipped(stepName: string, reason: string): void {
    if (!this.workflowState) return;
    this.workflowState.skippedSteps.add(stepName);
    this.workflowState.modifications.push({
      type: 'skip',
      targetStep: stepName,
      reason,
      timestamp: new Date().toISOString(),
      source: 'smart_orchestrator',
    });
    log(`Marked step ${stepName} as skipped`, 'info', { reason });
  }

  /**
   * Get multi-agent process data for visualization
   */
  getMultiAgentProcessData(): MultiAgentProcessData | null {
    if (!this.workflowState) return null;

    return {
      stepConfidences: this.workflowState.stepConfidences,
      routingHistory: this.workflowState.routingHistory,
      workflowModifications: this.workflowState.modifications,
      retryHistory: this.workflowState.retryHistory,
    };
  }

  /**
   * Get current workflow state
   */
  getWorkflowState(): WorkflowState | null {
    return this.workflowState;
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Calculate upstream confidence for a step based on its dependencies
   */
  private calculateUpstreamConfidence(
    stepName: string,
    stepDependencies: Record<string, string[]>
  ): number {
    const dependencies = stepDependencies[stepName] || [];
    if (dependencies.length === 0) return 1.0;

    let totalConfidence = 0;
    let count = 0;

    for (const dep of dependencies) {
      const depConfidence = this.workflowState?.stepConfidences[dep]?.overall;
      if (depConfidence !== undefined) {
        totalConfidence += depConfidence;
        count++;
      }
    }

    return count > 0 ? totalConfidence / count : 1.0;
  }

  /**
   * Check if workflow state is complex enough to warrant LLM routing
   */
  private hasComplexState(): boolean {
    if (!this.workflowState) return false;

    // Complex if: multiple retries, many skipped steps, or low confidence cascade
    const hasRetries = Object.values(this.workflowState.retryHistory).some(h => h.count > 0);
    const hasSkips = this.workflowState.skippedSteps.size > 0;
    const lowConfidenceCount = Object.values(this.workflowState.stepConfidences)
      .filter(c => c.overall < this.config.retryThreshold).length;

    return hasRetries || hasSkips || lowConfidenceCount > 2;
  }

  /**
   * Get LLM-assisted routing decision
   */
  private async getLLMRoutingDecision(
    availableSteps: string[],
    completedSteps: string[],
    stepDependencies: Record<string, string[]>
  ): Promise<{
    stepsToRun: string[];
    stepsToSkip: string[];
    stepsToAdd?: string[];
    reasoning: string;
  }> {
    const prompt = `You are a workflow orchestrator deciding which steps to run next.

Available steps: ${availableSteps.join(', ')}
Completed steps: ${completedSteps.join(', ')}

Step confidences:
${JSON.stringify(this.workflowState?.stepConfidences || {}, null, 2)}

Recent routing decisions:
${JSON.stringify(this.workflowState?.routingHistory.slice(-5) || [], null, 2)}

Retry history:
${JSON.stringify(this.workflowState?.retryHistory || {}, null, 2)}

Rules:
1. Don't run more than ${this.config.maxConcurrentSteps} steps at once
2. Skip steps if upstream confidence is below ${this.config.skipThreshold}
3. Prioritize steps that don't depend on low-confidence results
4. Consider adding remediation steps if quality is consistently low

Respond with JSON:
{
  "stepsToRun": ["step1", "step2"],
  "stepsToSkip": ["step3"],
  "stepsToAdd": [],
  "reasoning": "Clear explanation"
}`;

    const result = await this.semanticAnalyzer.analyzeContent(prompt, {
      analysisType: 'general',
      tier: 'premium',
    });

    const jsonMatch = result.insights.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    // Fallback
    return {
      stepsToRun: availableSteps.slice(0, this.config.maxConcurrentSteps),
      stepsToSkip: [],
      reasoning: 'LLM parsing failed, using default selection',
    };
  }

  /**
   * Build retry instructions based on issues
   */
  private buildRetryInstructions(
    stepName: string,
    issues: AgentIssue[],
    retryCount: number
  ): string {
    const issueMessages = issues.map(i => i.message).join('; ');
    const suggestedFixes = issues.map(i => i.suggestedFix).filter(Boolean).join('; ');

    return `Retry attempt ${retryCount + 1}: Fix the following issues: ${issueMessages}. ` +
           (suggestedFixes ? `Suggestions: ${suggestedFixes}` : '');
  }

  /**
   * Get examples for retry guidance
   */
  private getRetryExamples(stepName: string, issues: AgentIssue[]): string[] {
    // Step-specific examples
    const examples: Record<string, Record<string, string[]>> = {
      semantic_analysis: {
        LOW_CONFIDENCE: [
          'BAD: "This code does something"',
          'GOOD: "This module implements a Factory pattern for creating database connections, using lazy initialization to optimize resource usage"',
        ],
        SHORT_INSIGHTS: [
          'BAD: "Good code"',
          'GOOD: "The authentication flow uses JWT tokens with refresh token rotation, implementing OWASP security best practices"',
        ],
      },
      insight_generation: {
        LOW_CONFIDENCE: [
          'BAD: Generic pattern description',
          'GOOD: Specific implementation details with file references and code examples',
        ],
      },
    };

    const stepExamples = examples[stepName] || {};
    const relevantExamples: string[] = [];

    for (const issue of issues) {
      if (stepExamples[issue.code]) {
        relevantExamples.push(...stepExamples[issue.code]);
      }
    }

    return relevantExamples;
  }

  /**
   * Get upstream context for a step
   */
  private getUpstreamContext(stepName: string): UpstreamContext[] {
    if (!this.workflowState) return [];

    const contexts: UpstreamContext[] = [];

    for (const [name, result] of this.workflowState.stepResults) {
      if (result.agentResponse) {
        contexts.push({
          sourceAgent: result.agentResponse.agentId,
          sourceStep: name,
          confidence: result.agentResponse.metadata.confidence,
          relevantIssues: result.agentResponse.metadata.issues.filter(i => i.severity !== 'info'),
          routingSuggestions: result.agentResponse.routing.suggestions || [],
        });
      }
    }

    return contexts;
  }

  /**
   * Build enhanced parameters for retry
   */
  private buildEnhancedParameters(
    stepName: string,
    originalParameters: Record<string, unknown>,
    issues: AgentIssue[],
    retryCount: number
  ): Record<string, unknown> {
    const enhanced = { ...originalParameters };

    // Progressive enhancement based on retry count
    const progressiveMultiplier = 1 + (retryCount * 0.1);

    // Step-specific enhancements
    switch (stepName) {
      case 'semantic_analysis':
      case 'batch_semantic_analysis':
        enhanced.semanticValueThreshold = 0.6 + (retryCount * 0.1);
        enhanced.rejectGenericPatterns = retryCount >= 1;
        enhanced.requireConcreteEvidence = retryCount >= 2;
        enhanced.analysisDepth = retryCount >= 2 ? 'comprehensive' : 'standard';
        break;

      case 'insight_generation':
      case 'generate_insights':
        enhanced.minInsightLength = Math.round(100 * progressiveMultiplier);
        enhanced.requireSpecificExamples = retryCount >= 1;
        enhanced.validateAgainstCode = retryCount >= 2;
        enhanced.tier = retryCount >= 1 ? 'premium' : 'standard';
        break;

      case 'observation_generation':
      case 'generate_observations':
        enhanced.minObservationsPerEntity = 2 + retryCount;
        enhanced.rejectVagueObservations = retryCount >= 1;
        enhanced.requireActionableInsights = retryCount >= 2;
        break;

      case 'ontology_classification':
      case 'classify_with_ontology':
        enhanced.minConfidence = 0.6 + (retryCount * 0.1);
        enhanced.strictMatching = retryCount >= 2;
        break;

      default:
        // Generic enhancements
        enhanced.strictMode = retryCount >= 1;
        enhanced.enhancedValidation = retryCount >= 2;
        break;
    }

    // Issue-specific enhancements
    for (const issue of issues) {
      if (issue.category === 'low_confidence') {
        enhanced.tier = 'premium';
      }
      if (issue.category === 'data_quality') {
        enhanced.validateOutput = true;
      }
      if (issue.category === 'semantic_mismatch') {
        enhanced.semanticValidation = true;
      }
    }

    return enhanced;
  }
}

/**
 * Create a default SmartOrchestrator instance
 */
export function createSmartOrchestrator(config?: Partial<SmartOrchestratorConfig>): SmartOrchestrator {
  return new SmartOrchestrator(config);
}
