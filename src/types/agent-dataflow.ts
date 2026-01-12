/**
 * Agent Dataflow Types - Structured Interfaces for Multi-Agent Pipeline
 *
 * This module defines the strict input/output contracts for each agent in the
 * UKB (Update Knowledge Base) workflow. Every agent must consume and produce
 * data matching these interfaces exactly.
 *
 * DESIGN PRINCIPLE: No fallbacks, no guessing, no optional structure variations.
 * If an interface says `metadata.summary`, that's where it is. Period.
 *
 * @module types/agent-dataflow
 * @version 1.0.0
 */

// =============================================================================
// COMMON TYPES - Shared across agents
// =============================================================================

/**
 * Git commit extracted from repository history
 */
export interface GitCommit {
  hash: string;
  message: string;
  date: string | Date;
  author?: string;
  files: GitFileChange[];
  stats: CommitStats;
}

/**
 * File change within a commit
 */
export interface GitFileChange {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C';
  additions: number;
  deletions: number;
}

/**
 * Statistics for a commit
 */
export interface CommitStats {
  additions: number;
  deletions: number;
  totalChanges: number;
}

// =============================================================================
// GIT HISTORY AGENT
// =============================================================================

/**
 * Input to GitHistoryAgent
 */
export interface GitHistoryAgentInput {
  repositoryPath: string;
  sinceDate?: Date;
  untilDate?: Date;
  maxCommits?: number;
}

/**
 * Output from GitHistoryAgent
 */
export interface GitHistoryAgentOutput {
  commits: GitCommit[];
  totalCommits: number;
  dateRange: {
    start: string;
    end: string;
  };
}

// =============================================================================
// VIBE HISTORY AGENT
// =============================================================================

/**
 * Exchange within a conversation session
 */
export interface ConversationExchange {
  userMessage: string;
  assistantMessage: string;
  timestamp?: Date;
  context?: {
    toolsUsed?: string[];
    files?: string[];
  };
}

/**
 * Session metadata - summary lives HERE, not at top level
 */
export interface SessionMetadata {
  sessionId?: string;
  startTime?: Date;
  endTime?: Date;
  totalMessages: number;
  /** Summary is ALWAYS in metadata, never at session root */
  summary?: string;
}

/**
 * Conversation session from vibe history
 * CRITICAL: summary is at metadata.summary, NOT session.summary
 */
export interface ConversationSession {
  filename: string;
  timestamp: Date;
  project: string;
  sessionType: string;
  exchanges: ConversationExchange[];
  metadata: SessionMetadata;
}

/**
 * Input to VibeHistoryAgent
 */
export interface VibeHistoryAgentInput {
  repositoryPath: string;
  sinceDate?: Date;
  untilDate?: Date;
  project?: string;
}

/**
 * Output from VibeHistoryAgent
 */
export interface VibeHistoryAgentOutput {
  sessions: ConversationSession[];
  totalSessions: number;
  dateRange: {
    start: string;
    end: string;
  };
}

// =============================================================================
// SEMANTIC ANALYSIS AGENT
// =============================================================================

/**
 * Input to SemanticAnalysisAgent
 */
export interface SemanticAnalysisAgentInput {
  gitAnalysis: {
    commits: GitCommit[];
    architecturalDecisions?: ArchitecturalDecision[];
    codeEvolution?: CodeEvolutionPattern[];
  };
  vibeAnalysis: {
    sessions: Array<{
      content: string;
      timestamp: Date;
    }>;
    problemSolutionPairs?: ProblemSolutionPair[];
    patterns?: {
      developmentThemes?: string[];
    };
  };
  options?: {
    analysisDepth?: 'surface' | 'deep' | 'comprehensive';
    codeGraphAnalysis?: any;
    docAnalysis?: any;
  };
}

/**
 * Architectural decision detected in code
 */
export interface ArchitecturalDecision {
  type: string;
  description: string;
  files: string[];
  impact: 'high' | 'medium' | 'low';
  commit?: string;
}

