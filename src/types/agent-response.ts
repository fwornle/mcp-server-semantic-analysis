/**
 * Agent Response Types - Standard Envelope for Multi-Agent System
 *
 * This module defines the standard response envelope that all agents must return.
 * It enables:
 * - Confidence propagation between agents
 * - Semantic routing decisions based on agent output quality
 * - Issue tracking and self-healing capabilities
 * - Inter-agent awareness through metadata sharing
 *
 * @module types/agent-response
 * @version 1.0.0
 */

/**
 * Issue severity levels for agent problems
 */
export type IssueSeverity = 'critical' | 'warning' | 'info';

/**
 * Categories of issues that agents can encounter
 */
export type IssueCategory =
  | 'data_quality'      // Poor quality input or output data
  | 'missing_data'      // Required data not available
  | 'low_confidence'    // Agent uncertain about results
  | 'processing_error'  // Error during processing
  | 'timeout'           // Operation timed out
  | 'external_service'  // External service failure
  | 'validation'        // Validation check failed
  | 'semantic_mismatch'; // Semantic content doesn't match expectations

/**
 * Structured issue representation for agent problems
 */
export interface AgentIssue {
  /** Severity level determines routing response */
  severity: IssueSeverity;

  /** Category helps orchestrator understand issue type */
  category: IssueCategory;

  /** Unique code for programmatic handling */
  code: string;

  /** Human-readable description */
  message: string;

  /** Entities affected by this issue */
  affectedEntities?: string[];

  /** Suggested fix action for retry */
  suggestedFix?: string;

  /** Whether this issue is retryable */
  retryable: boolean;

  /** Additional context for debugging */
  context?: Record<string, unknown>;
}

/**
 * Breakdown of confidence score factors
 */
export interface ConfidenceBreakdown {
  /** Data completeness (0-1) */
  dataCompleteness: number;

  /** Semantic coherence of output (0-1) */
  semanticCoherence: number;

  /** External validation score if applicable (0-1) */
  externalValidation?: number;

  /** Upstream confidence influence (0-1) */
  upstreamInfluence: number;

  /** Processing quality score (0-1) */
  processingQuality: number;

  /** Per-factor weights used in calculation */
  weights: {
    dataCompleteness: number;
    semanticCoherence: number;
    externalValidation: number;
    upstreamInfluence: number;
    processingQuality: number;
  };
}

/**
 * Routing suggestion from agent to orchestrator
 */
export interface RoutingSuggestion {
  /** Suggested action for orchestrator */
  action: 'proceed' | 'retry' | 'skip' | 'escalate' | 'branch';

  /** Target step(s) for the action */
  targetSteps?: string[];

  /** Reason for the suggestion */
  reason: string;

  /** Confidence in this suggestion (0-1) */
  confidence: number;

  /** Priority relative to other suggestions */
  priority: number;
}

/**
 * Retry recommendation from agent
 */
export interface RetryRecommendation {
  /** Whether retry is recommended */
  shouldRetry: boolean;

  /** Reason for retry recommendation */
  reason: string;

  /** Semantic guidance for retry attempt */
  suggestedChanges: string;

  /** Specific parameters to modify */
  parameterAdjustments?: Record<string, unknown>;

  /** Maximum recommended retry attempts */
  maxRetries?: number;
}

/**
 * Corrections applied by the agent
 */
export interface AgentCorrections {
  /** Whether corrections were applied */
  applied: boolean;

  /** Description of corrections made */
  description: string;

  /** Original issues that were corrected */
  originalIssues: string[];

  /** Quality improvement from corrections */
  qualityImprovement?: number;
}

/**
 * Upstream context passed to downstream agents
 */
export interface UpstreamContext {
  /** Source agent ID */
  sourceAgent: string;

  /** Source step name */
  sourceStep: string;

  /** Confidence from upstream agent */
  confidence: number;

  /** Issues from upstream that may affect downstream */
  relevantIssues: AgentIssue[];

  /** Routing suggestions that apply to downstream */
  routingSuggestions: RoutingSuggestion[];

  /** Key insights to propagate */
  keyInsights?: string[];
}

/**
 * Metadata envelope for agent responses
 */
