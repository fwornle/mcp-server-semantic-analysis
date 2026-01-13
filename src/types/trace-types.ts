/**
 * Comprehensive trace types for UKB workflow visibility
 * These types enable detailed tracking of data flow through each step
 */

/**
 * LLM usage metrics for a single step
 */
export interface LLMUsageTrace {
  used: boolean;
  provider?: string;
  model?: string;
  calls: number;
  tokens: number;
  latencyMs?: number;
  fallbackToRegex: boolean;
  fallbackReason?: string;
}

/**
 * Input data summary for a step
 */
export interface StepInputTrace {
  count: number;                        // Number of items received
  itemNames: string[];                  // ALL item names (not samples)
  itemTypes: Record<string, number>;    // Type distribution { type: count }
  sampleContent?: string[];             // First 3 items' content for debugging
  sourceStep?: string;                  // Which step produced this input
}

/**
 * Output data summary for a step
 */
export interface StepOutputTrace {
  count: number;                        // Number of items produced
  itemNames: string[];                  // ALL item names
  itemTypes: Record<string, number>;    // Type distribution
  sampleContent?: string[];             // First 3 items for debugging
}

/**
 * Transformation metrics showing data changes
 */
export interface TransformationTrace {
  itemsAdded: number;
  itemsRemoved: number;
  itemsModified: number;
  itemsFiltered: number;               // Items removed by validation
  filteredItems: Array<{               // Details of filtered items
    name: string;
    reason: string;
  }>;
  dataLossPercent: number;             // (input - output) / input * 100
}

/**
 * Complete trace data for a single workflow step
 */
export interface StepTraceData {
  stepName: string;
  batchId: string;
  batchNumber?: number;
  timestamp: string;
  durationMs: number;

  // What went INTO this step
  input: StepInputTrace;

  // What came OUT of this step
  output: StepOutputTrace;

  // How data was transformed
  transformation: TransformationTrace;

  // LLM usage details
  llm?: LLMUsageTrace;

  // Any warnings or issues
  warnings: string[];
  errors: string[];
}

/**
 * Commit data for tracing (truncated for report readability)
 */
export interface TracedCommit {
  hash: string;                  // Full hash
  shortHash: string;             // First 7 chars
  message: string;               // Truncated to 80 chars
  date: string;
  author?: string;
  filesChanged?: number;
}

/**
 * Session data for tracing
 */
export interface TracedSession {
  id: string;
  filename?: string;
  summary: string;               // Summary text (synthesized if missing)
  timestamp: string;
  exchangeCount: number;
  hasSynthesizedSummary: boolean;
}

/**
 * Concept extracted during semantic analysis
 */
export interface TracedConcept {
  name: string;
  type: string;
  sourceStep: string;
  batchId: string;
  significance?: number;
  llmSynthesized: boolean;
}

/**
 * Observation generated during observation generation
 */
export interface TracedObservation {
  name: string;
  entityType: string;
  significance: number;
  observationCount: number;      // Number of observations in this entity
  sourceConcepts: string[];      // Concepts that contributed
}

/**
 * Final entity after classification
 */
export interface TracedEntity {
  name: string;
  type: string;                  // Ontology class
  classificationMethod: 'llm' | 'keyword' | 'similarity' | 'unclassified';
  confidence?: number;
}

/**
 * Complete trace data for a single batch
 */
export interface BatchTraceData {
  batchId: string;
  batchNumber: number;
  startTime: string;
  endTime?: string;
  durationMs?: number;

  // Step-by-step traces
  steps: StepTraceData[];

  // ALL commits in this batch (truncated messages)
  commits: TracedCommit[];

  // ALL sessions in this batch
  sessions: TracedSession[];

  // ALL concepts extracted (names and types)
  concepts: TracedConcept[];

  // ALL observations generated
  observations: TracedObservation[];

  // ALL entities after classification
  entities: TracedEntity[];

  // Summary metrics
  summary: {
    totalCommits: number;
    totalSessions: number;
    totalConcepts: number;
    totalObservations: number;
    totalEntities: number;
    dataLossPercent: number;     // From concepts to entities
    llmCallsTotal: number;
    tokensUsedTotal: number;
  };
}

/**
 * Data flow summary across all batches
 */
export interface DataFlowSummary {
  step: string;
  inputCount: number;
  outputCount: number;
  lossPercent: number;
  llmUsed: boolean;
  provider?: string;
}

/**
 * Complete trace report for an entire workflow run
 */
export interface UKBTraceReport {
  // Workflow metadata
  workflowId: string;
  workflowName: string;
  team: string;
  repositoryPath: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startTime: string;
  endTime?: string;
  durationMinutes?: number;

  // All batch traces
  batches: BatchTraceData[];

  // Aggregated summaries
  summary: {
    totalBatches: number;
    totalCommits: number;
    totalSessions: number;
    totalConceptsExtracted: number;
    totalObservationsGenerated: number;
    totalFinalEntities: number;
    overallDataLossPercent: number;
    llmCallsTotal: number;
    tokensUsedTotal: number;
    averageBatchDurationMs: number;
  };

  // Data flow across all steps (aggregated)
  dataFlow: DataFlowSummary[];

  // All concept names across all batches (for searchability)
  allConceptNames: string[];

  // All entity names across all batches (for searchability)
  allEntityNames: string[];

  // Quality issues detected
  qualityIssues: Array<{
    batchId?: string;
    step: string;
    severity: 'info' | 'warning' | 'error';
    category: string;
    message: string;
    details?: Record<string, any>;
  }>;
}

/**
 * Helper to create a traced commit from raw commit data
 */
export function createTracedCommit(commit: any): TracedCommit {
  return {
    hash: commit.hash || '',
    shortHash: (commit.hash || '').substring(0, 7),
    message: (commit.message || '').substring(0, 80),
    date: commit.date || new Date().toISOString(),
    author: commit.author,
    filesChanged: commit.files?.length || commit.stats?.totalChanges
  };
}

/**
 * Helper to create a traced session from raw session data
 */
export function createTracedSession(session: any, synthesizedSummary?: string): TracedSession {
  const summary = session.metadata?.summary || synthesizedSummary || 'No summary';
  return {
    id: session.metadata?.sessionId || session.filename || 'unknown',
    filename: session.filename,
    summary: summary.substring(0, 200),
    timestamp: session.timestamp || new Date().toISOString(),
    exchangeCount: session.exchanges?.length || 0,
    hasSynthesizedSummary: !session.metadata?.summary && !!synthesizedSummary
  };
}

/**
 * Helper to calculate data loss percentage
 */
export function calculateDataLoss(input: number, output: number): number {
  if (input === 0) return 0;
  return Math.round(((input - output) / input) * 100);
}