/**
 * Code evolution pattern
 */
export interface CodeEvolutionPattern {
  pattern: string;
  frequency: number;
  files: string[];
  trend: 'growing' | 'stable' | 'declining';
}

/**
 * Problem-solution pair from vibe analysis
 */
export interface ProblemSolutionPair {
  problem: {
    description: string;
    context?: string;
  };
  solution: {
    description: string;
    technologies: string[];
    steps: string[];
    outcome?: string;
  };
}

/**
 * Output from SemanticAnalysisAgent
 */
export interface SemanticAnalysisAgentOutput {
  codeAnalysis: {
    architecturalPatterns: Array<{
      name: string;
      description: string;
      files: string[];
      confidence: number;
    }>;
    totalFiles: number;
    averageComplexity?: number;
  };
  crossAnalysisInsights: {
    correlations: string[];
    evolutionTrends: string[];
    riskFactors: string[];
  };
  semanticInsights: {
    keyPatterns: string[];
    architecturalDecisions: string[];
    technicalDebt: string[];
    innovativeApproaches: string[];
    learnings: string[];
  };
  insights: string;
  confidence: number;
  processingTime: number;
}

// =============================================================================
// OBSERVATION GENERATION AGENT
// =============================================================================

/**
 * Structured observation - the core output unit
 */
export interface StructuredObservation {
  id: string;
  name: string;
  entityType: string;
  observations: string[];
  relationships: ObservationRelationship[];
  timestamp: string;
  observationType: string;
  content: string;
  entities: Array<{
    name: string;
    type: string;
    confidence: number;
  }>;
  relations: any[];
  metadata: ObservationMetadata;
  significance: number;
}

/**
 * Relationship within an observation
 */
export interface ObservationRelationship {
  from: string;
  to: string;
  relationType: string;
  type?: string;
  target?: string;
}

/**
 * Observation metadata
 */
export interface ObservationMetadata {
  created_at: string;
  last_updated: string;
  confidence: number;
  sourceType: string;
  processingPhase: string;
  tags?: string[];
  sessionId?: string;
}

/**
 * Input to ObservationGenerationAgent
 */
export interface ObservationGenerationAgentInput {
  gitAnalysis: {
    commits: GitCommit[];
    architecturalDecisions: ArchitecturalDecision[];
    codeEvolution: CodeEvolutionPattern[];
  };
  vibeAnalysis: {
    sessions: ConversationSession[];
    problemSolutionPairs?: ProblemSolutionPair[];
    patterns?: any;
  };
  insights: {
    insights: Array<{
      description: string;
      type: string;
      confidence: number;
    }>;
  };
}

/**
 * Output from ObservationGenerationAgent
 */
export interface ObservationGenerationAgentOutput {
  observations: StructuredObservation[];
  summary?: {
    totalObservations: number;
    byType: Record<string, number>;
    averageSignificance: number;
  };
}

// =============================================================================
// ONTOLOGY CLASSIFICATION AGENT
// =============================================================================

/**
 * Entity before classification
 */
export interface UnclassifiedEntity {
  id: string;
  name: string;
  type: string;
  observations: string[];
  significance: number;
  batchId?: string;
}

/**
 * Classification result for a single entity
 */
export interface EntityClassification {
  entity: UnclassifiedEntity;
  ontologyClass: string;
  ontologyMetadata: {
    ontologyClass: string;
    matchedPattern?: string;
    confidence: number;
    classificationMethod: 'llm' | 'pattern' | 'fallback';
  };
}

/**
 * Input to OntologyClassificationAgent
 */
export interface OntologyClassificationAgentInput {
  entities: UnclassifiedEntity[];
  team: string;
  repositoryPath: string;
}

/**
 * Output from OntologyClassificationAgent
 */
