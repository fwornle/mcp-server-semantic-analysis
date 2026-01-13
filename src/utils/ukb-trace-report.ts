/**
 * UKB Trace Report Generator
 *
 * Creates detailed trace reports for each UKB workflow run, capturing:
 * - Data flow through each agent
 * - What concepts are extracted from which sources
 * - Ontology classification mappings
 * - Observation derivation details
 * - QA issues at each step
 * - Loss tracking (where data is filtered/dropped)
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Interfaces
// ============================================================================

export interface BatchSourceData {
  batchId: string;
  batchNumber: number;

  // Git History Agent output
  gitHistory: {
    commitsCount: number;
    commits: Array<{
      hash: string;
      message: string;
      filesChanged: string[];
      author: string;
      date: string;
    }>;
    codeFilesDiscovered: string[];
    architecturalDecisions: string[];
  };

  // Vibe History Agent output
  vibeHistory: {
    sessionsCount: number;
    sessions: Array<{
      sessionId: string;
      date: string;
      duration: number;
      keyTopics: string[];
      problemsSolved: string[];
      toolsUsed: string[];
    }>;
    vibesExtracted: string[];
  };
}

export interface ConceptExtraction {
  batchId: string;

  // Semantic Analysis Agent output
  concepts: Array<{
    name: string;
    type: string;
    sourceType: 'git' | 'vibe' | 'code' | 'combined';
    sourceReferences: string[]; // commit hashes, session IDs, file paths
    significance: number;
    rawObservations: string[];
  }>;

  entitiesCreated: number;
  relationsCreated: number;
  llmProvider: string;
  tokensUsed: number;
}

export interface ObservationDerivation {
  batchId: string;

  observations: Array<{
    entityName: string;
    observationType: string;
    content: string;
    derivedFrom: {
      gitCommits: string[];
      vibeSessions: string[];
      codeFiles: string[];
    };
    confidence: number;
  }>;

  totalObservations: number;
  observationsByType: Record<string, number>;
}

export interface OntologyClassification {
  batchId: string;

  classifications: Array<{
    entityName: string;
    originalType: string;
    classifiedAs: string;
    ontologyPath: string[];
    confidence: number;
    llmReasoning: string;
  }>;

  classified: number;
  unclassified: number;
  byClass: Record<string, number>;
  llmCalls: number;
  tokensUsed: number;
}

export interface InsightGeneration {
  entityName: string;

  materialsUsed: {
    observations: string[];
    commits: string[];
    sessions: string[];
    codeSnippets: string[];
    patterns: string[];
  };

  insightDocument: {
    title: string;
    filePath: string;
    sections: string[];
    diagramsGenerated: string[];
  };

  significance: number;
  qualityScore: number;
}

export interface QAIssue {
  stepName: string;
  batchId?: string;
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  context?: Record<string, any>;
  resolution?: string;
}

export interface DataLossTracking {
  stepName: string;
  batchId?: string;
  inputCount: number;
  outputCount: number;
  lossCount: number;
  lossPercentage: number;
  lossReasons: Array<{
    reason: string;
    count: number;
    examples: string[];
  }>;
}

export interface UKBTraceReport {
  // Metadata
  workflowId: string;
  workflowName: string;
  team: string;
  repositoryPath: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  status: 'completed' | 'failed' | 'timeout' | 'cancelled';

  // Summary statistics
  summary: {
    totalBatches: number;
    totalCommits: number;
    totalSessions: number;
    totalCodeFiles: number;
    totalConcepts: number;
    totalObservations: number;
    totalInsights: number;
    finalEntities: number;
    finalRelations: number;
    dataLossPercentage: number;
  };

  // Per-batch trace data
  batches: Array<{
    batchId: string;
    batchNumber: number;
    sourceData: BatchSourceData;
    conceptExtraction: ConceptExtraction;
    observationDerivation: ObservationDerivation;
    ontologyClassification: OntologyClassification;
    qaIssues: QAIssue[];
    dataLoss: DataLossTracking[];
  }>;

  // Finalization phase
  finalization: {
    codeGraphStats: {
      totalFunctions: number;
      totalClasses: number;
      totalMethods: number;
      languageDistribution: Record<string, number>;
    };
    insightGeneration: InsightGeneration[];
    finalPersistence: {
      entitiesPersisted: number;
      relationsPersisted: number;
      duplicatesRemoved: number;
    };
    validation: {
      validationTimeout: boolean;
      validationDuration: number;
      issuesFound: number;
      staleEntities: number;
    };
  };

  // Cross-cutting concerns
  qaReport: {
    totalIssues: number;
    byStep: Record<string, QAIssue[]>;
    criticalIssues: QAIssue[];
    recommendations: string[];
  };

  dataLossReport: {
    totalInputItems: number;
    totalOutputItems: number;
    overallLossPercentage: number;
    byStep: DataLossTracking[];
    biggestLossPoints: Array<{
      step: string;
      lossPercentage: number;
      recommendation: string;
    }>;
  };

  // LLM usage
  llmUsage: {
    totalCalls: number;
    totalTokens: number;
    byProvider: Record<string, { calls: number; tokens: number }>;
    byStep: Record<string, { calls: number; tokens: number }>;
  };
}

// ============================================================================
// Trace Report Manager
// ============================================================================

export class UKBTraceReportManager {
  private report: Partial<UKBTraceReport>;
  private reportsDir: string;
  private currentBatchData: Map<string, any> = new Map();

  constructor(repositoryPath: string) {
    this.reportsDir = path.join(repositoryPath, '.data', 'ukb-trace-reports');
    this.ensureDir(this.reportsDir);
    this.report = {
      batches: [],
      finalization: {
        codeGraphStats: { totalFunctions: 0, totalClasses: 0, totalMethods: 0, languageDistribution: {} },
        insightGeneration: [],
        finalPersistence: { entitiesPersisted: 0, relationsPersisted: 0, duplicatesRemoved: 0 },
        validation: { validationTimeout: false, validationDuration: 0, issuesFound: 0, staleEntities: 0 }
      },
      qaReport: { totalIssues: 0, byStep: {}, criticalIssues: [], recommendations: [] },
      dataLossReport: { totalInputItems: 0, totalOutputItems: 0, overallLossPercentage: 0, byStep: [], biggestLossPoints: [] },
      llmUsage: { totalCalls: 0, totalTokens: 0, byProvider: {}, byStep: {} }
    };
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  startWorkflow(workflowId: string, workflowName: string, team: string, repositoryPath: string): void {
    this.report.workflowId = workflowId;
    this.report.workflowName = workflowName;
    this.report.team = team;
    this.report.repositoryPath = repositoryPath;
    this.report.startTime = new Date().toISOString();
    this.report.status = 'completed';

    console.error(`[UKBTraceReport] Started workflow ${workflowId}`);
  }

  // ============================================================================
  // Batch Tracing
  // ============================================================================

  startBatch(batchId: string, batchNumber: number): void {
    this.currentBatchData.set(batchId, {
      batchId,
      batchNumber,
      sourceData: {
        batchId,
        batchNumber,
        gitHistory: { commitsCount: 0, commits: [], codeFilesDiscovered: [], architecturalDecisions: [] },
        vibeHistory: { sessionsCount: 0, sessions: [], vibesExtracted: [] }
      },
      conceptExtraction: {
        batchId,
        concepts: [],
        entitiesCreated: 0,
        relationsCreated: 0,
        llmProvider: '',
        tokensUsed: 0
      },
      observationDerivation: {
        batchId,
        observations: [],
        totalObservations: 0,
        observationsByType: {}
      },
      ontologyClassification: {
        batchId,
        classifications: [],
        classified: 0,
        unclassified: 0,
        byClass: {},
        llmCalls: 0,
        tokensUsed: 0
      },
      qaIssues: [],
      dataLoss: []
    });
  }

  traceGitHistory(batchId: string, gitResult: any): void {
    const batch = this.currentBatchData.get(batchId);
    if (!batch) return;

    const commits = gitResult?.commits || [];
    // ENHANCED: Store ALL commits, not just first 20
    batch.sourceData.gitHistory = {
      commitsCount: commits.length,
      commits: commits.map((c: any) => ({
        hash: c.hash?.substring(0, 8) || 'unknown',
        message: (c.message || '').substring(0, 100),  // Truncate message, but keep all commits
        filesChanged: c.files || [],  // Keep all files
        author: c.author || 'unknown',
        date: c.date || ''
      })),
      codeFilesDiscovered: this.extractUniqueFiles(commits),  // All files, no slice
      architecturalDecisions: gitResult?.architecturalDecisions || []
    };

    console.error(`[UKBTraceReport] Batch ${batchId}: ${commits.length} commits, ${batch.sourceData.gitHistory.codeFilesDiscovered.length} files`);
  }

  traceVibeHistory(batchId: string, vibeResult: any): void {
    const batch = this.currentBatchData.get(batchId);
    if (!batch) return;

    const sessions = vibeResult?.sessions || [];
    // ENHANCED: Store ALL sessions, not just first 20
    batch.sourceData.vibeHistory = {
      sessionsCount: sessions.length,
      sessions: sessions.map((s: any) => ({
        sessionId: s.sessionId || s.metadata?.sessionId || s.id || s.filename || 'unknown',
        date: s.date || s.timestamp || '',
        duration: s.duration || 0,
        keyTopics: s.keyTopics || [],
        problemsSolved: s.problemsSolved || [],
        toolsUsed: s.toolsUsed || [],
        summary: s.metadata?.summary || this.extractSessionSummary(s) || '',
        exchangeCount: s.exchanges?.length || 0
      })),
      vibesExtracted: this.extractVibes(sessions)  // All vibes, no slice
    };

    console.error(`[UKBTraceReport] Batch ${batchId}: ${sessions.length} sessions, ${batch.sourceData.vibeHistory.vibesExtracted.length} vibes`);
  }

  /**
   * Extract a summary from session exchanges when metadata.summary is missing
   */
  private extractSessionSummary(session: any): string {
    if (!session?.exchanges?.length) return '';
    const firstExchange = session.exchanges[0];
    const userMsg = firstExchange?.userMessage || firstExchange?.user || '';
    if (userMsg && typeof userMsg === 'string') {
      return userMsg.substring(0, 100);
    }
    return `Session with ${session.exchanges.length} exchanges`;
  }

  traceSemanticAnalysis(batchId: string, semanticResult: any, llmProvider: string, tokensUsed: number): void {
    const batch = this.currentBatchData.get(batchId);
    if (!batch) return;

    const entities = semanticResult?.entities || [];
    // ENHANCED: Store ALL entities/concepts, not just first 30
    batch.conceptExtraction = {
      batchId,
      concepts: entities.map((e: any) => ({
        name: e.name || 'unknown',
        type: e.type || e.entityType || 'unknown',
        sourceType: this.inferSourceType(e),
        sourceReferences: this.extractSourceRefs(e),  // All refs, no slice
        significance: e.significance || 5,
        rawObservations: e.observations || []  // All observations, no slice
      })),
      entitiesCreated: entities.length,
      relationsCreated: semanticResult?.relations?.length || 0,
      llmProvider,
      tokensUsed
    };

    // Track data loss from source to concepts
    const inputItems = batch.sourceData.gitHistory.commitsCount + batch.sourceData.vibeHistory.sessionsCount;
    this.trackDataLoss(batch, 'semantic_analysis', inputItems, entities.length);

    console.error(`[UKBTraceReport] Batch ${batchId}: ${entities.length} entities, ${semanticResult?.relations?.length || 0} relations`);
  }

  traceObservations(batchId: string, observationResult: any): void {
    const batch = this.currentBatchData.get(batchId);
    if (!batch) return;

    const observations = observationResult?.observations || [];
    const byType: Record<string, number> = {};

    // ENHANCED: Store ALL observations, not just first 30
    batch.observationDerivation = {
      batchId,
      observations: observations.map((o: any) => {
        const type = o.entityType || o.type || 'unknown';
        byType[type] = (byType[type] || 0) + 1;

        // Extract first observation content for tracing
        const firstObs = o.observations?.[0];
        const content = typeof firstObs === 'string'
          ? firstObs
          : (firstObs?.content || '');

        return {
          entityName: o.name || 'unknown',
          observationType: type,
          content: content.substring(0, 300),  // More content for debugging
          observationCount: o.observations?.length || 0,
          significance: o.significance || 5,
          derivedFrom: {
            gitCommits: o.metadata?.sourceCommits || [],
            vibeSessions: o.metadata?.sourceSessions || [],
            codeFiles: o.metadata?.sourceFiles || []
          },
          confidence: o.metadata?.confidence || 0.5,
          llmSynthesized: o.metadata?.llmSynthesized || false
        };
      }),
      totalObservations: observations.length,
      observationsByType: byType
    };

    // Track data loss from entities to observations
    this.trackDataLoss(batch, 'observation_generation', batch.conceptExtraction.entitiesCreated, observations.length);

    console.error(`[UKBTraceReport] Batch ${batchId}: ${observations.length} observations`);
  }

  traceOntologyClassification(batchId: string, classificationResult: any, llmCalls: number, tokensUsed: number): void {
    const batch = this.currentBatchData.get(batchId);
    if (!batch) return;

    const classified = classificationResult?.classified || [];
    const byClass: Record<string, number> = {};

    // ENHANCED: Store ALL classifications, not just first 30
    batch.ontologyClassification = {
      batchId,
      classifications: classified.map((c: any) => {
        const classType = c.ontologyClass || c.ontologyMetadata?.ontologyClass || c.type || 'Unclassified';
        byClass[classType] = (byClass[classType] || 0) + 1;

        return {
          entityName: c.entity?.name || c.name || c.original?.name || 'unknown',
          originalType: c.originalType || c.original?.entityType || 'unknown',
          classifiedAs: classType,
          ontologyPath: c.ontologyPath || c.ontologyMetadata?.ontologyPath || [classType],
          confidence: c.confidence || c.ontologyMetadata?.confidence || 0.5,
          llmReasoning: (c.reasoning || c.ontologyMetadata?.reasoning || '').substring(0, 300),
          method: c.method || c.ontologyMetadata?.method || 'unknown'
        };
      }),
      classified: classified.length,
      unclassified: classificationResult?.unclassified?.length || classificationResult?.summary?.unclassifiedCount || 0,
      byClass,
      llmCalls,
      tokensUsed
    };

    console.error(`[UKBTraceReport] Batch ${batchId}: ${classified.length} classified, byClass: ${JSON.stringify(byClass)}`);
  }

  traceQAIssue(batchId: string | undefined, stepName: string, issue: Omit<QAIssue, 'stepName' | 'batchId'>): void {
    const qaIssue: QAIssue = { ...issue, stepName, batchId };

    if (batchId) {
      const batch = this.currentBatchData.get(batchId);
      if (batch) {
        batch.qaIssues.push(qaIssue);
      }
    }

    // Add to global QA report
    if (!this.report.qaReport!.byStep[stepName]) {
      this.report.qaReport!.byStep[stepName] = [];
    }
    this.report.qaReport!.byStep[stepName].push(qaIssue);
    this.report.qaReport!.totalIssues++;

    if (issue.severity === 'error') {
      this.report.qaReport!.criticalIssues.push(qaIssue);
    }
  }

  endBatch(batchId: string): void {
    const batch = this.currentBatchData.get(batchId);
    if (!batch) return;

    this.report.batches!.push(batch);
    this.currentBatchData.delete(batchId);
  }

  // ============================================================================
  // Finalization Tracing
  // ============================================================================

  traceCodeGraph(codeGraphResult: any): void {
    const stats = codeGraphResult?.codeGraphStats || {};
    const entityTypes = stats.entityTypeDistribution || {};

    this.report.finalization!.codeGraphStats = {
      totalFunctions: entityTypes.function || 0,
      totalClasses: entityTypes.class || 0,
      totalMethods: entityTypes.method || 0,
      languageDistribution: stats.languageDistribution || {}
    };

    console.error(`[UKBTraceReport] CodeGraph: ${stats.totalEntities || 0} entities`);
  }

  traceInsightGeneration(insightResult: any): void {
    const insights = insightResult?.insightDocuments || [];

    this.report.finalization!.insightGeneration = insights.map((i: any) => ({
      entityName: i.name || 'unknown',
      materialsUsed: {
        observations: [],
        commits: [],
        sessions: [],
        codeSnippets: [],
        patterns: []
      },
      insightDocument: {
        title: i.title || '',
        filePath: i.filePath || '',
        sections: [],
        diagramsGenerated: []
      },
      significance: i.significance || 5,
      qualityScore: i.qualityScore || 0
    }));

    // Track massive loss from patterns to insights
    const patternsCount = insightResult?.totalPatterns || 0;
    const insightsCount = insights.length;
    this.trackFinalizationLoss('insight_generation', patternsCount, insightsCount);

    console.error(`[UKBTraceReport] Insights: ${insights.length} documents from ${patternsCount} patterns`);
  }

  tracePersistence(persistResult: any): void {
    this.report.finalization!.finalPersistence = {
      entitiesPersisted: persistResult?.entitiesPersisted || persistResult?.created || 0,
      relationsPersisted: persistResult?.relationsPersisted || 0,
      duplicatesRemoved: persistResult?.duplicatesRemoved || 0
    };
  }

  traceValidation(validationResult: any, durationMs: number): void {
    this.report.finalization!.validation = {
      validationTimeout: !!validationResult?.error?.includes('timeout'),
      validationDuration: durationMs,
      issuesFound: validationResult?.issues?.length || 0,
      staleEntities: validationResult?.staleEntities?.length || 0
    };

    if (validationResult?.error?.includes('timeout')) {
      this.traceQAIssue(undefined, 'content_validation', {
        severity: 'error',
        category: 'timeout',
        message: `Validation timed out after ${durationMs}ms`,
        context: { timeout: 300000 }
      });
    }
  }

  traceLLMUsage(stepName: string, provider: string, calls: number, tokens: number): void {
    this.report.llmUsage!.totalCalls += calls;
    this.report.llmUsage!.totalTokens += tokens;

    if (!this.report.llmUsage!.byProvider[provider]) {
      this.report.llmUsage!.byProvider[provider] = { calls: 0, tokens: 0 };
    }
    this.report.llmUsage!.byProvider[provider].calls += calls;
    this.report.llmUsage!.byProvider[provider].tokens += tokens;

    if (!this.report.llmUsage!.byStep[stepName]) {
      this.report.llmUsage!.byStep[stepName] = { calls: 0, tokens: 0 };
    }
    this.report.llmUsage!.byStep[stepName].calls += calls;
    this.report.llmUsage!.byStep[stepName].tokens += tokens;
  }

  // ============================================================================
  // Finalize & Save
  // ============================================================================

  endWorkflow(status: 'completed' | 'failed' | 'timeout' | 'cancelled', finalEntityCount: number, finalRelationCount: number): void {
    this.report.endTime = new Date().toISOString();
    this.report.status = status;
    this.report.durationMs = new Date(this.report.endTime).getTime() - new Date(this.report.startTime!).getTime();

    // Calculate summary
    const batches = this.report.batches || [];
    let totalCommits = 0, totalSessions = 0, totalConcepts = 0, totalObservations = 0;
    const codeFiles = new Set<string>();

    for (const batch of batches) {
      totalCommits += batch.sourceData.gitHistory.commitsCount;
      totalSessions += batch.sourceData.vibeHistory.sessionsCount;
      totalConcepts += batch.conceptExtraction.entitiesCreated;
      totalObservations += batch.observationDerivation.totalObservations;
      batch.sourceData.gitHistory.codeFilesDiscovered.forEach(f => codeFiles.add(f));
    }

    this.report.summary = {
      totalBatches: batches.length,
      totalCommits,
      totalSessions,
      totalCodeFiles: codeFiles.size,
      totalConcepts,
      totalObservations,
      totalInsights: this.report.finalization!.insightGeneration.length,
      finalEntities: finalEntityCount,
      finalRelations: finalRelationCount,
      dataLossPercentage: totalConcepts > 0 ? Math.round((1 - finalEntityCount / totalConcepts) * 100) : 0
    };

    // Calculate data loss report
    this.calculateDataLossReport(totalConcepts, finalEntityCount);

    // Generate recommendations
    this.generateRecommendations();

    // Save report
    this.saveReport();
  }

  private calculateDataLossReport(totalInput: number, totalOutput: number): void {
    this.report.dataLossReport!.totalInputItems = totalInput;
    this.report.dataLossReport!.totalOutputItems = totalOutput;
    this.report.dataLossReport!.overallLossPercentage = totalInput > 0
      ? Math.round((1 - totalOutput / totalInput) * 100)
      : 0;

    // Find biggest loss points
    const losses = this.report.dataLossReport!.byStep.sort((a, b) => b.lossPercentage - a.lossPercentage);
    this.report.dataLossReport!.biggestLossPoints = losses.slice(0, 5).map(l => ({
      step: l.stepName,
      lossPercentage: l.lossPercentage,
      recommendation: this.getLossRecommendation(l.stepName, l.lossPercentage)
    }));
  }

  private generateRecommendations(): void {
    const recs: string[] = [];

    // Check for timeout issues
    if (this.report.finalization!.validation.validationTimeout) {
      recs.push('CRITICAL: Validation step timing out. Consider increasing timeout or reducing entity count.');
    }

    // Check for massive data loss
    if (this.report.summary!.dataLossPercentage > 50) {
      recs.push(`HIGH: ${this.report.summary!.dataLossPercentage}% data loss. Review semantic analysis and deduplication settings.`);
    }

    // Check for low insight generation
    const insightCount = this.report.finalization!.insightGeneration.length;
    if (insightCount < 5 && this.report.summary!.totalConcepts > 50) {
      recs.push(`MEDIUM: Only ${insightCount} insights from ${this.report.summary!.totalConcepts} concepts. Check insight generation thresholds.`);
    }

    // Check for QA issues
    if (this.report.qaReport!.criticalIssues.length > 0) {
      recs.push(`HIGH: ${this.report.qaReport!.criticalIssues.length} critical QA issues need attention.`);
    }

    this.report.qaReport!.recommendations = recs;
  }

  private saveReport(): void {
    const filename = `trace-${this.report.workflowId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const filepath = path.join(this.reportsDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(this.report, null, 2));
    console.error(`[UKBTraceReport] Report saved to ${filepath}`);

    // Also save a "latest" symlink-style copy
    const latestPath = path.join(this.reportsDir, 'latest-trace.json');
    fs.writeFileSync(latestPath, JSON.stringify(this.report, null, 2));
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private extractUniqueFiles(commits: any[]): string[] {
    const files = new Set<string>();
    for (const commit of commits) {
      for (const file of commit.files || []) {
        files.add(file);
      }
    }
    return Array.from(files);
  }

  private extractVibes(sessions: any[]): string[] {
    const vibes: string[] = [];
    for (const session of sessions) {
      if (session.keyTopics) vibes.push(...session.keyTopics);
      if (session.problemsSolved) vibes.push(...session.problemsSolved);
    }
    return [...new Set(vibes)];
  }

  private inferSourceType(entity: any): 'git' | 'vibe' | 'code' | 'combined' {
    const hasGit = entity.sourceCommits?.length > 0 || entity.metadata?.fromGit;
    const hasVibe = entity.sourceSessions?.length > 0 || entity.metadata?.fromVibe;
    const hasCode = entity.metadata?.fromCode;

    if (hasGit && hasVibe) return 'combined';
    if (hasGit) return 'git';
    if (hasVibe) return 'vibe';
    if (hasCode) return 'code';
    return 'combined';
  }

  private extractSourceRefs(entity: any): string[] {
    const refs: string[] = [];
    if (entity.sourceCommits) refs.push(...entity.sourceCommits);
    if (entity.sourceSessions) refs.push(...entity.sourceSessions);
    if (entity.sourceFiles) refs.push(...entity.sourceFiles);
    return refs;
  }

  private trackDataLoss(batch: any, stepName: string, inputCount: number, outputCount: number): void {
    const lossCount = Math.max(0, inputCount - outputCount);
    const lossPercentage = inputCount > 0 ? Math.round((lossCount / inputCount) * 100) : 0;

    const loss: DataLossTracking = {
      stepName,
      batchId: batch.batchId,
      inputCount,
      outputCount,
      lossCount,
      lossPercentage,
      lossReasons: []
    };

    batch.dataLoss.push(loss);
    this.report.dataLossReport!.byStep.push(loss);
  }

  private trackFinalizationLoss(stepName: string, inputCount: number, outputCount: number): void {
    const lossCount = Math.max(0, inputCount - outputCount);
    const lossPercentage = inputCount > 0 ? Math.round((lossCount / inputCount) * 100) : 0;

    this.report.dataLossReport!.byStep.push({
      stepName,
      inputCount,
      outputCount,
      lossCount,
      lossPercentage,
      lossReasons: []
    });
  }

  private getLossRecommendation(stepName: string, lossPercentage: number): string {
    const recs: Record<string, string> = {
      'semantic_analysis': 'Review LLM prompts and entity extraction logic',
      'observation_generation': 'Check observation templates and significance thresholds',
      'ontology_classification': 'Review ontology mappings and confidence thresholds',
      'insight_generation': 'Lower insight generation thresholds or adjust pattern grouping',
      'deduplication': 'Review similarity thresholds - may be too aggressive',
      'persistence': 'Check persistence agent and database connectivity'
    };

    return recs[stepName] || `Review ${stepName} configuration`;
  }

  // ============================================================================
  // Report Reading
  // ============================================================================

  static loadLatestReport(repositoryPath: string): UKBTraceReport | null {
    const latestPath = path.join(repositoryPath, '.data', 'ukb-trace-reports', 'latest-trace.json');

    try {
      if (fs.existsSync(latestPath)) {
        return JSON.parse(fs.readFileSync(latestPath, 'utf-8'));
      }
    } catch (e) {
      console.error(`[UKBTraceReport] Failed to load latest report: ${e}`);
    }

    return null;
  }

  static generateMarkdownReport(report: UKBTraceReport): string {
    let md = `# UKB Trace Report\n\n`;
    md += `**Workflow:** ${report.workflowName} (${report.workflowId})\n`;
    md += `**Team:** ${report.team}\n`;
    md += `**Status:** ${report.status}\n`;
    md += `**Duration:** ${(report.durationMs / 1000 / 60).toFixed(1)} minutes\n`;
    md += `**Date:** ${report.startTime}\n\n`;

    md += `## Summary\n\n`;
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| Total Batches | ${report.summary.totalBatches} |\n`;
    md += `| Total Commits | ${report.summary.totalCommits} |\n`;
    md += `| Total Sessions | ${report.summary.totalSessions} |\n`;
    md += `| Code Files Discovered | ${report.summary.totalCodeFiles} |\n`;
    md += `| Concepts Extracted | ${report.summary.totalConcepts} |\n`;
    md += `| Observations Generated | ${report.summary.totalObservations} |\n`;
    md += `| Insights Created | ${report.summary.totalInsights} |\n`;
    md += `| **Final Entities** | **${report.summary.finalEntities}** |\n`;
    md += `| **Final Relations** | **${report.summary.finalRelations}** |\n`;
    md += `| **Data Loss** | **${report.summary.dataLossPercentage}%** |\n\n`;

    md += `## Data Flow Analysis\n\n`;
    md += `\`\`\`\n`;
    md += `Commits (${report.summary.totalCommits}) + Sessions (${report.summary.totalSessions})\n`;
    md += `  ↓ Semantic Analysis\n`;
    md += `Concepts (${report.summary.totalConcepts})\n`;
    md += `  ↓ Observation Generation\n`;
    md += `Observations (${report.summary.totalObservations})\n`;
    md += `  ↓ Ontology Classification + Deduplication\n`;
    md += `Final Entities (${report.summary.finalEntities})\n`;
    md += `\`\`\`\n\n`;

    if (report.dataLossReport.biggestLossPoints.length > 0) {
      md += `## Data Loss Analysis\n\n`;
      for (const loss of report.dataLossReport.biggestLossPoints) {
        md += `- **${loss.step}**: ${loss.lossPercentage}% loss\n`;
        md += `  - Recommendation: ${loss.recommendation}\n`;
      }
      md += `\n`;
    }

    if (report.qaReport.recommendations.length > 0) {
      md += `## Recommendations\n\n`;
      for (const rec of report.qaReport.recommendations) {
        md += `- ${rec}\n`;
      }
      md += `\n`;
    }

    if (report.qaReport.criticalIssues.length > 0) {
      md += `## Critical Issues\n\n`;
      for (const issue of report.qaReport.criticalIssues) {
        md += `- **${issue.stepName}** [${issue.category}]: ${issue.message}\n`;
      }
      md += `\n`;
    }

    md += `## LLM Usage\n\n`;
    md += `- Total Calls: ${report.llmUsage.totalCalls}\n`;
    md += `- Total Tokens: ${report.llmUsage.totalTokens.toLocaleString()}\n`;
    md += `- Providers: ${Object.keys(report.llmUsage.byProvider).join(', ')}\n\n`;

    // Add detailed per-batch trace for visibility
    if (report.batches && report.batches.length > 0) {
      md += `## Per-Batch Execution Trace\n\n`;
      md += `This section shows exactly what was extracted at each step for each batch.\n\n`;

      // Show first 3 batches in detail, then summary for rest
      const detailedBatches = report.batches.slice(0, 3);
      const remainingBatches = report.batches.slice(3);

      for (const batch of detailedBatches) {
        md += `### Batch ${batch.batchNumber}: ${batch.batchId}\n\n`;

        // Git History Step
        md += `#### 1. Git History Analysis\n`;
        md += `- **Commits Processed:** ${batch.sourceData.gitHistory.commitsCount}\n`;
        if (batch.sourceData.gitHistory.commits.length > 0) {
          md += `- **Sample Commits:**\n`;
          for (const commit of batch.sourceData.gitHistory.commits.slice(0, 3)) {
            md += `  - \`${commit.hash}\`: ${commit.message.substring(0, 60)}${commit.message.length > 60 ? '...' : ''}\n`;
          }
        }
        if (batch.sourceData.gitHistory.codeFilesDiscovered.length > 0) {
          md += `- **Code Files:** ${batch.sourceData.gitHistory.codeFilesDiscovered.slice(0, 5).join(', ')}${batch.sourceData.gitHistory.codeFilesDiscovered.length > 5 ? ` (+${batch.sourceData.gitHistory.codeFilesDiscovered.length - 5} more)` : ''}\n`;
        }
        md += `\n`;

        // Vibe History Step
        md += `#### 2. Vibe/Session Analysis\n`;
        md += `- **Sessions Processed:** ${batch.sourceData.vibeHistory.sessionsCount}\n`;
        if (batch.sourceData.vibeHistory.vibesExtracted.length > 0) {
          md += `- **Vibes Extracted:** ${batch.sourceData.vibeHistory.vibesExtracted.slice(0, 5).join(', ')}\n`;
        }
        md += `\n`;

        // Semantic Analysis Step
        md += `#### 3. Semantic Analysis → Concepts\n`;
        md += `- **Entities Created:** ${batch.conceptExtraction.entitiesCreated}\n`;
        md += `- **Relations Created:** ${batch.conceptExtraction.relationsCreated}\n`;
        md += `- **LLM Provider:** ${batch.conceptExtraction.llmProvider || 'rule-based'}\n`;
        md += `- **Tokens Used:** ${batch.conceptExtraction.tokensUsed}\n`;
        if (batch.conceptExtraction.concepts.length > 0) {
          md += `- **Sample Concepts Extracted:**\n`;
          for (const concept of batch.conceptExtraction.concepts.slice(0, 5)) {
            md += `  - **${concept.name}** (${concept.type}, significance: ${concept.significance})\n`;
            if (concept.rawObservations.length > 0) {
              md += `    - Evidence: "${concept.rawObservations[0].substring(0, 80)}${concept.rawObservations[0].length > 80 ? '...' : ''}"\n`;
            }
          }
        }
        md += `\n`;

        // Observation Generation Step
        md += `#### 4. Observation Generation\n`;
        md += `- **Observations Created:** ${batch.observationDerivation.totalObservations}\n`;
        if (Object.keys(batch.observationDerivation.observationsByType).length > 0) {
          md += `- **By Type:** ${Object.entries(batch.observationDerivation.observationsByType).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
        }
        if (batch.observationDerivation.observations.length > 0) {
          md += `- **Sample Observations:**\n`;
          for (const obs of batch.observationDerivation.observations.slice(0, 3)) {
            md += `  - **${obs.entityName}** (${obs.observationType}): "${obs.content.substring(0, 60)}${obs.content.length > 60 ? '...' : ''}"\n`;
          }
        }
        md += `\n`;

        // Ontology Classification Step
        md += `#### 5. Ontology Classification\n`;
        md += `- **Classified:** ${batch.ontologyClassification.classified}\n`;
        md += `- **Unclassified:** ${batch.ontologyClassification.unclassified}\n`;
        md += `- **LLM Calls:** ${batch.ontologyClassification.llmCalls}\n`;
        if (Object.keys(batch.ontologyClassification.byClass).length > 0) {
          md += `- **By Ontology Class:** ${Object.entries(batch.ontologyClassification.byClass).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
        }
        if (batch.ontologyClassification.classifications.length > 0) {
          md += `- **Sample Classifications:**\n`;
          for (const cls of batch.ontologyClassification.classifications.slice(0, 3)) {
            md += `  - **${cls.entityName}**: ${cls.originalType} → ${cls.classifiedAs} (confidence: ${(cls.confidence * 100).toFixed(0)}%)\n`;
          }
        }
        md += `\n`;

        // Data Loss for this batch
        if (batch.dataLoss && batch.dataLoss.length > 0) {
          md += `#### Data Loss in This Batch\n`;
          for (const loss of batch.dataLoss) {
            md += `- **${loss.stepName}**: ${loss.inputCount} → ${loss.outputCount} (${loss.lossPercentage}% loss)\n`;
          }
          md += `\n`;
        }

        md += `---\n\n`;
      }

      // Summary for remaining batches
      if (remainingBatches.length > 0) {
        md += `### Remaining Batches Summary (${remainingBatches.length} batches)\n\n`;
        md += `| Batch | Commits | Sessions | Concepts | Observations | Classified |\n`;
        md += `|-------|---------|----------|----------|--------------|------------|\n`;
        for (const batch of remainingBatches) {
          md += `| ${batch.batchNumber} | ${batch.sourceData.gitHistory.commitsCount} | ${batch.sourceData.vibeHistory.sessionsCount} | ${batch.conceptExtraction.entitiesCreated} | ${batch.observationDerivation.totalObservations} | ${batch.ontologyClassification.classified} |\n`;
        }
        md += `\n`;
      }
    }

    // Finalization phase details
    if (report.finalization) {
      md += `## Finalization Phase\n\n`;

      if (report.finalization.codeGraphStats.totalFunctions > 0 ||
          report.finalization.codeGraphStats.totalClasses > 0) {
        md += `### Code Graph Analysis\n`;
        md += `- Functions: ${report.finalization.codeGraphStats.totalFunctions}\n`;
        md += `- Classes: ${report.finalization.codeGraphStats.totalClasses}\n`;
        md += `- Methods: ${report.finalization.codeGraphStats.totalMethods}\n`;
        if (Object.keys(report.finalization.codeGraphStats.languageDistribution).length > 0) {
          md += `- Languages: ${Object.entries(report.finalization.codeGraphStats.languageDistribution).map(([k, v]) => `${k}(${v})`).join(', ')}\n`;
        }
        md += `\n`;
      }

      if (report.finalization.insightGeneration.length > 0) {
        md += `### Insight Documents Generated\n`;
        for (const insight of report.finalization.insightGeneration.slice(0, 10)) {
          md += `- **${insight.entityName}** (significance: ${insight.significance})\n`;
          if (insight.insightDocument.filePath) {
            md += `  - File: ${insight.insightDocument.filePath}\n`;
          }
        }
        md += `\n`;
      }

      md += `### Final Persistence\n`;
      md += `- Entities Persisted: ${report.finalization.finalPersistence.entitiesPersisted}\n`;
      md += `- Relations Persisted: ${report.finalization.finalPersistence.relationsPersisted}\n`;
      md += `- Duplicates Removed: ${report.finalization.finalPersistence.duplicatesRemoved}\n\n`;
    }

    return md;
  }

  /**
   * Generate a FULL trace report showing ALL content (not samples)
   * This is a comprehensive report for debugging data flow issues
   */
  static generateFullTraceReport(report: UKBTraceReport): string {
    let md = `# UKB Full Trace Report\n\n`;
    md += `> **This report shows ALL content extracted at each step for debugging data flow.**\n\n`;
    md += `**Workflow:** ${report.workflowName} (${report.workflowId})\n`;
    md += `**Team:** ${report.team}\n`;
    md += `**Status:** ${report.status}\n`;
    md += `**Duration:** ${(report.durationMs / 1000 / 60).toFixed(1)} minutes\n`;
    md += `**Date:** ${report.startTime}\n\n`;

    // Executive Summary
    md += `## Executive Summary\n\n`;
    md += `| Metric | Count |\n|--------|-------|\n`;
    md += `| Total Batches | ${report.summary.totalBatches} |\n`;
    md += `| Total Commits | ${report.summary.totalCommits} |\n`;
    md += `| Total Sessions | ${report.summary.totalSessions} |\n`;
    md += `| Concepts Extracted | ${report.summary.totalConcepts} |\n`;
    md += `| Observations Generated | ${report.summary.totalObservations} |\n`;
    md += `| **Final Entities** | **${report.summary.finalEntities}** |\n`;
    md += `| **Data Loss** | **${report.summary.dataLossPercentage}%** |\n\n`;

    // Data Flow Visualization
    md += `## Data Flow\n\n`;
    md += `\`\`\`\n`;
    md += `Commits (${report.summary.totalCommits}) + Sessions (${report.summary.totalSessions})\n`;
    md += `  → Semantic Analysis → Concepts (${report.summary.totalConcepts})\n`;
    md += `  → Observation Gen → Observations (${report.summary.totalObservations})\n`;
    md += `  → Ontology + Dedup → Final Entities (${report.summary.finalEntities})\n`;
    md += `\`\`\`\n\n`;

    // ALL COMMITS across all batches
    md += `## All Commit Messages (${report.summary.totalCommits} total)\n\n`;
    md += `| Batch | Hash | Author | Date | Message (100 chars) |\n`;
    md += `|-------|------|--------|------|---------------------|\n`;
    let commitIndex = 0;
    for (const batch of report.batches || []) {
      for (const commit of batch.sourceData?.gitHistory?.commits || []) {
        commitIndex++;
        const truncMsg = commit.message.substring(0, 100).replace(/\|/g, '\\|').replace(/\n/g, ' ');
        md += `| ${batch.batchNumber} | ${commit.hash} | ${commit.author} | ${commit.date?.substring(0, 10) || ''} | ${truncMsg} |\n`;
      }
    }
    md += `\n`;

    // ALL SESSIONS across all batches
    md += `## All Sessions (${report.summary.totalSessions} total)\n\n`;
    md += `| Batch | Session ID | Date | Exchanges | Summary |\n`;
    md += `|-------|------------|------|-----------|---------|`;
    md += `\n`;
    for (const batch of report.batches || []) {
      for (const session of batch.sourceData?.vibeHistory?.sessions || []) {
        const summary = ((session as any).summary || 'No summary').substring(0, 80).replace(/\|/g, '\\|').replace(/\n/g, ' ');
        const exchangeCount = (session as any).exchangeCount || 0;
        md += `| ${batch.batchNumber} | ${session.sessionId?.substring(0, 20) || 'unknown'} | ${session.date?.substring(0, 10) || ''} | ${exchangeCount} | ${summary} |\n`;
      }
    }
    md += `\n`;

    // ALL CONCEPTS extracted
    md += `## All Concepts Extracted (${report.summary.totalConcepts} total)\n\n`;
    md += `| Batch | Concept Name | Type | Significance | Source | LLM |\n`;
    md += `|-------|--------------|------|--------------|--------|-----|\n`;
    for (const batch of report.batches || []) {
      for (const concept of batch.conceptExtraction?.concepts || []) {
        const llmUsed = batch.conceptExtraction.llmProvider ? 'Yes' : 'No';
        md += `| ${batch.batchNumber} | ${concept.name} | ${concept.type} | ${concept.significance} | ${concept.sourceType} | ${llmUsed} |\n`;
      }
    }
    md += `\n`;

    // ALL OBSERVATIONS generated
    md += `## All Observations Generated (${report.summary.totalObservations} total)\n\n`;
    md += `| Batch | Entity Name | Type | Significance | Obs Count | LLM Synth |\n`;
    md += `|-------|-------------|------|--------------|-----------|------------|\n`;
    for (const batch of report.batches || []) {
      for (const obs of batch.observationDerivation?.observations || []) {
        const llmSynth = (obs as any).llmSynthesized ? 'Yes' : 'No';
        const obsCount = (obs as any).observationCount || 0;
        md += `| ${batch.batchNumber} | ${obs.entityName} | ${obs.observationType} | ${(obs as any).significance || 5} | ${obsCount} | ${llmSynth} |\n`;
      }
    }
    md += `\n`;

    // ALL CLASSIFICATIONS
    md += `## All Ontology Classifications\n\n`;
    md += `| Batch | Entity | Original Type | Classified As | Confidence | Method |\n`;
    md += `|-------|--------|---------------|---------------|------------|--------|\n`;
    for (const batch of report.batches || []) {
      for (const cls of batch.ontologyClassification?.classifications || []) {
        const confidence = ((cls.confidence || 0) * 100).toFixed(0) + '%';
        const method = (cls as any).method || 'unknown';
        md += `| ${batch.batchNumber} | ${cls.entityName} | ${cls.originalType} | ${cls.classifiedAs} | ${confidence} | ${method} |\n`;
      }
    }
    md += `\n`;

    // DATA LOSS ANALYSIS by step
    md += `## Data Loss Analysis by Step\n\n`;
    md += `| Step | Total Input | Total Output | Loss % |\n`;
    md += `|------|-------------|--------------|--------|\n`;

    // Aggregate data loss across all batches
    const stepLoss: Record<string, { input: number; output: number }> = {};
    for (const batch of report.batches || []) {
      for (const loss of batch.dataLoss || []) {
        if (!stepLoss[loss.stepName]) {
          stepLoss[loss.stepName] = { input: 0, output: 0 };
        }
        stepLoss[loss.stepName].input += loss.inputCount;
        stepLoss[loss.stepName].output += loss.outputCount;
      }
    }
    for (const [step, data] of Object.entries(stepLoss)) {
      const lossPercent = data.input > 0 ? Math.round((1 - data.output / data.input) * 100) : 0;
      md += `| ${step} | ${data.input} | ${data.output} | ${lossPercent}% |\n`;
    }
    md += `\n`;

    // Per-Batch Detailed Trace (Sample from first 3)
    md += `## Sample Batch Trace (Batch 1)\n\n`;
    const sampleBatch = report.batches?.[0];
    if (sampleBatch) {
      md += `### 1. Git History\n`;
      md += `- Commits: ${sampleBatch.sourceData?.gitHistory?.commitsCount || 0}\n`;
      const sampleCommit = sampleBatch.sourceData?.gitHistory?.commits?.[0];
      if (sampleCommit) {
        md += `- Sample: ${sampleCommit.message.substring(0, 80)}...\n`;
      }
      md += `\n`;

      md += `### 2. Semantic Analysis\n`;
      md += `- Entities Created: ${sampleBatch.conceptExtraction?.entitiesCreated || 0}\n`;
      md += `- Relations: ${sampleBatch.conceptExtraction?.relationsCreated || 0}\n`;
      md += `- LLM: ${sampleBatch.conceptExtraction?.llmProvider || 'none'}\n`;
      md += `- Sample Concepts:\n`;
      for (const concept of (sampleBatch.conceptExtraction?.concepts || []).slice(0, 3)) {
        md += `  - ${concept.name} (${concept.type})\n`;
      }
      md += `\n`;

      md += `### 3. Observation Generation\n`;
      md += `- Observations: ${sampleBatch.observationDerivation?.totalObservations || 0}\n`;
      md += `\n`;

      md += `### 4. Ontology Classification\n`;
      md += `- Classified: ${sampleBatch.ontologyClassification?.classified || 0}\n`;
      md += `- Unclassified: ${sampleBatch.ontologyClassification?.unclassified || 0}\n`;
      md += `- By Class: ${JSON.stringify(sampleBatch.ontologyClassification?.byClass || {})}\n`;
    }
    md += `\n`;

    // QA Issues
    if (report.qaReport?.criticalIssues?.length > 0) {
      md += `## Critical QA Issues\n\n`;
      for (const issue of report.qaReport.criticalIssues) {
        md += `- **${issue.stepName}** [${issue.category}]: ${issue.message}\n`;
      }
      md += `\n`;
    }

    // Recommendations
    if (report.qaReport?.recommendations?.length > 0) {
      md += `## Recommendations\n\n`;
      for (const rec of report.qaReport.recommendations) {
        md += `- ${rec}\n`;
      }
    }

    return md;
  }
}

export default UKBTraceReportManager;
