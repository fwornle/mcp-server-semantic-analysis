/**
 * Base Agent - Abstract Base Class for Multi-Agent System
 *
 * Provides common functionality for all agents including:
 * - Standard response envelope creation
 * - Confidence calculation
 * - Issue detection framework
 * - Routing suggestion generation
 * - Upstream context handling
 *
 * @module agents/base-agent
 * @version 1.0.0
 */

import {
  AgentResponse,
  AgentMetadata,
  AgentRouting,
  AgentIssue,
  AgentCorrections,
  ConfidenceBreakdown,
  RoutingSuggestion,
  UpstreamContext,
  IssueSeverity,
  IssueCategory,
  createDefaultConfidenceBreakdown,
  calculateConfidence,
  createDefaultRouting,
  createDefaultMetadata,
  createAgentResponse,
  createIssue,
} from '../types/agent-response';

/**
 * Configuration for base agent
 */
export interface BaseAgentConfig {
  /** Agent identifier */
  agentId: string;

  /** Display name for logging */
  displayName: string;

  /** Whether this agent uses LLM */
  usesLLM: boolean;

  /** Default model if using LLM */
  defaultModel?: string;

  /** Default tier for this agent */
  tier: 'fast' | 'standard' | 'premium';

  /** Confidence thresholds */
  confidenceThresholds?: {
    /** Below this, routing suggests retry */
    retryThreshold: number;
    /** Below this, shows warning */
    warningThreshold: number;
    /** Below this, blocks downstream */
    blockingThreshold: number;
  };
}

/**
 * Execution context passed to agents
 */
export interface AgentExecutionContext {
  /** Current step name in workflow */
  stepName: string;

  /** Workflow ID */
  workflowId: string;

  /** Batch ID if batch processing */
  batchId?: string;

  /** Retry attempt number (0 = first try) */
  retryAttempt: number;

  /** Upstream contexts from dependent steps */
  upstreamContexts: UpstreamContext[];

  /** Retry guidance if this is a retry */
  retryGuidance?: {
    issues: AgentIssue[];
    instructions: string;
    examples?: string[];
    parameterOverrides?: Record<string, unknown>;
  };

  /** Timeout in milliseconds */
  timeout: number;

  /** Additional context */
  additionalContext?: Record<string, unknown>;
}

/**
 * Result of confidence calculation
 */
export interface ConfidenceResult {
  overall: number;
  breakdown: ConfidenceBreakdown;
  factors: {
    name: string;
    value: number;
    weight: number;
    reason: string;
  }[];
}

/**
 * Abstract base class for all agents in the multi-agent system
 */
export abstract class BaseAgent<TInput, TOutput> {
  protected config: BaseAgentConfig;
  protected startTime: number = 0;

  constructor(config: BaseAgentConfig) {
    this.config = {
      ...config,
      confidenceThresholds: config.confidenceThresholds ?? {
        retryThreshold: 0.5,
        warningThreshold: 0.7,
        blockingThreshold: 0.3,
      },
    };
  }

  /**
   * Main execution method that wraps the agent's logic in the response envelope
   */
  async execute(
    input: TInput,
    context: AgentExecutionContext
  ): Promise<AgentResponse<TOutput>> {
    this.startTime = Date.now();

    try {
      // Run the agent's specific logic
      const result = await this.process(input, context);

      // Calculate confidence
      const confidenceResult = await this.calculateConfidence(result, input, context);

      // Detect issues
      const issues = await this.detectIssues(result, input, context);

      // Generate routing suggestions
      const routing = await this.generateRouting(result, confidenceResult, issues, context);

      // Check for and apply corrections
      const corrections = await this.applyCorrections(result, issues, context);

      // Build metadata
      const metadata = this.buildMetadata(confidenceResult, issues, context);

      // Create and return response envelope
      return createAgentResponse(
        result,
        this.config.agentId,
        context.stepName,
        metadata,
        routing,
        corrections
      );
    } catch (error) {
      // Handle errors by returning a failure response
      return this.createErrorResponse(error, context);
    }
  }

  /**
   * Abstract method - implement the agent's specific logic
   */
  protected abstract process(
    input: TInput,
    context: AgentExecutionContext
  ): Promise<TOutput>;