export interface OntologyClassificationAgentOutput {
  classified: EntityClassification[];
  unclassified: UnclassifiedEntity[];
  summary: {
    classifiedCount: number;
    unclassifiedCount: number;
    byClass: Record<string, number>;
    byMethod: Record<string, number>;
    llmCalls: number;
    llmUsage?: {
      totalTokens: number;
      providersUsed: string[];
      modelsUsed: string[];
    };
  };
}

// =============================================================================
// QUALITY ASSURANCE AGENT
// =============================================================================

/**
 * Knowledge graph entity
 */
export interface KGEntity {
  id: string;
  name: string;
  type: string;
  observations: string[];
  significance: number;
  embedding?: number[];
  role?: 'core' | 'non-core';
  batchId?: string;
  timestamp?: string;
}

/**
 * Knowledge graph relation
 */
export interface KGRelation {
  from: string;
  to: string;
  type: string;
  weight: number;
  source: 'explicit' | 'inferred' | 'semantic';
  batchId?: string;
}

/**
 * QA validation issue
 */
export interface QAIssue {
  entityId: string;
  entityName: string;
  issueType: 'empty_observations' | 'low_significance' | 'orphan' | 'duplicate' | 'invalid_type';
  severity: 'error' | 'warning' | 'info';
  message: string;
  autoFixed?: boolean;
}

/**
 * Input to QualityAssuranceAgent
 */
export interface QualityAssuranceAgentInput {
  entities: KGEntity[];
  relations: KGRelation[];
  batchId?: string;
}

/**
 * Output from QualityAssuranceAgent
 */
export interface QualityAssuranceAgentOutput {
  validatedEntities: KGEntity[];
  validatedRelations: KGRelation[];
  issues: QAIssue[];
  stats: {
    entitiesCreated: number;
    entitiesRemoved: number;
    relationsAdded: number;
    relationsRemoved: number;
    issuesFound: number;
    issuesFixed: number;
  };
  passed: boolean;
}

// =============================================================================
// PERSISTENCE AGENT
// =============================================================================

/**
 * Input to PersistenceAgent
 */
export interface PersistenceAgentInput {
  entities: KGEntity[];
  relations: KGRelation[];
  team: string;
}

/**
 * Output from PersistenceAgent
 */
export interface PersistenceAgentOutput {
  entitiesCreated: number;
  entitiesUpdated: number;
  relationsCreated: number;
  relationsUpdated: number;
  errors: string[];
}

// =============================================================================
// BATCH WORKFLOW TYPES
// =============================================================================

/**
 * Batch definition for parallel processing
 */
export interface WorkflowBatch {
  id: string;
  batchNumber: number;
  startDate: Date;
  endDate: Date;
  commitCount: number;
  startCommit?: string;
  endCommit?: string;
}

/**
 * Batch processing result
 */
export interface BatchResult {
  batchId: string;
  entities: KGEntity[];
  relations: KGRelation[];
  observations: StructuredObservation[];
  llmMetrics?: {
    totalCalls: number;
    totalTokens: number;
    providers: string[];
  };
  duration: number;
}

// =============================================================================
// TYPE GUARDS - Use these to validate data at runtime
// =============================================================================

/**
 * Check if a session has valid summary
 */
export function hasValidSummary(session: ConversationSession): boolean {
  return typeof session.metadata?.summary === 'string' &&
         session.metadata.summary.trim().length >= 10;
}

/**
 * Check if observation is complete
 */
export function isCompleteObservation(obs: Partial<StructuredObservation>): obs is StructuredObservation {
  return typeof obs.id === 'string' &&
         typeof obs.name === 'string' &&
         typeof obs.entityType === 'string' &&
         Array.isArray(obs.observations) &&
         obs.observations.length > 0 &&
         typeof obs.significance === 'number';
}

/**
 * Validate entity has required fields
 */
export function isValidEntity(entity: Partial<KGEntity>): entity is KGEntity {
  return typeof entity.id === 'string' &&
         typeof entity.name === 'string' &&
         typeof entity.type === 'string' &&
         Array.isArray(entity.observations) &&
         typeof entity.significance === 'number';
}
