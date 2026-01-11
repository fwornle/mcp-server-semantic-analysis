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
    batch.sourceData.gitHistory = {
      commitsCount: commits.length,
      commits: commits.slice(0, 20).map((c: any) => ({
        hash: c.hash?.substring(0, 8) || 'unknown',
        message: (c.message || '').substring(0, 100),
        filesChanged: c.files?.slice(0, 10) || [],
        author: c.author || 'unknown',
        date: c.date || ''
      })),
      codeFilesDiscovered: this.extractUniqueFiles(commits).slice(0, 50),
      architecturalDecisions: gitResult?.architecturalDecisions || []
    };

    console.error(`[UKBTraceReport] Batch ${batchId}: ${commits.length} commits, ${batch.sourceData.gitHistory.codeFilesDiscovered.length} files`);
  }

  traceVibeHistory(batchId: string, vibeResult: any): void {
    const batch = this.currentBatchData.get(batchId);
    if (!batch) return;

    const sessions = vibeResult?.sessions || [];
    batch.sourceData.vibeHistory = {
      sessionsCount: sessions.length,
      sessions: sessions.slice(0, 20).map((s: any) => ({
        sessionId: s.sessionId || s.id || 'unknown',
        date: s.date || '',
        duration: s.duration || 0,
        keyTopics: s.keyTopics?.slice(0, 5) || [],
        problemsSolved: s.problemsSolved?.slice(0, 5) || [],
        toolsUsed: s.toolsUsed?.slice(0, 10) || []
      })),
      vibesExtracted: this.extractVibes(sessions).slice(0, 30)
    };

    console.error(`[UKBTraceReport] Batch ${batchId}: ${sessions.length} sessions, ${batch.sourceData.vibeHistory.vibesExtracted.length} vibes`);
  }

  traceSemanticAnalysis(batchId: string, semanticResult: any, llmProvider: string, tokensUsed: number): void {
    const batch = this.currentBatchData.get(batchId);
    if (!batch) return;

    const entities = semanticResult?.entities || [];
    batch.conceptExtraction = {
      batchId,
      concepts: entities.slice(0, 30).map((e: any) => ({
        name: e.name || 'unknown',
        type: e.type || e.entityType || 'unknown',
        sourceType: this.inferSourceType(e),
        sourceReferences: this.extractSourceRefs(e).slice(0, 10),
        significance: e.significance || 5,
        rawObservations: (e.observations || []).slice(0, 5)
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

    batch.observationDerivation = {
      batchId,
      observations: observations.slice(0, 30).map((o: any) => {
        const type = o.entityType || o.type || 'unknown';
        byType[type] = (byType[type] || 0) + 1;

        return {
          entityName: o.name || 'unknown',
          observationType: type,
          content: (o.observations?.[0] || '').substring(0, 200),
          derivedFrom: {
            gitCommits: [],
            vibeSessions: [],
            codeFiles: []
          },
          confidence: o.metadata?.confidence || 0.5
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

    batch.ontologyClassification = {
      batchId,
      classifications: classified.slice(0, 30).map((c: any) => {
        const classType = c.ontologyClass || c.type || 'Unclassified';
        byClass[classType] = (byClass[classType] || 0) + 1;

        return {
          entityName: c.name || 'unknown',
          originalType: c.originalType || 'unknown',
          classifiedAs: classType,
          ontologyPath: c.ontologyPath || [classType],
          confidence: c.confidence || 0.5,
          llmReasoning: (c.reasoning || '').substring(0, 200)
        };
      }),
      classified: classified.length,
      unclassified: classificationResult?.unclassified?.length || 0,
      byClass,
      llmCalls,
      tokensUsed
    };

    console.error(`[UKBTraceReport] Batch ${batchId}: ${classified.length} classified, ${byClass}`);
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

    return md;
  }
}

export default UKBTraceReportManager;