  /**
   * Calculate confidence score for the result
   * Override in subclasses for agent-specific logic
   */
  protected async calculateConfidence(
    result: TOutput,
    input: TInput,
    context: AgentExecutionContext
  ): Promise<ConfidenceResult> {
    // Default implementation - subclasses should override
    const upstreamInfluence = this.calculateUpstreamInfluence(context);

    const breakdown = createDefaultConfidenceBreakdown({
      dataCompleteness: 0.8,
      semanticCoherence: 0.8,
      upstreamInfluence,
      processingQuality: 0.8,
    });

    return {
      overall: calculateConfidence(breakdown),
      breakdown,
      factors: [
        { name: 'dataCompleteness', value: 0.8, weight: 0.25, reason: 'Default value' },
        { name: 'semanticCoherence', value: 0.8, weight: 0.25, reason: 'Default value' },
        { name: 'upstreamInfluence', value: upstreamInfluence, weight: 0.2, reason: 'From upstream contexts' },
        { name: 'processingQuality', value: 0.8, weight: 0.2, reason: 'Default value' },
      ],
    };
  }

  /**
   * Calculate upstream influence on confidence
   */
  protected calculateUpstreamInfluence(context: AgentExecutionContext): number {
    if (context.upstreamContexts.length === 0) {
      return 1.0; // No upstream, full confidence
    }

    // Average upstream confidence with penalty for issues
    let totalConfidence = 0;
    let totalWeight = 0;

    for (const upstream of context.upstreamContexts) {
      let weight = 1.0;

      // Reduce weight if upstream had issues
      const criticalIssues = upstream.relevantIssues.filter(i => i.severity === 'critical');
      const warningIssues = upstream.relevantIssues.filter(i => i.severity === 'warning');

      if (criticalIssues.length > 0) {
        weight *= 0.5;
      }
      if (warningIssues.length > 0) {
        weight *= 0.8;
      }

      totalConfidence += upstream.confidence * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? totalConfidence / totalWeight : 1.0;
  }

  /**
   * Detect issues in the result
   * Override in subclasses for agent-specific issue detection
   */
  protected async detectIssues(
    result: TOutput,
    input: TInput,
    context: AgentExecutionContext
  ): Promise<AgentIssue[]> {
    const issues: AgentIssue[] = [];

    // Check for upstream issues that should be propagated
    for (const upstream of context.upstreamContexts) {
      for (const issue of upstream.relevantIssues) {
        if (issue.severity === 'critical') {
          issues.push(createIssue(
            'warning',
            'data_quality',
            'UPSTREAM_CRITICAL_ISSUE',
            `Upstream ${upstream.sourceStep} had critical issue: ${issue.message}`,
            { retryable: false }
          ));
        }
      }
    }

    return issues;
  }

  /**
   * Generate routing suggestions based on results
   * Override in subclasses for agent-specific routing
   */
  protected async generateRouting(
    result: TOutput,
    confidence: ConfidenceResult,
    issues: AgentIssue[],
    context: AgentExecutionContext
  ): Promise<AgentRouting> {
    const routing = createDefaultRouting();
    const thresholds = this.config.confidenceThresholds!;

    // Check if retry is recommended
    if (confidence.overall < thresholds.retryThreshold) {
      const retryableIssues = issues.filter(i => i.retryable);
      if (retryableIssues.length > 0 && context.retryAttempt < 3) {
        routing.retryRecommendation = {
          shouldRetry: true,
          reason: `Confidence ${confidence.overall.toFixed(2)} below threshold ${thresholds.retryThreshold}`,
          suggestedChanges: retryableIssues.map(i => i.suggestedFix).filter(Boolean).join('; '),
          maxRetries: 3,
        };
      }
    }

    // Check if escalation is needed
    const criticalIssues = issues.filter(i => i.severity === 'critical' && !i.retryable);
    if (criticalIssues.length > 0) {
      routing.escalationNeeded = true;
      routing.escalationReason = criticalIssues.map(i => i.message).join('; ');
    }

    // Check if downstream should be skipped
    if (confidence.overall < thresholds.blockingThreshold) {
      routing.suggestions.push({
        action: 'skip',
        reason: `Confidence ${confidence.overall.toFixed(2)} too low to proceed`,
        confidence: 0.9,
        priority: 1,
      });
    }

    return routing;
  }

  /**
   * Apply corrections to fix detected issues
   * Override in subclasses for agent-specific corrections
   */
  protected async applyCorrections(
    result: TOutput,
    issues: AgentIssue[],
    context: AgentExecutionContext
  ): Promise<AgentCorrections | undefined> {
    // Default implementation - no corrections
    return undefined;
  }

  /**
   * Build metadata object
   */
  protected buildMetadata(
    confidence: ConfidenceResult,
    issues: AgentIssue[],
    context: AgentExecutionContext
  ): AgentMetadata {
    const processingTimeMs = Date.now() - this.startTime;
    const warnings: string[] = [];

    // Add confidence warnings
    const thresholds = this.config.confidenceThresholds!;
    if (confidence.overall < thresholds.warningThreshold) {
      warnings.push(`Confidence ${confidence.overall.toFixed(2)} is below warning threshold ${thresholds.warningThreshold}`);
    }

    // Add retry context warnings
    if (context.retryAttempt > 0) {
      warnings.push(`This is retry attempt ${context.retryAttempt}`);
    }

    return {
      confidence: confidence.overall,
      confidenceBreakdown: confidence.breakdown,
      qualityScore: Math.round(confidence.overall * 100),
      issues,
      warnings,
      processingTimeMs,
      upstreamContexts: context.upstreamContexts,
    };
  }

  /**
   * Create error response when processing fails
   */
  protected createErrorResponse(
    error: unknown,
    context: AgentExecutionContext
  ): AgentResponse<TOutput> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const processingTimeMs = Date.now() - this.startTime;

    const issue = createIssue(
      'critical',
      'processing_error',
      'AGENT_EXECUTION_ERROR',
      `Agent execution failed: ${errorMessage}`,
      {
        retryable: true,
        context: { error: errorMessage, stack: error instanceof Error ? error.stack : undefined },
      }
    );

    const metadata = createDefaultMetadata(0, processingTimeMs, [issue], []);
    const routing = createDefaultRouting();
    routing.retryRecommendation = {
      shouldRetry: context.retryAttempt < 3,
      reason: 'Agent execution failed',
      suggestedChanges: 'Check inputs and retry',
    };

    return createAgentResponse(
      null as unknown as TOutput, // Null data for error case
      this.config.agentId,
      context.stepName,
      metadata,
      routing
    );
  }