export interface AgentMetadata {
  /** Overall confidence score (0-1) */
  confidence: number;

  /** Detailed confidence breakdown */
  confidenceBreakdown: ConfidenceBreakdown;

  /** Quality score (0-100) */
  qualityScore: number;

  /** Issues encountered during processing */
  issues: AgentIssue[];

  /** Non-critical warnings */
  warnings: string[];

  /** Processing duration in milliseconds */
  processingTimeMs: number;

  /** Model/LLM used if applicable */
  modelUsed?: string;

  /** Token counts if LLM was used */
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };

  /** Upstream contexts received */
  upstreamContexts?: UpstreamContext[];
}

/**
 * Routing information in agent response
 */
export interface AgentRouting {
  /** Steps suggested to run next */
  suggestedNextSteps: string[];

  /** Steps that can be skipped */
  skipRecommendations: string[];

  /** Whether human review is needed */
  escalationNeeded: boolean;

  /** Escalation reason if needed */
  escalationReason?: string;

  /** Retry recommendation if applicable */
  retryRecommendation?: RetryRecommendation;

  /** Additional routing suggestions */
  suggestions: RoutingSuggestion[];
}

/**
 * Standard response envelope for all agents
 *
 * @template T The type of the actual result data
 */
export interface AgentResponse<T> {
  /** The actual result data from the agent */
  data: T;

  /** Metadata for routing decisions */
  metadata: AgentMetadata;

  /** Routing suggestions from agent */
  routing: AgentRouting;

  /** Corrections applied by agent */
  corrections?: AgentCorrections;

  /** Timestamp of response generation */
  timestamp: string;

  /** Agent identifier */
  agentId: string;

  /** Step name in workflow */
  stepName: string;
}

/**
 * Routing decision made by QA or orchestrator
 */
export interface RoutingDecision {
  /** Action to take */
  action: 'proceed' | 'retry' | 'skip_downstream' | 'escalate' | 'terminate';

  /** Steps affected by this decision */
  affectedSteps: string[];

  /** Reason for the decision */
  reason: string;

  /** Guidance for retry if applicable */
  retryGuidance?: {
    issues: AgentIssue[];
    instructions: string;
    examples?: string[];
    parameterOverrides?: Record<string, unknown>;
  };

  /** Confidence in this decision */
  confidence: number;

  /** Whether LLM was used for this decision */
  llmAssisted: boolean;

  /** Timestamp of decision */
  timestamp: string;
}

/**
 * Workflow modification for dynamic routing
 */
export interface WorkflowModification {
  /** Type of modification */
  type: 'skip' | 'add' | 'reorder' | 'retry';

  /** Target step */
  targetStep: string;

  /** Reason for modification */
  reason: string;

  /** Timestamp of modification */
  timestamp: string;

  /** Source of modification (QA, orchestrator, etc.) */
  source: string;
}

/**
 * Simplified confidence breakdown for visualization (without weights)
 */
export interface ConfidenceBreakdownSummary {
  dataCompleteness: number;
  semanticCoherence: number;
  upstreamInfluence: number;
  processingQuality: number;
}

/**
 * Extended process data for dashboard visualization
 */
export interface MultiAgentProcessData {
  /** Confidence scores per step */
  stepConfidences: Record<string, {
    overall: number;
    breakdown: ConfidenceBreakdownSummary;
    upstreamInfluence: number;
  }>;

  /** History of routing decisions */
  routingHistory: RoutingDecision[];

  /** Workflow modifications made */
  workflowModifications: WorkflowModification[];

  /** Retry history per step */
  retryHistory: Record<string, {
    count: number;
    lastRetryReason: string;
    confidenceProgression: number[];
    issues: AgentIssue[];
  }>;
}

/**
 * Helper type for agents that don't use LLM
 */
export type NonLLMAgentResponse<T> = AgentResponse<T> & {
  metadata: AgentMetadata & {
    modelUsed: undefined;
    tokenUsage: undefined;
  };
};

/**
 * Helper to create a default confidence breakdown
 */
