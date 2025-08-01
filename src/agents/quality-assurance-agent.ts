import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';

export interface QualityAssuranceReport {
  stepName: string;
  passed: boolean;
  errors: string[];
  warnings: string[];
  corrected: boolean;
  correctedOutput?: any;
  validationTime: Date;
  score: number; // 0-100
  details: {
    structureCompliance: number;
    contentQuality: number;
    namingConventions: number;
    completeness: number;
  };
}

export interface ValidationRules {
  entityNaming: {
    camelCase: boolean;
    noSpaces: boolean;
    descriptive: boolean;
    maxLength: number;
  };
  observations: {
    minCount: number;
    requiredTypes: string[];
    maxLength: number;
    hasLinks: boolean;
  };
  significance: {
    validRange: [number, number];
    allowedValues: number[];
  };
  files: {
    insightFiles: boolean;
    diagramFiles: boolean;
    extensions: string[];
  };
  knowledgeBase: {
    entityExists: boolean;
    relationshipsValid: boolean;
    synchronizedWithMCP: boolean;
  };
}

export class QualityAssuranceAgent {
  private rules: ValidationRules;
  private repositoryPath: string;

  constructor(repositoryPath: string = '.') {
    this.repositoryPath = repositoryPath;
    this.rules = this.getDefaultRules();
    this.initializeRules();
  }

  private getDefaultRules(): ValidationRules {
    return {
      entityNaming: {
        camelCase: true,
        noSpaces: true,
        descriptive: true,
        maxLength: 50
      },
      observations: {
        minCount: 1,
        requiredTypes: ['insight', 'implementation'],
        maxLength: 1000,
        hasLinks: false
      },
      significance: {
        validRange: [1, 10],
        allowedValues: [5, 8, 9]
      },
      files: {
        insightFiles: true,
        diagramFiles: false,
        extensions: ['.md', '.puml']
      },
      knowledgeBase: {
        entityExists: true,
        relationshipsValid: true,
        synchronizedWithMCP: false
      }
    };
  }

  private initializeRules(): void {
    // Load any custom rules from configuration
    log('QualityAssuranceAgent initialized with default rules', 'info');
  }

  private async validateStepTiming(
    stepName: string,
    timing: { startTime: Date; endTime: Date; timeout: number },
    errors: string[],
    warnings: string[]
  ): Promise<void> {
    const duration = timing.endTime.getTime() - timing.startTime.getTime();
    const durationSeconds = duration / 1000;
    const timeoutSeconds = timing.timeout;

    log(`Validating timing for ${stepName}`, 'info', {
      durationSeconds,
      timeoutSeconds,
      utilizationPercent: (durationSeconds / timeoutSeconds) * 100
    });

    // Critical timing thresholds by step type
    const timingExpectations: Record<string, { min: number; ideal: number; max: number }> = {
      'analyze_git_history': { min: 5, ideal: 30, max: 120 },
      'analyze_vibe_history': { min: 3, ideal: 20, max: 90 },
      'semantic_analysis': { min: 10, ideal: 60, max: 180 },
      'web_search': { min: 2, ideal: 15, max: 60 },
      'generate_insights': { min: 15, ideal: 90, max: 300 },
      'generate_observations': { min: 5, ideal: 30, max: 90 },
      'quality_assurance': { min: 2, ideal: 10, max: 60 },
      'persist_results': { min: 1, ideal: 10, max: 30 }
    };

    const expected = timingExpectations[stepName] || { min: 1, ideal: 30, max: 120 };

    // Performance analysis
    if (durationSeconds < expected.min) {
      warnings.push(`Step ${stepName} completed suspiciously fast (${durationSeconds.toFixed(1)}s < ${expected.min}s) - may indicate incomplete processing`);
    } else if (durationSeconds > expected.max) {
      errors.push(`Step ${stepName} exceeded maximum expected duration (${durationSeconds.toFixed(1)}s > ${expected.max}s) - performance concern`);
    } else if (durationSeconds > expected.ideal * 1.5) {
      warnings.push(`Step ${stepName} took longer than ideal (${durationSeconds.toFixed(1)}s > ${expected.ideal * 1.5}s) - consider optimization`);
    }

    // Timeout utilization analysis
    const utilizationPercent = (durationSeconds / timeoutSeconds) * 100;
    if (utilizationPercent > 90) {
      errors.push(`Step ${stepName} used ${utilizationPercent.toFixed(1)}% of timeout (${durationSeconds.toFixed(1)}s/${timeoutSeconds}s) - timeout too aggressive`);
    } else if (utilizationPercent > 75) {
      warnings.push(`Step ${stepName} used ${utilizationPercent.toFixed(1)}% of timeout - consider increasing timeout buffer`);
    } else if (utilizationPercent < 10 && timeoutSeconds > 60) {
      warnings.push(`Step ${stepName} timeout may be too generous (${utilizationPercent.toFixed(1)}% utilization) - consider optimization`);
    }

    // LLM-specific timing validation
    if (stepName === 'semantic_analysis' || stepName === 'generate_insights') {
      if (durationSeconds < 8) {
        errors.push(`LLM step ${stepName} completed too quickly (${durationSeconds.toFixed(1)}s) - likely skipped LLM calls`);
      } else if (durationSeconds < 15) {
        warnings.push(`LLM step ${stepName} may not have used LLM analysis (${durationSeconds.toFixed(1)}s) - verify API calls`);
      }
    }

    // File I/O intensive steps timing
    if (stepName === 'analyze_git_history' || stepName === 'analyze_vibe_history') {
      if (durationSeconds < 2) {
        warnings.push(`File analysis step ${stepName} completed very quickly - may indicate insufficient file processing`);
      }
    }
  }