  /**
   * Helper to create an issue
   */
  protected createIssue(
    severity: IssueSeverity,
    category: IssueCategory,
    code: string,
    message: string,
    options?: {
      affectedEntities?: string[];
      suggestedFix?: string;
      retryable?: boolean;
      context?: Record<string, unknown>;
    }
  ): AgentIssue {
    return createIssue(severity, category, code, message, options);
  }

  /**
   * Get agent configuration
   */
  getConfig(): BaseAgentConfig {
    return { ...this.config };
  }

  /**
   * Get agent ID
   */
  getAgentId(): string {
    return this.config.agentId;
  }
}

/**
 * Adapter to wrap existing agents that don't extend BaseAgent
 * This allows gradual migration to the new system
 */
export class AgentAdapter<TInput, TOutput> {
  private agentId: string;
  private legacyExecute: (input: TInput) => Promise<TOutput>;

  constructor(
    agentId: string,
    legacyExecute: (input: TInput) => Promise<TOutput>
  ) {
    this.agentId = agentId;
    this.legacyExecute = legacyExecute;
  }

  /**
   * Execute legacy agent and wrap result in response envelope
   */
  async execute(
    input: TInput,
    context: AgentExecutionContext
  ): Promise<AgentResponse<TOutput>> {
    const startTime = Date.now();

    try {
      const result = await this.legacyExecute(input);
      const processingTimeMs = Date.now() - startTime;

      // Create default metadata for legacy agent
      const metadata = createDefaultMetadata(0.8, processingTimeMs);

      return createAgentResponse(
        result,
        this.agentId,
        context.stepName,
        metadata
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const processingTimeMs = Date.now() - startTime;

      const issue = createIssue(
        'critical',
        'processing_error',
        'LEGACY_AGENT_ERROR',
        `Legacy agent failed: ${errorMessage}`,
        { retryable: true }
      );

      const metadata = createDefaultMetadata(0, processingTimeMs, [issue]);
      const routing = createDefaultRouting();
      routing.retryRecommendation = {
        shouldRetry: context.retryAttempt < 3,
        reason: 'Legacy agent execution failed',
        suggestedChanges: 'Check inputs and retry',
      };

      return createAgentResponse(
        null as unknown as TOutput,
        this.agentId,
        context.stepName,
        metadata,
        routing
      );
    }
  }
}

/**
 * Factory function to create an adapter for any legacy function
 */
export function adaptLegacyAgent<TInput, TOutput>(
  agentId: string,
  legacyFn: (input: TInput) => Promise<TOutput>
): AgentAdapter<TInput, TOutput> {
  return new AgentAdapter(agentId, legacyFn);
}

/**
 * Type guard to check if a response indicates success
 */
export function isSuccessResponse<T>(response: AgentResponse<T>): boolean {
  return (
    response.data !== null &&
    response.metadata.confidence > 0 &&
    !response.metadata.issues.some(i => i.severity === 'critical' && !i.retryable)
  );
}

/**
 * Type guard to check if a response needs retry
 */
export function needsRetry<T>(response: AgentResponse<T>): boolean {
  return response.routing.retryRecommendation?.shouldRetry ?? false;
}

/**
 * Type guard to check if a response needs escalation
 */
export function needsEscalation<T>(response: AgentResponse<T>): boolean {
  return response.routing.escalationNeeded;
}