export function createDefaultConfidenceBreakdown(overrides?: Partial<ConfidenceBreakdown>): ConfidenceBreakdown {
  return {
    dataCompleteness: 1.0,
    semanticCoherence: 1.0,
    upstreamInfluence: 1.0,
    processingQuality: 1.0,
    weights: {
      dataCompleteness: 0.25,
      semanticCoherence: 0.25,
      externalValidation: 0.1,
      upstreamInfluence: 0.2,
      processingQuality: 0.2,
    },
    ...overrides,
  };
}

/**
 * Calculate overall confidence from breakdown
 */
export function calculateConfidence(breakdown: ConfidenceBreakdown): number {
  const { weights } = breakdown;
  const weightSum = weights.dataCompleteness + weights.semanticCoherence +
                    (breakdown.externalValidation !== undefined ? weights.externalValidation : 0) +
                    weights.upstreamInfluence + weights.processingQuality;

  let score = 0;
  score += breakdown.dataCompleteness * weights.dataCompleteness;
  score += breakdown.semanticCoherence * weights.semanticCoherence;
  if (breakdown.externalValidation !== undefined) {
    score += breakdown.externalValidation * weights.externalValidation;
  }
  score += breakdown.upstreamInfluence * weights.upstreamInfluence;
  score += breakdown.processingQuality * weights.processingQuality;

  return score / weightSum;
}

/**
 * Create a default empty routing object
 */
export function createDefaultRouting(): AgentRouting {
  return {
    suggestedNextSteps: [],
    skipRecommendations: [],
    escalationNeeded: false,
    suggestions: [],
  };
}

/**
 * Create a default metadata object
 */
export function createDefaultMetadata(
  confidence: number,
  processingTimeMs: number,
  issues: AgentIssue[] = [],
  warnings: string[] = []
): AgentMetadata {
  const breakdown = createDefaultConfidenceBreakdown({
    dataCompleteness: confidence,
    semanticCoherence: confidence,
    upstreamInfluence: 1.0,
    processingQuality: confidence,
  });

  return {
    confidence,
    confidenceBreakdown: breakdown,
    qualityScore: Math.round(confidence * 100),
    issues,
    warnings,
    processingTimeMs,
  };
}

/**
 * Create a complete AgentResponse
 */
export function createAgentResponse<T>(
  data: T,
  agentId: string,
  stepName: string,
  metadata: AgentMetadata,
  routing: AgentRouting = createDefaultRouting(),
  corrections?: AgentCorrections
): AgentResponse<T> {
  return {
    data,
    metadata,
    routing,
    corrections,
    timestamp: new Date().toISOString(),
    agentId,
    stepName,
  };
}

/**
 * Create an issue object
 */
export function createIssue(
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
  return {
    severity,
    category,
    code,
    message,
    affectedEntities: options?.affectedEntities,
    suggestedFix: options?.suggestedFix,
    retryable: options?.retryable ?? severity !== 'critical',
    context: options?.context,
  };
}

/**
 * Check if response has critical issues
 */
export function hasCriticalIssues(response: AgentResponse<unknown>): boolean {
  return response.metadata.issues.some(issue => issue.severity === 'critical');
}

/**
 * Check if response has retryable issues
 */
export function hasRetryableIssues(response: AgentResponse<unknown>): boolean {
  return response.metadata.issues.some(issue => issue.retryable);
}

/**
 * Get all issues above a severity threshold
 */
export function getIssuesAboveSeverity(
  response: AgentResponse<unknown>,
  minSeverity: IssueSeverity
): AgentIssue[] {
  const severityOrder: Record<IssueSeverity, number> = {
    info: 0,
    warning: 1,
    critical: 2,
  };
  const minLevel = severityOrder[minSeverity];
  return response.metadata.issues.filter(issue => severityOrder[issue.severity] >= minLevel);
}

/**
 * Aggregate upstream contexts for downstream agent
 */
export function aggregateUpstreamContexts(
  responses: AgentResponse<unknown>[],
  stepName: string
): UpstreamContext[] {
  return responses.map(response => ({
    sourceAgent: response.agentId,
    sourceStep: response.stepName,
    confidence: response.metadata.confidence,
    relevantIssues: response.metadata.issues.filter(i => i.severity !== 'info'),
    routingSuggestions: response.routing.suggestions,
  }));
}
