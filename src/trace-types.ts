/**
 * Shared trace type contracts for pipeline observability.
 *
 * These interfaces define the shape of trace events captured during
 * wave-analysis execution. They are consumed by both the wave-controller
 * (producer) and the dashboard frontend (consumer via stepsDetail).
 *
 * @module trace-types
 */

/**
 * A single LLM call event captured during pipeline execution.
 * Each call to an LLM provider produces one of these records.
 */
export interface TraceLLMCall {
  /** Unique identifier for this call */
  id: string;
  /** Model name, e.g. "llama-3.3-70b-versatile" */
  model: string;
  /** Provider name, e.g. "groq" */
  provider: string;
  /** Purpose of the call, e.g. "analyze_component", "classify_entity" */
  purpose: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Input token count */
  tokensIn: number;
  /** Output token count */
  tokensOut: number;
  /** Outcome of the call */
  status: 'success' | 'failed' | 'retried';
  /** Error message if status is 'failed' */
  error?: string;
  /** First 500 characters of the prompt */
  promptPreview?: string;
  /** First 500 characters of the response */
  responsePreview?: string;
}

/**
 * A single CGR (Code Graph RAG) query event captured during pipeline execution.
 * Each Cypher query to Memgraph produces one of these records.
 */
export interface TraceCGRQuery {
  /** Unique identifier for this query */
  id: string;
  /** Type of CGR query performed */
  queryType: 'component_entities' | 'entity_details' | 'call_graph' | 'index_refresh';
  /** Entity name the query was scoped to */
  entityName: string;
  /** Raw Cypher query string (for debugging) */
  cypherQuery?: string;
  /** Number of results returned */
  resultCount: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether this result was served from cache */
  cacheHit: boolean;
  /** Outcome of the query */
  status: 'success' | 'failed' | 'timeout';
  /** Error message if status is 'failed' or 'timeout' */
  error?: string;
}

/**
 * An agent instance that ran during a wave step.
 * Groups LLM calls and entity output under a single agent execution.
 */
export interface TraceAgentInstance {
  /** Unique agent identifier, e.g. "wave2_agent_LiveLogging" */
  agentId: string;
  /** Agent class name, e.g. "Wave2ComponentAgent" */
  agentType: string;
  /** Parent entity this agent was processing */
  parentEntity: string;
  /** ISO timestamp when agent started */
  startTime: string;
  /** ISO timestamp when agent completed */
  endTime?: string;
  /** Current status */
  status: 'running' | 'completed' | 'failed';
  /** LLM calls made by this agent */
  llmCalls: TraceLLMCall[];
  /** Number of entities produced */
  entityCount: number;
  /** Number of observations generated */
  observationCount: number;
}

/**
 * Entity flow counters tracking how many entities survived each pipeline stage.
 */
export interface TraceEntityFlow {
  /** Entities produced by analysis */
  produced: number;
  /** Entities that passed QA validation */
  passedQA: number;
  /** Entities successfully persisted to the knowledge graph */
  persisted: number;
  /** Breakdown of rejection reasons and counts */
  rejectedReasons?: Record<string, number>;
}

/**
 * QA validation result for a wave step.
 */
export interface TraceQAResult {
  /** Whether QA passed */
  passed: boolean;
  /** QA score (0-100) */
  score: number;
  /** QA error messages */
  errors?: string[];
  /** Whether this result is from a retry attempt */
  retried?: boolean;
}

/**
 * Extension fields added to stepsDetail entries in workflow-progress.json.
 * These provide granular trace data for the dashboard to consume.
 */
export interface TraceStepExtension {
  /** Agent instances that ran during this step */
  agentInstances?: TraceAgentInstance[];
  /** Entity flow counters for this step */
  entityFlow?: TraceEntityFlow;
  /** QA validation result for this step */
  qaResult?: TraceQAResult;
  /** Individual LLM call events (from all agents in this step) */
  llmCallEvents?: TraceLLMCall[];
  /** Individual CGR query events (from all agents in this step) */
  cgrQueryEvents?: TraceCGRQuery[];
}