  async performComprehensiveQA(
    stepName: string,
    stepResult: any,
    expectedOutputs?: string[],
    stepTiming?: { startTime: Date; endTime: Date; timeout: number }
  ): Promise<QualityAssuranceReport> {
    log(`Starting QA validation for step: ${stepName}`, 'info', {
      stepName,
      hasResult: !!stepResult,
      expectedOutputs: expectedOutputs?.length || 0,
      hasTiming: !!stepTiming
    });

    const startTime = new Date();
    const errors: string[] = [];
    const warnings: string[] = [];
    let corrected = false;
    let correctedOutput = undefined;

    // Enhanced timing validation
    if (stepTiming) {
      await this.validateStepTiming(stepName, stepTiming, errors, warnings);
    }

    try {
      // Step-specific validations
      switch (stepName) {
        case 'analyze_git_history':
          await this.validateGitHistoryAnalysis(stepResult, errors, warnings);
          break;
          
        case 'analyze_vibe_history':
          await this.validateVibeHistoryAnalysis(stepResult, errors, warnings);
          break;
          
        case 'semantic_analysis':
          await this.validateSemanticAnalysis(stepResult, errors, warnings);
          break;
          
        case 'web_search_patterns':
          await this.validateWebSearchResults(stepResult, errors, warnings);
          break;
          
        case 'generate_insights':
          await this.validateInsightGeneration(stepResult, errors, warnings);
          break;
          
        case 'generate_observations':
          const correctionResult = await this.validateAndCorrectObservations(stepResult, errors, warnings);
          if (correctionResult.corrected) {
            corrected = true;
            correctedOutput = correctionResult.correctedOutput;
          }
          break;
          
        case 'persist_knowledge':
          await this.validateKnowledgePersistence(stepResult, errors, warnings);
          break;
          
        default:
          warnings.push(`Unknown step type: ${stepName} - performing generic validation`);
          await this.validateGenericOutput(stepResult, errors, warnings);
      }

      // Calculate quality scores
      const details = this.calculateQualityScores(stepResult, errors, warnings);
      const overallScore = this.calculateOverallScore(details, errors.length, warnings.length);

      const report: QualityAssuranceReport = {
        stepName,
        passed: errors.length === 0,
        errors,
        warnings,
        corrected,
        correctedOutput,
        validationTime: startTime,
        score: overallScore,
        details
      };

      log(`QA validation completed for ${stepName}`, 'info', {
        passed: report.passed,
        errors: errors.length,
        warnings: warnings.length,
        score: overallScore,
        corrected
      });

      return report;

    } catch (error) {
      log(`QA validation failed for ${stepName}`, 'error', error);
      errors.push(`QA validation error: ${error instanceof Error ? error.message : String(error)}`);
      
      return {
        stepName,
        passed: false,
        errors,
        warnings,
        corrected: false,
        validationTime: startTime,
        score: 0,
        details: {
          structureCompliance: 0,
          contentQuality: 0,
          namingConventions: 0,
          completeness: 0
        }
      };
    }
  }

