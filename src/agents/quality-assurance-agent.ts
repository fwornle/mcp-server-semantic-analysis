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

  async performComprehensiveQA(
    stepName: string,
    stepResult: any,
    expectedOutputs?: string[]
  ): Promise<QualityAssuranceReport> {
    log(`Starting QA validation for step: ${stepName}`, 'info', {
      stepName,
      hasResult: !!stepResult,
      expectedOutputs: expectedOutputs?.length || 0
    });

    const startTime = new Date();
    const errors: string[] = [];
    const warnings: string[] = [];
    let corrected = false;
    let correctedOutput = undefined;

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

    // Check for generated files
    if (!result.files && !result.insights && !result.documents) {
      errors.push('No insight files or documents were generated');
    }

    // Check for PlantUML diagrams
    if (result.diagrams) {
      const diagramTypes = ['architecture', 'sequence', 'class', 'use-case'];
      const generatedTypes = Object.keys(result.diagrams);
      const missingTypes = diagramTypes.filter(type => !generatedTypes.includes(type));
      
      if (missingTypes.length > 0) {
        warnings.push(`Missing diagram types: ${missingTypes.join(', ')}`);
      }
    } else {
      warnings.push('No PlantUML diagrams were generated');
    }

    // Validate insight file creation
    const insightDir = path.join(this.repositoryPath, 'knowledge-management', 'insights');
    if (!fs.existsSync(insightDir)) {
      errors.push('Insight directory does not exist - files may not have been created');
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