  // New comprehensive workflow QA method
  async performWorkflowQA(parameters: { all_results: Record<string, any> }): Promise<any> {
    const { all_results } = parameters;
    
    log('Starting comprehensive workflow QA', 'info', {
      stepsToValidate: Object.keys(all_results).length
    });

    const validations: Record<string, QualityAssuranceReport> = {};
    let overallPassed = true;
    let totalErrors = 0;
    let totalWarnings = 0;

    // Validate each step individually with timing data
    for (const [stepName, stepResult] of Object.entries(all_results)) {
      if (stepResult && typeof stepResult === 'object') {
        const timing = stepResult._timing ? {
          startTime: new Date(stepResult._timing.startTime),
          endTime: new Date(stepResult._timing.endTime),
          timeout: stepResult._timing.timeout
        } : undefined;

        const cleanResult = { ...stepResult };
        delete cleanResult._timing; // Remove timing data for validation

        const report = await this.performComprehensiveQA(stepName, cleanResult, undefined, timing);
        validations[stepName] = report;

        if (!report.passed) {
          overallPassed = false;
        }
        totalErrors += report.errors.length;
        totalWarnings += report.warnings.length;
      }
    }

    // Workflow-level validations
    const workflowErrors: string[] = [];
    const workflowWarnings: string[] = [];

    await this.validateWorkflowIntegrity(all_results, workflowErrors, workflowWarnings);
    await this.validateWorkflowTiming(all_results, workflowErrors, workflowWarnings);

    const result = {
      validations,
      workflowLevel: {
        passed: workflowErrors.length === 0 && overallPassed,
        errors: workflowErrors,
        warnings: workflowWarnings
      },
      summary: {
        totalSteps: Object.keys(all_results).length,
        passedSteps: Object.values(validations).filter(v => v.passed).length,
        totalErrors: totalErrors + workflowErrors.length,
        totalWarnings: totalWarnings + workflowWarnings.length,
        overallScore: this.calculateWorkflowScore(validations, workflowErrors, workflowWarnings)
      }
    };

    log('Workflow QA completed', 'info', {
      overallPassed: result.workflowLevel.passed,
      totalErrors: result.summary.totalErrors,
      totalWarnings: result.summary.totalWarnings,
      overallScore: result.summary.overallScore
    });

    return result;
  }

  private async validateWorkflowIntegrity(
    allResults: Record<string, any>,
    errors: string[],
    warnings: string[]
  ): Promise<void> {
    // Check for data flow consistency
    const gitResult = allResults.git_history;
    const semanticResult = allResults.semantic_analysis;
    const insightsResult = allResults.insights;

    if (gitResult && semanticResult) {
      if (gitResult.commits?.length > 0 && !semanticResult.insights) {
        errors.push('Git analysis found commits but semantic analysis produced no insights - data flow broken');
      }
    }

    if (semanticResult && insightsResult) {
      if (semanticResult.insights && (!insightsResult.patternCatalog?.patterns || insightsResult.patternCatalog.patterns.length === 0)) {
        errors.push('Semantic analysis produced insights but insight generation found no patterns - processing failure');
      }
    }

    // Validate cross-step dependencies
    const expectedFlow = [
      ['git_history', 'semantic_analysis'],
      ['vibe_history', 'semantic_analysis'],
      ['semantic_analysis', 'insights'],
      ['insights', 'observations']
    ];

    for (const [prereq, dependent] of expectedFlow) {
      if (allResults[prereq] && allResults[dependent]) {
        if (allResults[prereq].error && !allResults[dependent].error) {
          warnings.push(`Step ${dependent} succeeded despite ${prereq} failure - may indicate incomplete processing`);
        }
      }
    }
  }

  private async validateWorkflowTiming(
    allResults: Record<string, any>,
    errors: string[],
    warnings: string[]
  ): Promise<void> {
    const timings: Array<{ step: string; duration: number; startTime: Date }> = [];

    // Collect timing data
    for (const [stepName, result] of Object.entries(allResults)) {
      if (result?._timing) {
        timings.push({
          step: stepName,
          duration: result._timing.duration / 1000, // Convert to seconds
          startTime: new Date(result._timing.startTime)
        });
      }
    }

    if (timings.length === 0) {
      warnings.push('No timing data available for workflow analysis');
      return;
    }

    // Sort by start time to analyze sequential execution
    timings.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    // Calculate total workflow time
    const firstStart = timings[0].startTime;
    const lastEnd = new Date(Math.max(...timings.map(t => 
      new Date(t.startTime.getTime() + t.duration * 1000).getTime()
    )));
    const totalWorkflowTime = (lastEnd.getTime() - firstStart.getTime()) / 1000;

    log('Workflow timing analysis', 'info', {
      totalSteps: timings.length,
      totalWorkflowTime: `${totalWorkflowTime.toFixed(1)}s`,
      slowestStep: timings.reduce((max, t) => t.duration > max.duration ? t : max).step
    });

    // Validate workflow efficiency
    if (totalWorkflowTime > 900) { // 15 minutes
      errors.push(`Workflow took too long: ${totalWorkflowTime.toFixed(1)}s > 900s - needs optimization`);
    } else if (totalWorkflowTime > 600) { // 10 minutes
      warnings.push(`Workflow approaching time limit: ${totalWorkflowTime.toFixed(1)}s - monitor performance`);
    }

    // Identify performance bottlenecks
    const slowSteps = timings.filter(t => t.duration > 120); // > 2 minutes
    if (slowSteps.length > 0) {
      warnings.push(`Performance bottlenecks detected: ${slowSteps.map(s => `${s.step}(${s.duration.toFixed(1)}s)`).join(', ')}`);
    }

    // Check for suspiciously fast steps
    const fastSteps = timings.filter(t => t.duration < 1); // < 1 second
    if (fastSteps.length > 2) {
      warnings.push(`Multiple steps completed very quickly: ${fastSteps.map(s => s.step).join(', ')} - verify completeness`);
    }
  }

  private calculateWorkflowScore(
    validations: Record<string, QualityAssuranceReport>,
    workflowErrors: string[],
    workflowWarnings: string[]
  ): number {
    const stepScores = Object.values(validations).map(v => v.score);
    const avgStepScore = stepScores.length > 0 ? 
      stepScores.reduce((sum, score) => sum + score, 0) / stepScores.length : 0;

    // Apply workflow-level penalties
    const workflowPenalty = (workflowErrors.length * 15) + (workflowWarnings.length * 5);
    
    return Math.max(0, Math.min(100, Math.round(avgStepScore - workflowPenalty)));
  }

  private async validateGitHistoryAnalysis(result: any, errors: string[], warnings: string[]): Promise<void> {
    if (!result) {
      errors.push('Git history analysis result is null or undefined');
      return;
    }

    // Check required structure
    if (!result.commits || !Array.isArray(result.commits)) {
      errors.push('Missing or invalid commits array in git analysis');
    } else if (result.commits.length === 0) {
      warnings.push('No commits found in git analysis - may indicate checkpoint issue');
    }

    if (!result.architecturalDecisions || !Array.isArray(result.architecturalDecisions)) {
      errors.push('Missing architectural decisions in git analysis');
    }

    if (!result.codeEvolution || !Array.isArray(result.codeEvolution)) {
      errors.push('Missing code evolution patterns in git analysis');
    }

    if (!result.summary || typeof result.summary !== 'object') {
      errors.push('Missing or invalid summary in git analysis');
    } else {
      if (!result.summary.insights || result.summary.insights.length < 50) {
        warnings.push('Git analysis insights are too brief');
      }
    }

    // Check checkpoint information
    if (!result.checkpointInfo) {
      warnings.push('Missing checkpoint information in git analysis');
    } else if (!result.checkpointInfo.toTimestamp) {
      errors.push('Missing checkpoint timestamp in git analysis');
    }
  }

  private async validateVibeHistoryAnalysis(result: any, errors: string[], warnings: string[]): Promise<void> {
    if (!result) {
      errors.push('Vibe history analysis result is null or undefined');
      return;
    }

    // Check required structure
    if (!result.sessions || !Array.isArray(result.sessions)) {
      errors.push('Missing or invalid sessions array in vibe analysis');
    } else if (result.sessions.length === 0) {
      warnings.push('No conversation sessions found - may indicate .specstory directory issue');
    }

    if (!result.problemSolutionPairs || !Array.isArray(result.problemSolutionPairs)) {
      errors.push('Missing problem-solution pairs in vibe analysis');
    }

    if (!result.patterns || typeof result.patterns !== 'object') {
      errors.push('Missing patterns analysis in vibe history');
    } else {
      if (!result.patterns.commonProblems || result.patterns.commonProblems.length === 0) {
        warnings.push('No common problems identified in vibe analysis');
      }
    }

    // Validate session parsing quality
    if (result.sessions) {
      const sessionsWithExchanges = result.sessions.filter((s: any) => s.exchanges && s.exchanges.length > 0);
      if (sessionsWithExchanges.length < result.sessions.length * 0.8) {
        warnings.push('Many sessions have no exchanges - may indicate parsing issues');
      }
    }
  }

  private async validateSemanticAnalysis(result: any, errors: string[], warnings: string[]): Promise<void> {
    if (!result) {
      errors.push('Semantic analysis result is null or undefined');
      return;
    }

    // Check for meaningful insights
    if (!result.insights) {
      errors.push('Missing insights in semantic analysis');
    } else {
      const insightText = typeof result.insights === 'string' ? result.insights : JSON.stringify(result.insights);
      if (insightText.length < 100) {
        warnings.push('Semantic analysis insights are too brief');
      }
    }

    // Check for cross-analysis correlations
    if (!result.correlations && !result.patterns) {
      warnings.push('No cross-analysis correlations found - may indicate limited semantic depth');
    }
  }

  private async validateWebSearchResults(result: any, errors: string[], warnings: string[]): Promise<void> {
    if (!result) {
      warnings.push('Web search results are empty - may be acceptable');
      return;
    }

    if (!result.patterns && !result.references && !result.insights) {
      warnings.push('Web search returned no actionable patterns or references');
    }

    // Check for quality of references
    if (result.references && Array.isArray(result.references)) {
      const validUrls = result.references.filter((ref: string) => 
        ref.startsWith('http') || ref.startsWith('https')
      );
      if (validUrls.length < result.references.length * 0.5) {
        warnings.push('Many web search references are not valid URLs');
      }
    }
  }

  private async validateInsightGeneration(result: any, errors: string[], warnings: string[]): Promise<void> {
    if (!result) {
      errors.push('Insight generation result is null or undefined');
      return;
    }

    // CRITICAL: Validate actual content quality, not just file existence
    
    // 1. Validate patterns are meaningful (not garbage conversation fragments)
    if (result.patternCatalog?.patterns) {
      const patterns = result.patternCatalog.patterns;
      
      // Check for garbage pattern names
      const garbagePatterns = patterns.filter((p: any) => 
        p.name.startsWith('ProblemSolutionPattern') || 
        p.name.startsWith('ArchitecturalDecision') ||
        p.name.startsWith('SemanticPattern') ||
        p.description.includes('you were just in the process') ||
        p.description.includes('I cannot see any chan') ||
        p.description.length < 20
      );
      
      if (garbagePatterns.length > 0) {
        errors.push(`Found ${garbagePatterns.length} garbage patterns with meaningless names or conversation fragments`);
        garbagePatterns.forEach((p: any) => {
          errors.push(`Garbage pattern: "${p.name}" - "${p.description.substring(0, 50)}..."`);
        });
      }
      
      // Ensure patterns have real evidence
      const patternsWithoutEvidence = patterns.filter((p: any) => 
        !p.evidence || p.evidence.length === 0 || 
        p.evidence.some((e: string) => e.includes('N/A') || e.length < 10)
      );
      
      if (patternsWithoutEvidence.length > 0) {
        errors.push(`Found ${patternsWithoutEvidence.length} patterns without meaningful evidence`);
      }
      
      if (patterns.length === 0) {
        errors.push('No patterns identified - analysis may be incomplete');
      }
    } else {
      errors.push('No pattern catalog generated');
    }

    // 2. Validate git analysis actually found commits
    if (result.gitAnalysis || result.git_analysis_results) {
      const gitData = result.gitAnalysis || result.git_analysis_results;
      if (!gitData.commits || gitData.commits.length === 0) {
        errors.push('Git analysis found 0 commits - analysis scope may be too narrow');
      } else if (gitData.commits.length < 5) {
        warnings.push(`Only ${gitData.commits.length} commits analyzed - consider broader time window`);
      }
    }

    // 3. Validate insight document content quality
    if (result.insightDocument) {
      const content = result.insightDocument.content || '';
      
      // Check for template placeholders
      if (content.includes('{{') || content.includes('}}')) {
        errors.push('Insight document contains unresolved template placeholders');
      }
      
      // Check for meaningful content length
      if (content.length < 1000) {
        errors.push('Insight document is too short to be meaningful (less than 1000 characters)');
      }
      
      // Check for conversation fragments
      const conversationFragments = [
        'you were just in the process',
        'I cannot see any chan',
        'so, it seems that you somehow',
        'User:',
        'Assistant:'
      ];
      
      const foundFragments = conversationFragments.filter(fragment => 
        content.toLowerCase().includes(fragment.toLowerCase())
      );
      
      if (foundFragments.length > 0) {
        errors.push(`Insight contains conversation fragments: ${foundFragments.join(', ')}`);
      }
    } else {
      errors.push('No insight document generated');
    }

    // 4. Validate PlantUML diagrams have real content
    if (result.insightDocument?.diagrams) {
      const diagrams = result.insightDocument.diagrams;
      const emptyDiagrams = diagrams.filter((d: any) => 
        !d.success || 
        d.content.includes('Welcome to PlantUML!') ||
        d.content.includes('@startuml\n@enduml') ||
        d.content.length < 100
      );
      
      if (emptyDiagrams.length > 0) {
        errors.push(`Found ${emptyDiagrams.length} empty or placeholder PlantUML diagrams`);
      }
      
      if (diagrams.length === 0) {
        warnings.push('No PlantUML diagrams generated');
      }
    } else {
      warnings.push('No diagrams in insight document');
    }

    // 5. Validate meaningful filename generation
    if (result.insightDocument?.name) {
      const name = result.insightDocument.name;
      if (name.includes('SemanticAnalysisInsight') || 
          name.includes('timestamp') || 
          name.match(/\d{4}-\d{2}-\d{2}/)) {
        errors.push(`Generic or timestamp-based filename: ${name}`);
      }
    }

    // 6. Final quality gate - reject if too many errors
    if (errors.length > 3) {
      errors.push('QUALITY GATE FAILED: Too many content quality issues detected - output rejected');
    }
  }

  private async validateAndCorrectObservations(
    result: any, 
    errors: string[], 
    warnings: string[]
  ): Promise<{ corrected: boolean; correctedOutput?: any }> {
    if (!result || !result.observations) {
      errors.push('Missing observations in observation generation result');
      return { corrected: false };
    }

    const observations = result.observations;
    let corrected = false;
    const correctedObservations = [];

    for (let i = 0; i < observations.length; i++) {
      const obs = observations[i];
      const correctedObs = { ...obs };
      let obsChanged = false;

      // Validate and correct entity naming
      if (!this.isValidEntityName(obs.name)) {
        const correctedName = this.correctEntityName(obs.name);
        if (correctedName !== obs.name) {
          correctedObs.name = correctedName;
          obsChanged = true;
          warnings.push(`Corrected entity name: ${obs.name} → ${correctedName}`);
        } else {
          errors.push(`Entity name '${obs.name}' violates naming conventions and cannot be auto-corrected`);
        }
      }

      // Validate significance
      if (!this.rules.significance.validRange || 
          obs.significance < this.rules.significance.validRange[0] || 
          obs.significance > this.rules.significance.validRange[1]) {
        correctedObs.significance = 5; // Default to standard significance
        obsChanged = true;
        warnings.push(`Corrected significance for ${obs.name}: ${obs.significance} → 5`);
      }

      // Validate observations structure
      if (!obs.observations || obs.observations.length < this.rules.observations.minCount) {
        errors.push(`Entity '${obs.name}' has insufficient observations (minimum: ${this.rules.observations.minCount})`);
      }

      // Check for required observation types
      const observationTypes = obs.observations
        .filter((o: any) => typeof o === 'object' && o.type)
        .map((o: any) => o.type);
      
      const missingTypes = this.rules.observations.requiredTypes.filter(
        type => !observationTypes.includes(type)
      );

      if (missingTypes.length > 0) {
        warnings.push(`Entity '${obs.name}' missing observation types: ${missingTypes.join(', ')}`);
      }

      // Ensure link observation exists
      const hasLink = obs.observations.some((o: any) => 
        (typeof o === 'string' && o.includes('localhost:8080')) ||
        (typeof o === 'object' && o.type === 'link')
      );

      if (!hasLink) {
        // Add missing link observation
        correctedObs.observations.push({
          type: 'link',
          content: `Details: http://localhost:8080/knowledge-management/insights/${obs.name}.md`,
          date: new Date().toISOString()
        });
        obsChanged = true;
        warnings.push(`Added missing link observation for ${obs.name}`);
      }

      if (obsChanged) {
        corrected = true;
      }

      correctedObservations.push(correctedObs);
    }

    return {
      corrected,
      correctedOutput: corrected ? { ...result, observations: correctedObservations } : undefined
    };
  }

  private async validateKnowledgePersistence(result: any, errors: string[], warnings: string[]): Promise<void> {
    if (!result) {
      errors.push('Knowledge persistence result is null or undefined');
      return;
    }

    // Check shared-memory file update
    const sharedMemoryPath = path.join(this.repositoryPath, 'shared-memory-coding.json');
    if (!fs.existsSync(sharedMemoryPath)) {
      errors.push('shared-memory-coding.json file does not exist');
    } else {
      try {
        const data = JSON.parse(fs.readFileSync(sharedMemoryPath, 'utf8'));
        if (!data.entities || !Array.isArray(data.entities)) {
          errors.push('shared-memory-coding.json has invalid structure');
        }
        
        if (!data.metadata || !data.metadata.last_updated) {
          warnings.push('shared-memory-coding.json missing update timestamp');
        }
      } catch (error) {
        errors.push('shared-memory-coding.json is not valid JSON');
      }
    }

    // Check for entity count increase
    if (result.entitiesCreated !== undefined && result.entitiesCreated === 0) {
      warnings.push('No new entities were created during persistence');
    }

    // Validate checkpoint updates
    if (!result.checkpointUpdated) {
      warnings.push('Analysis checkpoints may not have been updated');
    }
  }

  private async validateGenericOutput(result: any, errors: string[], warnings: string[]): Promise<void> {
    if (!result) {
      errors.push('Step result is null or undefined');
      return;
    }

    if (result.error) {
      errors.push(`Step returned error: ${result.error}`);
    }

    if (result.success === false) {
      errors.push('Step did not complete successfully');
    }
  }

  private calculateQualityScores(
    result: any, 
    errors: string[], 
    warnings: string[]
  ): QualityAssuranceReport['details'] {
    // Base scores (assuming good quality)
    let structureCompliance = 100;
    let contentQuality = 100;
    let namingConventions = 100;
    let completeness = 100;

    // Deduct points for errors and warnings
    structureCompliance -= errors.length * 20; // -20 per error
    structureCompliance -= warnings.length * 5; // -5 per warning

    contentQuality -= errors.filter(e => e.includes('brief') || e.includes('missing')).length * 15;
    contentQuality -= warnings.filter(w => w.includes('quality') || w.includes('content')).length * 8;

    namingConventions -= errors.filter(e => e.includes('name') || e.includes('naming')).length * 25;
    namingConventions -= warnings.filter(w => w.includes('name') || w.includes('naming')).length * 10;

    completeness -= errors.filter(e => e.includes('missing') || e.includes('not exist')).length * 20;
    completeness -= warnings.filter(w => w.includes('missing') || w.includes('insufficient')).length * 10;

    return {
      structureCompliance: Math.max(0, structureCompliance),
      contentQuality: Math.max(0, contentQuality),
      namingConventions: Math.max(0, namingConventions),
      completeness: Math.max(0, completeness)
    };
  }

  private calculateOverallScore(
    details: QualityAssuranceReport['details'],
    errorCount: number,
    warningCount: number
  ): number {
    // Weighted average of quality scores
    const weightedScore = (
      details.structureCompliance * 0.3 +
      details.contentQuality * 0.25 +
      details.namingConventions * 0.2 +
      details.completeness * 0.25
    );

    // Additional penalty for high error/warning counts
    const penaltyScore = Math.max(0, weightedScore - (errorCount * 10) - (warningCount * 3));

    return Math.round(Math.max(0, Math.min(100, penaltyScore)));
  }

  private isValidEntityName(name: string): boolean {
    if (!name || name.length === 0) return false;
    if (name.length > this.rules.entityNaming.maxLength) return false;
    if (this.rules.entityNaming.noSpaces && name.includes(' ')) return false;
    
    // Check camelCase pattern
    if (this.rules.entityNaming.camelCase) {
      const camelCasePattern = /^[a-z][a-zA-Z0-9]*$/;
      const pascalCasePattern = /^[A-Z][a-zA-Z0-9]*$/;
      if (!camelCasePattern.test(name) && !pascalCasePattern.test(name)) {
        return false;
      }
    }
    
    return true;
  }

  private correctEntityName(name: string): string {
    if (!name) return 'UnnamedEntity';
    
    // Remove invalid characters and convert to CamelCase
    const cleaned = name
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .trim()
      .split(/\s+/)
      .filter(word => word.length > 0)
      .slice(0, 4) // Max 4 words
      .map((word, index) => 
        index === 0 
          ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
          : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      )
      .join('');

    return cleaned || 'CorrectedEntity';
  }

  // Public method for external validation
  async validateInsightFilename(filename: string): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];
    
    if (!filename.endsWith('.md')) {
      issues.push('Insight filename must end with .md');
    }
    
    const nameWithoutExt = filename.replace('.md', '');
    if (!this.isValidEntityName(nameWithoutExt)) {
      issues.push('Insight filename must follow camelCase naming convention');
    }
    
    if (nameWithoutExt.length < 3) {
      issues.push('Insight filename is too short (minimum 3 characters)');
    }
    
    if (nameWithoutExt.length > 50) {
      issues.push('Insight filename is too long (maximum 50 characters)');
    }
    
    return {
      valid: issues.length === 0,
      issues
    };
  }
}